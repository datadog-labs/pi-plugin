// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

// Plugin-owned config state. Unlike the OpenCode plugin — which edits the
// user's opencode.json surgically to preserve their comments — these files are
// fully owned by our extension. No jsonc-parser, no malformed branch: we read,
// default missing fields, and rewrite the whole thing.
//
// Two scopes, resolved project-first:
//   - project: <cwd>/.pi/<mcpFile> — an optional per-repo override.
//   - global:  <globalDir>/<mcpFile> — the default that follows you across
//     directories (globalDir is `<agentDir>/datadog`; see paths.ts).
// OAuth tokens are always global (see oauth-store.ts) so you sign in once per
// domain; only this small domain/toolsets config can be overridden per project.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type ConfigScope = 'project' | 'global';

export type StoredConfig = { domain: string; toolsets: string };

export type ServerState = { kind: 'not-setup' } | { kind: 'configured'; scope: ConfigScope; config: StoredConfig };

const projectConfigPath = (cwd: string, mcpFile: string): string => join(cwd, '.pi', mcpFile);
const globalConfigPath = (globalDir: string, mcpFile: string): string => join(globalDir, mcpFile);

const scopePath = (cwd: string, globalDir: string, mcpFile: string, scope: ConfigScope): string =>
  scope === 'project' ? projectConfigPath(cwd, mcpFile) : globalConfigPath(globalDir, mcpFile);

// A scope counts as configured only when its file parses and carries a
// non-empty domain. Anything else (missing file, malformed JSON, no domain) is
// treated as "not this scope" so resolution cleanly falls through to global.
const tryRead = async (path: string): Promise<StoredConfig | undefined> => {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredConfig>;
    if (typeof parsed.domain !== 'string' || parsed.domain.length === 0) {
      return undefined;
    }
    return { domain: parsed.domain, toolsets: typeof parsed.toolsets === 'string' ? parsed.toolsets : '' };
  } catch {
    return undefined;
  }
};

export const loadScopeConfig = (
  cwd: string,
  globalDir: string,
  mcpFile: string,
  scope: ConfigScope,
): Promise<StoredConfig | undefined> => tryRead(scopePath(cwd, globalDir, mcpFile, scope));

export const loadServerState = async (cwd: string, globalDir: string, mcpFile: string): Promise<ServerState> => {
  const projectCfg = await tryRead(projectConfigPath(cwd, mcpFile));
  if (projectCfg) {
    return { kind: 'configured', scope: 'project', config: projectCfg };
  }

  const globalCfg = await tryRead(globalConfigPath(globalDir, mcpFile));
  if (globalCfg) {
    return { kind: 'configured', scope: 'global', config: globalCfg };
  }

  return { kind: 'not-setup' };
};

export const persistConfig = async (
  cwd: string,
  globalDir: string,
  mcpFile: string,
  scope: ConfigScope,
  config: StoredConfig,
): Promise<void> => {
  const path = scopePath(cwd, globalDir, mcpFile, scope);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, undefined, 2)}\n`);
};
