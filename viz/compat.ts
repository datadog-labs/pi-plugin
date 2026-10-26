/**
 * Platform activation and machine diagnostics for the ddviz client.
 *
 * ddviz is enabled by default on compatible Macs; other hosts stay text-only.
 *
 * Activation (`checkActivation`) answers "could this machine ever run ddviz?"
 * using only the OS checks — no subprocesses, safe at startup. The full
 * toolchain diagnostics (`checkSupportDiagnostics`) probe Xcode tools and Swift
 * lazily: the first caller (a chart to render, or /datadog ddviz) pays for the
 * probes, and the result is shared for the session.
 */

import { execFile } from 'node:child_process';
import { release } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Bound lazy probes, allowing extra time for Swift's cold toolchain startup. */
const XCODE_SELECT_TIMEOUT_MS = 3_000;
const SWIFT_VERSION_TIMEOUT_MS = 10_000;
/** Use the same PATH lookup as DdvizClient's chart launcher. */
const SWIFT_EXECUTABLE = 'swift';
/** ddviz.swift uses shorthand syntax (`if let x { }`) introduced in Swift 5.7. */
const MIN_SWIFT_VERSION = { major: 5, minor: 7 };

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

/** OS verdict without any subprocess, shared by activation and full diagnostics. */
const platformCheck = (platform: string, kernelRelease: string): DiagnosticCheck => {
  const major = parseInt(kernelRelease.split('.')[0] ?? '', 10);
  if (platform !== 'darwin' || !Number.isInteger(major) || major < 22) {
    return {
      state: 'fail',
      detail:
        platform === 'darwin'
          ? `ddviz requires macOS 13 or later (detected Darwin kernel ${kernelRelease})`
          : `ddviz unsupported on current platform: ${platform}`,
      nextAction:
        platform === 'darwin'
          ? 'Use macOS 13 or later for ddviz; Datadog text results remain available.'
          : 'ddviz is only supported on macOS.',
    };
  }
  return { state: 'ok', detail: `macOS (Darwin ${kernelRelease})` };
};

export interface SupportProbe {
  platform: string;
  kernelRelease: string;
  run: (command: string, args: string[]) => Promise<{ status: number | null; stdout: string }>;
}

const defaultProbe: SupportProbe = {
  platform: process.platform,
  kernelRelease: release(),
  run: async (command, args) => {
    try {
      const timeout = command === SWIFT_EXECUTABLE ? SWIFT_VERSION_TIMEOUT_MS : XCODE_SELECT_TIMEOUT_MS;
      const { stdout } = await execFileAsync(command, args, { timeout, maxBuffer: 64 * 1024 });
      return { status: 0, stdout };
    } catch (error) {
      const failure = error as { code?: number | string; stdout?: string };
      return { status: typeof failure.code === 'number' ? failure.code : null, stdout: failure.stdout ?? '' };
    }
  },
};

/** Parse `swift --version`'s first line ("... Swift version 6.4 ...") into major.minor. */
export const parseSwiftVersion = (stdout: string): { major: number; minor: number } | undefined => {
  const match = /Swift version (\d+)\.(\d+)/.exec(stdout.trim().split('\n')[0] ?? '');
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
};

const isSupportedSwift = (version: { major: number; minor: number }): boolean =>
  version.major > MIN_SWIFT_VERSION.major ||
  (version.major === MIN_SWIFT_VERSION.major && version.minor >= MIN_SWIFT_VERSION.minor);

/**
 * Full prerequisite diagnostics: platform, Xcode Command Line Tools, and a
 * usable Swift of the minimum version. Probing is lazy — never call this at
 * startup — and each tool is probed only when the previous one passed, so a
 * missing developer directory can never trigger the macOS installer.
 */
export const checkSupportDiagnostics = async (probe: SupportProbe = defaultProbe): Promise<SupportDiagnostics> => {
  const platform = platformCheck(probe.platform, probe.kernelRelease);
  if (platform.state === 'fail') {
    return {
      platform,
      xcodeTools: { state: 'skipped', detail: 'unsupported platform' },
      swift: { state: 'skipped', detail: 'unsupported platform' },
    };
  }

  const xcode = await probe.run('xcode-select', ['-p']);
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
  const xcodeTools = { state: 'ok' as const, detail: xcode.stdout.trim() };

  const version = await probe.run(SWIFT_EXECUTABLE, ['--version']);
  if (version.status !== 0) {
    return {
      platform,
      xcodeTools,
      swift: {
        state: 'fail',
        detail: 'swift --version failed or timed out',
        nextAction: 'Run `swift --version` in your terminal and resolve the toolchain error, then restart Pi.',
      },
    };
  }
  const parsed = parseSwiftVersion(version.stdout);
  const swift: DiagnosticCheck = !parsed
    ? { state: 'ok', detail: `${SWIFT_EXECUTABLE} (version unavailable)` }
    : isSupportedSwift(parsed)
      ? { state: 'ok', detail: `${SWIFT_EXECUTABLE} (${version.stdout.trim().split('\n')[0]})` }
      : {
          state: 'fail',
          detail: `Swift ${parsed.major}.${parsed.minor} is too old for ddviz (needs ${MIN_SWIFT_VERSION.major}.${MIN_SWIFT_VERSION.minor}+)`,
          nextAction: 'Install a recent Swift toolchain, then restart Pi.',
        };
  return { platform, xcodeTools, swift };
};

export const checkActivation = (
  probe: Pick<SupportProbe, 'platform' | 'kernelRelease'> = defaultProbe,
): ActivationStatus => {
  const platform = platformCheck(probe.platform, probe.kernelRelease);
  return platform.state === 'ok' ? { ok: true } : { ok: false, reason: `${platform.detail}. ${platform.nextAction}` };
};
