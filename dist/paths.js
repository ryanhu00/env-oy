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
exports.APP_DISPLAY_NAME = exports.APP_NAME = void 0;
exports.envoyEnv = envoyEnv;
exports.sessionChildEnv = sessionChildEnv;
exports.defaultDataDir = defaultDataDir;
exports.defaultConfigDir = defaultConfigDir;
exports.defaultConfigPath = defaultConfigPath;
exports.resolveEventsDir = resolveEventsDir;
const os = __importStar(require("os"));
const path = __importStar(require("path"));
/** Lowercase id used for paths, package name, and backup suffixes. */
exports.APP_NAME = 'envoy';
/** User-facing product name. */
exports.APP_DISPLAY_NAME = 'Envoy';
const ENV_PREFIX = 'ENVOY_';
/**
 * Reads an envoy env var.
 * @param suffix Env suffix such as `CMD`, `ID`, `EVENTS_DIR`, `RESTART_CHANNEL`, `NO_HOOK_PROMPT`.
 * @returns The value, or undefined when unset.
 */
function envoyEnv(suffix) {
    return process.env[`${ENV_PREFIX}${suffix}`];
}
/**
 * Builds a process env that exports envoy conductor variables for spawned sessions.
 * @param id Conductor session id.
 * @param eventsDir Events directory for hook delivery.
 * @returns Env object suitable for node-pty spawn.
 */
function sessionChildEnv(id, eventsDir) {
    return {
        ...process.env,
        [`${ENV_PREFIX}ID`]: id,
        [`${ENV_PREFIX}EVENTS_DIR`]: eventsDir,
    };
}
/**
 * Default private data directory (~/.local/share/envoy).
 * @returns Absolute data directory path.
 */
function defaultDataDir(home = os.homedir()) {
    return path.join(home, '.local', 'share', exports.APP_NAME);
}
/**
 * Default config directory (~/.config/envoy).
 * @returns Absolute config directory path.
 */
function defaultConfigDir(home = os.homedir()) {
    return path.join(home, '.config', exports.APP_NAME);
}
/**
 * Default envoy config file path.
 * @returns Absolute config.json path under the envoy config directory.
 */
function defaultConfigPath(home = os.homedir()) {
    return path.join(defaultConfigDir(home), 'config.json');
}
/**
 * Resolves the events/data directory from ENVOY_EVENTS_DIR or the default data dir.
 * @returns Absolute events directory path.
 */
function resolveEventsDir(home = os.homedir()) {
    return envoyEnv('EVENTS_DIR') || defaultDataDir(home);
}
