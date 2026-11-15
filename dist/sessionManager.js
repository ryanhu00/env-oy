"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionManager = void 0;
const session_1 = require("./session");
const discovery_1 = require("./discovery");
const registry_1 = require("./adapters/registry");
const payload_1 = require("./hooks/payload");
const types_1 = require("./adapters/types");
const restart_1 = require("./restart");
const tags_1 = require("./tags");
class SessionManager {
    eventsDir;
    tagStore;
    onUpdate;
    notifier;
    sessions = [];
    attachedId = null;
    lastPromptAt = null;
    discovery;
    adapters;
    /** CLI used for new sessions; changed at runtime through `setDefaultAdapter`. */
    defaultAdapterId;
    adapterMap;
    resumedKeys = new Set();
    runtimeOrder = new Map();
    pendingAliases = new WeakMap();
    selectedIndex = 0;
    selectionTarget = null;
    selectionTouched = false;
    initialRecentPopulationSeen = false;
    moveTransaction = null;
    recentVisibility = true;
    counter = 0;
    paneCols = 80;
    paneRows = 24;
    /**
     * Creates the manager holding all sessions plus selection/attachment state, wiring an
     * external/recent poller that also assigns real ids from its shared owned-process lsof map.
     * @param eventsDir Directory passed to each session for hook event delivery.
     * @param discoveryDirs Directories always scanned when a CLI lists sessions per directory (default cwd, launch cwd).
     * @param tagStore Canonical tags and persisted per-tag real-id order.
     * @param onUpdate Invoked on any session/state change to schedule a redraw.
     * @param notifier Desktop notifier alerted whenever a session pushes an unread entry.
     * @param adapters CLI adapters this manager can spawn and discover; defaults to the registry.
     * @param defaultAdapterId CLI used for new sessions that do not name one; defaults to Devin when
     * enabled, otherwise the first adapter.
     * @param recentLimit Maximum RECENT rows across all CLIs; defaults to 10.
     */
    constructor(eventsDir, discoveryDirs, tagStore, onUpdate, notifier, adapters = (0, registry_1.createAdapters)(), defaultAdapterId, recentLimit) {
        this.eventsDir = eventsDir;
        this.tagStore = tagStore;
        this.onUpdate = onUpdate;
        this.notifier = notifier;
        this.adapters = adapters;
        this.defaultAdapterId = defaultAdapterId && adapters.some((adapter) => adapter.id === defaultAdapterId)
            ? defaultAdapterId
            : adapters.some((adapter) => adapter.id === types_1.DEFAULT_ADAPTER_ID) ? types_1.DEFAULT_ADAPTER_ID : (adapters[0]?.id ?? types_1.DEFAULT_ADAPTER_ID);
        this.adapterMap = new Map(adapters.map((adapter) => [adapter.id, adapter]));
        this.discovery = new discovery_1.Discovery(() => new Set(this.sessions.map((s) => s.pid)), () => this.resumedKeys, discoveryDirs, (sessions) => this.assignDiscoveredSessionIds(sessions), () => {
            const firstRecentPopulation = !this.initialRecentPopulationSeen && this.discovery.recents.length > 0;
            if (firstRecentPopulation)
                this.initialRecentPopulationSeen = true;
            if (firstRecentPopulation && !this.selectionTouched && this.recentVisibility && !this.entries.some((entry) => entry.kind === 'active')) {
                this.setSelected(this.entries.findIndex((entry) => entry.kind === 'recent'), false);
            }
            else {
                this.selectRenameTarget(this.selectionTarget);
            }
            this.onUpdate();
        }, adapters, recentLimit);
    }
    /**
     * Chooses the CLI preselected for new sessions.
     * @param id An enabled CLI.
     * @returns Nothing; throws when the CLI is not enabled.
     */
    setDefaultAdapter(id) {
        this.adapterFor(id);
        this.defaultAdapterId = id;
    }
    /**
     * Looks up a registered adapter.
     * @param id Adapter identifier.
     * @returns The adapter for that CLI; throws when it is not enabled.
     */
    adapterFor(id) {
        const adapter = this.adapterMap.get(id);
        if (!adapter)
            throw new Error(`Unknown CLI adapter: ${id}`);
        return adapter;
    }
    /**
     * Short CLI badge for a row ("DV", "CL", "CX"), shown only when more than one CLI is enabled
     * so single-CLI setups stay uncluttered.
     * @param adapterId CLI that owns the row.
     * @returns The badge, or '' when it should not be shown.
     */
    badgeFor(adapterId) {
        return this.adapters.length > 1 ? this.adapterMap.get(adapterId)?.badge ?? '' : '';
    }
    /**
     * Persistence key of an owned session once its real CLI id is known.
     * @param session Owned session.
     * @returns The adapter-scoped key, or null while the id is still unresolved.
     */
    keyOf(session) {
        return session.cliSessionId ? (0, types_1.sessionKey)(session.adapterId, session.cliSessionId) : null;
    }
    /**
     * Gets the current sidebar row index used by input and rendering.
     * @returns Zero-based selected entry index.
     */
    get selected() {
        return this.selectedIndex;
    }
    /**
     * Selects a row as an explicit user-facing movement and records its stable identity.
     * @param index Zero-based sidebar entry index.
     * @returns Nothing; input navigation and direct callers use this setter.
     */
    set selected(index) {
        this.setSelected(index, true);
    }
    /**
     * Clamps selection, records stable identity, and optionally marks user interaction.
     * @param index Requested zero-based sidebar entry index.
     * @param touched Whether this movement disables untouched startup RECENT preference.
     * @returns Nothing; internal refresh repair passes false while user actions pass true.
     */
    setSelected(index, touched) {
        const entries = this.entries;
        this.selectedIndex = Math.max(0, Math.min(index, Math.max(0, entries.length - 1)));
        const entry = entries[this.selectedIndex];
        this.selectionTarget = !entry
            ? null
            : entry.kind === 'active'
                ? { kind: 'active', session: entry.session }
                : entry.kind === 'recent'
                    ? { kind: 'discovered', adapterId: entry.recent.adapterId, sessionId: entry.recent.sessionId }
                    : { kind: 'discovered', adapterId: entry.external.adapterId, sessionId: entry.external.sessionId };
        if (touched)
            this.selectionTouched = true;
    }
    /**
     * Reports whether polled RECENT rows participate in the current run's sidebar.
     * @returns True when RECENT rows are visible; rendering and status hints read this value.
     */
    get recentVisible() {
        return this.recentVisibility;
    }
    /**
     * Flat ordered sidebar rows spanning runtime-ordered tag groups, optional RECENT resumable
     * sessions and TERMINAL external rows; selection indexes into this array.
     * @returns Ordered array of currently visible sidebar entries.
     */
    get entries() {
        const active = this.tagStore.tags.flatMap((tag) => (this.runtimeOrder.get(tag) ?? []).map((session) => ({ kind: 'active', session })));
        return [
            ...active,
            ...(this.recentVisibility ? this.discovery.recents.map((recent) => ({ kind: 'recent', recent })) : []),
            ...this.discovery.externals.map((external) => ({ kind: 'external', external })),
        ];
    }
    /**
     * Toggles run-local RECENT rows while preserving ACTIVE/TERMINAL identity or choosing the
     * first following TERMINAL, then last ACTIVE, when a selected RECENT row is hidden.
     * @returns Nothing; sidebar input uses this action and receives an immediate redraw.
     */
    toggleRecentVisibility() {
        const selected = this.entries[this.selectedIndex];
        this.recentVisibility = !this.recentVisibility;
        const entries = this.entries;
        let index = -1;
        if (selected?.kind === 'active')
            index = entries.findIndex((entry) => entry.kind === 'active' && entry.session === selected.session);
        else if (selected?.kind === 'external')
            index = entries.findIndex((entry) => entry.kind === 'external' && entry.external.adapterId === selected.external.adapterId && entry.external.sessionId === selected.external.sessionId);
        else if (selected?.kind === 'recent' && !this.recentVisibility) {
            index = entries.findIndex((entry) => entry.kind === 'external');
            if (index < 0) {
                for (let i = entries.length - 1; i >= 0; i--) {
                    if (entries[i].kind === 'active') {
                        index = i;
                        break;
                    }
                }
            }
        }
        this.selected = index >= 0 ? index : Math.max(0, Math.min(this.selectedIndex, Math.max(0, entries.length - 1)));
        this.onUpdate();
    }
    /**
     * Resolves the canonical displayed name for an owned Session or any sidebar row.
     * @param target Session or sidebar entry shown in UI, confirmations or notifications.
     * @returns Persisted/pending alias when present, otherwise the current source title or id.
     */
    displayName(target) {
        if (!('kind' in target)) {
            const key = this.keyOf(target);
            const persisted = key ? this.tagStore.getSessionAlias(key) : undefined;
            return persisted ?? this.pendingAliases.get(target) ?? target.name;
        }
        if (target.kind === 'active')
            return this.displayName(target.session);
        if (target.kind === 'recent')
            return this.tagStore.getSessionAlias((0, types_1.sessionKey)(target.recent.adapterId, target.recent.sessionId)) ?? (target.recent.title || target.recent.sessionId);
        return this.tagStore.getSessionAlias((0, types_1.sessionKey)(target.external.adapterId, target.external.sessionId)) ?? (target.external.title || target.external.sessionId);
    }
    /**
     * Applies a trimmed envoy alias to a stable target without touching the CLI or any PTY.
     * @param target Owned Session reference or discovered adapter + real session id.
     * @param value Raw field value; blank clears the alias and restores the source title.
     * @returns Validation/persistence error text, or null after success.
     */
    setDisplayAlias(target, value) {
        const alias = value.trim();
        if (alias.length > tags_1.SESSION_ALIAS_MAX_LENGTH)
            return `Alias must be ${tags_1.SESSION_ALIAS_MAX_LENGTH} characters or fewer`;
        try {
            if (target.kind === 'active' && !target.session.cliSessionId) {
                if (alias)
                    this.pendingAliases.set(target.session, alias);
                else
                    this.pendingAliases.delete(target.session);
            }
            else {
                const key = target.kind === 'active' ? this.keyOf(target.session) : (0, types_1.sessionKey)(target.adapterId, target.sessionId);
                this.tagStore.setSessionAlias(key, alias);
                if (target.kind === 'active')
                    this.pendingAliases.delete(target.session);
            }
        }
        catch (err) {
            return err instanceof Error ? err.message : String(err);
        }
        this.selectRenameTarget(target);
        this.onUpdate();
        return null;
    }
    /**
     * Restores selection to a stable rename/discovery identity, falling back to a valid row.
     * @param target Session reference or adapter + real session id, or null when no row was selected.
     * @returns Nothing; rename completion and discovery refreshes use this method.
     */
    selectRenameTarget(target) {
        const entries = this.entries;
        const index = target?.kind === 'active'
            ? entries.findIndex((entry) => entry.kind === 'active' && entry.session === target.session)
            : target
                ? entries.findIndex((entry) => entry.kind !== 'active' && (entry.kind === 'recent' ? entry.recent : entry.external).adapterId === target.adapterId && (entry.kind === 'recent' ? entry.recent.sessionId : entry.external.sessionId) === target.sessionId)
                : -1;
        this.setSelected(index >= 0 ? index : Math.max(0, Math.min(this.selectedIndex, Math.max(0, entries.length - 1))), false);
    }
    /**
     * Current transactional move target for renderer highlighting and status text.
     * @returns Moved session/tag while MOVE mode is active, otherwise null.
     */
    get moveState() {
        return this.moveTransaction ? { session: this.moveTransaction.session, tag: this.moveTransaction.tag } : null;
    }
    /**
     * Session the user is currently attached to, if any; used for input routing and rendering.
     * @returns The attached session or undefined.
     */
    get attachedSession() {
        return this.sessions.find((s) => s.id === this.attachedId);
    }
    /**
     * Owned session under the sidebar selection cursor; used for previews and lifecycle actions.
     * @returns The selected active session, or undefined for empty/external/recent rows.
     */
    get selectedSession() {
        const e = this.entries[this.selected];
        return e?.kind === 'active' ? e.session : undefined;
    }
    /**
     * Half the right-pane height in lines (min 1); the scroll step for attached normal mode.
     * @returns Half-page line count.
     */
    get halfPage() {
        return Math.max(1, Math.floor(this.paneRows / 2));
    }
    /**
     * Stores the right-pane dimensions and resizes every session's PTY/terminal to match.
     * @param cols Right-pane width in columns.
     * @param rows Right-pane height in rows.
     * @returns Nothing.
     */
    setPaneSize(cols, rows) {
        this.paneCols = Math.max(2, cols);
        this.paneRows = Math.max(2, rows);
        for (const s of this.sessions)
            s.resize(this.paneCols, this.paneRows);
    }
    /**
     * Spawns a new owned session, inserts known ids by saved rank within the selected tag,
     * then selects and attaches it; fresh unresolved sessions append after saved entries.
     * @param cwd Absolute working directory for the PTY.
     * @param name Optional display name; auto-generates `session-N` when empty.
     * @param tag Required canonical ACTIVE group chosen before creation.
     * @param resumeId Optional real CLI session id, resuming it instead of starting a fresh REPL.
     * @param options Optional adapter choice plus non-attaching restored state used during restart recovery.
     * @returns The newly created session.
     */
    create(cwd, name, tag, resumeId, options = {}) {
        if (!this.tagStore.tags.includes(tag))
            throw new Error(`Unknown session tag: ${tag}`);
        const adapterId = options.adapterId ?? this.defaultAdapterId;
        const adapter = this.adapterFor(adapterId);
        this.counter++;
        const id = `s${Date.now().toString(36)}-${this.counter}`;
        const displayName = name || `session-${this.counter}`;
        if (resumeId) {
            const key = (0, types_1.sessionKey)(adapterId, resumeId);
            this.resumedKeys.add(key);
            this.tagStore.assignSessionTag(key, tag);
        }
        const s = new session_1.Session(id, displayName, cwd, tag, resumeId ?? null, this.paneCols, this.paneRows, this.eventsDir, () => {
            const e = this.entries[this.selected];
            if (s.id === this.attachedId || (e?.kind === 'active' && e.session === s))
                this.onUpdate();
        }, this.onUpdate, (type) => this.notifier.send(id, this.displayName(s), type), { adapterId, command: options.command ?? [adapter.command(), ...(resumeId ? adapter.resumeArgs(resumeId) : adapter.freshArgs())], onExit: options.onExit, status: options.status, unread: options.unread, markedDone: options.markedDone });
        this.sessions.push(s);
        const group = [...(this.runtimeOrder.get(tag) ?? []), s];
        const saved = this.tagStore.getSessionOrder(tag);
        group.sort((a, b) => {
            const aKey = this.keyOf(a);
            const bKey = this.keyOf(b);
            const ai = aKey ? saved.indexOf(aKey) : -1;
            const bi = bKey ? saved.indexOf(bKey) : -1;
            return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
        });
        this.runtimeOrder.set(tag, group);
        if (options.attach !== false) {
            this.selected = this.entries.findIndex((entry) => entry.kind === 'active' && entry.session === s);
            this.attach(s);
        }
        else {
            s.suppressNotifications = false;
            this.onUpdate();
        }
        return s;
    }
    /**
     * Checks whether every live ACTIVE session is idle and has a real CLI session id.
     * @returns Ready session count, or the exact first blocker notice for refresh UX.
     */
    getRefreshReadiness() {
        const live = this.entries.flatMap((entry) => entry.kind === 'active' && !entry.session.exited ? [entry.session] : []);
        const working = live.find((session) => session.status === 'working');
        if (working)
            return { ready: false, message: `Cannot refresh: ${this.displayName(working)} is WORKING` };
        const permission = live.find((session) => session.status === 'needs-permission');
        if (permission)
            return { ready: false, message: `Cannot refresh: ${this.displayName(permission)} needs permission` };
        const unresolved = live.find((session) => !session.cliSessionId);
        if (unresolved)
            return { ready: false, message: `Cannot refresh: waiting for session ID for ${this.displayName(unresolved)}` };
        return { ready: true, count: live.length };
    }
    /**
     * Captures only resumable ACTIVE metadata needed by a replacement envoy process.
     * @returns Versioned state ordered like the sidebar with an optional selected session key.
     */
    getRestartState() {
        const selected = this.entries[this.selected];
        const selectedSessionId = selected?.kind === 'active' && !selected.session.exited ? this.keyOf(selected.session) : null;
        const sessions = this.entries.flatMap((entry) => {
            if (entry.kind !== 'active' || entry.session.exited || !entry.session.cliSessionId)
                return [];
            return [{
                    adapterId: entry.session.adapterId,
                    cliSessionId: entry.session.cliSessionId,
                    cwd: entry.session.cwd,
                    name: entry.session.name,
                    tag: entry.session.tag,
                    unread: entry.session.unread.map((notification) => ({ ...notification })),
                    status: entry.session.status,
                    markedDone: entry.session.markedDone,
                }];
        });
        return {
            version: restart_1.RESTART_STATE_VERSION,
            selectedSessionId,
            sessions,
            // absent stays absent so older handoffs round-trip without gaining fields
            ...(this.lastPromptAt === null ? {} : { lastPromptAt: this.lastPromptAt }),
        };
    }
    /**
     * Resumes valid handoff records without attachment, acknowledgement, or notification suppression.
     * @param state Sanitized restart state consumed before discovery starts.
     * @returns Sessions successfully spawned; individual invalid/spawn-failed records are skipped.
     */
    restoreRestartState(state) {
        const restored = [];
        const seen = new Set();
        if (state.lastPromptAt !== undefined)
            this.lastPromptAt = Math.max(this.lastPromptAt ?? 0, state.lastPromptAt);
        for (const record of state.sessions) {
            const key = (0, types_1.sessionKey)(record.adapterId, record.cliSessionId);
            if (seen.has(key) || !this.tagStore.tags.includes(record.tag))
                continue;
            seen.add(key);
            try {
                restored.push(this.create(record.cwd, record.name, record.tag, record.cliSessionId, {
                    adapterId: record.adapterId,
                    attach: false,
                    status: record.status,
                    unread: record.unread,
                    markedDone: record.markedDone,
                }));
            }
            catch { }
        }
        this.attachedId = null;
        for (const session of restored)
            session.suppressNotifications = false;
        const selectedIndex = state.selectedSessionId
            ? this.entries.findIndex((entry) => entry.kind === 'active' && this.keyOf(entry.session) === state.selectedSessionId)
            : -1;
        this.selected = selectedIndex >= 0 ? selectedIndex : 0;
        this.onUpdate();
        return restored;
    }
    /**
     * Starts a reversible MOVE transaction for an active session, rejecting singleton groups.
     * @param session Selected active session that should remain selected throughout the move.
     * @returns User-facing rejection text, or null when MOVE state was created.
     */
    beginMove(session) {
        const group = this.runtimeOrder.get(session.tag) ?? [];
        if (!group.includes(session))
            return 'm only moves ACTIVE sessions';
        if (group.length <= 1)
            return `Only one session in #${session.tag}`;
        this.moveTransaction = { session, tag: session.tag, original: [...group] };
        this.selected = this.entries.findIndex((entry) => entry.kind === 'active' && entry.session === session);
        this.onUpdate();
        return null;
    }
    /**
     * Moves the transaction target by one row or to a group edge without crossing tag bounds,
     * updating selection to the same Session object for immediate sidebar preview.
     * @param destination Signed row delta, `top`, or `bottom` within the current tag group.
     * @returns Nothing.
     */
    moveSelected(destination) {
        const state = this.moveTransaction;
        if (!state)
            return;
        const group = this.runtimeOrder.get(state.tag) ?? [];
        const from = group.indexOf(state.session);
        if (from < 0)
            return;
        const to = destination === 'top' ? 0 : destination === 'bottom' ? group.length - 1 : Math.max(0, Math.min(group.length - 1, from + destination));
        if (to !== from) {
            group.splice(from, 1);
            group.splice(to, 0, state.session);
        }
        this.selected = this.entries.findIndex((entry) => entry.kind === 'active' && entry.session === state.session);
        this.onUpdate();
    }
    /**
     * Finalizes the runtime MOVE preview and atomically saves real-id order when every active
     * session in the group is resolved; unresolved groups are persisted by later discovery.
     * @returns Nothing.
     */
    commitMove() {
        const state = this.moveTransaction;
        if (!state)
            return;
        this.moveTransaction = null;
        this.persistGroup(state.tag);
        this.selected = this.entries.findIndex((entry) => entry.kind === 'active' && entry.session === state.session);
        this.onUpdate();
    }
    /**
     * Restores the exact pre-MOVE group snapshot and keeps the same logical Session selected.
     * @returns Nothing.
     */
    cancelMove() {
        const state = this.moveTransaction;
        if (!state)
            return;
        this.runtimeOrder.set(state.tag, [...state.original]);
        this.moveTransaction = null;
        this.selected = this.entries.findIndex((entry) => entry.kind === 'active' && entry.session === state.session);
        this.onUpdate();
    }
    /**
     * Applies owned-process RSS and optional lock ids, then persists newly resolved groups.
     * @param sessions Map of owned PTY pid to the current discovery sample.
     * @returns Nothing.
     */
    assignDiscoveredSessionIds(sessions) {
        const selected = this.selectedSession;
        const changedTags = new Set();
        for (const session of this.sessions) {
            const sample = sessions.get(session.pid);
            session.memoryBytes = session.exited ? null : sample?.memoryBytes ?? null;
            const realId = sample?.sessionId;
            if (session.cliSessionId || !realId)
                continue;
            this.resolveSessionId(session, realId);
            changedTags.add(session.tag);
        }
        for (const tag of changedTags)
            this.persistGroup(tag);
        if (selected)
            this.selected = this.entries.findIndex((entry) => entry.kind === 'active' && entry.session === selected);
        if (changedTags.size > 0)
            this.onUpdate();
    }
    /**
     * Records a session's first real CLI id: persists its tag and any alias typed before the id
     * was known. The caller persists group order.
     * @param session Owned session whose id was just learned.
     * @param realId Real CLI session id from discovery or a hook payload.
     * @returns Nothing.
     */
    resolveSessionId(session, realId) {
        session.cliSessionId = realId;
        const key = (0, types_1.sessionKey)(session.adapterId, realId);
        this.resumedKeys.add(key);
        this.tagStore.assignSessionTag(key, session.tag);
        const alias = this.pendingAliases.get(session);
        if (alias) {
            this.tagStore.setSessionAlias(key, alias);
            this.pendingAliases.delete(session);
        }
    }
    /**
     * Switches a running session to a new CLI id (Claude `/clear`), keeping its row, tag,
     * position and alias, and letting the previous conversation show up as RECENT again.
     * @param session Owned session that reported a different id.
     * @param realId The new real CLI session id.
     * @returns Nothing.
     */
    rekeySession(session, realId) {
        const oldKey = this.keyOf(session);
        const newKey = (0, types_1.sessionKey)(session.adapterId, realId);
        session.cliSessionId = realId;
        this.resumedKeys.delete(oldKey);
        this.resumedKeys.add(newKey);
        this.tagStore.renameSessionKey(oldKey, newKey);
        this.tagStore.assignSessionTag(newKey, session.tag);
        this.persistGroup(session.tag);
    }
    /**
     * Applies the `session_id` from a hook payload: fills in an unknown id immediately (no
     * waiting for the next discovery poll), and re-keys only for CLIs whose id can change.
     * @param session Session the hook ran under.
     * @param hookId Validated session id from the payload.
     * @returns Nothing.
     */
    noteHookSessionId(session, hookId) {
        if (session.cliSessionId === hookId)
            return;
        if (!session.cliSessionId) {
            this.resolveSessionId(session, hookId);
            this.persistGroup(session.tag);
        }
        else if (this.adapterFor(session.adapterId).sessionIdChanges) {
            this.rekeySession(session, hookId);
        }
    }
    /**
     * Saves a tag's current runtime order only when every active session has a real CLI session id;
     * used by MOVE commit and deferred discovery completion.
     * @param tag Canonical runtime group to conditionally persist.
     * @returns Nothing.
     */
    persistGroup(tag) {
        const group = this.runtimeOrder.get(tag) ?? [];
        const ids = group.map((session) => this.keyOf(session));
        if (ids.some((id) => !id))
            return;
        this.tagStore.saveSessionOrder(tag, ids);
    }
    /**
     * Adopts an external agent REPL exclusively, waiting for graceful exit before resuming it
     * as an owned PTY under the selected required tag.
     * @param ext External row confirmed by the user; must still be in the current poll's list.
     * @param tag Required canonical ACTIVE group chosen before destructive confirmation.
     * @returns Promise resolving to an error message, or null on success.
     */
    async adopt(ext, tag) {
        if (!this.discovery.externals.some((e) => e.pid === ext.pid && e.adapterId === ext.adapterId && e.sessionId === ext.sessionId))
            return 'Session is no longer running externally';
        try {
            process.kill(ext.pid, 'SIGTERM');
        }
        catch {
            return `Could not signal pid ${ext.pid}`;
        }
        const deadline = Date.now() + 5000;
        let alive = true;
        while (alive && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 200));
            try {
                process.kill(ext.pid, 0);
            }
            catch {
                alive = false;
            }
        }
        if (alive)
            return `"${this.displayName({ kind: 'external', external: ext })}" did not exit within 5s; try adopting again`;
        this.discovery.removeExternal(ext.pid);
        await new Promise((r) => setTimeout(r, 300));
        this.create(ext.cwd, ext.title || ext.sessionId, tag, ext.sessionId, { adapterId: ext.adapterId });
        return null;
    }
    toggleMarkedDone(session) {
        session.markedDone = !session.markedDone;
        this.onUpdate();
    }
    /**
     * Attaches to a session, selecting its runtime ACTIVE row, acknowledging unread entries,
     * suppressing notifications and resetting scrollback to the live bottom.
     * @param s Session to attach to.
     * @returns Nothing.
     */
    attach(s) {
        const prev = this.attachedSession;
        if (prev)
            prev.suppressNotifications = false;
        const index = this.entries.findIndex((entry) => entry.kind === 'active' && entry.session === s);
        if (index >= 0)
            this.selected = index;
        this.attachedId = s.id;
        s.unread = [];
        s.markedDone = false;
        s.suppressNotifications = true;
        s.scrollOffset = 0;
        this.onUpdate();
    }
    /**
     * Detaches from the current session, re-enabling notifications and resetting its preview.
     * @returns Nothing.
     */
    detach() {
        const s = this.attachedSession;
        if (s) {
            s.suppressNotifications = false;
            s.scrollOffset = 0;
        }
        this.attachedId = null;
        this.onUpdate();
    }
    /**
     * Kills and removes the selected owned session while retaining its persisted real id for
     * future restarts, then repairs selection and attachment state.
     * @returns Nothing.
     */
    killSelected() {
        const e = this.entries[this.selected];
        if (!e || e.kind !== 'active')
            return;
        const s = e.session;
        s.kill();
        s.term.dispose();
        this.sessions.splice(this.sessions.indexOf(s), 1);
        const group = this.runtimeOrder.get(s.tag);
        if (group)
            group.splice(group.indexOf(s), 1);
        if (this.attachedId === s.id)
            this.attachedId = null;
        this.selected = Math.max(0, Math.min(this.selected, Math.max(0, this.entries.length - 1)));
        this.onUpdate();
    }
    /**
     * Applies a hook event to the matching session and redraws its lifecycle status.
     * @param id Conductor session id from the event line.
     * @param event Hook event name.
     * @returns Nothing.
     */
    applyEvent(id, event, payload) {
        const s = this.sessions.find((x) => x.id === id);
        if (!s)
            return;
        const hookId = (0, payload_1.hookSessionId)(payload);
        if (hookId)
            this.noteHookSessionId(s, hookId);
        if (event === 'UserPromptSubmit') {
            const now = Date.now();
            this.lastPromptAt = this.lastPromptAt === null ? now : Math.max(this.lastPromptAt, now);
            if (s.status !== 'exited')
                s.status = 'working';
            const prompt = payload?.prompt;
            if (typeof prompt === 'string' && prompt.length > 0)
                s.noteSubmittedPrompt(prompt);
        }
        else if (event === 'Stop') {
            if (s.status !== 'exited')
                s.status = 'waiting';
            s.notify('stop');
        }
        else if (event === 'PermissionRequest') {
            if (s.status !== 'exited')
                s.status = 'needs-permission';
            s.notify('permission');
        }
        else if (event === 'SessionEnd') {
            s.status = 'exited';
            s.memoryBytes = null;
            s.notify('exit');
        }
        this.onUpdate();
    }
    /**
     * Suppresses shutdown alerts, kills every owned live PTY, and captures pids for polling.
     * @returns Pids that were live before termination was requested.
     */
    killAll() {
        const pids = this.sessions.filter((session) => !session.exited).map((session) => session.pid);
        for (const session of this.sessions) {
            session.suppressNotifications = true;
            session.kill();
        }
        return pids;
    }
}
exports.SessionManager = SessionManager;
