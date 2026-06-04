// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

// One-shot localhost HTTP server that catches the OAuth authorization-code
// redirect from the Datadog auth server. Started lazily by oauth-provider.ts
// when redirectToAuthorization is called; shuts itself down on the first valid
// /callback hit (or on the timeout fallback).
//
// The default port (19876) matches pi-mcp-adapter so users with both extensions
// don't fight over the same port range. Override via DD_OAUTH_CALLBACK_PORT.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export const CALLBACK_PATH = '/callback';
export const DEFAULT_PORT = 19876;
const TIMEOUT_MS = 5 * 60 * 1000;

export type CallbackResult = { code: string; state: string | undefined };

const getPort = (): number => {
  const raw = process.env.DD_OAUTH_CALLBACK_PORT;
  if (!raw) return DEFAULT_PORT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : DEFAULT_PORT;
};

export const callbackUrl = (): string => `http://localhost:${String(getPort())}${CALLBACK_PATH}`;

const successHtml = (provider: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>${provider} sign-in complete</title>
<style>body{font-family:system-ui;text-align:center;padding:4rem;color:#222}</style></head>
<body><h1>Signed in to ${provider}</h1><p>You can close this tab and return to your terminal.</p></body></html>`;

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const errorHtml = (message: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>Sign-in failed</title>
<style>body{font-family:system-ui;text-align:center;padding:4rem;color:#222}code{color:#a00}</style></head>
<body><h1>Sign-in failed</h1><p><code>${escapeHtml(message)}</code></p>
<p>Return to your terminal and try again.</p></body></html>`;

// Resolves with the auth code on the first valid /callback hit. Server shuts
// down regardless of outcome (success, error, or timeout) so the port frees
// up promptly.
export const awaitCallback = (expectedState: string | undefined): Promise<CallbackResult> =>
  new Promise<CallbackResult>((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://localhost:${String(getPort())}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        const desc = url.searchParams.get('error_description') ?? error;
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(errorHtml(desc));
        server.close();
        reject(new Error(`OAuth provider returned error: ${desc}`));
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state') ?? undefined;
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(errorHtml('missing code parameter'));
        server.close();
        reject(new Error('OAuth callback missing code parameter'));
        return;
      }
      if (expectedState !== undefined && state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(errorHtml('state mismatch'));
        server.close();
        reject(new Error('OAuth callback state did not match — possible CSRF, aborting'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' }).end(successHtml('Datadog'));
      server.close();
      resolve({ code, state });
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`OAuth callback timed out after ${String(TIMEOUT_MS / 1000)}s. Try again.`));
    }, TIMEOUT_MS);
    timer.unref();

    server.once('close', () => {
      clearTimeout(timer);
    });

    server.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`OAuth callback server failed: ${err.message}`));
    });

    server.listen(getPort(), '127.0.0.1');
  });
