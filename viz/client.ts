/**
 * Client for the ddviz Swift host.
 *
 * Spawns `swift viz/ddviz.swift` as a child process and pipes
 * newline-delimited JSON payloads to it over stdin. The child's lifetime is
 * tied to ours — when pi exits, ddviz sees stdin EOF and shuts itself down.
 *
 * stdout carries JSON-RPC requests originating from the iframe (e.g.
 * `tools/call`). We dispatch them to handlers registered via
 * `setRequestHandler` and write the JSON-RPC response back over stdin.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CallToolRequestParams, ContentBlock } from '@modelcontextprotocol/sdk/types.js';

import type { McpClient } from '../mcp-client.js';
import {
  classifyMessage,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './jsonrpc2.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));
// ddviz.swift lives alongside this file in surface/
const DEFAULT_DDVIZ_SCRIPT = resolvePath(moduleDir, 'ddviz.swift');

/** Diagnostic logger threaded through the viz components. */
export type Logger = (message: string) => void;

/**
 * Build a logger that appends timestamped lines to the debug log when `debug`
 * is true, and is a no-op otherwise. Threaded into every viz component so a
 * single flag silences all diagnostic output.
 */
export const createLogger =
  (debug: boolean): Logger =>
  (message: string): void => {
    if (!debug) return;
    appendFileSync('/tmp/ddpi.log', `[${new Date().toISOString()}] ${message}\n`);
  };

export interface DdvizClientOptions {
  /** Override the path to ddviz.swift. */
  scriptPath?: string;
  /** Forwarded to ddviz as DDVIZ_DEBUG=1 when true. */
  isDebug?: boolean;
  /** Run the WebView without showing the panel (DDVIZ_HEADLESS=1). */
  isHeadless?: boolean;
  /** Optional logger (defaults to a no-op). */
  log?: Logger;
  /** Datadog MCP client. When provided, the client answers `tools/call`
   *  requests forwarded from the iframe by proxying to the MCP server — wired
   *  for every client so both the interactive and headless panels can fetch data. */
  mcp?: McpClient;
}

/** Typed params for each JSON-RPC method the iframe may forward to this client. */
export interface DdvizRequestParamsMap {
  'tools/call': CallToolRequestParams;
  'ui/update-model-context': { content: ContentBlock[] };
}

export type DdvizRequestMethod = keyof DdvizRequestParamsMap;

/**
 * Handler for an incoming JSON-RPC request from ddviz. Returning a value
 * resolves the request as a `result`; throwing maps to a JSON-RPC error
 * delivered back to the iframe.
 */
export type DdvizRequestHandler<M extends DdvizRequestMethod = DdvizRequestMethod> = (
  params: DdvizRequestParamsMap[M],
  id: unknown,
) => unknown;

export interface ScreenshotResult {
  data: string;
  mimeType: string;
}

const stringifyError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Notification the MCP app (iframe) emits once it is ready — see the mcp-app spec. */
const INITIALIZED_NOTIFICATION = 'ui/notifications/initialized';

/** Max time to wait for `ui/notifications/initialized` after spawning ddviz. */
const INIT_TIMEOUT_MS = 15_000;

export class DdvizClient {
  private readonly scriptPath: string;
  private readonly isDebug: boolean;
  private readonly isHeadless: boolean;
  private readonly log: Logger;
  private child: ChildProcessWithoutNullStreams | null = null;
  private spawnPromise: Promise<void> | null = null;
  private readonly requestHandlers = new Map<string, (params: unknown, id: unknown) => unknown>();
  private readonly pendingCommands = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private commandSeq = 0;
  private stdoutBuffer = '';
  /** Resolver armed by `waitForInitialized`, fired on the init notification. */
  private onInitialized: (() => void) | null = null;
  /** Number of in-flight `handleRequest` calls (iframe → MCP proxy round-trips). */
  private pendingRequests = 0;
  /** Fired every time `pendingRequests` drops to zero. */
  private onRequestDrained: (() => void) | null = null;

