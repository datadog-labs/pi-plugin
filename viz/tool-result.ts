// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const SHOW_UI_TOOL_NAME = 'show_ui';

/** Tools whose top-level results Pi may forward to the ddviz host. */
export const VIZ_TOOL_NAMES = ['get_widget', 'visualize_tabular_data', SHOW_UI_TOOL_NAME] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Product views carry their rendering contract in result `_meta`. */
export const hasShowUIViewSpec = (result: CallToolResult): boolean => {
  const meta = result['_meta'];
  if (!isRecord(meta)) return false;

  const namespace = meta['datadog/show_ui'];
  return isRecord(namespace) && isRecord(namespace.view_spec);
};

export const isRenderableVizResult = (toolName: string, result: CallToolResult): boolean => {
  if (toolName === SHOW_UI_TOOL_NAME) {
    return !result.isError && (Boolean(result.structuredContent) || hasShowUIViewSpec(result));
  }
  return toolName === 'get_widget' || toolName === 'visualize_tabular_data' ? Boolean(result.structuredContent) : false;
};
