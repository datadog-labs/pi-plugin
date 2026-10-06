import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { getCapabilities, type ImageProtocol } from '@earendil-works/pi-tui';
import { DEFAULT_DDVIZ_SCRIPT, type DdvizClientStatus } from './client.js';
import { profileLabel } from '../config.js';
import { errorMessage, SignInRequired } from '../connection-errors.js';
import type { Connections } from '../connections.js';
import {
  checkSupportDiagnostics,
  type ActivationStatus,
  type DiagnosticCheck,
  type SupportDiagnostics,
} from './compat.js';

export interface VizRuntimeStatus {
  interactive: DdvizClientStatus;
  screenshots: DdvizClientStatus;
}

export interface LocalDdvizStatus {
  enabled: boolean;
  supported: boolean;
  available: boolean;
  activation: ActivationStatus & { enabled: boolean };
  checks: SupportDiagnostics & { bundle: DiagnosticCheck; terminalImages: DiagnosticCheck };
  runtime: VizRuntimeStatus;
}

/** Result of the live server check; `formatLocalDdvizStatus` prints it on its own line. */
export type ServerAvailability = DiagnosticCheck;

const SERVER_CHECK_TIMEOUT_MS = 15_000;

// Stop waiting at the bound; the queued connection work itself keeps running.
const withTimeout = <T>(value: Promise<T>, timeout: AbortSignal): Promise<T> =>
  Promise.race([
    value,
    new Promise<never>((_, reject) => {
      timeout.addEventListener(
        'abort',
        () => {
          reject(timeout.reason instanceof Error ? timeout.reason : new Error(String(timeout.reason)));
        },
        { once: true },
      );
    }),
  ]);

/** Check the selected organization is reachable, without signing in or switching it. */
export const checkServerAvailability = async (connections: Connections): Promise<ServerAvailability> => {
  const timeout = new AbortController();
  // Ref'd so the event loop cannot drain while the check waits, and cleared the
  // moment the check settles (an unref'd AbortSignal.timeout lingers instead).
  const timer = setTimeout(() => {
    timeout.abort(new DOMException('connection check timed out', 'TimeoutError'));
  }, SERVER_CHECK_TIMEOUT_MS);
  try {
    // `current` can also reject (invalid selection); that too belongs in the
    // server row rather than failing the whole report.
    const selected = await withTimeout(connections.current(), timeout.signal);
    if (!selected)
      return { state: 'fail', detail: 'no organization selected', nextAction: 'Open /datadog to connect.' };
    const { profile } = await withTimeout(connections.check(timeout.signal), timeout.signal);
    return { state: 'ok', detail: `connected to ${profileLabel(profile)} · ${profile.domain}` };
  } catch (error) {
    if (error instanceof SignInRequired)
      return { state: 'fail', detail: 'sign-in required', nextAction: 'Open /datadog and choose “Sign in again”.' };
    if (error instanceof Error && error.name === 'TimeoutError')
      return {
        state: 'fail',
        detail: 'connection check timed out',
        nextAction: 'Check your network connection and retry.',
      };
    return { state: 'fail', detail: errorMessage(error), nextAction: 'Open /datadog to review the connection.' };
  } finally {
    clearTimeout(timer);
  }
};

interface StatusProbes {
  support(): SupportDiagnostics;
  swiftVersion(): Promise<string>;
  terminalImages(): ImageProtocol;
  scriptPath: string;
}

const execFileAsync = promisify(execFile);
const defaultProbes: StatusProbes = {
  support: checkSupportDiagnostics,
  swiftVersion: async () => {
    const { stdout } = await execFileAsync('swift', ['--version'], { timeout: 3_000, maxBuffer: 64 * 1024 });
    return stdout.trim().split('\n')[0];
  },
  terminalImages: () => getCapabilities().images,
  scriptPath: DEFAULT_DDVIZ_SCRIPT,
};

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

export const readLocalDdvizStatus = async (
  activation: ActivationStatus & { enabled: boolean },
  getRuntime: () => VizRuntimeStatus,
  probes: StatusProbes = defaultProbes,
): Promise<LocalDdvizStatus> => {
  const support = probes.support();
  // Activation checks PATH only. Status also diagnoses an installed but unusable toolchain.
  if (support.swift.state === 'ok') {
    try {
      const version = await probes.swiftVersion();
      support.swift = { state: 'ok', detail: `${version || 'version unknown'} (${support.swift.detail})` };
    } catch {
      support.swift = {
        state: 'fail',
        detail: 'swift --version failed or timed out',
        nextAction: 'Run `swift --version` in your terminal and resolve the toolchain error, then restart Pi.',
      };
    }
  }

  const root = dirname(probes.scriptPath);
  const requiredFiles = [probes.scriptPath, join(root, 'assets', 'mcp-host.html')];
  const missing = requiredFiles.filter((path) => !isFile(path));
  const bundle: DiagnosticCheck =
    missing.length > 0
      ? {
          state: 'fail',
          detail: `missing files: ${missing.join(', ')}`,
          nextAction: 'Reinstall the Datadog Pi plugin, or rebuild the bundle.',
        }
      : { state: 'ok', detail: root };
  // Inline screenshots never block the panel: they are an extra rendering path.
  const protocol = probes.terminalImages();
  const terminalImages: DiagnosticCheck = protocol
    ? {
        state: 'ok',
        detail: `supported (${protocol === 'kitty' ? 'kitty graphics' : 'iTerm2'} protocol; needs Pi's show-images setting on)`,
      }
    : { state: 'warn', detail: 'not supported in this terminal — charts still render in the interactive panel' };
  // A failed screenshot runtime only matters where screenshots can display;
  // its row is already hidden on terminals without an image protocol.
  const screenshotsApplicable = protocol !== null;
  const supported = Object.values(support).every((check) => check.state === 'ok');
  const runtime = getRuntime();
  return {
    enabled: activation.enabled,
    supported,
    available:
      activation.ok &&
      supported &&
      bundle.state === 'ok' &&
      runtime.interactive.state !== 'failed' &&
      (!screenshotsApplicable || runtime.screenshots.state !== 'failed'),
    activation,
    checks: { ...support, bundle, terminalImages },
    runtime,
  };
};

