// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

// Small pure string helpers used across the plugin.

// `lines(...)` joins parts with newlines, dropping false/null/undefined entries
// while preserving empty strings as intentional blank-line separators. Replaces
// the `[...].filter(Boolean).join('\n')` pattern, which confusingly swallows
// legitimate blank lines along with the falsy placeholders.
export const lines = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter((p): p is string => typeof p === 'string').join('\n');

export const parseToolsetList = (toolsets: string): string[] =>
  toolsets
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

export const formatToolsetList = (toolsets: string[]): string =>
  toolsets.length > 0 ? toolsets.join(',') : '(server defaults)';
