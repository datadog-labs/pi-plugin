// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import { type AgentToolResult, defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { loadServerState, persistConfig } from '../config.js';
import { readToolsetCatalog } from '../toolsets.js';
import { formatToolsetList, lines, parseToolsetList } from '#shared/text';
import { pickToolsets } from './tui.js';
import type { ToolDeps } from './types.js';

type ToolsetAction = 'list' | 'enable' | 'disable' | 'reset' | 'configure';

export type DdtoolsetsDetails =
  | { state: 'not-setup' }
  | { state: 'not-tui' }
  | { state: 'error' }
  | { state: 'cancelled'; toolsets: string[] }
  | { state: 'updated'; toolsets: string[] }
  | { state: 'list'; toolsets: string[] }
  | { state: 'rejected' };

export type DdtoolsetsResult = AgentToolResult<DdtoolsetsDetails>;

// Computes the next toolset list. Returns a string to short-circuit with an
// error message, or an array with the new toolsets. `force` gates removal of
// the core toolset because it's the foundation for most Datadog workflows.
const computeNewToolsets = (
  action: Exclude<ToolsetAction, 'list' | 'configure'>,
  current: string[],
  requested: string | undefined,
  force: boolean,
): string[] | string => {
  if (action === 'reset') return [];

  if (!requested) return `Provide a comma-separated list of toolset names to ${action}. Example: "core,alerting"`;
  const target = parseToolsetList(requested);
  if (target.length === 0) return 'No valid toolset names provided.';

  const next = (() => {
    if (action === 'enable') {
      if (target.includes('all')) return [...new Set(['all', ...target.filter((t) => t !== 'all')])];
      return [...new Set([...current, ...target])];
    }

    if (target.includes('all')) return [];
    return current.filter((t) => !new Set(target).has(t));
  })();

  const hasCore = (toolsets: readonly string[]): boolean =>
    toolsets.length === 0 || toolsets.includes('core') || toolsets.includes('all');

  if (hasCore(current) && !hasCore(next) && !force) {
    return lines(
      'Warning: removing the "core" toolset may break most Datadog workflows.',
      'The core toolset provides essential functionality that other toolsets depend on.',
      '',
      'To confirm, call ddtoolsets again with force set to true.',
      `Current toolsets: ${formatToolsetList(current)}`,
      `Proposed toolsets: ${formatToolsetList(next)}`,
    );
  }

  return next;
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const createDdtoolsets = ({ mcp, urls, mcpFile, cwd, globalDir }: ToolDeps) =>
  defineTool({
    name: 'ddtoolsets',
    label: 'Datadog Toolsets',
    description: lines(
      'View and manage Datadog MCP server toolsets.',
      'Toolsets control which groups of tools are available.',
      'Use to list current toolsets, enable or disable specific ones, or reset to server defaults.',
    ),
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union(
          [
            Type.Literal('list'),
            Type.Literal('enable'),
            Type.Literal('disable'),
            Type.Literal('reset'),
            Type.Literal('configure'),
          ],
          {
            description:
              'Action to perform. Omit to list current toolsets. Use "configure" in Pi TUI mode to open an interactive picker.',
          },
        ),
      ),
      toolsets: Type.Optional(
        Type.String({ description: 'Comma-separated toolset names, or "all" for every GA toolset.' }),
      ),
      force: Type.Optional(Type.Boolean({ description: 'Set to true to confirm removing the core toolset.' })),
    }),
    async execute(...args): Promise<DdtoolsetsResult> {
      const [, params, , , ctx] = args;
      const state = await loadServerState(cwd, globalDir, mcpFile);
      if (state.kind === 'not-setup') {
        return {
          content: [{ type: 'text', text: 'The Datadog MCP server has not been set up. Use the ddsetup tool first.' }],
          details: { state: 'not-setup' },
        };
      }

      const current = parseToolsetList(state.config.toolsets);
      const action: ToolsetAction = params.action ?? 'list';

      if (action === 'configure') {
        if (ctx.mode !== 'tui') {
          return {
            content: [
              {
                type: 'text',
                text: lines(
                  'The interactive Datadog toolset picker is only available in Pi TUI mode.',
                  '',
                  'Use ddtoolsets with action "list", "enable", "disable", or "reset" in this mode.',
                ),
              },
            ],
            details: { state: 'not-tui' },
          };
        }

        let catalog;
        try {
          catalog = await readToolsetCatalog(mcp);
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: lines(
                  `Failed to load Datadog MCP toolsets: ${errorMessage(error)}`,
                  '',
                  'The server may be configured but not responding. Use ddconfig with action "troubleshoot" to diagnose issues.',
                ),
              },
            ],
            details: { state: 'error' },
          };
        }

        const nextToolsets = await pickToolsets(ctx, catalog, state.config.toolsets);
        if (nextToolsets === undefined || nextToolsets === null) {
          return {
            content: [{ type: 'text', text: 'Toolset configuration unchanged.' }],
            details: { state: 'cancelled', toolsets: current },
          };
        }

        const newConfig = { ...state.config, toolsets: nextToolsets };
        await persistConfig(cwd, globalDir, mcpFile, state.scope, newConfig);
        mcp.setUrl(urls.build(state.config.domain, nextToolsets));
        const next = parseToolsetList(nextToolsets);

        return {
          content: [
            {
              type: 'text',
              text: lines(
                `Toolsets updated: ${formatToolsetList(next)}`,
                '',
                'The next Datadog tool call will use the updated toolsets.',
              ),
            },
          ],
          details: { state: 'updated', toolsets: next },
        };
      }

      if (action === 'list') {
        return {
          content: [
            {
              type: 'text',
              text: lines(
                'Current Datadog MCP toolsets:',
                current.length > 0 ? `  Enabled: ${current.join(', ')}` : '  Using server defaults',
                '',
                'Available actions:',
                '  - ddtoolsets with action "enable" and toolsets "name1,name2" to enable toolsets',
                '  - ddtoolsets with action "enable" and toolsets "all" to enable every generally available toolset',
                '  - ddtoolsets with action "disable" and toolsets "name1,name2" to disable toolsets',
                '  - ddtoolsets with action "reset" to revert to server defaults',
                '  - ddtoolsets with action "configure" in Pi TUI mode to open an interactive picker',
              ),
            },
          ],
          details: { state: 'list', toolsets: current },
        };
      }

      const next = computeNewToolsets(action, current, params.toolsets, params.force ?? false);
      if (typeof next === 'string') {
        return { content: [{ type: 'text', text: next }], details: { state: 'rejected' } };
      }

      const newToolsets = next.join(',');
      const newConfig = { ...state.config, toolsets: newToolsets };
      // Write back to the scope we resolved from, so a project override stays
      // project-local and a global config stays global.
      await persistConfig(cwd, globalDir, mcpFile, state.scope, newConfig);
      mcp.setUrl(urls.build(state.config.domain, newToolsets));

      const label =
        action === 'reset' ? 'Toolsets reset to server defaults.' : `Toolsets updated: ${formatToolsetList(next)}`;
      return {
        content: [
          { type: 'text', text: lines(label, '', 'The next Datadog tool call will use the updated toolsets.') },
        ],
        details: { state: 'updated', toolsets: next },
      };
    },
  });
