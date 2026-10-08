// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import { defineTool, type AgentToolResult } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { profileLabel, type Profile } from '../config.js';
import { errorMessage, SignInRequired, IdentityMismatch } from '../connection-errors.js';
import type { ToolDeps } from './types.js';

const savedConnections = (profiles: Profile[], selectedId?: string): string[] =>
  profiles.length === 0
    ? []
    : [
        'Saved connections:',
        ...profiles.map(
          (entry) =>
            `- ${profileLabel(entry)} · ${entry.domain} · profileId ${entry.id}${entry.id === selectedId ? ' (selected)' : ''}`,
        ),
      ];

export const createDdconfig = ({ connections }: ToolDeps) =>
  defineTool({
    name: 'ddconfig',
    label: 'Datadog Connection',
    // A switch replaces the shared client, so it mustn't race sibling datadog calls or another switch.
    executionMode: 'sequential',
    description:
      'Show the selected Datadog organization and saved connections, check connectivity, or switch this session to another saved connection (action "switch" with its profileId). Switch only when the user\'s request targets another organization. Never starts browser login; ask the user to open /datadog to sign in or add an organization.',
    parameters: Type.Object({
      action: Type.Optional(Type.Union([Type.Literal('status'), Type.Literal('check'), Type.Literal('switch')])),
      profileId: Type.Optional(Type.String({ description: 'Saved connection ID to switch to (from status).' })),
    }),
    async execute(_id, params, signal): Promise<AgentToolResult<{ state: string; profileId?: string }>> {
      const bounded = () =>
        signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
      try {
        if (params.action === 'switch') {
          if (!params.profileId)
            return {
              content: [{ type: 'text' as const, text: 'Provide the profileId of a saved connection to switch to.' }],
              details: { state: 'bad-input' },
            };
          if (connections.selection !== params.profileId) await connections.select(params.profileId, bounded());
        }
        let selected = await connections.current();
        if (!selected) {
          const { profiles } = await connections.store.read();
          const text = [
            'No Datadog organization selected.',
            ...savedConnections(profiles),
            'Open /datadog to connect.',
          ].join('\n');
          return { content: [{ type: 'text' as const, text }], details: { state: 'not-connected' } };
        }
        if (params.action === 'check') selected = await connections.check(bounded());
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
          ...savedConnections(registry.profiles, profile.id),
          'Open /datadog to sign in or manage connections.',
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
