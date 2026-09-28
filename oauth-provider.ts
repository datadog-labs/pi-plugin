// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import { auth, extractWWWAuthenticateParams, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { CredentialStore } from './oauth-store.js';
import { SignInRequired } from './connection-errors.js';

export type AuthorizationAttempt = {
  signal?: AbortSignal;
  redirectUrl: string;
  state: string;
  open(url: URL): Promise<void>;
};

export class ProfileOAuthProvider implements OAuthClientProvider {
  private verifier: string | undefined;
  constructor(
    private readonly store: CredentialStore,
    private readonly attempt?: AuthorizationAttempt,
  ) {}
  get redirectUrl(): string {
    return this.attempt?.redirectUrl ?? 'http://localhost:19876/callback';
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Datadog Pi Plugin',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state(): string {
    if (!this.attempt) throw new SignInRequired();
    return this.attempt.state;
  }
  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.store.read()).tokens;
  }
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.store.write({ ...(await this.store.read()), tokens });
  }
  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const client = (await this.store.read()).client;
    // Don't register new clients as a side effect of an ordinary query.
    if (!client && !this.attempt) throw new SignInRequired();
    return client;
  }
  async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
    await this.store.write({ ...(await this.store.read()), client });
  }
  saveCodeVerifier(verifier: string): void {
    if (!this.attempt) throw new SignInRequired();
    this.verifier = verifier;
  }
  codeVerifier(): string {
    if (!this.verifier) throw new Error('No active Datadog login attempt.');
    return this.verifier;
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.attempt) throw new SignInRequired();
    await this.attempt.open(url);
  }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'verifier') {
      this.verifier = undefined;
      return;
    }
    if (scope === 'discovery') return;
    const credentials = await this.store.read();
    if (scope === 'all') await this.store.write({});
    else if (scope === 'tokens') await this.store.write({ client: credentials.client });
    else await this.store.write({ tokens: credentials.tokens });
  }
}

// The SDK's transport owns interactive login, but cached grants need a shared
// refresh transaction. Keep ordinary HTTP requests outside the credential lock.
export const createSilentOAuthFetch =
  (serverUrl: string, store: CredentialStore, fetchFn: typeof fetch): typeof fetch =>
  async (input, init) => {
    let retried = false;
    for (;;) {
      const tokens = (await store.read()).tokens;
      if (!tokens) throw new SignInRequired();
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${tokens.access_token}`);
      const response = await fetchFn(input, { ...init, headers });
      const challenge = extractWWWAuthenticateParams(response);
      if (response.status !== 401 && !(response.status === 403 && challenge.error === 'insufficient_scope'))
        return response;
      await response.body?.cancel();
      if (retried) throw new SignInRequired();
      await store.lock(async () => {
        const current = (await store.read()).tokens;
        if (!current) throw new SignInRequired();
        // Another request/process may already have rotated this grant while our
        // rejected request was in flight. Reuse its result rather than refreshing twice.
        if (current.access_token !== tokens.access_token || current.refresh_token !== tokens.refresh_token) return;
        const result = await auth(new ProfileOAuthProvider(store), {
          serverUrl,
          resourceMetadataUrl: challenge.resourceMetadataUrl,
          scope: challenge.scope,
          fetchFn,
        });
        if (result !== 'AUTHORIZED') throw new SignInRequired();
      });
      retried = true;
    }
  };
