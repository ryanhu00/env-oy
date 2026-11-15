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
exports.InputHandler = void 0;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const PASTE_BUFFER_MAX = 2 * 1024 * 1024;
/**
 * Splits a raw stdin chunk into key tokens, keeping CSI escape sequences (e.g. arrow keys)
 * intact so mode handlers can treat each token as one keypress.
 * @param data Raw utf8 chunk from stdin.
 * @returns Array of single-key tokens.
 */
function tokenize(data) {
    const out = [];
    let i = 0;
    while (i < data.length) {
        if (data[i] === '\x1b' && data[i + 1] === '[') {
            let j = i + 2;
            while (j < data.length && !/[a-zA-Z~]/.test(data[j]))
                j++;
            out.push(data.slice(i, j + 1));
            i = j + 1;
        }
        else {
            out.push(data[i]);
            i++;
        }
    }
    return out;
}
class InputHandler {
    manager;
    render;
    quit;
    refreshAvailable;
    refresh;
    defaultCwd;
    mode = 'sidebar';
    attachedMode = 'normal';
    form = null;
    confirm = null;
    rename = null;
    tagPicker = null;
    tagName = null;
    tagPosition = null;
    notice = '';
    pendingAction = null;
    pendingG = false;
    pasteBuffer = null;
    /**
     * Creates the key-handling state machine for sidebar, attached, rename, form, tag and confirm modes.
     * @param manager Session manager mutated by navigation and lifecycle keys.
     * @param render Schedules a redraw after state changes.
     * @param quit Terminates the app after quit confirmation.
     * @param refreshAvailable Whether envoy was started through the stable refresh launcher.
     * @param refresh Restarts envoy after refresh readiness and confirmation.
     * @param defaultCwd Default working directory offered in the new-session form.
     */
    constructor(manager, render, quit, refreshAvailable, refresh, defaultCwd) {
        this.manager = manager;
        this.render = render;
        this.quit = quit;
        this.refreshAvailable = refreshAvailable;
        this.refresh = refresh;
        this.defaultCwd = defaultCwd;
    }
    /**
     * Splits stdin into ordinary input and bracketed-paste payloads, routing completed pastes
     * to attached INSERT or editable forms while all other modes ignore them.
     * Control characters are stripped from form, rename and tag-name paste before insertion.
     * @param data Raw utf8 chunk from stdin.
     * @returns Nothing.
     */
    handle(data) {
        this.notice = '';
        let rest = data;
        while (rest.length > 0) {
            if (this.pasteBuffer !== null) {
                const end = rest.indexOf(PASTE_END);
                if (end === -1) {
                    this.pasteBuffer += rest;
                    rest = '';
                    if (this.pasteBuffer.length > PASTE_BUFFER_MAX) {
                        const overflow = this.pasteBuffer;
                        this.pasteBuffer = null;
                        this.processInput(overflow);
                    }
                }
                else {
                    const payload = this.pasteBuffer + rest.slice(0, end);
                    this.pasteBuffer = null;
                    rest = rest.slice(end + PASTE_END.length);
                    if (this.mode === 'attached' && this.attachedMode === 'insert') {
                        const s = this.manager.attachedSession;
                        if (s && !s.exited)
                            s.input(s.term.modes.bracketedPasteMode ? PASTE_START + payload + PASTE_END : payload, true);
                    }
                    else if (this.mode === 'form' && this.form) {
                        const clean = payload.replace(/[\x00-\x1f\x7f]/g, '');
                        if (this.form.field === 0)
                            this.form.cwd += clean;
                        else
                            this.form.name += clean;
                    }
                    else if (this.mode === 'rename' && this.rename) {
                        this.rename.value += payload.replace(/[\x00-\x1f\x7f]/g, '');
                        this.rename.error = '';
                    }
                    else if (this.mode === 'tag-name' && this.tagName) {
                        this.tagName.value += payload.replace(/[\x00-\x1f\x7f]/g, '');
                        this.tagName.error = '';
                    }
                }
            }
            else {
                const start = rest.indexOf(PASTE_START);
                if (start === -1) {
                    this.processInput(rest);
                    rest = '';
                }
                else {
                    if (start > 0)
                        this.processInput(rest.slice(0, start));
                    this.pasteBuffer = '';
                    rest = rest.slice(start + PASTE_START.length);
                }
            }
        }
        this.render();
    }
    /**
     * Applies ordinary non-paste input: attached INSERT forwards raw bytes while every other
     * state consumes tokenized keys through its mode-specific handler.
     * @param data Ordinary input with paste markers and completed payloads removed.
     * @returns Nothing.
     */
    processInput(data) {
        if (this.mode === 'attached') {
            const s = this.manager.attachedSession;
            if (!s || s.exited) {
                this.manager.detach();
                this.mode = 'sidebar';
            }
            else if (this.attachedMode === 'insert') {
                if (data === '\x11')
                    this.attachedMode = 'normal';
                else
                    s.input(data);
            }
            else {
                for (const key of tokenize(data)) {
                    if (this.mode !== 'attached' || this.attachedMode !== 'normal')
                        break;
                    this.attachedNormalKey(key, s);
                }
            }
            return;
        }
        for (const key of tokenize(data)) {
            if (key === 'H' && this.mode !== 'sidebar')
                continue;
            if (this.mode === 'sidebar')
                this.sidebarKey(key);
            else if (this.mode === 'move')
                this.moveKey(key);
            else if (this.mode === 'rename')
                this.renameKey(key);
            else if (this.mode === 'form')
                this.formKey(key);
            else if (this.mode === 'confirm')
                this.confirmKey(key);
            else if (this.mode === 'tag-picker')
                this.tagPickerKey(key);
            else if (this.mode === 'tag-name')
                this.tagNameKey(key);
            else if (this.mode === 'tag-position')
                this.tagPositionKey(key);
        }
    }
    /**
     * Handles attached NORMAL navigation over scrollback and transitions to INSERT/sidebar.
     * @param key Single key token.
     * @param s Attached session whose scroll offset is adjusted.
     * @returns Nothing.
     */
    attachedNormalKey(key, s) {
        const top = s.term.buffer.active.baseY;
        if (this.pendingG) {
            this.pendingG = false;
            if (key === 'g') {
                s.scrollOffset = top;
                return;
            }
        }
        if (key === 'j' || key === '\x04')
            s.scrollOffset = Math.max(0, s.scrollOffset - this.manager.halfPage);
        else if (key === 'k' || key === '\x15')
            s.scrollOffset = Math.min(top, s.scrollOffset + this.manager.halfPage);
        else if (key === 'g')
            this.pendingG = true;
        else if (key === 'G')
            s.scrollOffset = 0;
        else if (key === 'p') {
            if (!s.jumpToLastPrompt())
                this.notice = 'No submitted prompt in scrollback';
        }
        else if (key === 'i' || key === 'a') {
            this.attachedMode = 'insert';
            s.scrollOffset = 0;
        }
        else if (key === '\x11') {
            this.manager.detach();
            this.mode = 'sidebar';
        }
    }
    /**
     * Handles sidebar navigation and opens attach, tag selection, form, kill or quit flows.
     * RECENT and TERMINAL rows perform no process action until a tag is selected.
     * @param key Single key token.
     * @returns Nothing.
     */
    sidebarKey(key) {
        const last = this.manager.entries.length - 1;
        const half = Math.max(1, Math.floor(((process.stdout.rows || 24) - 3) / 6));
        if (this.pendingG) {
            this.pendingG = false;
            if (key === 'g') {
                this.manager.selected = 0;
                return;
            }
        }
        if (key === 'j' || key === '\x1b[B')
            this.manager.selected = Math.min(Math.max(0, last), this.manager.selected + 1);
        else if (key === 'k' || key === '\x1b[A')
            this.manager.selected = Math.max(0, this.manager.selected - 1);
        else if (key === 'g')
            this.pendingG = true;
        else if (key === 'G')
            this.manager.selected = Math.max(0, last);
        else if (key === '\x04')
            this.manager.selected = Math.min(Math.max(0, last), this.manager.selected + half);
        else if (key === '\x15')
            this.manager.selected = Math.max(0, this.manager.selected - half);
        else if (key === '\r') {
            const e = this.manager.entries[this.manager.selected];
            if (e?.kind === 'active') {
                this.manager.attach(e.session);
                this.mode = 'attached';
                this.attachedMode = 'normal';
            }
            else if (e?.kind === 'recent') {
                this.beginTagPicker({ kind: 'recent', recent: e.recent });
            }
            else if (e?.kind === 'external') {
                this.beginTagPicker({ kind: 'external', external: e.external, tag: null });
            }
        }
        else if (key === 'n') {
            this.form = { field: 0, cwd: this.defaultCwd, name: '', error: '', adapterId: this.manager.defaultAdapterId };
            this.mode = 'form';
        }
        else if (key === 'H') {
            this.manager.toggleRecentVisibility();
        }
        else if (key === 'R') {
            if (!this.refreshAvailable)
                this.notice = 'Cannot refresh: restart envoy once to enable the launcher';
            else {
                const readiness = this.manager.getRefreshReadiness();
                if (!readiness.ready)
                    this.notice = readiness.message;
                else {
                    this.confirm = {
                        question: `Refresh Envoy and reconnect ${readiness.count} idle session${readiness.count === 1 ? '' : 's'}? Draft text and local scrollback will be lost.`,
                        onYes: this.refresh,
                    };
                    this.mode = 'confirm';
                }
            }
        }
        else if (key === 'r') {
            const entry = this.manager.entries[this.manager.selected];
            if (entry?.kind === 'active') {
                this.rename = {
                    target: { kind: 'active', session: entry.session },
                    section: 'ACTIVE',
                    original: entry.session.name,
                    value: this.manager.displayName(entry),
                    error: '',
                };
                this.mode = 'rename';
            }
            else if (entry?.kind === 'recent') {
                this.rename = {
                    target: { kind: 'discovered', adapterId: entry.recent.adapterId, sessionId: entry.recent.sessionId },
                    section: 'RECENT',
                    original: entry.recent.title || entry.recent.sessionId,
                    value: this.manager.displayName(entry),
                    error: '',
                };
                this.mode = 'rename';
            }
            else if (entry?.kind === 'external') {
                this.rename = {
                    target: { kind: 'discovered', adapterId: entry.external.adapterId, sessionId: entry.external.sessionId },
                    section: 'TERMINAL',
                    original: entry.external.title || entry.external.sessionId,
                    value: this.manager.displayName(entry),
                    error: '',
                };
                this.mode = 'rename';
            }
        }
        else if (key === 'm') {
            const s = this.manager.selectedSession;
            if (!s) {
                if (this.manager.entries[this.manager.selected])
                    this.notice = 'm only moves ACTIVE sessions';
            }
            else {
                const error = this.manager.beginMove(s);
                if (error)
                    this.notice = error;
                else {
                    this.pendingG = false;
                    this.mode = 'move';
                }
            }
        }
        else if (key === 'd') {
            const s = this.manager.selectedSession;
            if (s)
                this.manager.toggleMarkedDone(s);
            else if (this.manager.entries[this.manager.selected])
                this.notice = 'd only flags ACTIVE sessions';
        }
        else if (key === 'x') {
            const s = this.manager.selectedSession;
            if (s) {
                this.confirm = { question: `Kill session "${this.manager.displayName(s)}"?`, onYes: () => this.manager.killSelected() };
                this.mode = 'confirm';
            }
            else if (this.manager.entries[this.manager.selected]) {
                this.notice = 'x only kills ACTIVE sessions';
            }
        }
        else if (key === 'q' || key === '\x03') {
            this.confirm = { question: 'Quit Envoy and kill all sessions?', onYes: this.quit };
            this.mode = 'confirm';
        }
    }
    /**
     * Handles transactional MOVE keys within the selected session's tag, previewing each
     * reorder immediately and either committing persistence or restoring the exact snapshot.
     * @param key Single key token; unsupported keys are ignored.
     * @returns Nothing.
     */
    moveKey(key) {
        if (!this.manager.moveState) {
            this.mode = 'sidebar';
            return;
        }
        if (this.pendingG) {
            this.pendingG = false;
            if (key === 'g') {
                this.manager.moveSelected('top');
                return;
            }
        }
        if (key === 'j' || key === '\x1b[B')
            this.manager.moveSelected(1);
        else if (key === 'k' || key === '\x1b[A')
            this.manager.moveSelected(-1);
        else if (key === 'g')
            this.pendingG = true;
        else if (key === 'G')
            this.manager.moveSelected('bottom');
        else if (key === '\r') {
            this.manager.commitMove();
            this.mode = 'sidebar';
        }
        else if (key === '\x1b') {
            this.manager.cancelMove();
            this.mode = 'sidebar';
        }
    }
    /**
     * Edits, saves or cancels a envoy-only alias against its stable row identity.
     * @param key Single key token from rename mode.
     * @returns Nothing; successful save and cancel return to the sidebar.
     */
    renameKey(key) {
        const state = this.rename;
        if (!state) {
            this.mode = 'sidebar';
            return;
        }
        if (key === '\x1b') {
            this.manager.selectRenameTarget(state.target);
            this.rename = null;
            this.mode = 'sidebar';
        }
        else if (key === '\r') {
            const error = this.manager.setDisplayAlias(state.target, state.value);
            if (error)
                state.error = error;
            else {
                this.rename = null;
                this.mode = 'sidebar';
            }
        }
        else if (key === '\x7f' || key === '\b') {
            state.value = state.value.slice(0, -1);
            state.error = '';
        }
        else if (key === '\x15') {
            state.value = '';
            state.error = '';
        }
        else if (key.length >= 1 && !key.startsWith('\x1b') && key >= ' ' && key !== '\x7f') {
            state.value += key;
            state.error = '';
        }
    }
    /**
     * Handles text editing and submission of the cwd/name form. Valid submission stores a
     * pending fresh action and opens tag selection without spawning a process.
     * @param key Single key token.
     * @returns Nothing.
     */
    formKey(key) {
        const f = this.form;
        if (!f) {
            this.mode = 'sidebar';
            return;
        }
        if (key === '\x1b') {
            this.form = null;
            this.mode = 'sidebar';
        }
        else if (key === '\t') {
            f.field = f.field === 0 ? 1 : 0;
        }
        else if (key === '\x1b[C' || key === '\x1b[D') {
            const ids = this.manager.adapters.map((adapter) => adapter.id);
            if (ids.length > 1) {
                const at = Math.max(0, ids.indexOf(f.adapterId));
                f.adapterId = ids[(at + (key === '\x1b[C' ? 1 : ids.length - 1)) % ids.length];
            }
        }
        else if (key === '\r') {
            if (f.field === 0) {
                f.field = 1;
                return;
            }
            const dir = path.resolve(f.cwd.trim().replace(/^~(?=$|\/)/, os.homedir()) || '.');
            let ok = false;
            try {
                ok = fs.statSync(dir).isDirectory();
            }
            catch {
                ok = false;
            }
            if (!ok) {
                f.error = `Not a directory: ${dir}`;
                f.field = 0;
                return;
            }
            this.form = null;
            this.beginTagPicker({ kind: 'fresh', cwd: dir, name: f.name.trim(), adapterId: f.adapterId });
        }
        else if (key === '\x7f' || key === '\b') {
            if (f.field === 0)
                f.cwd = f.cwd.slice(0, -1);
            else
                f.name = f.name.slice(0, -1);
        }
        else if (key === '\x15') {
            if (f.field === 0)
                f.cwd = '';
            else
                f.name = '';
        }
        else if (key.length >= 1 && !key.startsWith('\x1b') && key >= ' ' && key !== '\x7f') {
            if (f.field === 0)
                f.cwd += key;
            else
                f.name += key;
        }
    }
    /**
     * Starts ordered tag selection for a validated fresh, RECENT or TERMINAL pending action.
     * @param action Deferred session action that receives the selected tag.
     * @returns Nothing.
     */
    beginTagPicker(action) {
        this.pendingAction = action;
        this.tagPicker = { selected: 0 };
        this.tagName = null;
        this.tagPosition = null;
        this.pendingG = false;
        this.mode = 'tag-picker';
    }
    /**
     * Applies vim-style top/bottom and single-row movement shared by tag and position lists.
     * @param key Single key token.
     * @param selected Current zero-based selected row.
     * @param last Last valid zero-based row.
     * @returns Updated selected row.
     */
    navigateList(key, selected, last) {
        if (this.pendingG) {
            this.pendingG = false;
            if (key === 'g')
                return 0;
        }
        if (key === 'j' || key === '\x1b[B')
            return Math.min(last, selected + 1);
        if (key === 'k' || key === '\x1b[A')
            return Math.max(0, selected - 1);
        if (key === 'g')
            this.pendingG = true;
        else if (key === 'G')
            return last;
        return selected;
    }
    /**
     * Handles existing-tag list navigation, custom-tag creation and whole-action cancellation.
     * @param key Single key token.
     * @returns Nothing.
     */
    tagPickerKey(key) {
        const picker = this.tagPicker;
        if (!picker || !this.pendingAction) {
            this.mode = 'sidebar';
            return;
        }
        if (key === '\x1b') {
            this.pendingAction = null;
            this.tagPicker = null;
            this.mode = 'sidebar';
        }
        else if (key === 'n') {
            this.tagName = { value: '', error: '' };
            this.pendingG = false;
            this.mode = 'tag-name';
        }
        else if (key === '\r') {
            const tag = this.manager.tagStore.tags[picker.selected];
            if (tag)
                this.selectPendingTag(tag);
        }
        else {
            picker.selected = this.navigateList(key, picker.selected, this.manager.tagStore.tags.length - 1);
        }
    }
    /**
     * Handles custom tag text entry and validation before opening insertion-slot selection.
     * @param key Single key token.
     * @returns Nothing.
     */
    tagNameKey(key) {
        const state = this.tagName;
        if (!state) {
            this.mode = 'tag-picker';
            return;
        }
        if (key === '\x1b') {
            this.mode = 'tag-picker';
        }
        else if (key === '\r') {
            try {
                const name = this.manager.tagStore.validateName(state.value);
                this.tagPosition = { name, selected: 0, error: '' };
                state.error = '';
                this.pendingG = false;
                this.mode = 'tag-position';
            }
            catch (err) {
                state.error = err instanceof Error ? err.message : String(err);
            }
        }
        else if (key === '\x7f' || key === '\b') {
            state.value = state.value.slice(0, -1);
            state.error = '';
        }
        else if (key === '\x15') {
            state.value = '';
            state.error = '';
        }
        else if (key.length >= 1 && !key.startsWith('\x1b') && key >= ' ' && key !== '\x7f') {
            state.value += key;
            state.error = '';
        }
    }
    /**
     * Handles insertion-slot navigation, persistence and return to tag-name on cancellation.
     * Successful insertion immediately selects the new tag for the pending session action.
     * @param key Single key token.
     * @returns Nothing.
     */
    tagPositionKey(key) {
        const state = this.tagPosition;
        if (!state) {
            this.mode = 'tag-name';
            return;
        }
        if (key === '\x1b') {
            this.tagPosition = null;
            this.mode = 'tag-name';
        }
        else if (key === '\r') {
            try {
                const tag = this.manager.tagStore.insert(state.name, state.selected);
                this.selectPendingTag(tag);
            }
            catch (err) {
                state.error = err instanceof Error ? err.message : String(err);
            }
        }
        else {
            state.selected = this.navigateList(key, state.selected, this.manager.tagStore.tags.length);
        }
    }
    /**
     * Executes a pending fresh/resume action with its required tag, or transitions TERMINAL
     * adoption to destructive confirmation while retaining the chosen tag in pending state.
     * @param tag Canonical tag selected from TagStore.
     * @returns Nothing.
     */
    selectPendingTag(tag) {
        const action = this.pendingAction;
        if (!action) {
            this.mode = 'sidebar';
            return;
        }
        this.tagPicker = null;
        this.tagName = null;
        this.tagPosition = null;
        this.pendingG = false;
        if (action.kind === 'fresh') {
            this.pendingAction = null;
            this.manager.create(action.cwd, action.name, tag, undefined, { adapterId: action.adapterId });
            this.mode = 'attached';
            this.attachedMode = 'insert';
        }
        else if (action.kind === 'recent') {
            this.pendingAction = null;
            this.manager.create(action.recent.cwd, action.recent.title || action.recent.sessionId, tag, action.recent.sessionId, { adapterId: action.recent.adapterId });
            this.mode = 'attached';
            this.attachedMode = 'normal';
        }
        else {
            this.pendingAction = { ...action, tag };
            const ext = action.external;
            this.confirm = {
                question: `Adopt '${this.manager.displayName({ kind: 'external', external: ext })}' as #${tag}? This closes it in your terminal window.`,
                onYes: () => void this.manager.adopt(ext, tag).then((err) => {
                    if (err)
                        this.notice = err;
                    else if (this.mode === 'sidebar') {
                        this.mode = 'attached';
                        this.attachedMode = 'normal';
                    }
                    this.render();
                }),
            };
            this.mode = 'confirm';
        }
    }
    /**
     * Handles y/n prompts and safely reports rejected asynchronous confirmation actions.
     * @param key Single key token; only y/Y accepts.
     * @returns Nothing; accepted asynchronous work continues without blocking input dispatch.
     */
    confirmKey(key) {
        const c = this.confirm;
        this.confirm = null;
        this.pendingAction = null;
        this.mode = 'sidebar';
        if (!c || (key !== 'y' && key !== 'Y'))
            return;
        try {
            const result = c.onYes();
            if (result instanceof Promise)
                void result.catch((error) => {
                    this.notice = error instanceof Error ? error.message : String(error);
                    this.render();
                });
        }
        catch (error) {
            this.notice = error instanceof Error ? error.message : String(error);
        }
    }
}
exports.InputHandler = InputHandler;