  constructor(options: DdvizClientOptions = {}) {
    this.scriptPath = options.scriptPath ?? DEFAULT_DDVIZ_SCRIPT;
    this.isDebug = options.isDebug ?? false;
    this.isHeadless = options.isHeadless ?? false;
    this.log = options.log ?? (() => undefined);
    if (options.mcp) this.registerToolCallProxy(options.mcp);
  }

  /**
   * Answer `tools/call` requests forwarded from the iframe by proxying them to
   * the Datadog MCP server. Errors propagate as JSON-RPC errors to the iframe.
   */
  private registerToolCallProxy(mcp: McpClient): void {
    this.setRequestHandler('tools/call', async (params) => {
      const { name, arguments: args } = params;
      this.log(`[ddviz] proxying tools/call → ${name}`);
      const result = await mcp.callTool(name, args);
      this.log(`[ddviz] tools/call ${name} resolved`);
      return result;
    });
  }

  /**
   * Register a handler for a JSON-RPC method that ddviz may forward from
   * the iframe. Last writer wins. Pass `null` to unregister.
   */
  setRequestHandler<M extends DdvizRequestMethod>(method: M, handler: DdvizRequestHandler<M> | null): void {
    if (handler === null) {
      this.requestHandlers.delete(method);
    } else {
      this.requestHandlers.set(method, handler as (params: unknown, id: unknown) => unknown);
    }
  }

  async backgroundRun(): Promise<void> {
    await this.ensureRunning();
  }

  /**
   * Forward a fire-and-forget JSON-RPC notification to ddviz, lazily spawning
   * it if it isn't already running. Errors are swallowed (logged) so that
   * visualization never breaks tool execution.
   */
  async forward(notification: JsonRpcNotification): Promise<void> {
    try {
      await this.ensureRunning();
      await this.writeJsonRpc(notification);
    } catch (err) {
      this.log(`[ddviz] forward failed: ${stringifyError(err)}`);
    }
  }

  /** Show the ddviz panel. */
  async show(): Promise<void> {
    try {
      await this.ensureRunning();
      await this.write({ command: 'show' });
    } catch (err) {
      this.log(`[ddviz] show failed: ${stringifyError(err)}`);
    }
  }

  /** Hide the ddviz panel. */
  async hide(): Promise<void> {
    try {
      await this.ensureRunning();
      await this.write({ command: 'hide' });
    } catch (err) {
      this.log(`[ddviz] hide failed: ${stringifyError(err)}`);
    }
  }

  /** Toggle the ddviz panel visibility. */
  async toggle(): Promise<void> {
    try {
      await this.ensureRunning();
      await this.write({ command: 'toggle' });
    } catch (err) {
      this.log(`[ddviz] toggle failed: ${stringifyError(err)}`);
    }
  }

