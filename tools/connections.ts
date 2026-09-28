// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import { BorderedLoader, DynamicBorder, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Container, Input, Key, matchesKey, SelectList, Text, truncateToWidth } from '@earendil-works/pi-tui';
import type { SelectItem } from '@earendil-works/pi-tui';
import { isKnownDomain } from '#shared/site';
import { profileLabel, type Profile } from '../config.js';
import { errorMessage, SignInRequired } from '../connection-errors.js';
import type { Connections } from '../connections.js';
import { fuzzyFilterByText } from '../toolsets.js';
import { pickDatadogSite } from './tui.js';
import { resolveSiteToDomain } from '#shared/site';
import { runDdtoolsets } from './ddtoolsets.js';

// Wait for cancellation cleanup before restoring the menu. Otherwise a second
// login could race a still-running first attempt and its callback listener.
export const withConnectionProgress = async <T>(
  ctx: ExtensionCommandContext,
  message: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> => {
  const result = await ctx.ui.custom<{ ok: true; value: T } | { ok: false; error?: unknown }>(
    (tui, theme, _keys, done) => {
      const loader = new BorderedLoader(tui, theme, message);
      const disposal = new AbortController();
      const signal = AbortSignal.any([loader.signal, disposal.signal]);
      const dispose = loader.dispose.bind(loader);
      loader.dispose = () => {
        disposal.abort();
        dispose();
      };
      loader.onAbort = () => {
        /* loader.signal is aborted; operation owns cleanup */
      };
      void operation(signal).then(
        (value) => {
          done({ ok: true, value });
        },
        (error: unknown) => {
          done({ ok: false, error: signal.aborted ? undefined : error });
        },
      );
      return loader;
    },
  );
  if (!result.ok && result.error) ctx.ui.notify(errorMessage(result.error), 'error');
  return result;
};

type Choice = { action: 'select' | 'details'; id: string } | { action: 'add' };

export const pickOrganization = async (
  ctx: ExtensionCommandContext,
  profiles: Profile[],
  selected?: string | null,
): Promise<Choice | null> =>
  ctx.ui.custom<Choice | null>((tui, theme, _keys, done) => {
    const input = new Input();
    const items: SelectItem[] = profiles.map((profile) => ({
      value: profile.id,
      label: profileLabel(profile),
      description: `${profile.domain}${profile.id === selected ? ' · current' : ''}`,
    }));
    items.push({
      value: 'add',
      label: 'Connect another organization…',
      description: 'Sign in without replacing your saved connections',
    });
    const buildList = (visible: SelectItem[]) => {
      const next = new SelectList(visible, 9, {
        selectedPrefix: (text) => theme.fg('accent', text),
        selectedText: (text) => theme.fg('accent', text),
        description: (text) => theme.fg('muted', text),
        scrollInfo: (text) => theme.fg('dim', text),
        noMatch: (text) => theme.fg('warning', text),
      });
      next.onSelect = (item) => {
        done(item.value === 'add' ? { action: 'add' } : { action: 'select', id: item.value });
      };
      next.onCancel = () => {
        done(null);
      };
      return next;
    };
    let list = buildList(items);
    const rows = new Container();
    rows.addChild(list);
    const body = new Container();
    body.addChild(new DynamicBorder((text: string) => theme.fg('accent', text)));
    body.addChild(new Text(theme.fg('accent', theme.bold('Datadog organizations')), 1, 0));
    body.addChild(new Text('Search by organization or label', 1, 0));
    body.addChild(input);
    body.addChild(rows);
    body.addChild(new Text(theme.fg('dim', '↑↓ navigate · enter switch · tab details · esc close'), 1, 0));
    body.addChild(new DynamicBorder((text: string) => theme.fg('accent', text)));
    return {
      get focused() {
        return input.focused;
      },
      set focused(value: boolean) {
        input.focused = value;
      },
      render: (width: number) => body.render(width).map((line) => truncateToWidth(line, width)),
      invalidate() {
        body.invalidate();
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.tab)) {
          const item = list.getSelectedItem();
          if (item && item.value !== 'add') done({ action: 'details', id: item.value });
        } else if ([Key.up, Key.down, Key.enter, Key.escape].some((key) => matchesKey(data, key)))
          list.handleInput(data);
        else {
          input.handleInput(data);
          list = buildList([
            ...fuzzyFilterByText(
              items.slice(0, -1),
              input.getValue(),
              (item) => `${item.label} ${item.description ?? ''}`,
            ),
            items[items.length - 1],
          ]);
          rows.clear();
          rows.addChild(list);
        }
        tui.requestRender();
      },
    };
  });

const connect = async (
  connections: Connections,
  ctx: ExtensionCommandContext,
  existing?: Profile,
): Promise<boolean> => {
  let domain = existing?.domain;
  if (!domain) {
    const site = await pickDatadogSite(ctx);
    if (!site) return false;
    domain = resolveSiteToDomain(site);
    if (!domain) {
      ctx.ui.notify('Invalid Datadog site.', 'error');
      return false;
    }
    if (
      !isKnownDomain(domain) &&
      !(await ctx.ui.confirm(
        'Connect to a custom MCP server?',
        `Credentials will be used with https://${domain}. Only continue if you trust this server.`,
      ))
    )
      return false;
  }
  let kind = existing?.auth.kind;
  if (!kind && connections.hasEnvironmentKeys) {
    const choice = await ctx.ui.select('Connect to Datadog', ['Browser sign-in', 'Use API keys from the environment']);
    if (!choice) return false;
    kind = choice === 'Browser sign-in' ? 'oauth' : 'environment';
  }
  const authKind = kind ?? 'oauth';
  const target = domain;
  const activate = !existing || connections.selection === existing.id;
  const result = await withConnectionProgress(
    ctx,
    authKind === 'oauth' ? 'Complete Datadog sign-in in your browser…' : 'Verifying Datadog API keys…',
    async (signal) => {
      const profile = await connections.signIn(target, authKind, existing, signal);
      if (activate) await connections.select(profile.id, signal);
      return profile;
    },
  );
  if (!result.ok) return false;
  ctx.ui.notify(
    `${activate ? 'Connected' : 'Signed in'} to ${profileLabel(result.value)} · ${result.value.domain}`,
    'info',
  );
  return true;
};

