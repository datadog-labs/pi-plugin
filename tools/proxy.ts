// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import { defineTool, keyHint, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Box, Container, Text } from '@earendil-works/pi-tui';

import { loadServerState } from '../config.js';
import { lines } from '#shared/text';

import { proxyParameters } from './types.js';
import type { ProxyDetails, ProxyToolResult, SubtoolConfig, ToolDeps } from './types.js';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Optional per-tool overrides, keyed by upstream Datadog tool name. Partial so a
// missing key is typed as `undefined` (only some tools have overrides).
export type SubtoolOverrides = Partial<Record<string, SubtoolConfig>>;

// One proxy tool, lazily aware of upstream MCP tools. Matches Pi's "token-
// efficient by default" philosophy: the agent pays ~200 tokens for this single
// definition regardless of how many Datadog tools the server exposes. `list:
// true` returns the full catalog; `query: "<keywords>"` filters that catalog
// by case-insensitive substring match across name + description. The parameter
// schema lives in ./types.js so the subtool render signatures can reference it.
//
// Subtool overrides are supplied up front (immutable) rather than registered
// after construction, so the set of overrides is fixed for the tool's lifetime.
export const createDatadogProxy = (
  { mcp, mcpFile, cwd, globalDir }: ToolDeps,
  subtools: SubtoolOverrides = {},
): ToolDefinition<typeof proxyParameters, ProxyDetails> =>
  defineTool<typeof proxyParameters, ProxyDetails>({
    name: 'datadog',
    label: 'Datadog',
    description: lines(
      'Query the Datadog observability MCP server (logs, metrics, traces, dashboards, monitors, RUM, security, and more).',
      'Always call this tool first to discover available Datadog tools — use { "list": true } for the full catalog,',
      'or { "query": "<keywords>" } to narrow when intent is clear (e.g. "logs", "monitor alert"). If a narrow query',
      'returns no useful matches, broaden it or call again with no query. Then invoke a tool with',
      '{ "tool": "<name>", "args": { ... } }. If this returns a not-setup error, ask the user to run the ddsetup tool.',
    ),
    parameters: proxyParameters,
    renderShell: 'self',
    renderCall(args, theme, context) {
      const isListMode = args.list || args.query !== undefined || (!args.tool && !args.args);
      if (isListMode) {
        return new Container();
      }
      const renderer = args.tool ? subtools[args.tool]?.renderCall : undefined;
      if (renderer) {
        return renderer(args, theme, context);
      }
      // Default rendering
      return new Container();
    },
    renderResult(result, options, theme, context) {
      const details = result.details;

      // Subtool rendering if override
      const subtool = 'tool' in details ? details.tool : undefined;
      const renderer = subtool ? subtools[subtool]?.renderResult : undefined;
      if (renderer) {
        return renderer(result, options, theme, context);
      }

      // Default rendering
      const bgKey = (() => {
        if (context.isPartial) return 'toolPendingBg';
        if (
          context.isError ||
          details.state === 'error' ||
          details.state === 'bad-input' ||
          details.state === 'not-setup' ||
          (details.state === 'called' && details.isError)
        ) {
          return 'toolErrorBg';
        }
        return 'toolSuccessBg';
      })();
      const box = new Box(1, 1, (s) => theme.bg(bgKey, s));
      if (details.state === 'listed' && !options.expanded) {
        const query = details.query?.trim();
        const summary = query
          ? `Found ${String(details.count)} of ${String(details.total)} Datadog tools matching "${query}"`
          : `Available Datadog tools: ${String(details.count)}`;
        box.addChild(
          new Text(
            theme.fg('toolOutput', `${summary} (${keyHint('app.tools.expand', 'to expand')})`),
            0,
            0,
          ),
        );
        return box;
      }
      const textBlocks = result.content.filter((c) => c.type === 'text');
      const output = textBlocks.map((c) => c.text.replace(/\r/g, '')).join('\n');
      if (output) {
        box.addChild(new Text(theme.fg('toolOutput', output), 0, 0));
      }
      return box;
    },
    async execute(toolCallId, params, signal, onUpdate, ctx): Promise<ProxyToolResult> {
      const state = await loadServerState(cwd, globalDir, mcpFile);
      if (state.kind === 'not-setup') {
        return {
          content: [
            {
              type: 'text',
              text: 'The Datadog MCP server has not been set up yet. Ask the user to run the ddsetup tool to configure a Datadog site.',
            },
          ],
          details: { state: 'not-setup' },
        };
      }

      if (params.list || params.query !== undefined || (!params.tool && !params.args)) {
        try {
          const tools = await mcp.listTools();
          const toolCatalog = tools.map((t) => ({
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema,
          }));
          const terms = (params.query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
          const matched =
            terms.length === 0
              ? toolCatalog
              : toolCatalog.filter((t) => {
                  const haystack = `${t.name}\n${t.description}`.toLowerCase();
                  return terms.every((term) => haystack.includes(term));
                });
          const header =
            terms.length === 0
              ? `Available Datadog tools (${String(tools.length)}):`
              : `Datadog tools matching "${params.query ?? ''}" (${String(matched.length)} of ${String(tools.length)}):`;
          const followUp =
            matched.length === 0
              ? 'No tools matched. Broaden the query or call again with no query to see the full catalog.'
              : 'Call the datadog tool again with { "tool": "<name>", "args": { ... } } to invoke one.';
          return {
            content: [{ type: 'text', text: lines(header, JSON.stringify(matched, undefined, 2), '', followUp) }],
            details: {
              state: 'listed',
              count: matched.length,
              total: tools.length,
              query: params.query,
              tools: matched,
            },
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Failed to list Datadog tools: ${errorMessage(error)}` }],
            details: { state: 'error' },
          };
        }
      }

      if (!params.tool) {
        return {
          content: [
            { type: 'text', text: 'Provide either { "list": true } or { "tool": "<name>", "args": { ... } }.' },
          ],
          details: { state: 'bad-input' },
        };
      }

      try {
        // Custom executor if override
        const executor = subtools[params.tool]?.execute;
        if (executor) {
          return await executor(toolCallId, params, signal, onUpdate, ctx, mcp);
        }

        const result = await mcp.callTool(params.tool, params.args);
        // SDK's CallToolResult.content is always an array. Concatenate text
        // blocks for readable output; fall back to JSON for non-text content
        // (images, embedded resources) so nothing is silently dropped.
        const text = result.content.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
        return {
          content: [{ type: 'text', text }],
          details: {
            state: 'called',
            tool: params.tool,
            isError: result.isError ?? false,
            structuredContent: result.structuredContent,
          },
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Datadog tool "${params.tool}" failed: ${errorMessage(error)}` }],
          details: { state: 'error', tool: params.tool },
        };
      }
    },
  });
