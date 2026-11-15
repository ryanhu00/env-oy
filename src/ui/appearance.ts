import { execFile } from 'child_process';
import type { Appearance, ThemeSetting } from './theme';

/** Runs a command and resolves its stdout, or rejects with an error carrying `code`. */
export type RunCommand = (file: string, args: string[]) => Promise<string>;

const runCommand: RunCommand = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 2000, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });

/**
 * Parses COLORFGBG ("fg;bg" or "fg;default;bg"), which many terminals export.
 * @param value Raw COLORFGBG value.
 * @returns The appearance implied by the background color index, or undefined.
 */
export function parseColorFgBg(value: string | undefined): Appearance | undefined {
  if (!value) return undefined;
  const bg = Number(value.split(';').pop());
  if (!Number.isInteger(bg) || bg < 0 || bg > 15) return undefined;
  // ANSI 0-6 and 8 are dark backgrounds; 7 and 9-15 are light
  return bg === 7 || bg >= 9 ? 'light' : 'dark';
}

/**
 * Reads the user's forced appearance from ENVOY_THEME.
 * @param value Raw value (light | dark | auto).
 * @returns 'light' or 'dark' when forced; undefined for auto/unset/invalid.
 */
export function forcedAppearance(value: string | undefined): Appearance | undefined {
  const v = (value ?? '').trim().toLowerCase();
  return v === 'light' || v === 'dark' ? v : undefined;
}

/**
 * Asks the operating system for its light/dark setting.
 * @param platform Node platform name.
 * @param run Command runner (injectable for tests).
 * @returns The system appearance, or undefined when it cannot be determined.
 */
export async function systemAppearance(platform: NodeJS.Platform = process.platform, run: RunCommand = runCommand): Promise<Appearance | undefined> {
  if (platform === 'darwin') {
    try {
      return /dark/i.test(await run('defaults', ['read', '-g', 'AppleInterfaceStyle'])) ? 'dark' : 'light';
    } catch (error) {
      // the key only exists in dark mode: a plain non-zero exit means light mode
      return (error as { code?: unknown }).code === 1 ? 'light' : undefined;
    }
  }
  if (platform === 'linux') {
    try {
      const scheme = await run('gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme']);
      if (/prefer-dark/.test(scheme)) return 'dark';
      if (/prefer-light|default/.test(scheme)) return 'light';
    } catch {}
  }
  return undefined;
}

/**
 * Resolves the appearance to paint with: ENVOY_THEME if forced, else the configured `theme`,
 * else the system setting, else the terminal's COLORFGBG hint, else dark.
 * @param env Environment (injectable for tests).
 * @param platform Node platform name.
 * @param run Command runner.
 * @param configured The `theme` config value ('auto' follows the system).
 * @returns 'light' or 'dark'.
 */
export async function detectAppearance(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  run: RunCommand = runCommand,
  configured: ThemeSetting = 'auto'
): Promise<Appearance> {
  const forced = forcedAppearance(env.ENVOY_THEME) ?? forcedAppearance(configured);
  if (forced) return forced;
  return (await systemAppearance(platform, run)) ?? parseColorFgBg(env.COLORFGBG) ?? 'dark';
}
