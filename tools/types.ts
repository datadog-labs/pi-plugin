// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import type { McpClient } from '../mcp-client.js';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
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

export type ToolResult = AgentToolResult<Record<string, unknown>>;
