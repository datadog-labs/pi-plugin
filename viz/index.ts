// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Box, Image, MouseRegion, Spacer, Text } from '@earendil-works/pi-tui';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { McpClient } from '../mcp-client.js';
import type { SubtoolOverrides } from '../tools/proxy.js';
import type { SubtoolConfig } from '../tools/types.js';
import {
  createLogger,
  DdvizClient,
  type DdvizClientOptions,
  type DdvizClientStatus,
  type Logger,
  type ScreenshotResult,
} from './client.js';
import { createUiMessageHandler } from './ui-message.js';
import { checkActivation } from './compat.js';
import { readLocalDdvizStatus, type LocalDdvizStatus } from './status.js';

import type { JsonRpcNotification } from './jsonrpc2.js';

// Keyboard shortcut to show the Datadog visualization panel.
export const DDVIZ_TOGGLE_SHORTCUT = 'shift+right';
// Human-readable form of the shortcut for rendered hints (the key id spells
// the arrow out, which reads like the letters r-i-g-h-t).
export const DDVIZ_TOGGLE_SHORTCUT_LABEL = 'Shift+→';

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

  getStatus(): DdvizClientStatus {
    return this.headless.getStatus();
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
type Runtime = { mcp: McpClient; client: DdvizClient; screenshotQueue: ScreenshotQueue };

const createSubtool = (
  toolName: string,
  log: Logger,
  getRuntime: (mcp: McpClient) => Promise<Runtime>,
  togglePanel: () => Promise<void>,
): SubtoolConfig => ({
  async execute(_toolCallId, params, signal, onUpdate, ctx, mcp) {
    const { client, screenshotQueue } = await getRuntime(mcp);
    const emitPhase = (phase: VizSubtoolData['phase']) =>
      onUpdate?.({
        content: [],
        details: { state: 'called', tool: params.tool!, isError: false, subtoolData: { phase } as VizSubtoolData },
      });

    emitPhase('fetching');
    const raw = await mcp.callTool(params.tool!, params.args, signal);
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

    // The shortcut toggles (the panel may already be open), and the menubar
    // icon is the second way back after a close.
    const panelHint = theme.fg(
      'muted',
      `Press ${theme.bold(DDVIZ_TOGGLE_SHORTCUT_LABEL)} to show the interactive panel, or click the Datadog menu-bar icon`,
    );

    const bgKey = isPartial ? 'toolPendingBg' : isError ? 'toolErrorBg' : 'toolSuccessBg';
    const box = new Box(1, 1, (s) => theme.bg(bgKey, s));

    const header = theme.fg(
      'accent',
      theme.bold(`Datadog Widget${details.profile ? ` · ${details.profile.label}` : ''}`),
    );
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
      box.addChild(new Text(panelHint, 0, 0));
    } else {
      // No inline image (disabled, unsupported terminal, or capture failed) — skip the
      // large placeholder and point straight at the interactive panel.
      box.addChild(new Text(panelHint, 0, 0));
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
      const text = result.content
        .filter((content) => content.type === 'text')
        .map((content) => content.text.replace(/\r/g, ''))
        .join('\n');
      if (text) {
        box.addChild(new Spacer(1));
        box.addChild(new Text(theme.fg('toolOutput', text), 0, 0));
      }
    }
    if (isPartial || isError || !subtoolData?.toolResult?.structuredContent || subtoolData.toolResult.isError) {
      return box;
    }
    // Handle fullscreen clicks before Pi's click-to-expand fallback, without
    // capturing selection or scrolling gestures.
    return new MouseRegion(box, (event) => {
      if (event.type !== 'click' || event.button !== 'left') return undefined;
      void togglePanel().catch((err: unknown) => {
        log(`[viz] click toggle failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      return { handled: true };
    });
  },
});

/** Options for `initVizRuntime`; tests inject the interactive client. */
export interface VizRuntimeOptions {
  createClient?: (options: DdvizClientOptions) => DdvizClient;
}

/**
 * Initialise the viz integration on compatible platforms and return the subtool
 * override map and a reset hook. Unsupported hosts stay text-only. Each runtime
 * is bound to an immutable client; switching discards both visible and headless UI.
 */
export const initVizRuntime = (
  pi: ExtensionAPI,
  options: VizRuntimeOptions = {},
): { enabled: boolean; subtools: SubtoolOverrides; reset(): Promise<void>; getStatus(): Promise<LocalDdvizStatus> } => {
  const isDebug = process.env.DDVIZ_DEBUG === '1';
  const log = createLogger(isDebug);
  let runtime: Runtime | undefined;
  let transition: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = transition.then(operation);
    transition = next.catch(() => undefined);
    return next;
  };
  const closeCurrent = async (): Promise<void> => {
    const previous = runtime;
    runtime = undefined;
    if (previous) {
      try {
        await previous.screenshotQueue.shutdown();
      } finally {
        await previous.client.shutdown();
      }
    }
  };
  const reset = () => serialize(closeCurrent);
  const activation = checkActivation();
  const getStatus = () =>
    readLocalDdvizStatus(activation, () => ({
      interactive: runtime?.client.getStatus() ?? { state: 'not-started' },
      screenshots: runtime?.screenshotQueue.getStatus() ?? { state: 'not-started' },
    }));
  if (!activation.ok) return { enabled: activation.enabled, subtools: {}, reset, getStatus };

  // Subscribe before session_start; clients are created lazily and replaced on org switches.
  const onUiMessage = createUiMessageHandler(pi);
  const getRuntime = (mcp: McpClient): Promise<Runtime> =>
    serialize(async () => {
      if (runtime?.mcp === mcp) return runtime;
      await closeCurrent();
      // pi lets the user open the panel on demand (Shift+Right Arrow, menubar icon).
      const clientOptions: DdvizClientOptions = { log, isDebug, mcp, isOpenedOnDemand: true };
      const client = options.createClient?.(clientOptions) ?? new DdvizClient(clientOptions);
      client.setRequestHandler('ui/message', onUiMessage);
      runtime = { mcp, client, screenshotQueue: new ScreenshotQueue(mcp, log) };
      return runtime;
    });
  const togglePanel = async (): Promise<void> => {
    await runtime?.client.toggle();
  };
  const toggleShortcut = { description: 'Show Datadog visualization panel', handler: togglePanel };
  pi.registerShortcut(DDVIZ_TOGGLE_SHORTCUT, toggleShortcut);
  // Session replacement (/new, /resume, reload) must not leave a stale panel
  // or menubar icon behind: tear the current runtime down like an org switch.
  pi.on('session_shutdown', async () => {
    log('[viz] session_shutdown — closing runtime');
    await reset();
  });

  return {
    enabled: activation.enabled,
    subtools: Object.fromEntries(VizToolNames.map((name) => [name, createSubtool(name, log, getRuntime, togglePanel)])),
    reset,
    getStatus,
  };
};
