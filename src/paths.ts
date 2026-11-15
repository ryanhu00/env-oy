import * as os from 'os';
import * as path from 'path';

/** Lowercase id used for paths, package name, and backup suffixes. */
export const APP_NAME = 'envoy';

/** User-facing product name. */
export const APP_DISPLAY_NAME = 'Envoy';

const ENV_PREFIX = 'ENVOY_';

/**
 * Reads an envoy env var.
 * @param suffix Env suffix such as `CMD`, `ID`, `EVENTS_DIR`, `RESTART_CHANNEL`, `NO_HOOK_PROMPT`.
 * @returns The value, or undefined when unset.
 */
export function envoyEnv(suffix: string): string | undefined {
  return process.env[`${ENV_PREFIX}${suffix}`];
}

/**
 * Builds a process env that exports envoy conductor variables for spawned sessions.
 * @param id Conductor session id.
 * @param eventsDir Events directory for hook delivery.
 * @returns Env object suitable for node-pty spawn.
 */
export function sessionChildEnv(id: string, eventsDir: string): { [key: string]: string } {
  return {
    ...process.env,
    [`${ENV_PREFIX}ID`]: id,
    [`${ENV_PREFIX}EVENTS_DIR`]: eventsDir,
  } as { [key: string]: string };
}

/**
 * Default private data directory (~/.local/share/envoy).
 * @returns Absolute data directory path.
 */
export function defaultDataDir(home = os.homedir()): string {
  return path.join(home, '.local', 'share', APP_NAME);
}

/**
 * Default config directory (~/.config/envoy).
 * @returns Absolute config directory path.
 */
export function defaultConfigDir(home = os.homedir()): string {
  return path.join(home, '.config', APP_NAME);
}

/**
 * Default envoy config file path.
 * @returns Absolute config.json path under the envoy config directory.
 */
export function defaultConfigPath(home = os.homedir()): string {
  return path.join(defaultConfigDir(home), 'config.json');
}

/**
 * Resolves the events/data directory from ENVOY_EVENTS_DIR or the default data dir.
 * @returns Absolute events directory path.
 */
export function resolveEventsDir(home = os.homedir()): string {
  return envoyEnv('EVENTS_DIR') || defaultDataDir(home);
}
