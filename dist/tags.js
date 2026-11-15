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
exports.TagStore = exports.SESSION_ALIAS_MAX_LENGTH = exports.SEEDED_TAGS = void 0;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const types_1 = require("./adapters/types");
const discovery_1 = require("./discovery");
const paths_1 = require("./paths");
const koi_1 = require("./ui/koi");
exports.SEEDED_TAGS = ['investigation', 'planning', 'code', 'chat'];
exports.SESSION_ALIAS_MAX_LENGTH = 120;
class TagStore {
    configPath;
    ordered;
    sessionOrder = Object.create(null);
    sessionAliases = Object.create(null);
    config;
    /**
     * Loads tags, real-id order and valid envoy aliases while retaining unrelated config keys.
     * @param configPath Config file path; tests may provide an isolated location.
     * @returns A store used as the sole envoy-config writer.
     */
    constructor(configPath = (0, paths_1.defaultConfigPath)()) {
        this.configPath = configPath;
        let parsed = {};
        try {
            parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
        catch {
            parsed = {};
        }
        this.config = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
        const configured = this.config.tags;
        const valid = Array.isArray(configured) &&
            configured.length > 0 &&
            configured.every((tag) => typeof tag === 'string' && tag.trim().length > 0 && tag === tag.trim()) &&
            new Set(configured.map((tag) => tag.toLocaleLowerCase())).size === configured.length;
        this.ordered = valid ? [...configured] : [...exports.SEEDED_TAGS];
        const configuredOrder = this.config.session_order;
        if (typeof configuredOrder === 'object' && configuredOrder !== null && !Array.isArray(configuredOrder)) {
            for (const [tag, value] of Object.entries(configuredOrder)) {
                if (!tag.trim() || !Array.isArray(value))
                    continue;
                const ids = value.filter((id) => typeof id === 'string' && id.trim().length > 0 && id === id.trim());
                this.sessionOrder[tag] = [...new Set(ids)];
            }
        }
        const configuredAliases = this.config.session_aliases;
        if (typeof configuredAliases === 'object' && configuredAliases !== null && !Array.isArray(configuredAliases)) {
            for (const [id, value] of Object.entries(configuredAliases)) {
                if (!id.trim() || id !== id.trim() || typeof value !== 'string')
                    continue;
                const alias = value.trim();
                if (alias && alias.length <= exports.SESSION_ALIAS_MAX_LENGTH)
                    this.sessionAliases[id] = alias;
            }
        }
        if (!valid)
            this.persist({ ...this.config, tags: this.ordered, session_order: this.sessionOrder, session_aliases: this.sessionAliases });
    }
    /**
     * Exposes the current canonical tag order for pickers and ACTIVE grouping.
     * @returns Read-only ordered tag names.
     */
    get tags() {
        return this.ordered;
    }
    /**
     * Reads the CLI preferences from the config: `enabled_adapters` (list of CLI ids),
     * `default_adapter` (one id) and `adapter_commands` (id -> executable). Unknown ids and
     * malformed values are ignored rather than failing startup.
     * @returns Validated settings; fields are omitted when unset or invalid.
     */
    get adapterSettings() {
        const known = (value) => typeof value === 'string' && types_1.ADAPTER_IDS.includes(value);
        const settings = {};
        const enabled = this.config.enabled_adapters;
        if (Array.isArray(enabled)) {
            const ids = [...new Set(enabled.filter(known))];
            if (ids.length > 0)
                settings.enabled = ids;
        }
        if (known(this.config.default_adapter))
            settings.default = this.config.default_adapter;
        const commands = this.config.adapter_commands;
        if (typeof commands === 'object' && commands !== null && !Array.isArray(commands)) {
            const valid = {};
            for (const [id, value] of Object.entries(commands)) {
                if (known(id) && typeof value === 'string' && value.trim())
                    valid[id] = value.trim().replace(/^~(?=$|\/)/, os.homedir());
            }
            if (Object.keys(valid).length > 0)
                settings.commands = valid;
        }
        return settings;
    }
    /**
     * Maximum RECENT rows across all CLIs, from `recent_limit` (a whole number from 1 to 100).
     * @returns The configured limit, or 10 when unset or invalid.
     */
    get recentLimit() {
        const value = this.config.recent_limit;
        return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100 ? value : discovery_1.DEFAULT_RECENT_LIMIT;
    }
    /**
     * Color scheme preference from `theme`.
     * @returns 'light', 'dark', or 'auto' (follow the system) when unset or invalid.
     */
    get theme() {
        const value = this.config.theme;
        return value === 'light' || value === 'dark' ? value : 'auto';
    }
    /**
     * Whether the swimming-koi background is on (`koi`, default true).
     * @returns False only when the config explicitly says false.
     */
    get koi() {
        return this.config.koi !== false;
    }
    /**
     * Fixed number of koi from `koi_count` (a whole number from 1 to 12).
     * @returns The count, or undefined for automatic (scales with the window).
     */
    get koiCount() {
        const value = this.config.koi_count;
        return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= koi_1.KOI_MAX_COUNT ? value : undefined;
    }
    /**
     * Whether desktop notifications are on (`desktop_notifications`, default true).
     * @returns False only when the config explicitly says false.
     */
    get desktopNotifications() {
        return this.config.desktop_notifications !== false;
    }
    /**
     * Raw `default_cwd` as the user wrote it (before `~` expansion).
     * @returns The non-empty string, or undefined when unset or invalid.
     */
    get defaultCwdSetting() {
        const value = this.config.default_cwd;
        return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    }
    /**
     * Atomically sets or removes one user-facing setting, leaving every other key untouched.
     * @param key Config key edited by the in-app settings screen.
     * @param value New value; undefined removes the key so its default applies.
     * @returns Nothing.
     */
    setSetting(key, value) {
        const next = { ...this.config };
        if (value === undefined)
            delete next[key];
        else
            next[key] = value;
        this.persist(next);
    }
    /**
     * Returns persisted session keys for one tag in relative sidebar order.
     * @param tag Canonical session tag whose saved order is requested.
     * @returns Copy of the saved id list, or an empty array when none is valid.
     */
    getSessionOrder(tag) {
        return [...(this.sessionOrder[tag] ?? [])];
    }
    /**
     * Looks up a persisted envoy-only alias by session key.
     * @param id Session key (see `sessionKey`) used by discovery and resume.
     * @returns The alias, or undefined when the original title should be shown.
     */
    getSessionAlias(id) {
        return this.sessionAliases[id];
    }
    /**
     * Validates and atomically sets or clears one real-id envoy alias.
     * @param id Non-empty session key; Envoy ids and pids must not be supplied.
     * @param value Raw alias; trimming to blank clears it.
     * @returns The trimmed alias, or undefined after a clear.
     */
    setSessionAlias(id, value) {
        if (!id.trim() || id !== id.trim())
            throw new Error('A real session ID is required');
        const alias = value.trim();
        if (alias.length > exports.SESSION_ALIAS_MAX_LENGTH)
            throw new Error(`Alias must be ${exports.SESSION_ALIAS_MAX_LENGTH} characters or fewer`);
        const next = { ...this.sessionAliases };
        if (alias)
            next[id] = alias;
        else
            delete next[id];
        this.persist({ ...this.config, tags: this.ordered, session_order: this.sessionOrder, session_aliases: next });
        this.sessionAliases = next;
        return alias || undefined;
    }
    /**
     * Trims and validates a proposed custom tag against length and case-insensitive uniqueness.
     * @param name Raw tag name entered by the user.
     * @returns Trimmed canonical name for insertion.
     */
    validateName(name) {
        const trimmed = name.trim();
        if (!trimmed)
            throw new Error('Tag name cannot be empty');
        if (trimmed.length > 30)
            throw new Error('Tag name must be 30 characters or fewer');
        if (this.ordered.some((tag) => tag.toLocaleLowerCase() === trimmed.toLocaleLowerCase()))
            throw new Error(`Tag already exists: ${trimmed}`);
        return trimmed;
    }
    /**
     * Validates and atomically inserts a custom tag at a zero-based slot, then publishes the
     * new order to managers and pickers.
     * @param name Raw custom tag name.
     * @param position Zero-based insertion position from 0 through the current length.
     * @returns Trimmed inserted tag name.
     */
    insert(name, position) {
        if (!Number.isInteger(position) || position < 0 || position > this.ordered.length)
            throw new RangeError('Tag position is out of range');
        const tag = this.validateName(name);
        const next = [...this.ordered.slice(0, position), tag, ...this.ordered.slice(position)];
        this.persist({ ...this.config, tags: next, session_order: this.sessionOrder, session_aliases: this.sessionAliases });
        this.ordered = next;
        return tag;
    }
    /**
     * Associates one session key with its selected tag, removing stale copies from every
     * other tag while retaining an existing position in the selected list or appending it.
     * @param id Non-empty session key discovered or supplied by resume.
     * @param tag Canonical tag selected for the current run.
     * @returns Nothing.
     */
    assignSessionTag(id, tag) {
        if (!id.trim())
            return;
        const next = Object.create(null);
        let selectedIndex = -1;
        for (const [name, ids] of Object.entries(this.sessionOrder)) {
            if (name === tag)
                selectedIndex = ids.indexOf(id);
            next[name] = ids.filter((saved) => saved !== id);
        }
        const target = next[tag] ?? [];
        target.splice(selectedIndex >= 0 ? Math.min(selectedIndex, target.length) : target.length, 0, id);
        next[tag] = target;
        this.sessionOrder = next;
        this.persist({ ...this.config, tags: this.ordered, session_order: next, session_aliases: this.sessionAliases });
    }
    /**
     * Moves a session's saved position to a new key and carries its alias over, used when a
     * running REPL switches session id. The old alias is kept for the old session.
     * @param from Session key being replaced.
     * @param to Session key that now identifies the same sidebar row.
     * @returns Nothing.
     */
    renameSessionKey(from, to) {
        if (!from.trim() || from !== from.trim() || !to.trim() || to !== to.trim())
            throw new Error('A real session ID is required');
        if (from === to)
            return;
        const order = Object.create(null);
        for (const [name, ids] of Object.entries(this.sessionOrder))
            order[name] = [...new Set(ids.map((id) => (id === from ? to : id)))];
        const aliases = { ...this.sessionAliases };
        if (aliases[from] !== undefined && aliases[to] === undefined)
            aliases[to] = aliases[from];
        this.persist({ ...this.config, tags: this.ordered, session_order: order, session_aliases: aliases });
        this.sessionOrder = order;
        this.sessionAliases = aliases;
    }
    /**
     * Persists the current active real-id order for one tag, removing those ids from stale
     * tag lists and retaining inactive historical ids after the active sequence.
     * @param tag Canonical tag whose active runtime order was committed or resolved.
     * @param ids Complete ordered real ids of currently active sessions in the tag.
     * @returns Nothing.
     */
    saveSessionOrder(tag, ids) {
        const active = [...new Set(ids.filter((id) => id.trim().length > 0))];
        const activeSet = new Set(active);
        const next = Object.create(null);
        for (const [name, saved] of Object.entries(this.sessionOrder))
            next[name] = saved.filter((id) => !activeSet.has(id));
        next[tag] = [...active, ...(next[tag] ?? [])];
        this.sessionOrder = next;
        this.persist({ ...this.config, tags: this.ordered, session_order: next, session_aliases: this.sessionAliases });
    }
    /**
     * Writes a complete config object through a same-directory temporary file and atomic rename;
     * all tag and order writers share this in-memory object so unrelated keys cannot be clobbered.
     * @param next Complete config object to persist and retain in memory.
     * @returns Nothing.
     */
    persist(next) {
        fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
        const temp = `${this.configPath}.tmp-${process.pid}-${Date.now()}`;
        try {
            fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
            fs.renameSync(temp, this.configPath);
            this.config = next;
        }
        finally {
            try {
                fs.unlinkSync(temp);
            }
            catch { }
        }
    }
}
exports.TagStore = TagStore;
