/**
 * Activation gate for the ddviz client.
 *
 * ddviz relies on a macOS WebView host driven through the Swift toolchain, so
 * the runtime is only available on recent macOS with `swift` on PATH.
 *
 * It's also opt-in while in preview in feature-flagging is not yet implemented
 * on server-side: set DDVIZ_ENABLED=1 (or "true") to turn it on.
 */

import { spawnSync } from 'node:child_process';
import { release } from 'node:os';

export interface ActivationStatus {
  ok: boolean;
  reason?: string;
}

const isEnabledByEnv = (): boolean => {
  const value = (process.env.DDVIZ_ENABLED ?? '').toLowerCase();
  return value === '1' || value === 'true';
};

/**
 * Whether the current machine is capable of running ddviz at all (OS version,
 * Xcode Command Line Tools, swift toolchain), independent of the opt-in
 * feature flag.
 */
export const checkSupport = (): ActivationStatus => {
  switch (process.platform) {
    case 'darwin': {
      const MIN_DARWIN_MAJOR = 22; // macOS 13
      const version = release();
      const major = parseInt(version.split('.')[0] ?? '', 10);
      if (!Number.isInteger(major) || major < MIN_DARWIN_MAJOR) {
        return { ok: false, reason: `ddviz requires macOS 13 or later (detected Darwin kernel ${version})` };
      }
      // check Xcode Command Line Tools are installed
      if (spawnSync('xcode-select', ['-p']).status !== 0) {
        return { ok: false, reason: 'ddviz requires the Xcode Command Line Tools (run `xcode-select --install`)' };
      }
      // check swift toolchain is available
      if (spawnSync('which', ['swift']).status !== 0) {
        return { ok: false, reason: 'ddviz requires the Swift toolchain (swift not found on PATH)' };
      }
      return { ok: true };
    }
    default:
      return { ok: false, reason: `ddviz unsupported on current platform: ${process.platform}` };
  }
};

const computeActivationStatus = (): ActivationStatus => {
  if (!isEnabledByEnv()) {
    return { ok: false, reason: 'ddviz is disabled (set DDVIZ_ENABLED=1 to enable)' };
  }

  return checkSupport();
};

// Check whether the ddviz client is activated and supported. The result is
// memoized because it shells out to sync subprocesses and activation does not
// change during a session.
let cachedStatus: ActivationStatus | undefined;
export const checkActivation = (): ActivationStatus => (cachedStatus ??= computeActivationStatus());
