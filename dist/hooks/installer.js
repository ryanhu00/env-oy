"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONFIG_PATH = void 0;
exports.isOnPath = isOnPath;
exports.installedHookTargets = installedHookTargets;
exports.missingHookTargets = missingHookTargets;
exports.describeHookInstall = describeHookInstall;
exports.installHookTargets = installHookTargets;
exports.hooksInstalled = hooksInstalled;
exports.installHooks = installHooks;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const paths_1 = require("../paths");
exports.CONFIG_PATH = path.join(os.homedir(), '.config', 'devin', 'config.json');
const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'PermissionRequest', 'SessionEnd'];
const HOOK_SCRIPT = path.resolve(__dirname, '..', '..', 'bin', 'envoy-hook.sh');
/** Hook config location and shape for each supported CLI. All three share one hook schema. */
const HOOK_CONFIGS = {
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
/**
 * Checks whether an executable is available on PATH.
 * @param binary Bare executable name.
 * @param pathEnv PATH value to search; defaults to the current process PATH.
 * @returns True when an executable regular file with that name exists in a PATH entry.
 */
function isOnPath(binary, pathEnv = process.env.PATH ?? '') {
    for (const dir of pathEnv.split(path.delimiter)) {
        if (!dir)
            continue;
        const candidate = path.join(dir, binary);
        try {
            if (fs.statSync(candidate).isFile()) {
                fs.accessSync(candidate, fs.constants.X_OK);
                return true;
            }
        }
        catch { }
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
function installedHookTargets(adapterIds, home = os.homedir(), pathEnv = process.env.PATH ?? '') {
    return adapterIds.flatMap((adapterId) => {
        const spec = HOOK_CONFIGS[adapterId];
        if (!spec || !isOnPath(spec.binary, pathEnv))
            return [];
        return [{ adapterId, label: spec.label, configPath: path.join(home, ...spec.segments) }];
    });
}
/**
 * Narrows targets to those whose config does not yet contain every Envoy hook.
 * @param targets Candidate targets, usually from `installedHookTargets`.
 * @returns Targets that still need hooks installed.
 */
function missingHookTargets(targets) {
    return targets.filter((target) => !hooksInstalled(target.configPath));
}
/**
 * Builds the confirmation question shown before touching any CLI config.
 * @param targets Targets that will be modified.
 * @returns Single-line question naming each CLI (and the file when there is only one).
 */
function describeHookInstall(targets) {
    if (targets.length === 1)
        return `Install ${targets[0].label} notification hooks into ${targets[0].configPath}? (backup written first)`;
    return `Install notification hooks for ${targets.map((target) => target.label).join(', ')}? (backups written first)`;
}
/**
 * Installs hooks into every target independently, so one unreadable config never blocks the
 * others.
 * @param targets Targets to modify.
 * @returns Which targets were installed, per-target error text, and follow-up notices.
 */
function installHookTargets(targets) {
    const result = { installed: [], errors: [], notices: [] };
    for (const target of targets) {
        try {
            installHooks(target.configPath, HOOK_CONFIGS[target.adapterId].emptyMatcher);
            result.installed.push(target);
            const notice = HOOK_CONFIGS[target.adapterId].notice;
            if (notice)
                result.notices.push(notice);
        }
        catch (error) {
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
function hooksInstalled(configPath = exports.CONFIG_PATH) {
    let cfg;
    try {
        cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    catch {
        return false;
    }
    return HOOK_EVENTS.every((ev) => Array.isArray(cfg?.hooks?.[ev]) &&
        cfg.hooks[ev].some((m) => Array.isArray(m?.hooks) && m.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_SCRIPT))));
}
/**
 * Appends missing Envoy hooks while preserving config keys and the one-time backup. An
 * existing file that is not a valid JSON object is never overwritten.
 * @param configPath Hook config path; defaults to the Devin config after confirmation.
 * @param emptyMatcher Whether to write an explicit empty `matcher` on new entries.
 * @returns Nothing; throws when the existing config cannot be safely modified.
 */
function installHooks(configPath = exports.CONFIG_PATH, emptyMatcher = true) {
    let raw = null;
    let cfg = {};
    try {
        raw = fs.readFileSync(configPath, 'utf8');
    }
    catch {
        raw = null;
    }
    if (raw !== null && raw.trim() !== '') {
        try {
            cfg = JSON.parse(raw);
        }
        catch {
            throw new Error(`${configPath} is not valid JSON; fix or remove it, then try again`);
        }
        if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg))
            throw new Error(`${configPath} is not a JSON object; fix or remove it, then try again`);
    }
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const backup = configPath + `.bak-${paths_1.APP_NAME}`;
    if (raw !== null && !fs.existsSync(backup))
        fs.writeFileSync(backup, raw);
    if (typeof cfg.hooks !== 'object' || cfg.hooks === null || Array.isArray(cfg.hooks))
        cfg.hooks = {};
    for (const ev of HOOK_EVENTS) {
        if (!Array.isArray(cfg.hooks[ev]))
            cfg.hooks[ev] = [];
        const present = cfg.hooks[ev].some((m) => Array.isArray(m?.hooks) && m.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_SCRIPT)));
        if (!present) {
            const group = { hooks: [{ type: 'command', command: `${HOOK_SCRIPT} ${ev}` }] };
            cfg.hooks[ev].push(emptyMatcher ? { matcher: '', ...group } : group);
        }
    }
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
}
