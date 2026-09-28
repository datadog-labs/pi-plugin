// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { ToolDeps } from './tools/types.js';
import { manageConnections } from './tools/connections.js';
import { runDdtoolsets } from './tools/ddtoolsets.js';
import { errorMessage } from './connection-errors.js';

export const registerDatadogCommands = (pi: ExtensionAPI, deps: ToolDeps): void => {
  pi.registerCommand('datadog', {
    description: 'Manage Datadog connections and toolsets',
    getArgumentCompletions: (prefix) =>
      'toolsets'.startsWith(prefix.trim())
        ? [{ value: 'toolsets', label: 'toolsets', description: 'Configure toolsets for the selected organization' }]
        : null,
    handler: async (args, ctx) => {
      if (ctx.mode !== 'tui') {
        ctx.ui.notify(
          'Use Pi TUI mode to sign in. Headless runs use saved connections or configured API keys.',
          'error',
        );
        return;
      }
      // Don't change targets halfway through an agent run or queued continuation.
      await ctx.waitForIdle();
      try {
        const command = args.trim();
        if (command === 'toolsets') {
          const result = await runDdtoolsets(deps, { action: 'configure' }, ctx);
          ctx.ui.notify(
            result.content
              .filter((entry) => entry.type === 'text')
              .map((entry) => entry.text)
              .join('\n'),
            'info',
          );
        } else if (['', 'setup', 'configure', 'config'].includes(command))
          await manageConnections(deps.connections, ctx);
        else
          ctx.ui.notify(
            'Use /datadog to manage connections, or /datadog toolsets. Setup and site changes now live in the connection screen.',
            'info',
          );
      } catch (error) {
        ctx.ui.notify(errorMessage(error), 'error');
      }
    },
  });
};
