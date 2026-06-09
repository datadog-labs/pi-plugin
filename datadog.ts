// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { loadServerState } from './config.js';
import { createMcpClient } from './mcp-client.js';
import { globalDatadogDir, resolveAgentDir } from './paths.js';
import { createDdconfig } from './tools/ddconfig.js';
import { createDdsetup } from './tools/ddsetup.js';
import { createDdtoolsets } from './tools/ddtoolsets.js';
import { createDatadogProxy } from './tools/proxy.js';
import { makeUrlBuilder } from '#shared/url';

// Build-time constants (replaced by bundle.ts — keep inside string literals)
const PLUGIN_VERSION = '0.1.1';
const PLUGIN_ID = 'pi-plugin';
const MCP_NAME = 'datadog';
const MCP_FILE = 'datadog.json';
const MCP_ENABLED_TOOLSETS = 'core,visualizations';

export default async function activate(pi: ExtensionAPI): Promise<void> {
  const urls = makeUrlBuilder({ clientId: PLUGIN_ID, version: PLUGIN_VERSION });
  const cwd = process.cwd();
  // Global state dir (config default + OAuth tokens) follows the user across
  // projects; an optional <cwd>/.pi/<mcpFile> can still override per repo.
  const globalDir = globalDatadogDir(resolveAgentDir());

  // Resolve the persisted domain (if any) on load so the proxy tool can target
  // it without waiting for the user. Tools update the URL after /ddsetup or
  // /ddconfig via `mcp.setUrl(...)`. The MCP connection is lazy: nothing
  // contacts Datadog (or opens a browser for OAuth) until a tool actually
  // calls listTools/callTool.
  const state = await loadServerState(cwd, globalDir, MCP_FILE);
  const initialUrl = state.kind === 'configured' ? urls.build(state.config.domain, state.config.toolsets) : '';
  const mcp = createMcpClient(globalDir, initialUrl);

  const deps = {
    mcp,
    urls,
    mcpName: MCP_NAME,
    mcpFile: MCP_FILE,
    mcpEnabledToolsets: MCP_ENABLED_TOOLSETS,
    cwd,
    globalDir,
  };

  pi.registerTool(createDatadogProxy(deps));
  pi.registerTool(createDdsetup(deps));
  pi.registerTool(createDdconfig(deps));
  pi.registerTool(createDdtoolsets(deps));
}
