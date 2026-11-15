import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { APP_NAME } from '../paths';
import type { AdapterId } from '../adapters/types';

export const CONFIG_PATH = path.join(os.homedir(), '.config', 'devin', 'config.json');

const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'PermissionRequest', 'SessionEnd'];

const HOOK_SCRIPT = path.resolve(__dirname, '..', '..', 'bin', 'envoy-hook.sh');

interface HookConfigSpec {
  label: string;
  /** Executable that must be on PATH for the CLI to count as installed. */
  binary: string;
  /** Config file location relative to the home directory. */
  segments: string[];
  /** Whether matcher groups carry an explicit empty `matcher` (Codex omits it). */
  emptyMatcher: boolean;
  /** Shown after install when the CLI needs a manual follow-up step. */
  notice?: string;
}

/** Hook config location and shape for each supported CLI. All three share one hook schema. */
const HOOK_CONFIGS: Record<AdapterId, HookConfigSpec> = {
  devin: { label: 'Devin', binary: 'devin', segments: ['.config', 'devin', 'config.json'], emptyMatcher: true },
  claude: { label: 'Claude', binary: 'claude', segments: ['.claude', 'settings.json'], emptyMatcher: true },
  codex: {
    label: 'Codex',
    binary: 'codex',
    segments: ['.codex', 'hooks.json'],
    emptyMatcher: false,
    notice: 'Codex must trust the new hooks before they run: open Codex and run /hooks.',
  },
};

export interface HookTarget {
  adapterId: AdapterId;
  label: string;
  configPath: string;
}

/**
 * Checks whether an executable is available on PATH.
 * @param binary Bare executable name.
 * @param pathEnv PATH value to search; defaults to the current process PATH.
 * @returns True when an executable regular file with that name exists in a PATH entry.
 */
export function isOnPath(binary: string, pathEnv = process.env.PATH ?? ''): boolean {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      }
    } catch {}
  }
  return false;
}

/**
 * Hook targets for the given CLIs that are actually installed on this machine, so users are
 * only ever offered hooks for the CLIs they use.
 * @param adapterIds CLIs Envoy has enabled.
 * @param home Home directory used to resolve each CLI's config file.
 * @param pathEnv PATH value used to detect installed CLIs.
 * @returns One target per enabled CLI found on PATH.
 */
export function installedHookTargets(adapterIds: readonly AdapterId[], home = os.homedir(), pathEnv = process.env.PATH ?? ''): HookTarget[] {
  return adapterIds.flatMap((adapterId) => {
    const spec = HOOK_CONFIGS[adapterId];
    if (!spec || !isOnPath(spec.binary, pathEnv)) return [];
    return [{ adapterId, label: spec.label, configPath: path.join(home, ...spec.segments) }];
  });
}

/**
 * Narrows targets to those whose config does not yet contain every Envoy hook.
 * @param targets Candidate targets, usually from `installedHookTargets`.
 * @returns Targets that still need hooks installed.
 */
export function missingHookTargets(targets: readonly HookTarget[]): HookTarget[] {
  return targets.filter((target) => !hooksInstalled(target.configPath));
}

/**
 * Builds the confirmation question shown before touching any CLI config.
 * @param targets Targets that will be modified.
 * @returns Single-line question naming each CLI (and the file when there is only one).
 */
export function describeHookInstall(targets: readonly HookTarget[]): string {
  if (targets.length === 1) return `Install ${targets[0].label} notification hooks into ${targets[0].configPath}? (backup written first)`;
  return `Install notification hooks for ${targets.map((target) => target.label).join(', ')}? (backups written first)`;
}

export interface HookInstallResult {
  installed: HookTarget[];
  errors: string[];
  /** Manual follow-up steps for the CLIs that were just installed. */
  notices: string[];
}

/**
 * Installs hooks into every target independently, so one unreadable config never blocks the
 * others.
 * @param targets Targets to modify.
 * @returns Which targets were installed, per-target error text, and follow-up notices.
 */
export function installHookTargets(targets: readonly HookTarget[]): HookInstallResult {
  const result: HookInstallResult = { installed: [], errors: [], notices: [] };
  for (const target of targets) {
    try {
      installHooks(target.configPath, HOOK_CONFIGS[target.adapterId].emptyMatcher);
      result.installed.push(target);
      const notice = HOOK_CONFIGS[target.adapterId].notice;
      if (notice) result.notices.push(notice);
    } catch (error) {
      result.errors.push(`${target.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

/**
 * Checks whether a CLI hook config contains Envoy hooks for all four lifecycle events.
 * @param configPath Hook config path; defaults to the Devin config.
 * @returns True when every event references the Envoy hook script.
 */
export function hooksInstalled(configPath = CONFIG_PATH): boolean {
  let cfg: any;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return false;
  }
  return HOOK_EVENTS.every(
    (ev) =>
      Array.isArray(cfg?.hooks?.[ev]) &&
      cfg.hooks[ev].some(
        (m: any) => Array.isArray(m?.hooks) && m.hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes(HOOK_SCRIPT))
      )
  );
}

/**
 * Appends missing Envoy hooks while preserving config keys and the one-time backup. An
 * existing file that is not a valid JSON object is never overwritten.
 * @param configPath Hook config path; defaults to the Devin config after confirmation.
 * @param emptyMatcher Whether to write an explicit empty `matcher` on new entries.
 * @returns Nothing; throws when the existing config cannot be safely modified.
 */
export function installHooks(configPath = CONFIG_PATH, emptyMatcher = true): void {
  let raw: string | null = null;
  let cfg: any = {};
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    raw = null;
  }
  if (raw !== null && raw.trim() !== '') {
    try {
      cfg = JSON.parse(raw);
    } catch {
      throw new Error(`${configPath} is not valid JSON; fix or remove it, then try again`);
    }
    if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) throw new Error(`${configPath} is not a JSON object; fix or remove it, then try again`);
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const backup = configPath + `.bak-${APP_NAME}`;
  if (raw !== null && !fs.existsSync(backup)) fs.writeFileSync(backup, raw);
  if (typeof cfg.hooks !== 'object' || cfg.hooks === null || Array.isArray(cfg.hooks)) cfg.hooks = {};
  for (const ev of HOOK_EVENTS) {
    if (!Array.isArray(cfg.hooks[ev])) cfg.hooks[ev] = [];
    const present = cfg.hooks[ev].some(
      (m: any) => Array.isArray(m?.hooks) && m.hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes(HOOK_SCRIPT))
    );
    if (!present) {
      const group = { hooks: [{ type: 'command', command: `${HOOK_SCRIPT} ${ev}` }] };
      cfg.hooks[ev].push(emptyMatcher ? { matcher: '', ...group } : group);
    }
  }
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
}
