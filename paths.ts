// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

// Resolves the global location where the plugin keeps its cross-project state
// (the configured domain/toolsets and OAuth tokens). Pi's own config dir is
// `~/.pi/agent`, overridable via `PI_CODING_AGENT_DIR` (see Pi's usage docs);
// we honor the same override so we never drift from where Pi itself lives.
//
// Everything the plugin owns is namespaced under a `datadog/` subdir so we
// never collide with Pi internals (settings.json, auth.json, sessions/, …) or
// other extensions sharing the agent dir.

import { homedir } from 'node:os';
import { join } from 'node:path';

export const resolveAgentDir = (env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string => {
  const override = env.PI_CODING_AGENT_DIR;
  return override && override.length > 0 ? override : join(home, '.pi', 'agent');
};

export const globalDatadogDir = (agentDir: string): string => join(agentDir, 'datadog');
