// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import { lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { isBareHostname } from '#shared/site';
import { isId, isRecord } from './config.js';
import { isMissing, privateDirectory, readPrivateJson, withStoreLock, writePrivateJson } from './private-store.js';

export type Credentials = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens };
export type CredentialStore = {
  read(): Promise<Credentials>;
  write(credentials: Credentials): Promise<void>;
  clear(): Promise<void>;
  lock<T>(run: () => Promise<T>): Promise<T>;
};

// Existing domain caches remain in place: migration mustn't duplicate rotating
// refresh tokens. New grants get an independent, opaque storage ID.
export const createCredentialStore = (baseDir: string, domain: string, id: string): CredentialStore => {
  if (!isBareHostname(domain) || (id !== 'legacy' && !isId(id))) throw new Error('Invalid OAuth storage identity.');
  const root = join(baseDir, 'datadog-oauth');
  const profiles = join(root, 'profiles');
  const profileDir = join(profiles, id);
  const dir = id === 'legacy' ? join(root, domain) : join(profileDir, domain);
  const path = join(dir, 'credentials.json');
  const prepare = async () => {
    await privateDirectory(root);
    if (id !== 'legacy') {
      await privateDirectory(profiles);
      await privateDirectory(profileDir);
    }
    await privateDirectory(dir);
  };
  const read = async (): Promise<Credentials> => {
    // Reject directory symlinks even on the legacy read path.
    try {
      for (const directory of [root, ...(id === 'legacy' ? [] : [profiles, profileDir]), dir]) {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe OAuth credential directory.');
      }
    } catch (error) {
      if (isMissing(error)) return {};
      throw error;
    }
    let raw = await readPrivateJson(path);
    if (raw === undefined && id === 'legacy') {
      const client = await readPrivateJson(join(dir, 'client.json'));
      const tokens = await readPrivateJson(join(dir, 'tokens.json'));
      // A writer commits the combined record before removing these old files.
      const committed = await readPrivateJson(path);
      raw = committed === undefined ? { client, tokens } : committed;
    }
    if (raw !== undefined && !isRecord(raw)) throw new Error('Invalid OAuth credentials.');
    const client = raw?.client;
    const tokens = raw?.tokens;
    return {
      ...(client === undefined
        ? {}
        : {
            client: (isRecord(client) && 'redirect_uris' in client
              ? OAuthClientInformationFullSchema
              : OAuthClientInformationSchema
            ).parse(client),
          }),
      ...(tokens === undefined ? {} : { tokens: OAuthTokensSchema.parse(tokens) }),
    };
  };
  return {
    read,
    async write(value) {
      await prepare();
      // One record commits client registration and tokens together.
      await writePrivateJson(path, value);
      if (id === 'legacy')
        for (const file of ['client.json', 'tokens.json', 'verifier.json']) await rm(join(dir, file), { force: true });
    },
    async clear() {
      // Leave a tombstone so legacy artifacts can never become a fallback.
      await prepare();
      await writePrivateJson(path, {});
      if (id === 'legacy')
        for (const file of ['client.json', 'tokens.json', 'verifier.json']) await rm(join(dir, file), { force: true });
    },
    async lock(run) {
      await prepare();
      return withStoreLock(path, run);
    },
  };
};
