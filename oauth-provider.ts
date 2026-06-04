// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

// OAuthClientProvider implementation for the Datadog MCP server.
//
// The SDK calls into this object during the OAuth flow:
//   1. tokens() — return cached tokens if any
//   2. (on 401) clientInformation() — fetch any prior dynamic registration
//   3. saveClientInformation() — if we registered fresh
//   4. state() — supply the OAuth state parameter
//   5. saveCodeVerifier() — store PKCE verifier
//   6. redirectToAuthorization(url) — kick off the browser flow
//   7. (caller waits for callback via oauth-callback-server, calls
//      transport.finishAuth(code), which triggers:)
//   8. codeVerifier() — retrieve the PKCE verifier for token exchange
//   9. saveTokens() — persist the new tokens
//
// Token refresh on subsequent requests is automatic: the SDK calls tokens(),
// detects expiry, refreshes using the stored refresh_token, and calls
// saveTokens() with the new pair. No app-level retry needed.

import { randomBytes } from 'node:crypto';

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import open from 'open';

import { callbackUrl } from './oauth-callback-server.js';
import { type Artifact, clearAll, clearArtifact, readArtifact, writeArtifact } from './oauth-store.js';

const CLIENT_NAME = 'Datadog Pi Plugin';

export class DatadogOAuthProvider implements OAuthClientProvider {
  private cachedState: string | undefined;

  constructor(
    private readonly baseDir: string,
    private readonly domain: string,
  ) {}

  get redirectUrl(): string {
    return callbackUrl();
  }

  get clientMetadata(): OAuthClientMetadata {
    // No `scope` field on purpose — Datadog's OAuth server defines its own
    // supported scopes and rejects unrecognized values (e.g. "mcp"). Omitting
    // lets the server grant whatever default scope it uses for dynamically-
    // registered clients, which matches how cursor / claude-code go through
    // OAuth via their host clients.
    return {
      client_name: CLIENT_NAME,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  // Returns the state value the SDK should embed in the authorize URL. We
  // generate once per provider instance and cache so the orchestrator can read
  // it back via getCurrentState() to validate the callback.
  state(): string {
    this.cachedState ??= randomBytes(16).toString('hex');
    return this.cachedState;
  }

  getCurrentState(): string | undefined {
    return this.cachedState;
  }

  // Storage delegates — generic over Artifact since the shapes are SDK types.
  private read<T>(artifact: Artifact): Promise<T | undefined> {
    return readArtifact<T>(this.baseDir, this.domain, artifact);
  }

  private write(artifact: Artifact, value: unknown): Promise<void> {
    return writeArtifact(this.baseDir, this.domain, artifact, value);
  }

  tokens(): Promise<OAuthTokens | undefined> {
    return this.read<OAuthTokens>('tokens');
  }

  saveTokens(tokens: OAuthTokens): Promise<void> {
    return this.write('tokens', tokens);
  }

  clientInformation(): Promise<OAuthClientInformation | undefined> {
    return this.read<OAuthClientInformation>('client');
  }

  saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    return this.write('client', info);
  }

  codeVerifier(): Promise<string> {
    return this.read<string>('verifier').then((v) => {
      if (!v) throw new Error('No PKCE code verifier saved — auth flow not initiated correctly');
      return v;
    });
  }

  saveCodeVerifier(verifier: string): Promise<void> {
    return this.write('verifier', verifier);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // Don't await `open()` — it returns a ChildProcess, and we don't need to
    // wait for the browser to actually paint. The caller (mcp-client.ts) is
    // already listening on the callback port; the SDK will throw
    // UnauthorizedError immediately after this returns, and the caller will
    // await the callback there.
    void open(authorizationUrl.toString());
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    switch (scope) {
      case 'all':
        await clearAll(this.baseDir, this.domain);
        this.cachedState = undefined;
        return;
      case 'tokens':
      case 'client':
      case 'verifier':
        await clearArtifact(this.baseDir, this.domain, scope);
        return;
      case 'discovery':
        // SDK-internal scope; we don't persist discovery state, so nothing to clear.
        return;
    }
  }
}
