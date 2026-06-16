// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import { type AgentToolResult, defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { loadServerState, persistConfig } from '../config.js';
import { SITE_TABLE, domainToSite, isKnownDomain, resolveSiteToDomain } from '#shared/site';
import { lines } from '#shared/text';
import { pickDatadogSite } from './tui.js';
import type { ToolDeps } from './types.js';

export type DdconfigDetails =
  | { state: 'not-setup' }
  | { state: 'status'; domain: string }
  | { state: 'awaiting-site' }
  | { state: 'bad-site' }
  | { state: 'no-op' }
  | { state: 'changed'; domain: string }
  | { state: 'troubleshoot' };

export type DdconfigResult = AgentToolResult<DdconfigDetails>;

export const createDdconfig = ({ mcp, urls, mcpFile, cwd, globalDir }: ToolDeps) =>
  defineTool({
    name: 'ddconfig',
    label: 'Datadog Config',
    description: lines(
      'Configure or troubleshoot the Datadog MCP server.',
      'Use to view the current configuration, change the Datadog domain or site, or diagnose connection issues.',
    ),
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union([Type.Literal('status'), Type.Literal('change-site'), Type.Literal('troubleshoot')], {
          description: 'Action to perform. Omit to show current status.',
        }),
      ),
      site: Type.Optional(
        Type.String({
          description:
            'New Datadog site code (us1, us3, us5, eu, ap1, ap2), a Datadog URL, or any MCP domain hostname (for change-site action).',
        }),
      ),
    }),
    async execute(...args): Promise<DdconfigResult> {
      const [, params, , , ctx] = args;
      const state = await loadServerState(cwd, globalDir, mcpFile);
      if (state.kind === 'not-setup') {
        return {
          content: [{ type: 'text', text: 'The Datadog MCP server has not been set up. Use the ddsetup tool first.' }],
          details: { state: 'not-setup' },
        };
      }

      const { domain: currentDomain, toolsets: currentToolsets } = state.config;
      const currentSite = domainToSite(currentDomain);
      const scopeLabel = state.scope === 'project' ? 'Project (.pi/datadog.json)' : 'Global (~/.pi/agent/datadog/)';
      const action = params.action ?? 'status';

      if (action === 'status') {
        return {
          content: [
            {
              type: 'text',
              text: lines(
                'Datadog MCP server configuration:',
                `  Domain: ${currentDomain}`,
                currentSite && `  Site: ${currentSite}`,
                `  Scope: ${scopeLabel}`,
                currentToolsets ? `  Toolsets: ${currentToolsets}` : '  Toolsets: (server defaults)',
                `  Auth: ${mcp.authMode === 'oauth' ? 'OAuth (browser sign-in)' : 'API key (DD_API_KEY + DD_APPLICATION_KEY from env)'}`,
                '',
                'Available actions:',
                '  - ddconfig with action "change-site" to switch domains',
                '  - ddconfig with action "troubleshoot" to diagnose issues',
                '  - ddtoolsets to manage toolsets',
              ),
            },
          ],
          details: { state: 'status', domain: currentDomain },
        };
      }

      if (action === 'change-site') {
        const site = params.site ?? (await pickDatadogSite(ctx, currentDomain));
        if (!site) {
          return {
            content: [
              {
                type: 'text',
                text: lines(
                  `Current domain: ${currentDomain}${currentSite ? ` (${currentSite})` : ''}`,
                  '',
                  'Provide a site code or MCP domain to switch to:',
                  SITE_TABLE,
                ),
              },
            ],
            details: { state: 'awaiting-site' },
          };
        }

        const newDomain = resolveSiteToDomain(site);
        if (!newDomain) {
          return {
            content: [
              {
                type: 'text',
                text: lines(`Could not resolve "${site}" to a Datadog MCP domain.`, '', 'Available sites:', SITE_TABLE),
              },
            ],
            details: { state: 'bad-site' },
          };
        }

        if (newDomain === currentDomain) {
          return {
            content: [{ type: 'text', text: `The domain is already set to ${currentDomain}. No changes needed.` }],
            details: { state: 'no-op' },
          };
        }

        const unknownDomainNote =
          !isKnownDomain(newDomain) &&
          `Note: "${newDomain}" is not a known Datadog MCP domain. If the plugin fails to connect, re-run ddconfig with a site code from the list.`;

        const newConfig = { domain: newDomain, toolsets: currentToolsets };
        // Keep the change in the scope we resolved from (project override or global).
        await persistConfig(cwd, globalDir, mcpFile, state.scope, newConfig);
        mcp.setUrl(urls.build(newDomain, newConfig.toolsets));

        const newSite = domainToSite(newDomain);
        return {
          content: [
            {
              type: 'text',
              text: lines(
                `Domain changed from ${currentDomain} to ${newDomain}${newSite ? ` (${newSite})` : ''}.`,
                unknownDomainNote,
                '',
                'The next Datadog tool call will use the new domain.',
              ),
            },
          ],
          details: { state: 'changed', domain: newDomain },
        };
      }

      // action === 'troubleshoot'
      return {
        content: [
          {
            type: 'text',
            text: lines(
              'The Datadog MCP server is configured but may not be responding.',
              '',
              `Current domain: ${currentDomain}${currentSite ? ` (${currentSite})` : ''}`,
              '',
              'Common causes:',
              `  1. Domain issue — verify "${currentDomain}" is correct for your Datadog site.`,
              '     Use ddconfig with action "change-site" to update if needed.',
              mcp.authMode === 'oauth'
                ? '  2. Authentication — your sign-in may have expired or been revoked.'
                : '  2. Authentication — DD_API_KEY or DD_APPLICATION_KEY may be unset or wrong.',
              mcp.authMode === 'oauth'
                ? '     Call the datadog tool with { "list": true } to trigger a fresh sign-in flow.'
                : '     Set both env vars before starting Pi and verify they match a working Datadog account.',
              '  3. Network or access — your network may be blocking the connection,',
              '     or your Datadog account may not have the MCP Read permission.',
            ),
          },
        ],
        details: { state: 'troubleshoot' },
      };
    },
  });
