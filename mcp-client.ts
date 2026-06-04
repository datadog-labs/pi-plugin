// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

// Thin wrapper around the MCP SDK's Client + StreamableHTTPClientTransport.
//
// The wrapper exists to (a) gate connection lazily so Pi startup never has a
// side effect, (b) decide between OAuth and API-key auth at construction time,
// and (c) plumb the OAuth callback dance around the SDK's UnauthorizedError.
//
// Auth-mode selection — API keys take precedence over OAuth:
//   - apiKey: BOTH DD_API_KEY and DD_APPLICATION_KEY are set in the env at
//     construction time. We pass them as request headers and never instantiate
//     the OAuth provider. Path for headless / SSH / CI contexts; also the
//     opt-out for users who don't want a browser tab to fly open.
//   - oauth: at least one of those env vars is missing. We use
//     DatadogOAuthProvider; the first listTools/callTool may open a browser
//     and block on the callback. Tokens are cached, refreshes are automatic.
//
// We decide once, at construction. To switch modes after startup, change env
// vars and `/reload` inside Pi (which re-executes the entry file).

import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { DatadogOAuthProvider } from './oauth-provider.js';
import { awaitCallback } from './oauth-callback-server.js';
import { type ParsedUrl, parseMcpUrl } from '#shared/url';

export type AuthMode = 'apiKey' | 'oauth';

const CLIENT_NAME = 'datadog-pi-plugin';
const CLIENT_VERSION = '0.0.0';

const buildApiKeyHeaders = (): Record<string, string> | undefined => {
  const apiKey = process.env.DD_API_KEY;
  const appKey = process.env.DD_APPLICATION_KEY;
  if (!apiKey || !appKey) return undefined;
  return { DD_API_KEY: apiKey, DD_APPLICATION_KEY: appKey };
};

export const detectAuthMode = (): AuthMode => (buildApiKeyHeaders() ? 'apiKey' : 'oauth');

export type McpClient = {
  readonly authMode: AuthMode;
  setUrl(url: string): void;
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult>;
  close(): Promise<void>;
};

type Connection = {
  client: Client;
  transport: StreamableHTTPClientTransport;
  provider?: DatadogOAuthProvider;
  target: string;
};

const parseOrThrow = (target: string): ParsedUrl => {
  if (!target) throw new Error('Datadog MCP URL not configured — run ddsetup first.');
  const parsed = parseMcpUrl(target);
  if (!parsed) throw new Error(`Invalid Datadog MCP URL: ${target}`);
  return parsed;
};

// `oauthDir` is the global Datadog state dir (<agentDir>/datadog); OAuth tokens
// are stored there, per-domain, so sign-in is shared across projects.
export const createMcpClient = (oauthDir: string, initialUrl: string): McpClient => {
  const authMode = detectAuthMode();
  let url = initialUrl;
  let connection: Connection | undefined;
  let connecting: Promise<Connection> | undefined;
  let recovering: Promise<Connection> | undefined;

  const buildTransport = (
    target: string,
    parsed: ParsedUrl,
  ): { transport: StreamableHTTPClientTransport; provider?: DatadogOAuthProvider } => {
    if (authMode === 'apiKey') {
      return {
        transport: new StreamableHTTPClientTransport(new URL(target), {
          requestInit: { headers: buildApiKeyHeaders() },
        }),
      };
    }
    const provider = new DatadogOAuthProvider(oauthDir, parsed.domain);
    return { transport: new StreamableHTTPClientTransport(new URL(target), { authProvider: provider }), provider };
  };

  const finishOAuth = async (
    transport: StreamableHTTPClientTransport,
    provider: DatadogOAuthProvider,
  ): Promise<void> => {
    const { code } = await awaitCallback(provider.getCurrentState());
    await transport.finishAuth(code);
  };

  const connect = async (target: string): Promise<Connection> => {
    const parsed = parseOrThrow(target);
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
    const built = buildTransport(target, parsed);
    let transport = built.transport;
    let provider = built.provider;

    try {
      await client.connect(transport);
    } catch (err) {
      if (!(err instanceof UnauthorizedError) || authMode !== 'oauth' || !provider) throw err;

      // The provider has already kicked off `open(authorizeUrl)`. Wait for the
      // browser callback to deliver the code, then complete the exchange.
      await finishOAuth(transport, provider);

      // Per the SDK docs, finishAuth doesn't re-attempt the connection; build a
      // fresh transport (the old one is in a failed-handshake state) and
      // reconnect. Tokens are now in the provider's store; the SDK will use
      // them transparently on this call.
      const rebuilt = buildTransport(target, parsed);
      transport = rebuilt.transport;
      provider = rebuilt.provider;
      await client.connect(transport);
    }

    return { client, transport, provider, target };
  };

  const ensureConnected = async (): Promise<Connection> => {
    if (connection) return connection;
    connecting ??= connect(url).then((c) => {
      connection = c;
      return c;
    });
    try {
      return await connecting;
    } finally {
      connecting = undefined;
    }
  };

  const close = async (): Promise<void> => {
    const current = connection;
    connection = undefined;
    if (current) {
      try {
        await current.client.close();
      } catch {
        // best effort — we're tearing down anyway
      }
    }
  };

  const recoverAuth = async (current: Connection): Promise<Connection> => {
    const provider = current.provider;
    if (!provider) throw new Error('OAuth provider unavailable for authentication recovery');

    recovering ??= (async () => {
      await finishOAuth(current.transport, provider);
      try {
        await current.client.close();
      } catch {
        // best effort — the failed connection will be replaced
      }
      if (connection === current) connection = undefined;
      const next = await connect(current.target);
      connection = next;
      return next;
    })();

    try {
      return await recovering;
    } finally {
      recovering = undefined;
    }
  };

  const withAuthRecovery = async <T>(operation: (client: Client) => Promise<T>): Promise<T> => {
    const current = await ensureConnected();
    try {
      return await operation(current.client);
    } catch (err) {
      if (!(err instanceof UnauthorizedError) || authMode !== 'oauth') throw err;
      const next = await recoverAuth(current);
      return await operation(next.client);
    }
  };

  return {
    authMode,
    setUrl(next) {
      url = next;
      void close();
    },
    async listTools() {
      const result = await withAuthRecovery((client) => client.listTools());
      return result.tools;
    },
    async callTool(name, args) {
      return (await withAuthRecovery((client) => client.callTool({ name, arguments: args ?? {} }))) as CallToolResult;
    },
    close,
  };
};
