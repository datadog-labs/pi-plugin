// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { UrlBuilder } from '#shared/url';
import { isBareHostname, isKnownDomain } from '#shared/site';
import {
  createConnectionClient,
  environmentHeaders,
  type ConnectionClient,
  type ConnectionAuth,
} from './mcp-client.js';
import { createCredentialStore, type Credentials, type CredentialStore } from './oauth-store.js';
import { IdentityMismatch, SignInRequired } from './connection-errors.js';
import { startLoginCallback } from './oauth-callback-server.js';
import { writePrivateJson, withStoreLock } from './private-store.js';
import {
  createProfileStore,
  parseIdentity,
  readProjectSelection,
  resolveProfile,
  sameIdentity,
  type Profile,
  type OrgIdentity,
  type ProjectSelection,
} from './config.js';

export type SelectedConnection = {
  profile: Profile;
  toolsets: string;
  scope: 'project' | 'profile';
  sessionVersion: number;
};
export type VerifiedConnection = SelectedConnection & { client: ConnectionClient; identity: OrgIdentity };
export type ConnectionOptions = {
  cwd: string;
  globalDir: string;
  mcpFile: string;
  urls: UrlBuilder;
  defaultToolsets: string;
  headers?: Record<string, string>;
  makeClient?: typeof createConnectionClient;
  login?: typeof startLoginCallback;
};

// One session's selection; only the registry and credentials are shared globally.
export class Connections {
  readonly store;
  readonly hasEnvironmentKeys: boolean;
  onReset: () => Promise<void> = async () => undefined;
  // Synchronous so the session pin and in-memory selection publish together.
  onSelection: (id: string | null) => void = () => undefined;
  private transition: Promise<unknown> = Promise.resolve();
  private sessionVersion = 0;
  private readonly clients = new Set<ConnectionClient>();
  private selectedId: string | null | undefined;
  private project: ProjectSelection | undefined;
  private trusted = false;
  private selectionError: Error | undefined;
  private active: { key: string; client: ConnectionClient; verified: boolean } | undefined;
  private signingIn = false;
  private loginAbort: AbortController | undefined;
  private readonly headers: Record<string, string> | undefined;
  private readonly makeClient: typeof createConnectionClient;

  constructor(private readonly options: ConnectionOptions) {
    this.headers = options.headers ?? environmentHeaders();
    this.hasEnvironmentKeys = !!this.headers;
    this.store = createProfileStore(options.globalDir, options.mcpFile, this.hasEnvironmentKeys);
    this.makeClient = options.makeClient ?? createConnectionClient;
  }

  get selection(): string | null | undefined {
    return this.selectedId;
  }
  get isVerified(): boolean {
    return this.active?.verified ?? false;
  }

  private invalidateSession(): void {
    this.sessionVersion++;
    this.loginAbort?.abort();
    // Don't queue cancellation behind the handshake it needs to interrupt.
    // Include staged clients, which haven't become active yet.
    for (const client of this.clients) void client.close().catch(() => undefined);
  }

  private assertSession(version: number): void {
    if (version !== this.sessionVersion) throw new Error('The Pi session changed. Retry the Datadog operation.');
  }

  private serialize<T>(operation: (version: number) => Promise<T>): Promise<T> {
    const version = this.sessionVersion;
    const next = this.transition.then(async () => {
      this.assertSession(version);
      const result = await operation(version);
      this.assertSession(version);
      return result;
    });
    this.transition = next.catch(() => undefined);
    return next;
  }

  private persistSelection(id: string | null, version: number): void {
    // appendEntry targets Pi's current session, not the one that began this work.
    this.assertSession(version);
    try {
      this.onSelection(id);
    } catch (error) {
      // Pi may have appended in memory before a disk write failed. Don't keep
      // using an organization while the session pin is uncertain.
      this.selectionError = new Error('Could not save the Datadog selection. Open /datadog to select it again.', {
        cause: error,
      });
      throw this.selectionError;
    }
  }

  initialize(savedId: string | null | undefined, trusted: boolean, cwd = this.options.cwd): Promise<void> {
    this.invalidateSession();
    return this.serialize(async (version) => {
      await this.reset();
      await this.restore(savedId, trusted, cwd);
      if (!this.selectionError && savedId === undefined && this.selectedId)
        this.persistSelection(this.selectedId, version);
    });
  }

