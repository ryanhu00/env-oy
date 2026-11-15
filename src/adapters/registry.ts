import * as fs from 'fs';
import * as path from 'path';
import { isOnPath } from '../hooks/installer';
import { createClaudeAdapter } from './claude';
import { createCodexAdapter } from './codex';
import { createDevinAdapter } from './devin';
import { ADAPTER_IDS, DEFAULT_ADAPTER_ID } from './types';
import type { AdapterId, CliAdapter } from './types';

export { ADAPTER_IDS, DEFAULT_ADAPTER_ID, sessionKey } from './types';

/** User preferences read from the Envoy config file. */
export interface AdapterSettings {
  /** CLIs to enable. When absent, every CLI found on PATH is enabled. */
  enabled?: readonly AdapterId[];
  /** CLI preselected in the new-session form. */
  default?: AdapterId;
  /** Executable per CLI, used unless that CLI's `ENVOY_*_CMD` env var is set. */
  commands?: Partial<Record<AdapterId, string>>;
}

export interface AdapterSelection {
  adapters: CliAdapter[];
  defaultAdapterId: AdapterId;
}

/**
 * Creates a fresh set of every adapter Envoy knows. Adapters hold per-instance caches, so each
 * manager or discovery instance gets its own set rather than sharing module-level state.
 * @param commands Optional executable override per CLI.
 * @returns One adapter per supported CLI, in canonical order.
 */
export function createAdapters(commands: Partial<Record<AdapterId, string>> = {}): CliAdapter[] {
  return [
    createDevinAdapter({ command: commands.devin }),
    createClaudeAdapter({ command: commands.claude }),
    createCodexAdapter({ command: commands.codex }),
  ];
}

/**
 * Checks whether a CLI's executable can be launched: an explicit path must be an executable
 * file, a bare name must be on PATH.
 * @param command Executable from the adapter.
 * @param pathEnv PATH value to search.
 * @returns True when the command resolves to an executable file.
 */
export function isCommandAvailable(command: string, pathEnv = process.env.PATH ?? ''): boolean {
  if (!command) return false;
  if (command.includes('/')) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return fs.statSync(command).isFile();
    } catch {
      return false;
    }
  }
  return isOnPath(path.basename(command), pathEnv);
}

/**
 * Chooses which CLIs Envoy drives. An explicit `enabled` list wins; otherwise every CLI that is
 * installed is used, so people only get the CLIs they actually have. If nothing is installed the
 * default CLI stays enabled so the app still starts and explains itself when spawning fails.
 * @param settings Config preferences.
 * @param pathEnv PATH value used to detect installed CLIs.
 * @returns Enabled adapters in canonical order and the CLI preselected for new sessions.
 */
export function selectAdapters(settings: AdapterSettings = {}, pathEnv = process.env.PATH ?? ''): AdapterSelection {
  const all = createAdapters(settings.commands);
  const explicit = settings.enabled ? ADAPTER_IDS.filter((id) => settings.enabled!.includes(id)) : [];
  let adapters = explicit.length > 0 ? all.filter((adapter) => explicit.includes(adapter.id)) : all.filter((adapter) => isCommandAvailable(adapter.command(), pathEnv));
  if (adapters.length === 0) adapters = all.filter((adapter) => adapter.id === DEFAULT_ADAPTER_ID);
  const ids = adapters.map((adapter) => adapter.id);
  const defaultAdapterId = settings.default && ids.includes(settings.default)
    ? settings.default
    : ids.includes(DEFAULT_ADAPTER_ID) ? DEFAULT_ADAPTER_ID : ids[0];
  return { adapters, defaultAdapterId };
}