const formatRuntime = (status: DdvizClientStatus): string => {
  const pid = status.pid === undefined ? '' : ` (pid ${status.pid})`;
  switch (status.state) {
    case 'not-started':
      return 'not started — starts on the first chart';
    case 'starting':
      return `starting${pid} — waiting for initialization`;
    case 'running':
      return `running${pid}`;
    case 'stopped':
      return 'idle — wakes up on the next chart';
    case 'failed':
      return `failed — ${status.error ?? 'unknown runtime error'}`;
  }
};

const serverLine = (server: ServerAvailability | undefined): string =>
  server
    ? `Datadog server availability: ${server.state} — ${server.detail}`
    : 'Datadog server availability: not checked.';

export const formatLocalDdvizStatus = (
  status: LocalDdvizStatus,
  shortcutLabel: string,
  server?: ServerAvailability,
): string => {
  // Unsupported OS: stop at the platform verdict — toolchain, bundle, and panel
  // rows are meaningless there (Claude Code's status script does the same).
  // Server availability is platform-independent; a failure keeps its own count and fix.
  if (status.checks.platform.state === 'fail') {
    const platform = status.checks.platform;
    const fixes = [platform.nextAction, ...(server?.state === 'fail' && server.nextAction ? [server.nextAction] : [])];
    return [
      'ddviz: not supported',
      '',
      `Platform: fail — ${platform.detail}`,
      serverLine(server),
      '',
      `blocking: ${fixes.length}`,
      ...fixes.map((fix) => `Next: ${fix}`),
    ].join('\n');
  }
  // Claude's first line answers "is it on?"; ours answers "can this machine render charts?",
  // since the gate being on is implied by the command being reachable at all.
  const lines = [`ddviz: ${status.available ? 'supported' : 'not supported'}`, ''];
  // Panel rows (inline images, runtime, screenshots) and panel hints only
  // make sense when the panel could actually run: toolchain present and bundle intact.
  const panelPossible = !(['xcodeTools', 'swift', 'bundle'] as const).some(
    (key) => status.checks[key].state === 'fail',
  );
  const labels = {
    platform: 'Platform',
    xcodeTools: 'Xcode tools',
    swift: 'Swift',
    bundle: 'Bundle',
    terminalImages: 'Inline images',
  };
  const rowKeys = (
    ['platform', 'xcodeTools', 'swift', 'bundle', ...(panelPossible ? ['terminalImages'] : [])] as const
  ).filter((key): key is keyof typeof labels => key in labels);
  for (const key of rowKeys) {
    const check = status.checks[key];
    lines.push(`${labels[key]}: ${check.state} — ${check.detail}`);
  }
  if (panelPossible) {
    lines.push(`Runtime: ${status.activation.ok ? formatRuntime(status.runtime.interactive) : 'inactive'}`);
    // Screenshots only exist to render inline via the terminal image protocol;
    // without it (e.g. Terminal.app) the row would only invite confusion.
    if (status.checks.terminalImages.state === 'ok') {
      lines.push(`Screenshots: ${status.activation.ok ? formatRuntime(status.runtime.screenshots) : 'inactive'}`);
    }
  }
  lines.push(serverLine(server));

  // Claude-style verdict: a plain count of failures instead of an aggregate label.
  // Runtime failures count only when their rows are shown (panel can run and, for
  // screenshots, the terminal can display them).
  const screenshotsShown = status.checks.terminalImages.state === 'ok';
  const blocking =
    Object.values(status.checks).filter((check) => check.state === 'fail').length +
    (['interactive', 'screenshots'] as const).filter(
      (key) => panelPossible && status.runtime[key].state === 'failed' && (key === 'interactive' || screenshotsShown),
    ).length +
    (server?.state === 'fail' ? 1 : 0);
  lines.push('', `blocking: ${blocking}`);

  const fixes = Object.values(status.checks).flatMap((check) => (check.nextAction ? [check.nextAction] : []));
  if (status.enabled && !status.activation.ok && status.supported) {
    fixes.push('Restart Pi to recheck activation after fixing the prerequisites.');
  }
  if (
    panelPossible &&
    (status.runtime.interactive.state === 'failed' ||
      (screenshotsShown && status.runtime.screenshots.state === 'failed'))
  ) {
    fixes.push(
      'Generate another chart to retry. If it still fails, restart Pi with DDVIZ_DEBUG=1 and check /tmp/ddpi.log.',
    );
  }
  if (server?.nextAction) fixes.push(server.nextAction);
  if (fixes.length > 0) lines.push(...fixes.map((fix) => `Next: ${fix}`));
  if (panelPossible) {
    lines.push(
      '',
      'The interactive panel stays hidden until you open it; a running runtime does not mean the panel is visible.',
      `After generating a chart, press ${shortcutLabel} in Pi's editor to show the interactive panel.`,
    );
  }
  return lines.join('\n');
};