  private async restore(savedId: string | null | undefined, trusted: boolean, cwd: string): Promise<void> {
    this.options.cwd = cwd;
    this.trusted = trusted;
    this.selectionError = undefined;
    this.project = undefined;
    this.selectedId = savedId;
    try {
      if (trusted) {
        const project = await readProjectSelection(this.options.cwd, this.options.mcpFile);
        if (project && 'domain' in project) {
          if (
            !isKnownDomain(project.domain) &&
            !(await this.store.read()).profiles.some((profile) => profile.domain === project.domain)
          )
            throw new Error(
              'This legacy project selects a custom MCP domain. Connect it explicitly in /datadog before using credentials with that server.',
            );
          const imported = await this.store.importProject(project);
          this.project = { profileId: imported.id, toolsets: project.toolsets };
        } else this.project = project;
      }
      if (savedId === undefined)
        this.selectedId = this.project?.profileId ?? (await this.store.read()).defaultProfileId;
      await this.readCurrent();
    } catch (error) {
      // An explicit session selection wins over a broken project override, but a
      // fresh session mustn't silently choose a different org.
      if (savedId !== undefined) {
        this.project = undefined;
        try {
          await this.readCurrent();
          return;
        } catch {
          /* report the selected profile error below */
        }
      }
      this.selectionError = error instanceof Error ? error : new Error(String(error));
    }
  }

  current(): Promise<SelectedConnection | undefined> {
    return this.serialize(() => this.readCurrent());
  }

  private async readCurrent(): Promise<SelectedConnection | undefined> {
    if (this.selectionError) throw this.selectionError;
    if (!this.selectedId) return undefined;
    const profile = resolveProfile(await this.store.read(), this.selectedId)!;
    return this.describe(profile);
  }

  private describe(profile: Profile): SelectedConnection {
    const override = this.project?.profileId === profile.id ? this.project.toolsets : undefined;
    return {
      profile,
      toolsets: override ?? profile.toolsets,
      scope: override === undefined ? 'profile' : 'project',
      sessionVersion: this.sessionVersion,
    };
  }

  private credentials(profile: Profile): CredentialStore {
    if (profile.auth.kind !== 'oauth') throw new Error('This connection uses environment credentials.');
    return createCredentialStore(this.options.globalDir, profile.domain, profile.auth.store);
  }

  private build(selection: SelectedConnection): ConnectionClient {
    const { profile, toolsets } = selection;
    let auth: ConnectionAuth;
    if (profile.auth.kind === 'oauth') auth = { kind: 'oauth', store: this.credentials(profile) };
    else {
      if (!this.headers)
        throw new Error('Set DD_API_KEY and DD_APPLICATION_KEY before starting Pi for this connection.');
      auth = { kind: 'environment', headers: this.headers };
    }
    const client = this.makeClient(
      this.options.urls.build(profile.domain, toolsets),
      auth,
      profile.identity,
      async () => {
        const current = resolveProfile(await this.store.read(), profile.id)!;
        if (current.domain !== profile.domain || JSON.stringify(current.auth) !== JSON.stringify(profile.auth))
          throw new SignInRequired();
        if (profile.identity && (!current.identity || !sameIdentity(current.identity, profile.identity)))
          throw new IdentityMismatch();
      },
    );
    const managed: ConnectionClient = {
      ...client,
      close: async () => {
        this.clients.delete(managed);
        await client.close();
      },
    };
    this.clients.add(managed);
    return managed;
  }

  private async verify(
    selection: SelectedConnection,
    client: ConnectionClient,
    signal?: AbortSignal,
  ): Promise<OrgIdentity> {
    const identity = await client.identity(signal);
    if (selection.profile.identity && !sameIdentity(selection.profile.identity, identity)) throw new IdentityMismatch();
    if (!selection.profile.identity) {
      await this.store.update((registry) => {
        // Reading a legacy registry also migrates its metadata on the first use.
        const profile = resolveProfile(registry, selection.profile.id)!;
        if (profile.identity && !sameIdentity(profile.identity, identity)) throw new IdentityMismatch();
        profile.identity = identity;
      });
      selection.profile.identity = identity;
    }
    return identity;
  }

  connection(signal?: AbortSignal): Promise<VerifiedConnection> {
    return this.serialize((version) => this.openConnection(version, signal));
  }

  private async openConnection(version: number, signal?: AbortSignal): Promise<VerifiedConnection> {
    const selected = await this.readCurrent();
    this.assertSession(version);
    if (!selected) throw new SignInRequired();
    const key = JSON.stringify([
      selected.profile.id,
      selected.profile.domain,
      selected.profile.auth,
      selected.toolsets,
    ]);
    let active = this.active;
    if (active?.key !== key) {
      const previous = active;
      active = { key, client: this.build(selected), verified: false };
      this.active = active;
      await previous?.client.close();
    }
    try {
      const identity = await this.verify(selected, active.client, signal);
      active.verified = true;
      return { ...selected, client: active.client, identity };
    } catch (error) {
      active.verified = false;
      throw error;
    }
  }

