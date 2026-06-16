// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

import type { McpClient } from './mcp-client.js';
import { parseToolsetList } from '#shared/text';

export const TOOLSETS_RESOURCE_URI = 'datadog://mcp/toolsets';

export type ToolsetCatalogEntry = {
  name: string;
  description: string;
  isDefault: boolean;
  isEnabled: boolean;
  isPreview: boolean;
};

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeName = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return NAME_RE.test(normalized) ? normalized : undefined;
};

const stringValue = (record: Record<string, unknown>, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
};

const booleanValue = (record: Record<string, unknown>, keys: readonly string[]): boolean => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', 'yes', 'enabled', 'default', 'preview'].includes(normalized)) return true;
    }
  }
  return false;
};

const stringListValue = (record: Record<string, unknown>, keys: readonly string[]): string[] => {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value.map(normalizeName).filter((name): name is string => Boolean(name));
    if (typeof value === 'string') return parseToolsetList(value).map((name) => name.toLowerCase());
  }
  return [];
};

const parseJsonEntry = (value: unknown, fallbackName?: string): ToolsetCatalogEntry | undefined => {
  if (!isRecord(value)) return undefined;

  const name =
    normalizeName(value.name) ?? normalizeName(value.id) ?? normalizeName(value.toolset) ?? normalizeName(fallbackName);
  if (!name) return undefined;

  const status = stringValue(value, ['status', 'state']);
  const statusWords = status?.toLowerCase() ?? '';
  const description = stringValue(value, ['description', 'summary', 'details']) ?? '';
  const isDefault = booleanValue(value, ['default', 'isDefault', 'is_default', 'defaultEnabled', 'default_enabled']);
  const isEnabled = booleanValue(value, ['enabled', 'isEnabled', 'is_enabled']) || statusWords.includes('enabled');
  const isPreview = booleanValue(value, ['preview', 'isPreview', 'is_preview']) || statusWords.includes('preview');

  return { name, description, isDefault, isEnabled, isPreview };
};

const parseJsonEntries = (value: unknown, fallbackName?: string): ToolsetCatalogEntry[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item) => parseJsonEntries(item));
  }

  if (!isRecord(value)) return [];

  const entry = parseJsonEntry(value, fallbackName);
  if (entry) return [entry];

  const toolsets = value.toolsets ?? value.availableToolsets ?? value.available_toolsets;
  if (Array.isArray(toolsets)) return parseJsonEntries(toolsets);

  if (isRecord(toolsets)) {
    return Object.entries(toolsets).flatMap(([name, nested]) => parseJsonEntries(nested, name));
  }

  const mappedEntries = Object.entries(value).flatMap(([name, nested]) => {
    if (!isRecord(nested)) return [];
    const nestedEntry = parseJsonEntry(nested, name);
    return nestedEntry ? [nestedEntry] : [];
  });
  if (mappedEntries.length > 0) return mappedEntries;

  return Object.values(value).flatMap((nested) => parseJsonEntries(nested));
};

const applyRootMetadata = (entries: ToolsetCatalogEntry[], root: unknown): ToolsetCatalogEntry[] => {
  if (!isRecord(root)) return entries;

  const defaultNames = new Set(
    stringListValue(root, ['defaults', 'defaultToolsets', 'default_toolsets', 'defaultEnabledToolsets']),
  );
  const enabledNames = new Set(stringListValue(root, ['enabled', 'enabledToolsets', 'enabled_toolsets']));

  return entries.map((entry) => ({
    ...entry,
    isDefault: entry.isDefault || defaultNames.has(entry.name),
    isEnabled: entry.isEnabled || enabledNames.has(entry.name),
  }));
};

const parseMarkdownCatalog = (text: string): ToolsetCatalogEntry[] => {
  const entries: ToolsetCatalogEntry[] = [];

  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[-*]\s+(?:`([a-z0-9][a-z0-9_-]*)`|([a-z0-9][a-z0-9_-]*))\s*:\s*(.*)$/i.exec(line);
    if (!match) continue;

    const name = normalizeName(match[1] || match[2]);
    if (!name) continue;

    const description = match[3].trim();
    const haystack = `${name} ${description}`.toLowerCase();
    entries.push({
      name,
      description,
      isDefault: haystack.includes('default'),
      isEnabled: haystack.includes('enabled'),
      isPreview: haystack.includes('preview'),
    });
  }

  return entries;
};

const mergeEntries = (entries: ToolsetCatalogEntry[]): ToolsetCatalogEntry[] => {
  const merged = new Map<string, ToolsetCatalogEntry>();

  for (const entry of entries) {
    const current = merged.get(entry.name);
    if (!current) {
      merged.set(entry.name, entry);
      continue;
    }

    merged.set(entry.name, {
      name: entry.name,
      description: current.description || entry.description,
      isDefault: current.isDefault || entry.isDefault,
      isEnabled: current.isEnabled || entry.isEnabled,
      isPreview: current.isPreview || entry.isPreview,
    });
  }

  return [...merged.values()];
};

