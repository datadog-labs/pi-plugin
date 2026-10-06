// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { ToolDeps } from './tools/types.js';
import { manageConnections } from './tools/connections.js';
import { runDdtoolsets } from './tools/ddtoolsets.js';
import { errorMessage } from './connection-errors.js';
import { DDVIZ_TOGGLE_SHORTCUT_LABEL } from './viz/index.js';
import { checkServerAvailability, formatLocalDdvizStatus, type LocalDdvizStatus } from './viz/status.js';

export const registerDatadogCommands = (
  pi: ExtensionAPI,
  deps: ToolDeps,
  viz: { enabled: boolean; getStatus(): Promise<LocalDdvizStatus> },
): void => {
  const completions = [
    { value: 'toolsets', label: 'toolsets', description: 'Configure toolsets for the selected organization' },
    { value: 'ddviz', label: 'ddviz', description: 'Show visualization status and diagnostics (read-only)' },
    {
      value: 'ddviz status',
      label: 'ddviz status',
      description: 'Show visualization status and diagnostics (read-only)',
    },
  ].filter((item) => viz.enabled || !item.value.startsWith('ddviz'));
  pi.registerCommand('datadog', {
    description: viz.enabled
      ? 'Manage Datadog connections and toolsets, or check visualization status'
      : 'Manage Datadog connections and toolsets',
    getArgumentCompletions: (prefix) => {
      const input = prefix.trimStart();
      const matches = completions.filter(
        (item) => item.value.startsWith(input) && (input.includes(' ') || !item.value.includes(' ')),
      );
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const command = args.trim().replace(/\s+/g, ' ');
      if (command === 'ddviz' || command.startsWith('ddviz ')) {
        if (ctx.mode !== 'tui') {
          ctx.ui.notify('Use /datadog ddviz in Pi TUI mode to view visualization diagnostics.', 'error');
          return;
        }
        if (command !== 'ddviz' && command !== 'ddviz status') {
          ctx.ui.notify(
            'Use /datadog ddviz to check status. This command is read-only; enable/disable controls are not available.',
            'info',
          );
          return;
        }
        try {
          // Both checks are read-only; the server check may take up to its timeout.
          const [status, server] = await Promise.all([viz.getStatus(), checkServerAvailability(deps.connections)]);
          ctx.ui.notify(formatLocalDdvizStatus(status, DDVIZ_TOGGLE_SHORTCUT_LABEL, server), 'info');
        } catch (error) {
          ctx.ui.notify(errorMessage(error), 'error');
        }
        return;
      }
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
        else {
          const ddvizHint = viz.enabled ? ' or /datadog ddviz to check visualization status' : '';
          ctx.ui.notify(
            `Use /datadog to manage connections, /datadog toolsets to configure toolsets${ddvizHint}. Setup and site changes now live in the connection screen.`,
            'info',
          );
        }
      } catch (error) {
        ctx.ui.notify(errorMessage(error), 'error');
      }
    },
  });
};
