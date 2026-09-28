// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';

export const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const privateMode = async (path: string, mode: number): Promise<void> => {
  try {
    await chmod(path, mode);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
};

export const privateDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Not a private directory: ${path}`);
  await privateMode(path, 0o700);
};

export const readPrivateJson = async (path: string): Promise<unknown> => {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular Datadog state file: ${path}`);
    await privateMode(path, 0o600);
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

export const writePrivateJson = async (path: string, value: unknown): Promise<void> => {
  await privateDirectory(dirname(path));
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, undefined, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
};

// Cross-process locking matters here: separate Pi sessions share refresh tokens
// and the profile registry. An in-memory queue or atomic rename alone isn't enough.
export const withStoreLock = async <T>(path: string, run: () => Promise<T>): Promise<T> => {
  await privateDirectory(dirname(path));
  const release = await lockfile.lock(path, {
    realpath: false,
    stale: 30_000,
    retries: { retries: 20, minTimeout: 50, maxTimeout: 250 },
  });
  try {
    return await run();
  } finally {
    await release();
  }
};