  async check(signal?: AbortSignal): Promise<VerifiedConnection> {
    const connection = await this.connection(signal);
    try {
      const resource = await connection.client.readResource('datadog://mcp/whoami', signal);
      const text = resource.contents.find((entry) => 'text' in entry)?.text;
      if (typeof text !== 'string') throw new Error('Datadog organization verification is unavailable.');
      const identity = parseIdentity(JSON.parse(text) as unknown);
      if (!sameIdentity(identity, connection.identity)) throw new IdentityMismatch();
      return connection;
    } catch (error) {
      if (this.active?.client === connection.client) this.active.verified = false;
      throw error;
    }
  }

  select(id: string, signal?: AbortSignal): Promise<void> {
    return this.serialize(async (version) => {
      signal?.throwIfAborted();
      const profile = resolveProfile(await this.store.read(), id)!;
      this.assertSession(version);
      const selection = this.describe(profile);
      const client = this.build(selection);
      try {
        await this.verify(selection, client, signal);
        signal?.throwIfAborted();
        await this.onReset();
        signal?.throwIfAborted();
        try {
          this.persistSelection(id, version);
        } catch (error) {
          await this.closeActive();
          throw error;
        }
      } catch (error) {
        await client.close();
        throw error;
      }
      const previous = this.active;
      this.selectionError = undefined;
      this.selectedId = id;
      this.active = {
        key: JSON.stringify([id, profile.domain, profile.auth, selection.toolsets]),
        client,
        verified: true,
      };
      // close() invalidates and aborts the old transport before awaiting cleanup.
      // Cleanup failure mustn't undo an already-persisted switch.
      await previous?.client.close().catch(() => undefined);
    });
  }

  // The interactive client sees only a staging store. A cancelled or wrong-org
  // login cannot overwrite the saved grant. Publish after server verification.
  async signIn(
    domain: string,
    kind: 'oauth' | 'environment',
    existing?: Profile,
    signal?: AbortSignal,
  ): Promise<Profile> {
    if (this.signingIn) throw new Error('A Datadog sign-in is already in progress.');
    if (!isBareHostname(domain) || (existing && existing.domain !== domain))
      throw new Error('Invalid Datadog connection domain.');
    this.signingIn = true;
    this.loginAbort = new AbortController();
    signal = AbortSignal.any([this.loginAbort.signal, ...(signal ? [signal] : [])]);
    let staged: Credentials = {};
    const memory: CredentialStore = {
      read: async () => staged,
      write: async (value) => {
        staged = value;
      },
      clear: async () => {
        staged = {};
      },
      lock: async (run) => run(),
    };
    let login: Awaited<ReturnType<typeof startLoginCallback>> | undefined;
    let client: ConnectionClient | undefined;
    try {
      if (!existing) await this.verifyUnboundProfiles(domain, signal);
      let auth: ConnectionAuth;
      if (kind === 'oauth') {
        login = await (this.options.login ?? startLoginCallback)(signal);
        const browserOpen = login.open.bind(login);
        const expected = existing?.identity;
        login.open = async (url) => {
          if (expected) url.searchParams.set('dd_oid', expected.orgUuid);
          await browserOpen(url);
        };
        auth = { kind, store: memory, login };
      } else {
        if (!this.headers) throw new Error('DD_API_KEY and DD_APPLICATION_KEY must both be set.');
        auth = { kind, headers: this.headers };
      }
      client = this.makeClient(
        this.options.urls.build(domain, existing?.toolsets ?? this.options.defaultToolsets),
        auth,
        existing?.identity,
      );
      const identity = await client.identity(signal);
      if (existing?.identity && !sameIdentity(existing.identity, identity)) throw new IdentityMismatch();
      signal.throwIfAborted();
      const profile: Profile = {
        id: existing?.id ?? randomUUID(),
        domain,
        label: existing?.label,
        toolsets: existing?.toolsets ?? this.options.defaultToolsets,
        identity,
        auth: kind === 'oauth' ? { kind, store: randomUUID() } : { kind },
      };
      if (kind === 'oauth') {
        if (!staged.client || !staged.tokens) throw new Error('Datadog sign-in did not return complete credentials.');
        const store = this.credentials(profile);
        await store.lock(() => store.write(staged));
      }
      try {
        signal.throwIfAborted();
        await this.store.update((registry) => {
          signal.throwIfAborted();
          if (existing) {
            const current = resolveProfile(registry, existing.id)!;
            if (current.domain !== existing.domain || JSON.stringify(current.auth) !== JSON.stringify(existing.auth))
              throw new Error('This connection changed in another Pi session. Try again.');
            // A stale menu may predate another session's first organization verification.
            if (current.identity && !sameIdentity(current.identity, identity)) throw new IdentityMismatch();
            Object.assign(current, { auth: profile.auth, identity });
          } else {
            // A project may have imported another legacy profile during login.
            if (registry.profiles.some((entry) => entry.domain === domain && !entry.identity))
              throw new Error('An unverified connection was added on this site during sign-in. Try again.');
            if (
              registry.profiles.some(
                (entry) => entry.domain === profile.domain && entry.identity?.orgUuid === identity.orgUuid,
              )
            )
              throw new Error(
                'This organization is already saved. Use its existing connection or choose another organization in the browser.',
              );
            registry.profiles.push(profile);
            registry.defaultProfileId ??= profile.id;
          }
        });
      } catch (error) {
        if (kind === 'oauth') await this.credentials(profile).clear();
        throw error;
      }
      if (existing?.auth.kind === 'oauth') {
        const oldStore = this.credentials(existing);
        await oldStore.lock(() => oldStore.clear());
      }
      return profile;
    } finally {
      try {
        await client?.close();
      } finally {
        try {
          await login?.close();
        } finally {
          this.loginAbort = undefined;
          this.signingIn = false;
        }
      }
    }
  }

