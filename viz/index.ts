// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Box, Image, Spacer, Text } from '@earendil-works/pi-tui';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { McpClient } from '../mcp-client.js';
import type { SubtoolOverrides } from '../tools/proxy.js';
import type { SubtoolConfig } from '../tools/types.js';
import { createLogger, DdvizClient, type Logger, type ScreenshotResult } from './client.js';
import { checkActivation } from './compat.js';

import type { JsonRpcNotification } from './jsonrpc2.js';

// Keyboard shortcut to toggle the Datadog visualization panel.
export const DDVIZ_TOGGLE_SHORTCUT = 'ctrl+shift+o';

// Free-form viz metadata stored in `ProxyDetails.subtoolData`.
interface VizSubtoolData {
  phase?: 'fetching' | 'rendering';
  toolResult?: CallToolResult;
  args?: Record<string, unknown>;
  screenshot?: ScreenshotResult;
}

/** Required window of request silence before snapshotting. */
const SCREENSHOT_QUIET_MS = 3_000;
/** Screenshot capture timeout. */
const SCREENSHOT_TIMEOUT_MS = 10_000;
// Shut down the headless client after this many ms of queue inactivity.
const IDLE_SHUTDOWN_MS = 30_000;

// ── Screenshot Queue ────────────────────────────────────────────

interface QueueEntry {
  payload: JsonRpcNotification;
  signal?: AbortSignal;
  resolve: (result: ScreenshotResult) => void;
  reject: (err: Error) => void;
}

class ScreenshotQueue {
  private readonly headless: DdvizClient;
  private readonly log: Logger;
  private queue: QueueEntry[] = [];
  private stopped = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(mcp: McpClient | undefined, log: Logger) {
    this.log = log;
    this.headless = new DdvizClient({ isHeadless: true, log, mcp });
  }

