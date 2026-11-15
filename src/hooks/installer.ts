import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const CONFIG_PATH = path.join(os.homedir(), '.config', 'devin', 'config.json');

const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'PermissionRequest', 'SessionEnd'];

const HOOK_SCRIPT = path.resolve(__dirname, '..', '..', 'bin', 'conductor-hook.sh');

/**
 * Checks whether a Devin config contains conductor hooks for all four lifecycle events.
 * @param configPath Devin config path; defaults to the current user's config.
 * @returns True when every event references the conductor hook script.
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
 * Appends missing conductor hooks while preserving config keys and the one-time backup.
 * @param configPath Devin config path; defaults to the current user's config after confirmation.
 * @returns Nothing.
 */
export function installHooks(configPath = CONFIG_PATH): void {
  let raw: string | null = null;
  let cfg: any = {};
  try {
    raw = fs.readFileSync(configPath, 'utf8');
    cfg = JSON.parse(raw);
  } catch {
    cfg = {};
  }
  if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) cfg = {};
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const backup = configPath + '.bak-devin-conductor';
  if (raw !== null && !fs.existsSync(backup)) fs.writeFileSync(backup, raw);
  if (typeof cfg.hooks !== 'object' || cfg.hooks === null || Array.isArray(cfg.hooks)) cfg.hooks = {};
  for (const ev of HOOK_EVENTS) {
    if (!Array.isArray(cfg.hooks[ev])) cfg.hooks[ev] = [];
    const present = cfg.hooks[ev].some(
      (m: any) => Array.isArray(m?.hooks) && m.hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes(HOOK_SCRIPT))
    );
    if (!present) cfg.hooks[ev].push({ matcher: '', hooks: [{ type: 'command', command: `${HOOK_SCRIPT} ${ev}` }] });
  }
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
}
