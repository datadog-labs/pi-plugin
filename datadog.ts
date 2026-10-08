// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerDatadogCommands } from './commands.js';
import { Connections } from './connections.js';
import { isRecord, profileLabel } from './config.js';
import { globalDatadogDir, resolveAgentDir } from './paths.js';
import { createDdconfig } from './tools/ddconfig.js';
import { createDdtoolsets } from './tools/ddtoolsets.js';
import { createDatadogProxy } from './tools/proxy.js';
import { initVizRuntime } from './viz/index.js';
import { makeConnectionBuilder } from '#shared/url';

const PLUGIN_VERSION = '0.7.20';
const PLUGIN_ID = 'pi-plugin';
const MCP_FILE = 'datadog.json';
const MCP_ENABLED_TOOLSETS = 'core,visualizations';
const SELECTION_ENTRY = 'datadog-selection';
const ORGANIZATION_SECTION = 'datadog_organization';

const organizationNotice = async (connections: Connections): Promise<string | undefined> => {
  try {
    const selected = await connections.current();
    if (!selected) return undefined;
    return `The selected Datadog organization is ${profileLabel(selected.profile)} at ${selected.profile.domain}, UUID ${selected.profile.identity?.orgUuid ?? 'not yet verified'}. Datadog calls target the selected connection only, and each datadog result names its organization. To use another saved organization, switch with ddconfig; ask the user to open /datadog to sign in or add one. Do not edit credential/config files to switch. Earlier results may belong to a different organization.`;
  } catch {
    return 'The Datadog selection is invalid. Ask the user to open /datadog; do not fall back to another organization.';
  }
};

export default function activate(pi: ExtensionAPI): void {
  const connections = new Connections({
    cwd: process.cwd(),
    globalDir: globalDatadogDir(resolveAgentDir()),
    mcpFile: MCP_FILE,
    endpoint: makeConnectionBuilder({ clientId: PLUGIN_ID, version: PLUGIN_VERSION }),
    defaultToolsets: MCP_ENABLED_TOOLSETS,
  });
  const deps = { connections };
  const viz = initVizRuntime(pi);
  connections.onReset = () => viz.reset();
  connections.onSelection = (profileId) => {
    pi.appendEntry(SELECTION_ENTRY, { profileId });
  };
  const restore = async (ctx: ExtensionContext) => {
    const entry = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((item) => item.type === 'custom' && item.customType === SELECTION_ENTRY);
    let saved: string | null | undefined;
    if (entry?.type === 'custom' && isRecord(entry.data)) {
      const value = entry.data.profileId;
      if (typeof value === 'string' || value === null) saved = value;
    }
    await connections.initialize(saved, ctx.isProjectTrusted(), ctx.cwd);
  };
  pi.on('session_start', async (_event, ctx) => {
    await restore(ctx);
  });
  pi.on('session_tree', async (_event, ctx) => {
    await restore(ctx);
  });
  pi.on('session_shutdown', async () => {
    await connections.close();
  });
  // A prompt section, unlike a returned message, is only re-sent to the model when its text changes.
  pi.on('before_agent_start', async ({ systemPromptOptions: { sections } }) => {
    const notice = await organizationNotice(connections);
    if (notice) sections[ORGANIZATION_SECTION] = notice;
  });
  pi.registerTool(createDatadogProxy(deps, viz.subtools));
  pi.registerTool(createDdconfig(deps));
  pi.registerTool(createDdtoolsets(deps));
  registerDatadogCommands(pi, deps, viz);
}
