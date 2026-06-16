// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import { type Static, Type } from 'typebox';

import type { McpClient } from '../mcp-client.js';
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { UrlBuilder } from '#shared/url';

// Shared dependency record the entry file builds once and hands to each tool
// factory. Lives in `tools/` (not at the package root) so the entry module
// never imports from here — avoids an import cycle. Mirrors the convention
// used by plugins/opencode/tools/types.ts.
export type ToolDeps = {
  mcp: McpClient;
  urls: UrlBuilder;
  mcpName: string;
  mcpFile: string;
  mcpEnabledToolsets: string;
  // Current working directory — the project-override config lives at <cwd>/.pi/.
  cwd: string;
  // Global Datadog state dir (<agentDir>/datadog) — the default config and all
  // OAuth tokens live here so setup survives changing directories.
  globalDir: string;
};

export interface ProxyToolCatalogEntry {
  name: string;
  description: string;
  inputSchema: Tool['inputSchema'];
}

export const proxyParameters = Type.Object({
  list: Type.Optional(Type.Boolean({ description: 'List available Datadog tools and their schemas.' })),
  query: Type.Optional(
    Type.String({
      description:
        'Optional space-separated keywords. When listing, only tools whose name or description match every keyword (case-insensitive) are returned. Passing `query` alone implies list mode.',
    }),
  ),
  tool: Type.Optional(Type.String({ description: 'Name of the Datadog tool to call (from list).' })),
  args: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: 'Arguments object for the tool.' })),
});

export type ProxyDetails =
  | { state: 'not-setup' }
  | { state: 'bad-input' }
  | { state: 'listed'; count: number; total: number; query?: string; tools: ProxyToolCatalogEntry[] }
  | { state: 'error'; tool?: string }
  | {
      state: 'called';
      tool: string;
      isError: boolean;
      structuredContent?: CallToolResult['structuredContent'];
      // Free-form, subtool-owned render metadata.
      subtoolData?: unknown;
    };

export type ProxyToolResult = AgentToolResult<ProxyDetails>;

export type ProxyToolDefinition = ToolDefinition<typeof proxyParameters, ProxyDetails>;
export type SubtoolRenderCall = NonNullable<ProxyToolDefinition['renderCall']>;
export type SubtoolRenderResult = NonNullable<ProxyToolDefinition['renderResult']>;

// Mirrors ToolDefinition.execute: (toolCallId, params, signal, onUpdate, ctx),
// using the proxy params (so subtools read params.tool/params.args themselves)
// and Pi's ExtensionContext in its native slot, with the injected MCP client
// appended as the trailing argument.
export type SubtoolExecutor = (
  toolCallId: string,
  params: Static<typeof proxyParameters>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<ProxyDetails> | undefined,
  ctx: ExtensionContext,
  mcp: McpClient,
) => Promise<ProxyToolResult>;

export interface SubtoolConfig {
  renderCall?: SubtoolRenderCall;
  renderResult?: SubtoolRenderResult;
  execute?: SubtoolExecutor;
}
