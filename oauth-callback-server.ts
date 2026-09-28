// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import open from 'open';
import type { AuthorizationAttempt } from './oauth-provider.js';

export type LoginCallback = AuthorizationAttempt & { code: Promise<string>; close(): Promise<void> };
export const callbackPort = (): number => {
  const raw = process.env.DD_OAUTH_CALLBACK_PORT;
  const port = raw === undefined ? 19876 : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DD_OAUTH_CALLBACK_PORT.');
  return port;
};

// Bind before opening a browser, and own all resources for exactly one attempt.
// A port collision fails here, without creating an orphan browser login.
export const startLoginCallback = async (
  signal?: AbortSignal,
  port = callbackPort(),
  openBrowser: (url: string) => Promise<unknown> = open,
): Promise<LoginCallback> => {
  signal?.throwIfAborted();
  const cancellation = new AbortController();
  signal = AbortSignal.any([cancellation.signal, ...(signal ? [signal] : [])]);
  let timedOut = false;
  const state = randomBytes(32).toString('hex');
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // The browser might fail or the attempt might abort before anyone awaits code.
  void code.catch(() => undefined);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' || url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400).end('Invalid OAuth state.');
      return;
    }
    if (url.searchParams.has('error')) {
      res.writeHead(400).end('Datadog sign-in was not completed. Return to Pi.');
      rejectCode(new Error('Datadog authorization was declined.'));
      return;
    }
    const value = url.searchParams.get('code');
    if (!value) {
      res.writeHead(400).end('Missing authorization code.');
      return;
    }
    res
      .writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
      .end('Authorization received. Return to Pi to finish verifying your organization.');
    resolveCode(value);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  // Port 0 is useful for isolated tests; production uses the configured fixed port.
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Datadog callback did not bind.');
  const abort = () => {
    rejectCode(
      new Error(timedOut ? 'Datadog sign-in timed out. Open /datadog to try again.' : 'Datadog sign-in cancelled.'),
    );
    server.closeAllConnections();
    server.close();
  };
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    cancellation.abort();
  }, 5 * 60_000);
  timeout.unref();
  server.on('error', rejectCode);
  if (signal.aborted) abort();
  return {
    state,
    signal,
    code,
    redirectUrl: `http://localhost:${address.port}/callback`,
    async open(url) {
      signal.throwIfAborted();
      await openBrowser(url.toString());
    },
    async close() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      cancellation.abort();
      rejectCode(new Error('Datadog login attempt closed.'));
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          }),
        );
    },
  };
};