const details = async (connections: Connections, ctx: ExtensionCommandContext, profile: Profile): Promise<void> => {
  const identity = profile.identity;
  const title = [
    profileLabel(profile),
    profile.domain,
    identity ? `Organization: ${identity.orgName} (${identity.orgUuid})` : 'Organization not yet verified',
    profile.auth.kind === 'oauth' ? 'Browser sign-in' : 'API keys from environment',
  ].join('\n');
  const choice = await ctx.ui.select(title, [
    'Use for this session',
    'Configure toolsets',
    'Use by default for new sessions',
    'Use for this project',
    'Rename',
    ...(profile.auth.kind === 'oauth' ? ['Sign in again', 'Sign out on this device'] : []),
    'Remove saved connection',
  ]);
  if (choice === 'Use for this session') await select(connections, ctx, profile);
  else if (choice === 'Configure toolsets') {
    if (
      connections.selection !== profile.id &&
      !(await ctx.ui.confirm('Switch organization?', `Switch to ${profileLabel(profile)} to configure its toolsets?`))
    )
      return;
    if (connections.selection !== profile.id) await connections.select(profile.id);
    const result = await runDdtoolsets({ connections }, { action: 'configure' }, ctx);
    ctx.ui.notify(
      result.content
        .filter((entry) => entry.type === 'text')
        .map((entry) => entry.text)
        .join('\n'),
      'info',
    );
  } else if (choice === 'Use by default for new sessions') await connections.setDefault(profile.id);
  else if (choice === 'Use for this project') {
    if (
      await ctx.ui.confirm(
        'Save project selection?',
        'Write this connection selection to .pi/datadog.json? Existing toolset overrides will be cleared.',
      )
    )
      await connections.useForProject(profile.id);
  } else if (choice === 'Rename') {
    const label = await ctx.ui.input('Optional connection label', profile.label ?? '');
    if (label !== undefined) await connections.rename(profile.id, label);
  } else if (choice === 'Sign in again') await connect(connections, ctx, profile);
  else if (
    choice === 'Sign out on this device' &&
    (await ctx.ui.confirm(
      'Sign out?',
      `This clears ${profileLabel(profile)} credentials for every Pi session on this device. Other connections are unchanged.`,
    ))
  )
    await connections.signOut(profile);
  else if (
    choice === 'Remove saved connection' &&
    (await ctx.ui.confirm(
      'Remove connection?',
      `Remove ${profileLabel(profile)} and its locally stored credentials? Sessions or projects selecting it will need another selection.`,
    ))
  )
    await connections.remove(profile);
};

const select = async (connections: Connections, ctx: ExtensionCommandContext, profile: Profile): Promise<void> => {
  await withConnectionProgress(ctx, `Connecting to ${profileLabel(profile)}…`, async (signal) => {
    try {
      await connections.select(profile.id, signal);
    } catch (error) {
      if (error instanceof SignInRequired)
        throw new Error('Sign-in required. Open this connection’s details and choose “Sign in again”.');
      throw error;
    }
  });
};

export const manageConnections = async (connections: Connections, ctx: ExtensionCommandContext): Promise<void> => {
  for (;;) {
    const registry = await connections.store.read();
    if (registry.profiles.length === 0) {
      await connect(connections, ctx);
      return;
    }
    if (registry.profiles.length > 1) {
      const choice = await pickOrganization(ctx, registry.profiles, connections.selection);
      if (!choice) return;
      if (choice.action === 'add') await connect(connections, ctx);
      else {
        const profile = registry.profiles.find((entry) => entry.id === choice.id)!;
        if (choice.action === 'select') {
          await select(connections, ctx, profile);
          return;
        }
        await details(connections, ctx, profile);
      }
      continue;
    }
    const profile = registry.profiles[0];
    const choice = await ctx.ui.select(`Datadog · ${profileLabel(profile)}\n${profile.domain}`, [
      'Configure toolsets',
      'Connection details',
      'Check connection',
      ...(profile.auth.kind === 'oauth' ? ['Sign in again'] : []),
      'Connect another organization',
    ]);
    if (!choice) return;
    if (choice === 'Configure toolsets') {
      const result = await runDdtoolsets({ connections }, { action: 'configure' }, ctx);
      ctx.ui.notify(
        result.content
          .filter((entry) => entry.type === 'text')
          .map((entry) => entry.text)
          .join('\n'),
        'info',
      );
    } else if (choice === 'Connection details') await details(connections, ctx, profile);
    else if (choice === 'Sign in again') await connect(connections, ctx, profile);
    else if (choice === 'Connect another organization') await connect(connections, ctx);
    else await select(connections, ctx, profile);
  }
};