export const parseToolsetCatalog = (text: string): ToolsetCatalogEntry[] => {
  const trimmed = text.trim();
  if (!trimmed) return [];

  try {
    const parsed: unknown = JSON.parse(trimmed);
    const entries = mergeEntries(applyRootMetadata(parseJsonEntries(parsed), parsed));
    if (entries.length > 0) return entries;
  } catch {
    // Fall through to markdown-ish parsing. The server resource is expected to
    // be structured, but keeping this tolerant makes the picker resilient to a
    // docs-style resource body.
  }

  return mergeEntries(parseMarkdownCatalog(text));
};

const fuzzyScore = (query: string, text: string): number | undefined => {
  if (query.length === 0) return 0;

  const substringIndex = text.indexOf(query);
  if (substringIndex !== -1) return substringIndex;

  let score = 0;
  let lastIndex = -1;
  for (const char of query) {
    const index = text.indexOf(char, lastIndex + 1);
    if (index === -1) return undefined;

    const gap = index - lastIndex - 1;
    score += gap === 0 ? 1 : gap + 3;
    lastIndex = index;
  }

  return score;
};

export const fuzzyFilterByText = <T>(items: readonly T[], query: string, getText: (item: T) => string): T[] => {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...items];

  return items
    .map((item, index) => {
      const text = getText(item).toLowerCase();
      let score = 0;
      for (const term of terms) {
        const termScore = fuzzyScore(term, text);
        if (termScore === undefined) return undefined;
        score += termScore;
      }
      return { item, index, score };
    })
    .filter((match): match is { item: T; index: number; score: number } => match !== undefined)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((match) => match.item);
};

export const toolsetSearchText = (entry: ToolsetCatalogEntry): string =>
  [
    entry.name,
    entry.description,
    entry.isDefault && 'default',
    entry.isEnabled && 'enabled',
    entry.isPreview && 'preview',
  ]
    .filter(Boolean)
    .join(' ');

export const filterToolsetCatalog = (catalog: readonly ToolsetCatalogEntry[], query: string): ToolsetCatalogEntry[] =>
  fuzzyFilterByText(catalog, query, toolsetSearchText);

export const getDefaultToolsetNames = (catalog: readonly ToolsetCatalogEntry[]): string[] => {
  const defaults = catalog.filter((entry) => entry.isDefault).map((entry) => entry.name);
  if (defaults.length > 0) return defaults;
  return catalog.some((entry) => entry.name === 'core') ? ['core'] : [];
};

export const getGenerallyAvailableToolsetNames = (catalog: readonly ToolsetCatalogEntry[]): string[] =>
  catalog.filter((entry) => !entry.isPreview).map((entry) => entry.name);

const expandToolsetNames = (names: readonly string[], catalog: readonly ToolsetCatalogEntry[]): string[] => {
  const availableNames = new Set(catalog.map((entry) => entry.name));
  const normalized: string[] = [];
  const add = (name: string): void => {
    if (!normalized.includes(name)) normalized.push(name);
  };

  for (const name of names.map((value) => value.toLowerCase())) {
    if (name === 'all') {
      for (const gaName of getGenerallyAvailableToolsetNames(catalog)) add(gaName);
      continue;
    }
    if (availableNames.has(name)) add(name);
  }

  return normalized;
};

export const getEffectiveToolsetNames = (toolsets: string, catalog: readonly ToolsetCatalogEntry[]): string[] => {
  const requested = parseToolsetList(toolsets).map((name) => name.toLowerCase());
  return requested.length === 0 ? getDefaultToolsetNames(catalog) : expandToolsetNames(requested, catalog);
};

const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
  const l = new Set(left);
  const r = new Set(right);
  return l.size === r.size && [...l].every((value) => r.has(value));
};

export const normalizeToolsetConfig = (
  selection: readonly string[],
  catalog: readonly ToolsetCatalogEntry[],
): string => {
  const normalized = expandToolsetNames(selection, catalog);
  if (sameSet(normalized, getDefaultToolsetNames(catalog))) return '';

  const gaNames = getGenerallyAvailableToolsetNames(catalog);
  if (gaNames.length > 0 && gaNames.every((name) => normalized.includes(name))) {
    const gaSet = new Set(gaNames);
    const extraNames = normalized.filter((name) => !gaSet.has(name));
    return ['all', ...extraNames].join(',');
  }

  return normalized.join(',');
};

const resourceText = (result: ReadResourceResult): string =>
  result.contents
    .map((content) => {
      if ('text' in content) return content.text;
      if ('blob' in content) return Buffer.from(content.blob, 'base64').toString('utf8');
      return '';
    })
    .filter(Boolean)
    .join('\n');

export const readToolsetCatalog = async (mcp: McpClient): Promise<ToolsetCatalogEntry[]> => {
  const result = await mcp.readResource(TOOLSETS_RESOURCE_URI);
  const catalog = parseToolsetCatalog(resourceText(result));
  if (catalog.length === 0) {
    throw new Error('The Datadog MCP toolset catalog did not contain any toolsets.');
  }
  return catalog;
};
