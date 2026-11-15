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
exports.hooksInstalled = hooksInstalled;
exports.installHooks = installHooks;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
exports.CONFIG_PATH = path.join(os.homedir(), '.config', 'devin', 'config.json');
const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'PermissionRequest', 'SessionEnd'];
const HOOK_SCRIPT = path.resolve(__dirname, '..', '..', 'bin', 'conductor-hook.sh');
/**
 * Checks whether a Devin config contains conductor hooks for all four lifecycle events.
 * @param configPath Devin config path; defaults to the current user's config.
 * @returns True when every event references the conductor hook script.
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
 * Appends missing conductor hooks while preserving config keys and the one-time backup.
 * @param configPath Devin config path; defaults to the current user's config after confirmation.
 * @returns Nothing.
 */
function installHooks(configPath = exports.CONFIG_PATH) {
    let raw = null;
    let cfg = {};
    try {
        raw = fs.readFileSync(configPath, 'utf8');
        cfg = JSON.parse(raw);
    }
    catch {
        cfg = {};
    }
    if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg))
        cfg = {};
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const backup = configPath + '.bak-devin-conductor';
    if (raw !== null && !fs.existsSync(backup))
        fs.writeFileSync(backup, raw);
    if (typeof cfg.hooks !== 'object' || cfg.hooks === null || Array.isArray(cfg.hooks))
        cfg.hooks = {};
    for (const ev of HOOK_EVENTS) {
        if (!Array.isArray(cfg.hooks[ev]))
            cfg.hooks[ev] = [];
        const present = cfg.hooks[ev].some((m) => Array.isArray(m?.hooks) && m.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_SCRIPT)));
        if (!present)
            cfg.hooks[ev].push({ matcher: '', hooks: [{ type: 'command', command: `${HOOK_SCRIPT} ${ev}` }] });
    }
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
}
