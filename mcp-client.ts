// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, ReadResourceResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { OrgIdentity } from './config.js';
import { parseIdentity, sameIdentity } from './config.js';
import type { CredentialStore } from './oauth-store.js';
import { createSilentOAuthFetch, ProfileOAuthProvider } from './oauth-provider.js';
import type { LoginCallback } from './oauth-callback-server.js';
import { IdentityMismatch, SignInRequired } from './connection-errors.js';

export type ConnectionAuth =
  | { kind: 'oauth'; store: CredentialStore; login?: LoginCallback }
  | { kind: 'environment'; headers: Record<string, string> };
export type ConnectionClient = {
  readonly authMode: 'oauth' | 'apiKey';
  identity(signal?: AbortSignal): Promise<OrgIdentity>;
  listTools(signal?: AbortSignal): Promise<Tool[]>;
  readResource(uri: string, signal?: AbortSignal): Promise<ReadResourceResult>;
  callTool(name: string, args: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<CallToolResult>;
  close(): Promise<void>;
};

export const environmentHeaders = (env: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined =>
  env.DD_API_KEY && env.DD_APPLICATION_KEY
    ? { DD_API_KEY: env.DD_API_KEY, DD_APPLICATION_KEY: env.DD_APPLICATION_KEY }
    : undefined;

export const createConnectionClient = (
  url: string,
  auth: ConnectionAuth,
  expected?: OrgIdentity,
  validate?: () => Promise<void>,
): ConnectionClient => {
  let client: Client | undefined;
  let identity: OrgIdentity | undefined;
  let connecting: Promise<Client> | undefined;
  let closed = false;
  const lifecycle = new AbortController();
  const assertOpen = () => {
    if (closed) throw new Error('Datadog connection closed.');
  };
  const fetchWithSignal: typeof fetch = (input, init) =>
    fetch(input, {
      ...init,
      signal: AbortSignal.any([
        lifecycle.signal,
        ...(init?.signal ? [init.signal] : []),
        ...(auth.kind === 'oauth' && auth.login?.signal ? [auth.login.signal] : []),
      ]),
    });
  const transport = () =>
    new StreamableHTTPClientTransport(new URL(url), {
      authProvider: auth.kind === 'oauth' && auth.login ? new ProfileOAuthProvider(auth.store, auth.login) : undefined,
      requestInit: auth.kind === 'environment' ? { headers: auth.headers } : undefined,
      fetch:
        auth.kind === 'oauth' && !auth.login
          ? createSilentOAuthFetch(url, auth.store, fetchWithSignal)
          : fetchWithSignal,
    });
  const connect = async (signal?: AbortSignal): Promise<Client> => {
    signal?.throwIfAborted();
    assertOpen();
    const next = new Client({ name: 'datadog-pi-plugin', version: '0.0.0' });
    let wire = transport();
    try {
      try {
        await next.connect(wire, { signal });
      } catch (error) {
        if (!(error instanceof UnauthorizedError) || auth.kind !== 'oauth' || !auth.login) throw error;
        const code = await auth.login.code;
        signal?.throwIfAborted();
        await wire.finishAuth(code);
        await wire.close();
        wire = transport();
        await next.connect(wire, { signal });
      }
      const result = await next.readResource({ uri: 'datadog://mcp/whoami' }, { signal });
      const text = result.contents.find((entry) => 'text' in entry)?.text;
      if (typeof text !== 'string') throw new Error('Datadog organization verification is unavailable.');
      const actual = parseIdentity(JSON.parse(text) as unknown);
      if (expected && !sameIdentity(actual, expected)) throw new IdentityMismatch();
      assertOpen();
      identity = actual;
      client = next;
      return next;
    } catch (error) {
      await next.close().catch(() => undefined);
      await wire.close().catch(() => undefined);
      throw error;
    }
  };
  const ensure = async (signal?: AbortSignal): Promise<Client> => {
    assertOpen();
    if (client) return client;
    connecting ??= connect(signal).finally(() => {
      connecting = undefined;
    });
    return connecting;
  };
  const run = async <T>(operation: (current: Client) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted();
    await validate?.();
    // A sign-out in another process must also stop an existing transport.
    if (auth.kind === 'oauth' && !auth.login && !(await auth.store.read()).tokens) throw new SignInRequired();
    return operation(await ensure(signal));
  };
  return {
    authMode: auth.kind === 'oauth' ? 'oauth' : 'apiKey',
    identity: (signal) => run(async () => identity!, signal),
    listTools: (signal) => run(async (current) => (await current.listTools({}, { signal })).tools, signal),
    readResource: (uri, signal) => run((current) => current.readResource({ uri }, { signal }), signal),
    callTool: (name, args, signal) =>
      run(
        async (current) =>
          (await current.callTool({ name, arguments: args ?? {} }, undefined, { signal })) as CallToolResult,
        signal,
      ),
    async close() {
      closed = true;
      lifecycle.abort();
      await client?.close();
      client = undefined;
      identity = undefined;
    },
  };
};

export type AuthMode = 'oauth' | 'apiKey';
export type McpCallToolArgs = Record<string, unknown> | undefined;
export type McpClient = Omit<ConnectionClient, 'identity'>;
