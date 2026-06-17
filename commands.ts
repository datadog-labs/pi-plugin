// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

import type { ConfigScope } from './config.js';
import { runDdconfig, type DdconfigParams } from './tools/ddconfig.js';
import { runDdsetup, type DdsetupParams } from './tools/ddsetup.js';
import { runDdtoolsets, type DdtoolsetsParams } from './tools/ddtoolsets.js';
import type { ToolDeps } from './tools/types.js';
import { lines } from '#shared/text';

export type CommandParseResult<T> = { ok: true; params: T } | { ok: false; error: string; usage: string };

export type DdCommandRequest =
  | { subcommand: 'menu' }
  | { subcommand: 'setup'; params: DdsetupParams }
  | { subcommand: 'configure'; params: DdconfigParams }
  | { subcommand: 'toolsets'; params: DdtoolsetsParams };

type TokenizeResult = { ok: true; tokens: string[] } | { ok: false; error: string };
type NotificationType = 'info' | 'warning' | 'error';

const DD_COMMAND_NAME = 'datadog';
const DD_COMMAND = `/${DD_COMMAND_NAME}`;
const DD_USAGE = `Usage: ${DD_COMMAND} [setup|configure|toolsets]`;
const DD_SETUP_USAGE = `Usage: ${DD_COMMAND} setup [site|mcp-domain] [--global|--project]`;
const DD_CONFIGURE_USAGE = `Usage: ${DD_COMMAND} configure [site|mcp-domain]`;
const DD_TOOLSETS_USAGE = `Usage: ${DD_COMMAND} toolsets`;

const DD_HELP = lines(
  DD_USAGE,
  '',
  'Commands:',
  `  ${DD_COMMAND} setup [site|mcp-domain] [--global|--project]  Configure the Datadog MCP site`,
  `  ${DD_COMMAND} configure [site|mcp-domain]                    Change the configured Datadog MCP site`,
  `  ${DD_COMMAND} toolsets                                       Open the Datadog toolset picker`,
  '',
  'Examples:',
  `  ${DD_COMMAND} setup us1`,
  `  ${DD_COMMAND} setup eu --project`,
  `  ${DD_COMMAND} configure ap1`,
  `  ${DD_COMMAND} toolsets`,
  '',
  `Run ${DD_COMMAND} with no arguments to choose from a menu.`,
);

const DD_MENU_SETUP = 'Setup Datadog MCP site';
const DD_MENU_CONFIGURE = 'Change Datadog MCP site';
const DD_MENU_TOOLSETS = 'Configure Datadog toolsets';

const DD_SUBCOMMAND_COMPLETIONS = [
  { value: 'setup', label: 'setup', description: 'Configure the Datadog MCP site' },
  { value: 'configure', label: 'configure', description: 'Change the configured Datadog MCP site' },
  { value: 'toolsets', label: 'toolsets', description: 'Open the Datadog toolset picker' },
];

const tokenizeCommandArgs = (args: string): TokenizeResult => {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (const char of args.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += '\\';
  if (quote) return { ok: false, error: 'Unclosed quote in command arguments.' };
  if (current) tokens.push(current);

  return { ok: true, tokens };
};

const parseError = <T>(usage: string, error: string): CommandParseResult<T> => ({ ok: false, error, usage });

const isHelpToken = (token: string): boolean => token === '--help' || token === '-h' || token === 'help';

const parseTokens = <T>(
  args: string,
  usage: string,
  parse: (tokens: string[]) => CommandParseResult<T>,
): CommandParseResult<T> => {
  const tokenized = tokenizeCommandArgs(args);
  if (!tokenized.ok) return parseError(usage, tokenized.error);
  if (tokenized.tokens.some(isHelpToken)) return parseError(usage, usage);
  return parse(tokenized.tokens);
};

const parseScopeValue = (value: string, usage: string): CommandParseResult<ConfigScope> => {
  if (value === 'global' || value === 'project') return { ok: true, params: value };
  return parseError(usage, `Invalid scope "${value}". Expected "global" or "project".`);
};

const parseSetupTokens = (tokens: string[]): CommandParseResult<DdsetupParams> => {
  let site: string | undefined;
  let scope: ConfigScope | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === '--global') {
      scope = 'global';
      continue;
    }

    if (token === '--project') {
      scope = 'project';
      continue;
    }

    if (token === '--scope') {
      const next = tokens[index + 1];
      if (!next) return parseError(DD_SETUP_USAGE, 'Missing value for --scope. Expected "global" or "project".');
      const parsed = parseScopeValue(next, DD_SETUP_USAGE);
      if (!parsed.ok) return parsed;
      scope = parsed.params;
      index += 1;
      continue;
    }

    if (token.startsWith('--scope=')) {
      const parsed = parseScopeValue(token.slice('--scope='.length), DD_SETUP_USAGE);
      if (!parsed.ok) return parsed;
      scope = parsed.params;
      continue;
    }

    if (token.startsWith('-')) return parseError(DD_SETUP_USAGE, `Unknown option "${token}".`);
    if (site)
      return parseError(DD_SETUP_USAGE, `Unexpected argument "${token}". Only one site or MCP domain is accepted.`);
    site = token;
  }

  const params: DdsetupParams = {};
  if (site) params.site = site;
  if (scope) params.scope = scope;
  return { ok: true, params };
};

const parseConfigureTokens = (tokens: string[]): CommandParseResult<DdconfigParams> => {
  if (tokens.length > 1) return parseError(DD_CONFIGURE_USAGE, `Unexpected argument "${tokens[1]}".`);

  if (tokens.length === 0) return { ok: true, params: { action: 'change-site' } };

  const site = tokens[0];
  if (site.startsWith('-')) return parseError(DD_CONFIGURE_USAGE, `Unknown option "${site}".`);
  return { ok: true, params: { action: 'change-site', site } };
};

