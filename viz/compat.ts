/**
 * Activation gate and machine diagnostics for the ddviz client.
 *
 * ddviz relies on a macOS WebView host driven through the Swift toolchain, so
 * the runtime is only available on recent macOS with `swift` on PATH.
 *
 * It's also opt-in while in preview, since server-side feature-flagging is
 * not yet implemented: set DDVIZ_ENABLED=1 (or "true") to turn it on.
 *
 * `checkSupportDiagnostics` serves both the activation gate and the
 * /datadog ddviz status report, so the two can never disagree.
 */

import { spawnSync } from 'node:child_process';
import { release } from 'node:os';

export interface ActivationStatus {
  ok: boolean;
  reason?: string;
}

export interface DiagnosticCheck {
  state: 'ok' | 'warn' | 'fail' | 'skipped';
  detail: string;
  nextAction?: string;
}

export type SupportDiagnostics = Record<'platform' | 'xcodeTools' | 'swift', DiagnosticCheck>;

interface SupportProbe {
  platform: string;
  kernelRelease: string;
  run(command: string, args: string[]): { status: number | null; stdout: string };
}

export const isEnabledByEnv = (): boolean => {
  const value = (process.env.DDVIZ_ENABLED ?? '').toLowerCase();
  return value === '1' || value === 'true';
};

/** Prerequisites shared by activation and diagnostics, independent of the temporary feature gate. */
export const checkSupportDiagnostics = (
  probe: SupportProbe = {
    platform: process.platform,
    kernelRelease: release(),
    run: (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 3_000 }),
  },
): SupportDiagnostics => {
  const major = parseInt(probe.kernelRelease.split('.')[0] ?? '', 10);
  if (probe.platform !== 'darwin' || !Number.isInteger(major) || major < 22) {
    return {
      platform: {
        state: 'fail',
        detail:
          probe.platform === 'darwin'
            ? `ddviz requires macOS 13 or later (detected Darwin kernel ${probe.kernelRelease})`
            : `ddviz unsupported on current platform: ${probe.platform}`,
        nextAction:
          probe.platform === 'darwin'
            ? 'Use macOS 13 or later for ddviz; Datadog text results remain available.'
            : 'ddviz is only supported on macOS.',
      },
      xcodeTools: { state: 'skipped', detail: 'unsupported platform' },
      swift: { state: 'skipped', detail: 'unsupported platform' },
    };
  }
  const platform = { state: 'ok' as const, detail: `macOS (Darwin ${probe.kernelRelease})` };

  const xcode = probe.run('xcode-select', ['-p']);
  if (xcode.status !== 0) {
    return {
      platform,
      xcodeTools: {
        state: 'fail',
        detail: 'Xcode Command Line Tools not available',
        nextAction: 'Run `xcode-select --install`, then restart Pi.',
      },
      // Invoking Swift without Command Line Tools can open the macOS installer.
      swift: { state: 'skipped', detail: 'Xcode Command Line Tools unavailable' },
    };
  }

  const swiftProbe = probe.run('which', ['swift']);
  return {
    platform,
    xcodeTools: { state: 'ok', detail: xcode.stdout.trim() },
    swift:
      swiftProbe.status === 0
        ? { state: 'ok', detail: swiftProbe.stdout.trim() }
        : {
            state: 'fail',
            detail: 'Swift not found on PATH',
            nextAction: 'Install the Swift toolchain and make swift available on PATH, then restart Pi.',
          },
  };
};

const checkSupport = (): ActivationStatus => {
  const failure = Object.values(checkSupportDiagnostics()).find((check) => check.state === 'fail');
  return failure ? { ok: false, reason: `${failure.detail}. ${failure.nextAction}` } : { ok: true };
};

const computeActivationStatus = (): ActivationStatus & { enabled: boolean } => {
  const enabled = isEnabledByEnv();
  return enabled
    ? { ...checkSupport(), enabled }
    : { ok: false, enabled, reason: 'ddviz is disabled (set DDVIZ_ENABLED=1 to enable)' };
};

// Activation is fixed for this extension instance; status must report the same gate decision.
let cachedStatus: ReturnType<typeof computeActivationStatus> | undefined;
export const checkActivation = (): ReturnType<typeof computeActivationStatus> =>
  (cachedStatus ??= computeActivationStatus());
