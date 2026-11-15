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
exports.SEEDED_TAGS = ['investigation', 'planning', 'code', 'chat'];
exports.SESSION_ALIAS_MAX_LENGTH = 120;
class TagStore {
    configPath;
    ordered;
    sessionOrder = Object.create(null);
    sessionAliases = Object.create(null);
    config;
    /**
     * Loads tags, real-id order and valid dgui aliases while retaining unrelated config keys.
     * @param configPath Config file path; tests may provide an isolated location.
     * @returns A store used as the sole conductor-config writer.
     */
    constructor(configPath = path.join(os.homedir(), '.config', 'devin-conductor', 'config.json')) {
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
    /** Returns the Haein-only sidebar grouping preference, defaulting to pipeline stages. */
    get haeinSidebarGrouping() {
        return this.config.haein_sidebar_grouping === 'tag' ? 'tag' : 'pipeline_stage';
    }
    /** Persists the Haein-only sidebar grouping without changing normal-mode tag settings. */
    setHaeinSidebarGrouping(grouping) {
        this.persist({ ...this.config, tags: this.ordered, session_order: this.sessionOrder, session_aliases: this.sessionAliases, haein_sidebar_grouping: grouping });
    }
    /**
     * Returns persisted real Devin ids for one tag in relative sidebar order.
     * @param tag Canonical session tag whose saved order is requested.
     * @returns Copy of the saved id list, or an empty array when none is valid.
     */
    getSessionOrder(tag) {
        return [...(this.sessionOrder[tag] ?? [])];
    }
    /**
     * Looks up a persisted dgui-only alias by real Devin session id.
     * @param id Real Devin session id used by discovery and resume.
     * @returns The alias, or undefined when the original title should be shown.
     */
    getSessionAlias(id) {
        return this.sessionAliases[id];
    }
    /**
     * Validates and atomically sets or clears one real-id dgui alias.
     * @param id Non-empty real Devin session id; conductor ids and pids must not be supplied.
     * @param value Raw alias; trimming to blank clears it.
     * @returns The trimmed alias, or undefined after a clear.
     */
    setSessionAlias(id, value) {
        if (!id.trim() || id !== id.trim())
            throw new Error('A real Devin session ID is required');
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
     * Associates one real Devin id with its selected tag, removing stale copies from every
     * other tag while retaining an existing position in the selected list or appending it.
     * @param id Non-empty real Devin session id discovered or supplied by resume.
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