const parseToolsetsTokens = (tokens: string[]): CommandParseResult<DdtoolsetsParams> => {
  if (tokens.length > 0) return parseError(DD_TOOLSETS_USAGE, `Unexpected argument "${tokens[0]}".`);
  return { ok: true, params: { action: 'configure' } };
};

export const parseDdCommandArgs = (args: string): CommandParseResult<DdCommandRequest> =>
  parseTokens(args, DD_USAGE, (tokens) => {
    const [rawSubcommand, ...rest] = tokens;
    if (!rawSubcommand) return { ok: true, params: { subcommand: 'menu' } };

    const subcommand = rawSubcommand.toLowerCase();
    if (subcommand === 'setup') {
      const parsed = parseSetupTokens(rest);
      return parsed.ok ? { ok: true, params: { subcommand: 'setup', params: parsed.params } } : parsed;
    }

    if (subcommand === 'configure' || subcommand === 'config') {
      const parsed = parseConfigureTokens(rest);
      return parsed.ok ? { ok: true, params: { subcommand: 'configure', params: parsed.params } } : parsed;
    }

    if (subcommand === 'toolsets' || subcommand === 'toolset' || subcommand === 'tools') {
      const parsed = parseToolsetsTokens(rest);
      return parsed.ok ? { ok: true, params: { subcommand: 'toolsets', params: parsed.params } } : parsed;
    }

    return parseError(DD_USAGE, `Unknown Datadog command "${rawSubcommand}".`);
  });

const resultText = <TDetails>(result: AgentToolResult<TDetails>): string =>
  result.content
    .filter((content): content is { type: 'text'; text: string } => content.type === 'text')
    .map((content) => content.text)
    .join('\n');

const resultState = (details: unknown): string | undefined => {
  if (typeof details !== 'object' || details === null || !('state' in details)) return undefined;
  const state = (details as { state?: unknown }).state;
  return typeof state === 'string' ? state : undefined;
};

const notificationType = (state: string | undefined): NotificationType => {
  if (
    state === 'error' ||
    state === 'bad-site' ||
    state === 'not-setup' ||
    state === 'not-tui' ||
    state === 'rejected'
  ) {
    return 'error';
  }

  if (state === 'awaiting-site' || state === 'cancelled' || state === 'no-op') return 'warning';
  return 'info';
};

const notifyResult = <TDetails>(ctx: ExtensionCommandContext, result: AgentToolResult<TDetails>): void => {
  const text = resultText(result);
  ctx.ui.notify(text || 'Done.', notificationType(resultState(result.details)));
};

const notifyParseError = (ctx: ExtensionCommandContext, result: { error: string; usage: string }): void => {
  const text = result.error === result.usage ? DD_HELP : lines(result.error, '', DD_HELP);
  ctx.ui.notify(text, 'error');
};

const menuChoiceToRequest = (choice: string | undefined): DdCommandRequest | undefined => {
  if (choice === DD_MENU_SETUP) return { subcommand: 'setup', params: {} };
  if (choice === DD_MENU_CONFIGURE) return { subcommand: 'configure', params: { action: 'change-site' } };
  if (choice === DD_MENU_TOOLSETS) return { subcommand: 'toolsets', params: { action: 'configure' } };
  return undefined;
};

const authenticateAfterSetup = async (deps: ToolDeps, ctx: ExtensionCommandContext): Promise<void> => {
  ctx.ui.notify(
    deps.mcp.authMode === 'oauth'
      ? 'Opening Datadog sign-in. Complete the browser flow to finish setup.'
      : 'Checking the Datadog MCP connection with DD_API_KEY + DD_APPLICATION_KEY.',
    'info',
  );

  try {
    const tools = await deps.mcp.listTools();
    ctx.ui.notify(`Datadog MCP connection ready. Loaded ${String(tools.length)} tools.`, 'info');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Datadog MCP sign-in or connection check failed: ${message}`, 'error');
  }
};

const executeDdCommand = async (deps: ToolDeps, request: DdCommandRequest, ctx: ExtensionCommandContext) => {
  if (request.subcommand === 'menu') {
    const choice = await ctx.ui.select('Datadog', [DD_MENU_SETUP, DD_MENU_CONFIGURE, DD_MENU_TOOLSETS]);
    const selected = menuChoiceToRequest(choice);
    if (!selected) return;
    await executeDdCommand(deps, selected, ctx);
    return;
  }

  if (request.subcommand === 'setup') {
    const result = await runDdsetup(deps, request.params, ctx, { hasImmediateAuthentication: true });
    notifyResult(ctx, result);
    if (result.details.state === 'configured' || result.details.state === 'already-configured') {
      await authenticateAfterSetup(deps, ctx);
    }
    return;
  }

  if (request.subcommand === 'configure') {
    notifyResult(ctx, await runDdconfig(deps, request.params, ctx));
    return;
  }

  notifyResult(ctx, await runDdtoolsets(deps, request.params, ctx));
};

export const registerDatadogCommands = (pi: ExtensionAPI, deps: ToolDeps): void => {
  pi.registerCommand(DD_COMMAND_NAME, {
    description: `Configure Datadog MCP (${DD_COMMAND} setup, ${DD_COMMAND} configure, ${DD_COMMAND} toolsets)`,
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trimStart().toLowerCase();
      if (normalized.includes(' ')) return null;
      const matches = DD_SUBCOMMAND_COMPLETIONS.filter((item) => item.value.startsWith(normalized));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const parsed = parseDdCommandArgs(args);
      if (!parsed.ok) {
        notifyParseError(ctx, parsed);
        return;
      }

      await executeDdCommand(deps, parsed.params, ctx);
    },
  });
};
