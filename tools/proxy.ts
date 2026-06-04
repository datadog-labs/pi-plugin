// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { loadServerState } from '../config.js';
import { lines } from '#shared/text';
import type { ToolDeps, ToolResult } from './types.js';

// One proxy tool, lazily aware of upstream MCP tools. Matches Pi's "token-
// efficient by default" philosophy: the agent pays ~200 tokens for this single
// definition regardless of how many Datadog tools the server exposes. `list:
// true` returns the full catalog; `query: "<keywords>"` filters that catalog
// by case-insensitive substring match across name + description.
export const createDatadogProxy = ({ mcp, mcpFile, cwd, globalDir }: ToolDeps) =>
  defineTool({
    name: 'datadog',
    label: 'Datadog',
    description: lines(
      'Query the Datadog observability MCP server (logs, metrics, traces, dashboards, monitors, RUM, security, and more).',
      'Always call this tool first to discover available Datadog tools — use { "list": true } for the full catalog,',
      'or { "query": "<keywords>" } to narrow when intent is clear (e.g. "logs", "monitor alert"). If a narrow query',
      'returns no useful matches, broaden it or call again with no query. Then invoke a tool with',
      '{ "tool": "<name>", "args": { ... } }. If this returns a not-setup error, ask the user to run the ddsetup tool.',
    ),
    parameters: Type.Object({
      list: Type.Optional(Type.Boolean({ description: 'List available Datadog tools and their schemas.' })),
      query: Type.Optional(
        Type.String({
          description:
            'Optional space-separated keywords. When listing, only tools whose name or description match every keyword (case-insensitive) are returned. Passing `query` alone implies list mode.',
        }),
      ),
      tool: Type.Optional(Type.String({ description: 'Name of the Datadog tool to call (from list).' })),
      args: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: 'Arguments object for the tool.' })),
    }),
    async execute(_toolCallId, params): Promise<ToolResult> {
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
            content: [{ type: 'text', text: `Failed to list Datadog tools: ${(error as Error).message}` }],
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
        const result = await mcp.callTool(params.tool, params.args);
        // SDK's CallToolResult.content is always an array. Concatenate text
        // blocks for readable output; fall back to JSON for non-text content
        // (images, embedded resources) so nothing is silently dropped.
        const text = result.content.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
        return {
          content: [{ type: 'text', text }],
          details: { state: 'called', tool: params.tool, isError: result.isError ?? false },
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Datadog tool "${params.tool}" failed: ${(error as Error).message}` }],
          details: { state: 'error', tool: params.tool },
        };
      }
    },
  });