  private async verifyUnboundProfiles(domain: string, signal: AbortSignal): Promise<void> {
    const profiles = (await this.store.read()).profiles.filter(
      (profile) => profile.domain === domain && !profile.identity,
    );
    for (const profile of profiles) {
      const selection = this.describe(profile);
      let client: ConnectionClient | undefined;
      try {
        client = this.build(selection);
        await this.verify(selection, client, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
      } catch (error) {
        signal.throwIfAborted();
        throw new Error(
          'Could not verify an existing connection on this site. Open /datadog and check that connection, sign in again, or remove it before adding another.',
          { cause: error },
        );
      } finally {
        await client?.close();
      }
    }
  }

  async setDefault(id: string): Promise<void> {
    await this.store.update((registry) => {
      resolveProfile(registry, id);
      registry.defaultProfileId = id;
    });
  }
  useForProject(id: string): Promise<void> {
    return this.serialize(async () => {
      if (!this.trusted) throw new Error('Trust this project in Pi before saving a project selection.');
      resolveProfile(await this.store.read(), id);
      const project = { profileId: id };
      const path = join(this.options.cwd, '.pi', this.options.mcpFile);
      await withStoreLock(path, () => writePrivateJson(path, project));
      this.project = project;
    });
  }
  async rename(id: string, label: string): Promise<void> {
    await this.store.update((registry) => {
      const profile = resolveProfile(registry, id)!;
      profile.label = label.trim() || undefined;
    });
  }
  setToolsets(selected: SelectedConnection, toolsets: string): Promise<void> {
    return this.serialize(async () => {
      this.assertSession(selected.sessionVersion);
      const current = await this.readCurrent();
      if (
        current?.profile.id !== selected.profile.id ||
        current.scope !== selected.scope ||
        current.toolsets !== selected.toolsets
      )
        throw new Error('The Datadog selection changed. Try configuring toolsets again.');
      if (selected.scope === 'project') {
        if (!this.trusted) throw new Error('Project configuration is not trusted.');
        const project = { profileId: selected.profile.id, toolsets };
        const path = join(this.options.cwd, '.pi', this.options.mcpFile);
        await withStoreLock(path, () => writePrivateJson(path, project));
        this.project = project;
      } else
        await this.store.update((registry) => {
          resolveProfile(registry, selected.profile.id)!.toolsets = toolsets;
        });
      await this.reset();
    });
  }
  private async forget(profile: Profile, remove: boolean, version: number): Promise<void> {
    // Resolve the latest credential reference under the registry lock. A stale
    // menu mustn't sign out an old grant while another session replaces it.
    await this.store.update(async (registry) => {
      const current = resolveProfile(registry, profile.id)!;
      if (current.auth.kind === 'oauth') {
        const store = this.credentials(current);
        await store.lock(() => store.clear());
      } else if (!remove) throw new Error('Unset the API key environment variables to sign out.');
      if (remove) {
        registry.profiles = registry.profiles.filter((entry) => entry.id !== profile.id);
        if (registry.defaultProfileId === profile.id) delete registry.defaultProfileId;
      }
    });
    if (this.selectedId === profile.id) {
      await this.reset();
      if (remove) {
        this.selectedId = null;
        this.persistSelection(null, version);
      }
    }
  }
  signOut(profile: Profile): Promise<void> {
    return this.serialize((version) => this.forget(profile, false, version));
  }
  remove(profile: Profile): Promise<void> {
    return this.serialize((version) => this.forget(profile, true, version));
  }
  close(): Promise<void> {
    // Invalidate old session work and abort browser login without waiting for the queue.
    this.invalidateSession();
    return this.serialize(() => this.reset());
  }

  private async reset(): Promise<void> {
    try {
      try {
        await this.onReset();
      } finally {
        await this.closeActive();
      }
    } catch (error) {
      this.selectionError = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  private async closeActive(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    await active?.client.close();
  }
}