  /**
   * Request a native PNG snapshot of the WebView from ddviz.
   * Sends a JSON-RPC `snapshot` request over stdin and waits for the
   * response on stdout. Returns base64 PNG data.
   */
  async screenshot(timeoutMs = 10_000): Promise<ScreenshotResult> {
    if (!this.isAlive()) throw new Error('ddviz is not running');
    const id = `snap-${++this.commandSeq}`;
    const promise = new Promise<unknown>((resolveSnapshot, reject) => {
      this.pendingCommands.set(id, { resolve: resolveSnapshot, reject });
      setTimeout(() => {
        if (this.pendingCommands.delete(id)) {
          reject(new Error(`snapshot timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    });
    await this.writeJsonRpc({ jsonrpc: '2.0', id, method: 'snapshot' });
    const result = (await promise) as { data?: string; mimeType?: string } | null;
    if (!result?.data) throw new Error('snapshot returned no image data');
    return { data: result.data, mimeType: result.mimeType ?? 'image/png' };
  }

  /**
   * Stop ddviz. Closes stdin (which the child treats as EOF and exits on)
   * and force-kills if it doesn't go away within a short window.
   */
  async shutdown(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    if (child.exitCode !== null) return;
    await new Promise<void>((resolveShutdown) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          // already gone
        }
        resolveShutdown();
      }, 500);
      child.once('exit', () => {
        clearTimeout(timer);
        resolveShutdown();
      });
    });
  }

  private async ensureRunning(): Promise<void> {
    if (this.isAlive()) return;
    if (!this.spawnPromise) {
      this.spawnPromise = this.spawnDdviz().finally(() => {
        this.spawnPromise = null;
      });
    }
    await this.spawnPromise;
  }

  private isAlive(): boolean {
    const child = this.child;
    if (!child) return false;
    if (child.killed) return false;
    if (child.exitCode !== null) return false;
    if (!child.stdin.writable) return false;
    return true;
  }

  private async spawnDdviz(): Promise<void> {
    if (!existsSync(this.scriptPath)) {
      throw new Error(`ddviz script not found at ${this.scriptPath}`);
    }

    this.log(`[ddviz] spawning swift ${this.scriptPath}`);

    const child = spawn('swift', [this.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(this.isDebug ? { DDVIZ_DEBUG: '1' } : {}),
        ...(this.isHeadless ? { DDVIZ_HEADLESS: '1' } : {}),
        DDVIZ_PARENT_PID: String(process.pid),
        DDVIZ_IPC: 'stdio',
      },
    });
    child.on('error', (err) => {
      this.log(`[ddviz] child error: ${stringifyError(err)}`);
      if (this.child === child) this.child = null;
    });
    // Catch EPIPE on stdin so it doesn't become an uncaught exception
    // when the child dies while we're writing to it.
    child.stdin.on('error', (err) => {
      this.log(`[ddviz] stdin error: ${stringifyError(err)}`);
    });
    child.on('exit', (code, signal) => {
      this.log(`[ddviz] exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      if (this.child === child) this.child = null;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      if (text) this.log(`[ddviz:stderr] ${text}`);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      this.consumeStdout(chunk.toString());
    });
    this.child = child;

    // Don't consider ddviz "running" until the iframe reports it has
    // initialized (forwarded to us by the Swift host as a JSON-RPC
    // notification). Bail if that never arrives.
    await this.waitForInitialized(child);
  }

  /**
   * Resolve once the iframe sends `ui/notifications/initialized`, or reject if
   * the child exits first or the notification doesn't arrive within
   * INIT_TIMEOUT_MS. On timeout the child is torn down so a stuck panel can't
   * linger.
   */
  private waitForInitialized(child: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise<void>((resolveInit, rejectInit) => {
      const timer = setTimeout(() => {
        child.removeListener('exit', onExit);
        this.onInitialized = null;
        this.log(`[ddviz] initialization timed out after ${INIT_TIMEOUT_MS}ms`);
        void this.shutdown();
        rejectInit(new Error(`ddviz did not initialize within ${INIT_TIMEOUT_MS}ms`));
      }, INIT_TIMEOUT_MS);
      const onExit = (): void => {
        clearTimeout(timer);
        this.onInitialized = null;
        rejectInit(new Error('ddviz exited before initializing'));
      };
      child.once('exit', onExit);
      this.onInitialized = () => {
        clearTimeout(timer);
        child.removeListener('exit', onExit);
        this.onInitialized = null;
        this.log('[ddviz] initialized');
        resolveInit();
      };
    });
  }

  private consumeStdout(text: string): void {
    this.stdoutBuffer += text;
    let nl = this.stdoutBuffer.indexOf('\n');
    while (nl !== -1) {
      const line = this.stdoutBuffer.slice(0, nl).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (line.length > 0) {
        void this.handleStdoutLine(line);
      }
      nl = this.stdoutBuffer.indexOf('\n');
    }
  }

  private async handleStdoutLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.log(`[ddviz] non-JSON stdout line: ${line.slice(0, 120)}`);
      return;
    }

    const message = classifyMessage(parsed);
    switch (message.kind) {
      case 'request':
        await this.handleRequest(message.request);
        return;
      case 'notification':
        this.dispatchNotification(message.notification);
        return;
      case 'response':
        this.settleResponse(message.response);
        return;
      case 'invalid':
        this.log(`[ddviz] ${message.reason}: ${line.slice(0, 120)}`);
        return;
      default: {
        const unexpected: never = message;
        this.log(`[ddviz] unhandled message kind: ${JSON.stringify(unexpected)}`);
      }
    }
  }

  /** Dispatch a JSON-RPC request to its handler and reply with result or error. */
  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    const { id, method, params } = request;
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      await this.respondError(id, -32601, `Method not found: ${method}`);
      return;
    }
    this.pendingRequests++;
    try {
      const result = await handler(params, id);
      await this.respond(id, result);
    } catch (err) {
      await this.respondError(id, -32000, stringifyError(err));
    } finally {
      this.pendingRequests--;
      if (this.pendingRequests === 0) this.onRequestDrained?.();
    }
  }

  /**
   * Resolves once no proxied request has been in flight for `quietMs`
   * continuously. Never resolves while a request is live, so a snapshot taken
   * afterwards always reflects a fully-settled render.
   */
  waitForQuiescence(quietMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;

      // Arm (or reset) the quiescence countdown. Invoked on every drain-to-zero
      // and once at the start if already quiet.
      const arm = () => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          if (this.pendingRequests > 0) return;
          this.onRequestDrained = null;
          resolve();
        }, quietMs);
      };

      this.onRequestDrained = arm;
      if (this.pendingRequests === 0) arm();
    });
  }

  /** Dispatch a JSON-RPC notification (fire-and-forget; no response is sent). */
  private dispatchNotification(notification: JsonRpcNotification): void {
    const { method, params } = notification;
    if (method === INITIALIZED_NOTIFICATION) {
      this.onInitialized?.();
      return;
    }
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.log(`[ddviz] unhandled notification: ${method}`);
      return;
    }
    void Promise.resolve(handler(params, undefined)).catch((err: unknown) => {
      this.log(`[ddviz] notification ${method} handler failed: ${stringifyError(err)}`);
    });
  }

  /** Resolve/reject the pending command (e.g. snapshot) keyed by the response id. */
  private settleResponse(response: JsonRpcResponse): void {
    const key = String(response.id);
    const pending = this.pendingCommands.get(key);
    if (!pending) {
      this.log(`[ddviz] response for unknown id: ${key}`);
      return;
    }
    this.pendingCommands.delete(key);
    if ('error' in response) {
      pending.reject(new Error(response.error.message || JSON.stringify(response.error)));
    } else {
      pending.resolve(response.result);
    }
  }

  private respond(id: JsonRpcId, result: unknown): Promise<void> {
    return this.writeJsonRpc({ jsonrpc: '2.0', id, result });
  }

  private respondError(id: JsonRpcId, code: number, message: string): Promise<void> {
    return this.writeJsonRpc({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /** Serialize and write a single JSON-RPC message as a newline-delimited line. */
  private writeJsonRpc(message: JsonRpcMessage): Promise<void> {
    return this.write(message);
  }

  /** Low-level writer: JSON-serialize an arbitrary payload and write one line. */
  private write(payload: unknown): Promise<void> {
    return new Promise((resolveWrite, rejectWrite) => {
      const child = this.child;
      if (!child || !child.stdin.writable) {
        rejectWrite(new Error('ddviz stdin is not writable'));
        return;
      }
      child.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
        if (err) rejectWrite(err);
        else resolveWrite();
      });
    });
  }
}
