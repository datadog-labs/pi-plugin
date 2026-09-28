// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isBareHostname } from '#shared/site';
import { isMissing, readPrivateJson, withStoreLock, writePrivateJson } from './private-store.js';

export type OrgIdentity = { orgUuid: string; orgName: string; site: string };
export const sameIdentity = (a: OrgIdentity, b: OrgIdentity): boolean => a.orgUuid === b.orgUuid && a.site === b.site;
export type ProfileAuth = { kind: 'oauth'; store: string } | { kind: 'environment' };
export type Profile = {
  id: string;
  domain: string;
  label?: string;
  toolsets: string;
  auth: ProfileAuth;
  // Only legacy imports may lack an identity. They must be verified before use.
  identity?: OrgIdentity;
};
export type ProfileRegistry = { version: 2; profiles: Profile[]; defaultProfileId?: string };
export type ProjectSelection = { profileId: string; toolsets?: string };
export type LegacyConfig = { domain: string; toolsets: string };
export type ProjectConfig = ProjectSelection | LegacyConfig;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export const isId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|legacy-[a-f0-9]{24}-(?:oauth|environment))$/.test(
    value,
  );
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
export const profileLabel = (profile: Profile): string =>
  (profile.label ?? profile.identity?.orgName ?? profile.domain).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

export const parseIdentity = (raw: unknown): OrgIdentity => {
  if (!isRecord(raw) || !nonempty(raw.org_uuid) || !nonempty(raw.org_name) || !nonempty(raw.dd_site))
    throw new Error('Datadog did not return a verifiable organization identity.');
  return { orgUuid: raw.org_uuid, orgName: raw.org_name, site: raw.dd_site };
};

const parseLegacy = (raw: unknown): LegacyConfig | undefined => {
  if (!isRecord(raw) || 'version' in raw || 'profileId' in raw || !nonempty(raw.domain)) return undefined;
  if (!isBareHostname(raw.domain)) throw new Error('Invalid legacy Datadog domain. Open /datadog to reconnect.');
  if (raw.toolsets !== undefined && typeof raw.toolsets !== 'string') throw new Error('Invalid Datadog toolsets.');
  return { domain: raw.domain.toLowerCase(), toolsets: raw.toolsets ?? '' };
};

const legacyProfile = (config: LegacyConfig, environment: boolean): Profile => {
  const kind = environment ? 'environment' : 'oauth';
  return {
    id: `legacy-${createHash('sha256').update(config.domain).digest('hex').slice(0, 24)}-${kind}`,
    ...config,
    auth: kind === 'oauth' ? { kind, store: 'legacy' } : { kind },
  };
};

export const parseRegistry = (raw: unknown): ProfileRegistry => {
  if (!isRecord(raw) || raw.version !== 2 || !Array.isArray(raw.profiles))
    throw new Error('Invalid Datadog profile configuration.');
  const ids = new Set<string>();
  for (const entry of raw.profiles as unknown[]) {
    if (
      !isRecord(entry) ||
      !isId(entry.id) ||
      ids.has(entry.id) ||
      !nonempty(entry.domain) ||
      !isBareHostname(entry.domain) ||
      typeof entry.toolsets !== 'string' ||
      (entry.label !== undefined && (!nonempty(entry.label) || entry.label.length > 100)) ||
      !isRecord(entry.auth)
    )
      throw new Error('Invalid Datadog profile.');
    if (
      entry.auth.kind !== 'environment' &&
      !(entry.auth.kind === 'oauth' && (entry.auth.store === 'legacy' || isId(entry.auth.store)))
    )
      throw new Error('Invalid Datadog profile authentication.');
    if (
      entry.identity !== undefined &&
      (!isRecord(entry.identity) ||
        !nonempty(entry.identity.orgUuid) ||
        !nonempty(entry.identity.orgName) ||
        !nonempty(entry.identity.site))
    )
      throw new Error('Invalid Datadog org identity.');
    ids.add(entry.id);
  }
  if (raw.defaultProfileId !== undefined && (!isId(raw.defaultProfileId) || !ids.has(raw.defaultProfileId)))
    throw new Error('The default Datadog connection no longer exists. Open /datadog to select one.');
  return raw as ProfileRegistry;
};

export const createProfileStore = (globalDir: string, mcpFile: string, environment: boolean) => {
  const path = join(globalDir, mcpFile);
  const read = async (): Promise<ProfileRegistry> => {
    const raw = await readPrivateJson(path);
    if (raw === undefined) return { version: 2, profiles: [] };
    const legacy = parseLegacy(raw);
    if (!legacy) return parseRegistry(raw);
    const profile = legacyProfile(legacy, environment);
    return { version: 2, profiles: [profile], defaultProfileId: profile.id };
  };
  const update = async (change: (registry: ProfileRegistry) => void | Promise<void>): Promise<ProfileRegistry> =>
    withStoreLock(path, async () => {
      const registry = await read();
      await change(registry);
      parseRegistry(registry);
      await writePrivateJson(path, registry);
      return registry;
    });
  return {
    read,
    update,
    async importProject(config: LegacyConfig): Promise<Profile> {
      const profile = legacyProfile(config, environment);
      const registry = await update((state) => {
        if (!state.profiles.some((entry) => entry.id === profile.id)) state.profiles.push(profile);
      });
      return registry.profiles.find((entry) => entry.id === profile.id)!;
    },
  };
};
export type ProfileStore = ReturnType<typeof createProfileStore>;

// Project config isn't a credential source. Never ignore a malformed or dangling
// selection and silently fall through to a potentially different organization.
export const readProjectSelection = async (cwd: string, mcpFile: string): Promise<ProjectConfig | undefined> => {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(cwd, '.pi', mcpFile), 'utf8')) as unknown;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new Error('Invalid .pi/datadog.json; refusing to fall back to another organization.', { cause: error });
  }
  const legacy = parseLegacy(raw);
  if (legacy) return legacy;
  if (
    !isRecord(raw) ||
    !isId(raw.profileId) ||
    (raw.toolsets !== undefined && typeof raw.toolsets !== 'string') ||
    Object.keys(raw).some((key) => !['profileId', 'toolsets'].includes(key))
  )
    throw new Error('Project Datadog config must select a saved profile, not define a connection.');
  return raw as ProjectSelection;
};

export const resolveProfile = (registry: ProfileRegistry, id?: string): Profile | undefined => {
  const selected = id ?? registry.defaultProfileId;
  if (!selected) return undefined;
  const profile = registry.profiles.find((entry) => entry.id === selected);
  if (!profile) throw new Error('The selected Datadog connection no longer exists. Open /datadog to select one.');
  return profile;
};
