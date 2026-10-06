// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import { defineTool, type AgentToolResult } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { profileLabel } from '../config.js';
import { errorMessage, SignInRequired, IdentityMismatch } from '../connection-errors.js';
import type { ToolDeps } from './types.js';

export const createDdconfig = ({ connections }: ToolDeps) =>
  defineTool({
    name: 'ddconfig',
    label: 'Datadog Connection',
    description:
      'Show the selected Datadog organization and saved connections, or check connectivity. Never starts browser login or changes the organization. Ask the user to open /datadog to connect or switch.',
    parameters: Type.Object({ action: Type.Optional(Type.Union([Type.Literal('status'), Type.Literal('check')])) }),
    async execute(_id, params, signal): Promise<AgentToolResult<{ state: string; profileId?: string }>> {
      try {
        let selected = await connections.current();
        if (!selected)
          return {
            content: [{ type: 'text' as const, text: 'No Datadog organization selected. Open /datadog to connect.' }],
            details: { state: 'not-connected' },
          };
        if (params.action === 'check')
          selected = await connections.check(
            signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
          );
        const { profile, toolsets, scope } = selected;
        const registry = await connections.store.read();
        const status = connections.isVerified ? 'Verified in this session' : 'Saved; not checked in this session';
        const text = [
          `Datadog: ${profileLabel(profile)}`,
          `Domain: ${profile.domain}`,
          `Status: ${status}`,
          `Organization UUID: ${profile.identity?.orgUuid ?? '(not verified yet)'}`,
          `Auth: ${profile.auth.kind === 'oauth' ? 'OAuth' : 'API keys from environment'}`,
          `Toolsets (${scope}): ${toolsets || '(server defaults)'}`,
          `Saved connections: ${registry.profiles.map(profileLabel).join(', ')}`,
          'Open /datadog to manage connections.',
        ].join('\n');
        return { content: [{ type: 'text' as const, text }], details: { state: 'status', profileId: profile.id } };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: errorMessage(error) }],
          details: {
            state:
              error instanceof SignInRequired
                ? 'sign-in-required'
                : error instanceof IdentityMismatch
                  ? 'identity-mismatch'
                  : 'error',
          },
        };
      }
    },
  });
