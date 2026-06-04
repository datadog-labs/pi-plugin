// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

// File-based persistence for OAuth artifacts under <baseDir>/datadog-oauth/<domain>/.
// `baseDir` is the global Datadog state dir (<agentDir>/datadog; see paths.ts),
// so tokens follow the user across projects — sign in once per domain. Pure
// read/write — no protocol knowledge. The OAuthClientProvider in
// oauth-provider.ts delegates to these functions. Per-domain isolation means
// switching between mcp.datadoghq.com and mcp.datadoghq.eu keeps separate token
// sets, which matters when /ddconfig change-site flips domains.

import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Artifact = 'tokens' | 'client' | 'verifier';

const ARTIFACT_FILES: Record<Artifact, string> = {
  tokens: 'tokens.json',
  client: 'client.json',
  verifier: 'verifier.json',
};

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const oauthRootDir = (baseDir: string): string => join(baseDir, 'datadog-oauth');

const domainDir = (baseDir: string, domain: string): string =>
  // Replace any chars that aren't safe for directory names. We control the
  // input (URL hostnames from site.ts), but `:` for hostname:port could trip up
  // older filesystems.
  join(oauthRootDir(baseDir), domain.replace(/[^a-zA-Z0-9.-]/g, '_'));

const isNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const chmodPrivate = async (path: string, mode: number): Promise<void> => {
  try {
    await chmod(path, mode);
  } catch (error) {
    // Windows has limited POSIX mode support. Keep the secure mode on POSIX,
    // and let the OS ACL model handle access control on Windows.
    if (process.platform !== 'win32') throw error;
  }
};

const ensurePrivateDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Refusing to store Datadog OAuth credentials in non-directory path: ${path}`);
  }
  await chmodPrivate(path, PRIVATE_DIR_MODE);
};

const chmodPrivateIfExists = async (path: string, mode: number): Promise<void> => {
  try {
    await chmodPrivate(path, mode);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
};

const hardenExistingArtifact = async (path: string): Promise<void> => {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Refusing to use Datadog OAuth artifact at non-file path: ${path}`);
    }
    await chmodPrivate(path, PRIVATE_FILE_MODE);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
};

const writePrivateFile = async (path: string, contents: string): Promise<void> => {
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`;

  try {
    await writeFile(tempPath, contents, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
    await chmodPrivate(tempPath, PRIVATE_FILE_MODE);
    await rename(tempPath, path);
    await chmodPrivate(path, PRIVATE_FILE_MODE);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
};

const ensureOAuthDirectory = async (baseDir: string, domain: string): Promise<string> => {
  await ensurePrivateDirectory(oauthRootDir(baseDir));
  const dir = domainDir(baseDir, domain);
  await ensurePrivateDirectory(dir);
  return dir;
};

const hardenExistingStore = async (baseDir: string, domain: string, artifact: Artifact): Promise<void> => {
  await chmodPrivateIfExists(oauthRootDir(baseDir), PRIVATE_DIR_MODE);
  await chmodPrivateIfExists(domainDir(baseDir, domain), PRIVATE_DIR_MODE);
  await hardenExistingArtifact(join(domainDir(baseDir, domain), ARTIFACT_FILES[artifact]));
};

export const readArtifact = async <T>(baseDir: string, domain: string, artifact: Artifact): Promise<T | undefined> => {
  try {
    await hardenExistingStore(baseDir, domain, artifact);
    const raw = await readFile(join(domainDir(baseDir, domain), ARTIFACT_FILES[artifact]), 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
};

export const writeArtifact = async (
  baseDir: string,
  domain: string,
  artifact: Artifact,
  value: unknown,
): Promise<void> => {
  const dir = await ensureOAuthDirectory(baseDir, domain);
  await writePrivateFile(join(dir, ARTIFACT_FILES[artifact]), `${JSON.stringify(value, undefined, 2)}\n`);
};

export const clearArtifact = async (baseDir: string, domain: string, artifact: Artifact): Promise<void> => {
  await rm(join(domainDir(baseDir, domain), ARTIFACT_FILES[artifact]), { force: true });
};

export const clearAll = async (baseDir: string, domain: string): Promise<void> => {
  await rm(domainDir(baseDir, domain), { recursive: true, force: true });
};
