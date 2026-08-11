// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import { DynamicBorder, type ExtensionContext, type Theme } from '@earendil-works/pi-coding-agent';
import {
  Container,
  Input,
  Key,
  matchesKey,
  SelectList,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type SelectItem,
} from '@earendil-works/pi-tui';

import {
  fuzzyFilterByText,
  getDefaultToolsetNames,
  getEffectiveToolsetNames,
  getGenerallyAvailableToolsetNames,
  normalizeToolsetConfig,
  toolsetSearchText,
  type ToolsetCatalogEntry,
} from '../toolsets.js';
import { checkActivation as vizCheckActivation } from '../viz/compat.js';
import { SITE_TO_DOMAIN, domainToSite } from '#shared/site';
import { parseToolsetList } from '#shared/text';

const CUSTOM_SITE = '__custom__';
const MAX_VISIBLE_TOOLSETS = 12;

export const pickDatadogSite = async (ctx: ExtensionContext, currentDomain?: string): Promise<string | undefined> => {
  if (ctx.mode !== 'tui') return undefined;

  const currentSite = currentDomain ? domainToSite(currentDomain) : undefined;
  const items: SelectItem[] = [...SITE_TO_DOMAIN.entries()].map(([site, domain]) => ({
    value: site,
    label: `${site.toUpperCase()}${site === currentSite ? ' (current)' : ''}`,
    description: domain,
  }));

  items.push({
    value: CUSTOM_SITE,
    label: currentDomain && !currentSite ? 'Custom MCP domain / URL (current)' : 'Custom MCP domain / URL',
    description: currentDomain && !currentSite ? currentDomain : 'Use a non-standard MCP domain or Datadog URL',
  });

  const choice = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
    container.addChild(new Text(theme.fg('accent', theme.bold('Select Datadog Site')), 1, 0));

    const selectList = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (text) => theme.fg('accent', text),
      selectedText: (text) => theme.fg('accent', text),
      description: (text) => theme.fg('muted', text),
      scrollInfo: (text) => theme.fg('dim', text),
      noMatch: (text) => theme.fg('warning', text),
    });
    selectList.onSelect = (item) => {
      done(item.value);
    };
    selectList.onCancel = () => {
      done(null);
    };
    container.addChild(selectList);
    container.addChild(new Text(theme.fg('dim', '↑↓ navigate • enter select • esc cancel'), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  if (!choice) return undefined;
  if (choice !== CUSTOM_SITE) return choice;

  const custom = await ctx.ui.input('Custom Datadog MCP domain or URL', currentDomain ?? 'mcp.datadoghq.com');
  const trimmed = custom?.trim();
  return trimmed || undefined;
};

type ToolsetRow =
  | { kind: 'defaults'; description: string }
  | { kind: 'all'; description: string }
  | { kind: 'toolset'; entry: ToolsetCatalogEntry; description: string };

type ToolsetPickerOptions = {
  theme: Theme;
  catalog: readonly ToolsetCatalogEntry[];
  currentToolsets: string;
  done: (result: string | null) => void;
  requestRender: () => void;
};

class ToolsetPicker implements Component, Focusable {
  private readonly theme: Theme;
  private readonly catalog: readonly ToolsetCatalogEntry[];
  private readonly done: (result: string | null) => void;
  private readonly requestRender: () => void;
  private readonly rows: ToolsetRow[];
  private readonly defaults: string[];
  private readonly gaToolsets: string[];
  private readonly selection: Set<string>;
  private readonly searchInput = new Input();
  private selectedIndex = 0;
  private usingServerDefaults: boolean;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor({ theme, catalog, currentToolsets, done, requestRender }: ToolsetPickerOptions) {
    this.theme = theme;
    this.catalog = catalog;
    this.done = done;
    this.requestRender = requestRender;
    this.defaults = getDefaultToolsetNames(catalog);
    this.gaToolsets = getGenerallyAvailableToolsetNames(catalog);
    this.usingServerDefaults = parseToolsetList(currentToolsets).length === 0;
    this.selection = new Set(getEffectiveToolsetNames(currentToolsets, catalog));
    const defaultSuffix = this.defaults.length > 0 ? ` (currently: ${this.defaults.join(', ')})` : '';
    this.rows = [
      { kind: 'defaults', description: `Let the Datadog MCP server choose its default toolsets${defaultSuffix}.` },
      {
        kind: 'all',
        description:
          'Enable every generally available Datadog MCP toolset. Preview toolsets still need to be selected explicitly.',
      },
      ...catalog.map((entry) => ({
        kind: 'toolset' as const,
        entry,
        description: entry.description || 'No description available from the Datadog MCP server.',
      })),
    ];
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  handleInput(data: string): void {
    const visibleRows = this.visibleRows();

    if (matchesKey(data, Key.up)) {
      if (visibleRows.length > 0) {
        this.selectedIndex = this.selectedIndex === 0 ? visibleRows.length - 1 : this.selectedIndex - 1;
      }
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.down)) {
      if (visibleRows.length > 0) {
        this.selectedIndex = this.selectedIndex === visibleRows.length - 1 ? 0 : this.selectedIndex + 1;
      }
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.space)) {
      this.toggleSelectedRow();
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.done(this.currentConfig());
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.done(null);
      return;
    }

    const previousSearch = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    if (this.searchInput.getValue() !== previousSearch) {
      this.selectedIndex = 0;
    }
    this.clampSelectedIndex();
    this.requestRender();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const normalized = this.currentConfig();
    const currentMode = normalized ? 'Using an explicit toolset list' : 'Using server defaults';
    const selectedLabel = normalized || '(server defaults)';
    const visibleRows = this.visibleRows();

    lines.push(this.theme.fg('accent', this.theme.bold('Configure Datadog Toolsets')));
    lines.push(this.theme.fg('dim', `${currentMode}: ${selectedLabel}`));
    lines.push(this.renderSearch(width));
    lines.push('');

    if (visibleRows.length === 0) {
      lines.push(this.theme.fg('warning', '  No matching toolsets'));
      lines.push('');
      lines.push(this.helpLine());
      return lines.map((line) => truncateToWidth(line, width));
    }

    const { start, end } = this.visibleRange(visibleRows.length);
    const labelWidth = this.labelWidth(visibleRows);
    for (let i = start; i < end; i++) {
      const row = visibleRows[i];
      lines.push(this.renderRow(row, i === this.selectedIndex, labelWidth, width));
    }

    if (start > 0 || end < visibleRows.length) {
      lines.push(this.theme.fg('dim', `  (${String(this.selectedIndex + 1)}/${String(visibleRows.length)})`));
    }

    const selected = visibleRows[this.selectedIndex];
    lines.push('');
    for (const line of wrapTextWithAnsi(this.describeRow(selected), Math.max(1, width - 4))) {
      lines.push(this.theme.fg('muted', `  ${line}`));
    }

    lines.push('');
    lines.push(this.helpLine());

    return lines.map((line) => truncateToWidth(line, width));
  }

  private visibleRows(): ToolsetRow[] {
    return fuzzyFilterByText(this.rows, this.searchInput.getValue(), (row) => {
      if (row.kind === 'defaults') return `server defaults default ${this.defaults.join(' ')} ${row.description}`;
      if (row.kind === 'all')
        return `all ga generally available every toolset ${this.gaToolsets.join(' ')} ${row.description}`;
      return toolsetSearchText(row.entry);
    });
  }

  private clampSelectedIndex(): void {
    const visibleRows = this.visibleRows();
    if (visibleRows.length === 0) {
      this.selectedIndex = 0;
      return;
    }
    this.selectedIndex = Math.min(Math.max(0, this.selectedIndex), visibleRows.length - 1);
  }

  private renderSearch(width: number): string {
    const label = 'Search ';
    const inputWidth = Math.max(1, width - visibleWidth(label));
    const inputLine = this.searchInput.render(inputWidth)[0];
    return `${this.theme.fg('dim', label)}${inputLine}`;
  }

  private helpLine(): string {
    return this.theme.fg('dim', 'type to fuzzy search • ↑↓ navigate • space toggle/reset • enter apply • esc cancel');
  }

  private visibleRange(totalRows: number): { start: number; end: number } {
    const visible = Math.min(totalRows, MAX_VISIBLE_TOOLSETS);
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(visible / 2), totalRows - visible));
    return { start, end: Math.min(start + visible, totalRows) };
  }

  private labelWidth(rows: readonly ToolsetRow[]): number {
    const widest = rows.reduce((max, row) => Math.max(max, visibleWidth(this.rowLabel(row))), 0);
    return Math.min(32, Math.max(12, widest));
  }

  private renderRow(row: ToolsetRow, isSelected: boolean, labelWidth: number, width: number): string {
    const prefix = isSelected ? this.theme.fg('accent', '→ ') : '  ';
    const label = this.rowLabel(row);
    const paddedLabel = `${truncateToWidth(label, labelWidth, '')}${' '.repeat(
      Math.max(0, labelWidth - visibleWidth(label)),
    )}`;
    const value = this.rowValue(row);
    const styledLabel = isSelected ? this.theme.fg('accent', paddedLabel) : paddedLabel;
    const styledValue =
      value === 'enabled' || value === 'on' ? this.theme.fg('success', value) : this.theme.fg('muted', value);

    return truncateToWidth(`${prefix}${styledLabel}  ${styledValue}`, width);
  }

  private rowLabel(row: ToolsetRow): string {
    if (row.kind === 'defaults') return 'Use server defaults';
    if (row.kind === 'all') return 'All GA toolsets';
    const badges = [row.entry.isDefault && 'default', row.entry.isPreview && 'preview'].filter(Boolean).join(', ');
    return badges ? `${row.entry.name} (${badges})` : row.entry.name;
  }

  private rowValue(row: ToolsetRow): string {
    if (row.kind === 'defaults') return this.currentConfig() ? 'off' : 'on';
    if (row.kind === 'all') return parseToolsetList(this.currentConfig()).includes('all') ? 'on' : 'off';
    return this.selection.has(row.entry.name) ? 'enabled' : 'disabled';
  }

  private describeRow(row: ToolsetRow): string {
    if (row.kind === 'defaults' || row.kind === 'all') return row.description;
    const defaultNote = row.entry.isDefault ? ' Default toolset.' : '';
    const previewNote = row.entry.isPreview ? ' Preview toolset; access may require enablement.' : '';
    const piSpecificNote =
      row.entry.name === 'visualizations' && vizCheckActivation().ok
        ? ' - Adds an interactive chart panel and inline screenshots in the terminal.'
        : '';
    return `${row.description}${piSpecificNote}${defaultNote}${previewNote}`;
  }

  private toggleSelectedRow(): void {
    const visibleRows = this.visibleRows();
    if (visibleRows.length === 0) return;
    const row = visibleRows[this.selectedIndex];

    if (row.kind === 'defaults') {
      this.usingServerDefaults = true;
      this.selection.clear();
      for (const name of this.defaults) this.selection.add(name);
      return;
    }

    if (row.kind === 'all') {
      this.usingServerDefaults = false;
      this.selection.clear();
      for (const name of this.gaToolsets) this.selection.add(name);
      return;
    }

    this.usingServerDefaults = false;
    if (this.selection.has(row.entry.name)) {
      this.selection.delete(row.entry.name);
    } else {
      this.selection.add(row.entry.name);
    }
  }

  private currentConfig(): string {
    return this.usingServerDefaults ? '' : normalizeToolsetConfig([...this.selection], this.catalog);
  }
}

export const pickToolsets = async (
  ctx: ExtensionContext,
  catalog: readonly ToolsetCatalogEntry[],
  currentToolsets: string,
): Promise<string | null | undefined> => {
  if (ctx.mode !== 'tui') return undefined;

  const currentEffective = getEffectiveToolsetNames(currentToolsets, catalog);
  const next = await ctx.ui.custom<string | null>(
    (tui, theme, _keybindings, done) =>
      new ToolsetPicker({
        theme,
        catalog,
        currentToolsets,
        done,
        requestRender: () => {
          tui.requestRender();
        },
      }),
  );

  if (next === null) return null;

  const nextEffective = getEffectiveToolsetNames(next, catalog);
  if (currentEffective.includes('core') && !nextEffective.includes('core')) {
    const confirmed = await ctx.ui.confirm(
      'Remove core toolset?',
      'The core toolset provides essential Datadog MCP functionality that most workflows depend on. Continue without it?',
    );
    if (!confirmed) return null;
  }

  return next;
};
