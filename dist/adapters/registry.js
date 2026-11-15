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
exports.sessionKey = exports.DEFAULT_ADAPTER_ID = exports.ADAPTER_IDS = void 0;
exports.createAdapters = createAdapters;
exports.isCommandAvailable = isCommandAvailable;
exports.selectAdapters = selectAdapters;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const installer_1 = require("../hooks/installer");
const claude_1 = require("./claude");
const codex_1 = require("./codex");
const devin_1 = require("./devin");
const types_1 = require("./types");
var types_2 = require("./types");
Object.defineProperty(exports, "ADAPTER_IDS", { enumerable: true, get: function () { return types_2.ADAPTER_IDS; } });
Object.defineProperty(exports, "DEFAULT_ADAPTER_ID", { enumerable: true, get: function () { return types_2.DEFAULT_ADAPTER_ID; } });
Object.defineProperty(exports, "sessionKey", { enumerable: true, get: function () { return types_2.sessionKey; } });
/**
 * Creates a fresh set of every adapter Envoy knows. Adapters hold per-instance caches, so each
 * manager or discovery instance gets its own set rather than sharing module-level state.
 * @param commands Optional executable override per CLI.
 * @returns One adapter per supported CLI, in canonical order.
 */
function createAdapters(commands = {}) {
    return [
        (0, devin_1.createDevinAdapter)({ command: commands.devin }),
        (0, claude_1.createClaudeAdapter)({ command: commands.claude }),
        (0, codex_1.createCodexAdapter)({ command: commands.codex }),
    ];
}
/**
 * Checks whether a CLI's executable can be launched: an explicit path must be an executable
 * file, a bare name must be on PATH.
 * @param command Executable from the adapter.
 * @param pathEnv PATH value to search.
 * @returns True when the command resolves to an executable file.
 */
function isCommandAvailable(command, pathEnv = process.env.PATH ?? '') {
    if (!command)
        return false;
    if (command.includes('/')) {
        try {
            fs.accessSync(command, fs.constants.X_OK);
            return fs.statSync(command).isFile();
        }
        catch {
            return false;
        }
    }
    return (0, installer_1.isOnPath)(path.basename(command), pathEnv);
}
/**
 * Chooses which CLIs Envoy drives. An explicit `enabled` list wins; otherwise every CLI that is
 * installed is used, so people only get the CLIs they actually have. If nothing is installed the
 * default CLI stays enabled so the app still starts and explains itself when spawning fails.
 * @param settings Config preferences.
 * @param pathEnv PATH value used to detect installed CLIs.
 * @returns Enabled adapters in canonical order and the CLI preselected for new sessions.
 */
function selectAdapters(settings = {}, pathEnv = process.env.PATH ?? '') {
    const all = createAdapters(settings.commands);
    const explicit = settings.enabled ? types_1.ADAPTER_IDS.filter((id) => settings.enabled.includes(id)) : [];
    let adapters = explicit.length > 0 ? all.filter((adapter) => explicit.includes(adapter.id)) : all.filter((adapter) => isCommandAvailable(adapter.command(), pathEnv));
    if (adapters.length === 0)
        adapters = all.filter((adapter) => adapter.id === types_1.DEFAULT_ADAPTER_ID);
    const ids = adapters.map((adapter) => adapter.id);
    const defaultAdapterId = settings.default && ids.includes(settings.default)
        ? settings.default
        : ids.includes(types_1.DEFAULT_ADAPTER_ID) ? types_1.DEFAULT_ADAPTER_ID : ids[0];
    return { adapters, defaultAdapterId };
}