  private scheduleIdleShutdown(): void {
    this.cancelIdleShutdown();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.log('[screenshot-queue] idle timeout — shutting down headless client');
      void this.headless.shutdown();
    }, IDLE_SHUTDOWN_MS);
  }

  private cancelIdleShutdown(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Remove `entry` by identity (never by index, since paths interleave across awaits); returns whether it was present. */
  private removeEntry(entry: QueueEntry): boolean {
    const idx = this.queue.indexOf(entry);
    if (idx === -1) {
      return false;
    }
    this.queue.splice(idx, 1);
    return true;
  }

  enqueue(payload: JsonRpcNotification, signal?: AbortSignal): Promise<ScreenshotResult> {
    if (this.stopped) {
      return Promise.reject(new Error('ScreenshotQueue is stopped'));
    }
    this.cancelIdleShutdown();
    return new Promise<ScreenshotResult>((resolve, reject) => {
      const entry: QueueEntry = { payload, signal, resolve, reject };
      if (signal) {
        const onAbort = () => {
          if (this.removeEntry(entry)) {
            reject(new Error('aborted'));
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.queue.push(entry);
      if (this.queue.length === 1) {
        void this.processNext();
      }
    });
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.cancelIdleShutdown();
    for (const entry of this.queue) {
      entry.reject(new Error('ScreenshotQueue shutting down'));
    }
    this.queue.length = 0;
    await this.headless.shutdown();
  }

  private async processNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.scheduleIdleShutdown();
      return;
    }
    const entry = this.queue[0];
    if (entry.signal?.aborted || this.stopped) {
      this.removeEntry(entry);
      entry.reject(new Error('aborted'));
      return this.processNext();
    }
    try {
      this.log('[screenshot-queue] forwarding payload...');
      await this.headless.forward(entry.payload);

      this.log('[screenshot-queue] waiting for quiescence...');
      await this.headless.waitForQuiescence(SCREENSHOT_QUIET_MS);

      this.log('[screenshot-queue] capturing...');
      const screenshot = await this.headless.screenshot(SCREENSHOT_TIMEOUT_MS);
      entry.resolve(screenshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[screenshot-queue] error: ${msg}`);
      entry.reject(err instanceof Error ? err : new Error(msg));
    }
    this.removeEntry(entry);
    void this.processNext();
  }
}

// Image sizing (terminal rows / cells).
const IMAGE_EXPANDED = { maxHeightCells: 24, maxWidthCells: 160 } as const;

/**
 * Upstream Datadog tools whose results carry structuredContent the viz panel
 * can render. The entry point iterates this list to register a subtool override
 * per name; the restore guard reuses it to recognize replayable widgets.
 */
const VizToolNames = ['get_widget', 'visualize_tabular_data'] as const;

/** Wrap a CallToolResult as the JSON-RPC notification the Swift IPCStdioAdapter expects. */
const toToolResultNotification = (raw: CallToolResult): JsonRpcNotification => ({
  jsonrpc: '2.0',
  method: 'ui/notifications/tool-result',
  params: raw,
});

/** Build the viz override (execute + render) for a single upstream tool. */
const createSubtool = (
  client: DdvizClient,
  screenshotQueue: ScreenshotQueue,
  toolName: string,
  log: Logger,
): SubtoolConfig => ({
  async execute(_toolCallId, params, signal, onUpdate, ctx, mcp) {
    const emitPhase = (phase: VizSubtoolData['phase']) =>
      onUpdate?.({
        content: [],
        details: { state: 'called', tool: params.tool!, isError: false, subtoolData: { phase } as VizSubtoolData },
      });

    emitPhase('fetching');
    const raw = await mcp.callTool(params.tool!, params.args);
    const text = raw.content.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');

    // Only widgets carry structured content, and renderResult only runs in TUI mode.
    if (!raw.structuredContent || ctx.mode !== 'tui') {
      return {
        content: [{ type: 'text', text }],
        details: {
          state: 'called',
          tool: params.tool!,
          isError: raw.isError ?? false,
          structuredContent: raw.structuredContent,
        },
      };
    }

    const notification = toToolResultNotification(raw);

    void client.forward(notification);

    emitPhase('rendering');
    let screenshot: ScreenshotResult | undefined;
    try {
      screenshot = await screenshotQueue.enqueue(notification, signal);
      log(`screenshot OK: ${screenshot.data.length} chars`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`screenshot error: ${msg}`);
    }

    const subtoolData: VizSubtoolData = { toolResult: raw, args: params.args, screenshot: screenshot };
    return {
      content: [{ type: 'text', text }],
      details: {
        state: 'called',
        tool: params.tool!,
        isError: raw.isError ?? false,
        structuredContent: raw.structuredContent,
        subtoolData: subtoolData,
      },
    };
  },
  renderResult(result, options, theme, context) {
    const details = result.details;
    const subtoolData = ('subtoolData' in details ? details.subtoolData : undefined) as VizSubtoolData | undefined;
    const phase = subtoolData?.phase;
    const screenshot = subtoolData?.screenshot;

    const { isPartial, isError, showImages } = context;
    const { expanded } = options;

    const bgKey = isPartial ? 'toolPendingBg' : isError ? 'toolErrorBg' : 'toolSuccessBg';
    const box = new Box(1, 1, (s) => theme.bg(bgKey, s));

    const header = theme.fg('accent', theme.bold('\ud83d\udc36 Datadog Widget'));
    let phaseLabel: string;
    switch (phase) {
      case 'fetching':
        phaseLabel = 'fetching\u2026';
        break;
      case 'rendering':
        phaseLabel = 'rendering\u2026';
        break;
      default:
        phaseLabel = 'loading\u2026';
    }
    const status = isPartial
      ? theme.fg('muted', `  \u23f3 ${phaseLabel}`)
      : isError
        ? theme.fg('error', '  \u2717 failed')
        : theme.fg('success', '  \u2713');

    box.addChild(new Text(`${header}${status}`, 0, 0));

    const imageSize = IMAGE_EXPANDED;
    if (isError) {
      // Header status already shows the failure; nothing else to render.
    } else if (isPartial) {
      if (showImages) {
        // A screenshot may still be coming; reserve its footprint so the panel doesn't jump.
        box.addChild(new Spacer(1));
        box.addChild(new Spacer(imageSize.maxHeightCells));
        box.addChild(new Spacer(1));
      }
    } else if (showImages && screenshot) {
      const imageTheme = { fallbackColor: (s: string) => theme.fg('muted', s) };
      box.addChild(new Spacer(1));
      box.addChild(new Image(screenshot.data, screenshot.mimeType, imageTheme, imageSize));
      box.addChild(new Spacer(1));
      box.addChild(
        new Text(theme.fg('muted', `Press ${theme.bold(DDVIZ_TOGGLE_SHORTCUT)} to open the interactive panel`), 0, 0),
      );
    } else {
      // No inline image (disabled, unsupported terminal, or capture failed) — skip the
      // large placeholder and point straight at the interactive panel shortcut.
      box.addChild(
        new Text(
          theme.fg('muted', `Press ${theme.bold(DDVIZ_TOGGLE_SHORTCUT)} to view this chart in the interactive panel`),
          0,
          0,
        ),
      );
    }

    // Expanded: tool call details.
    if (expanded && !isPartial && !isError) {
      const args = subtoolData?.args;
      const toolLabel = theme.fg('muted', `Tool: ${theme.bold(toolName)}`);
      box.addChild(new Text(toolLabel, 0, 0));
      if (args && Object.keys(args).length > 0) {
        const argsLabel = theme.fg('muted', `Args: ${JSON.stringify(args)}`);
        box.addChild(new Text(argsLabel, 0, 0));
      }

      // Full textual tool output below the image.
      const firstContent = result.content[0];
      const text = firstContent.type === 'text' ? firstContent.text.replace(/\r/g, '') : '';
      if (text) {
        box.addChild(new Spacer(1));
        box.addChild(new Text(theme.fg('toolOutput', text), 0, 0));
      }
    }
    return box;
  },
});

/**
 * Initialise the viz integration on compatible platforms and return the subtool
 * override map for the proxy. Returns null on unsupported hosts so the proxy
 * degrades to text-only without extra checks at the call site.
 */
export const initVizRuntime = (pi: ExtensionAPI, mcp: McpClient | undefined): SubtoolOverrides | null => {
  const isDebug = process.env.DDVIZ_DEBUG === '1';
  const log = createLogger(isDebug);

  const activation = checkActivation();
  if (!activation.ok) {
    log(`[viz] disabled: ${activation.reason}`);
    return null;
  }

  const client = new DdvizClient({ log, isDebug, mcp });
  const screenshotQueue = new ScreenshotQueue(mcp, log);

  pi.registerShortcut(DDVIZ_TOGGLE_SHORTCUT, {
    description: 'Toggle Datadog visualization panel',
    handler: () => {
      void client.toggle();
    },
  });

  pi.on('session_shutdown', async () => {
    log('[viz] session_shutdown — stopping screenshot queue');
    await screenshotQueue.shutdown();
  });

  client.setRequestHandler('ui/update-model-context', async (_params) => {
    // pi does not allow updating the next prompt message yet.
  });

  return Object.fromEntries(VizToolNames.map((name) => [name, createSubtool(client, screenshotQueue, name, log)]));
};
