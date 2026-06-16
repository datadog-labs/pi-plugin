// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import { type AgentToolResult, defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { type ConfigScope, loadScopeConfig, persistConfig } from '../config.js';
import type { AuthMode } from '../mcp-client.js';
import { SITE_TABLE, isKnownDomain, resolveSiteToDomain } from '#shared/site';
import { lines } from '#shared/text';
import { pickDatadogSite } from './tui.js';
import type { ToolDeps } from './types.js';

export type DdsetupDetails =
  | { state: 'already-configured'; scope: ConfigScope }
  | { state: 'awaiting-site' }
  | { state: 'bad-site' }
  | { state: 'configured'; domain: string; scope: ConfigScope; authMode: AuthMode };

export type DdsetupResult = AgentToolResult<DdsetupDetails>;

export const createDdsetup = ({ mcp, urls, mcpFile, mcpEnabledToolsets, cwd, globalDir }: ToolDeps) =>
  defineTool({
    name: 'ddsetup',
    label: 'Datadog Setup',
    description: lines(
      'Set up the Datadog MCP server for the first time.',
      'Run this when Datadog tools are not available or the MCP server has not been configured.',
      'Accepts a Datadog site code (us1, us3, us5, eu, ap1, ap2), a Datadog URL, or any MCP domain hostname.',
      "If the user's Datadog site is not in the standard list, ask them for the MCP domain to use.",
      'Setup is global by default (shared across all projects). Pass scope "project" only if the user explicitly wants this repo to use a different Datadog site than their global default.',
    ),
    parameters: Type.Object({
      site: Type.Optional(
        Type.String({
          description:
            'Datadog site code (us1, us3, us5, eu, ap1, ap2), a Datadog URL, or any MCP domain hostname provided by the user. In Pi TUI mode, omit this to show an interactive site picker.',
        }),
      ),
      scope: Type.Optional(
        Type.Union([Type.Literal('global'), Type.Literal('project')], {
          description:
            'Where to store the config. "global" (default) applies to every project; "project" writes a per-repo override at .pi/datadog.json. OAuth sign-in is always shared globally per domain.',
        }),
      ),
    }),
    async execute(...args): Promise<DdsetupResult> {
      const [, params, , , ctx] = args;
      const scope: ConfigScope = params.scope ?? 'global';
      const existing = await loadScopeConfig(cwd, globalDir, mcpFile, scope);

      if (existing) {
        return {
          content: [
            {
              type: 'text',
              text: lines(
                `The Datadog MCP server is already configured for the ${scope} scope.`,
                `Current domain: ${existing.domain}`,
                'To change the domain or troubleshoot, use the ddconfig tool.',
              ),
            },
          ],
          details: { state: 'already-configured', scope },
        };
      }

      const site = params.site ?? (await pickDatadogSite(ctx));
      if (!site) {
        return {
          content: [{ type: 'text', text: lines('Choose a Datadog site to configure the MCP server:', SITE_TABLE) }],
          details: { state: 'awaiting-site' },
        };
      }

      const domain = resolveSiteToDomain(site);
      if (!domain) {
        return {
          content: [
            {
              type: 'text',
              text: lines(
                `Could not resolve "${site}" to a Datadog MCP domain.`,
                '',
                'Available sites:',
                SITE_TABLE,
                '',
                'You can also provide an MCP domain directly (e.g. mcp.datadoghq.com).',
              ),
            },
          ],
          details: { state: 'bad-site' },
        };
      }

      const unknownDomainNote =
        !isKnownDomain(domain) &&
        `Note: "${domain}" is not a known Datadog MCP domain. If the plugin fails to connect, re-run ddsetup with a site code from the list.`;

      const config = { domain, toolsets: mcpEnabledToolsets };
      await persistConfig(cwd, globalDir, mcpFile, scope, config);
      mcp.setUrl(urls.build(domain, config.toolsets));

      const scopeNote =
        scope === 'project'
          ? 'Stored as a project override at .pi/datadog.json (applies to this repo only).'
          : 'Stored globally — this applies to every project.';

      const authNote =
        mcp.authMode === 'oauth'
          ? 'The next datadog tool call will open your browser to sign in to Datadog. Sign-in is shared across all projects for this domain.'
          : 'Using DD_API_KEY + DD_APPLICATION_KEY from the environment for authentication.';

      return {
        content: [
          {
            type: 'text',
            text: lines(
              `The Datadog MCP server has been configured with domain: ${domain}`,
              unknownDomainNote,
              scopeNote,
              '',
              authNote,
              'Continue with the user\'s original request — call the datadog tool with { "query": "<keywords>" } if their intent has clear keywords (e.g. "logs", "monitors"), or { "list": true } to browse the full catalog.',
            ),
          },
        ],
        details: { state: 'configured', domain, scope, authMode: mcp.authMode },
      };
    },
  });
