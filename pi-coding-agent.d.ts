// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

// Local ambient types for the subset of the @earendil-works/pi-coding-agent API
// we depend on. We don't take a runtime devDependency on the package because it
// transitively pulls in a flagged version of @mistralai/mistralai (MAL-2026-3432);
// at runtime Pi provides the implementation via its bundled virtual modules.
// Keeping these declarations in sync with upstream is a manual chore — see
// https://github.com/badlogic/pi-mono for the source of truth.

declare module '@earendil-works/pi-coding-agent' {
  import type { Static, TSchema } from 'typebox';

  export interface TextContent {
    type: 'text';
    text: string;
  }

  export interface AgentToolResult<TDetails = unknown> {
    content: TextContent[];
    details: TDetails;
    terminate?: boolean;
  }

  export interface AgentToolUpdateCallback<TDetails = unknown> {
    (partial: AgentToolResult<TDetails>): void;
  }

  export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
    name: string;
    label: string;
    description: string;
    parameters: TParams;
    execute(
      toolCallId: string,
      params: Static<TParams>,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
      ctx: unknown,
    ): Promise<AgentToolResult<TDetails>>;
  }

  export interface ExtensionAPI {
    registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void;
  }

  // Identity helper that locks in TParams from the literal `parameters` schema
  // so `execute`'s `params` is precisely typed (rather than the opaque default
  // `Static<TSchema>`). Mirrors `defineTool` from pi-mono.
  export function defineTool<TParams extends TSchema, TDetails = unknown>(
    tool: ToolDefinition<TParams, TDetails>,
  ): ToolDefinition<TParams, TDetails>;
}
