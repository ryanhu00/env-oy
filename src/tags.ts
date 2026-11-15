import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const SEEDED_TAGS = ['investigation', 'planning', 'code', 'chat'] as const;
export const SESSION_ALIAS_MAX_LENGTH = 120;

export class TagStore {
  private ordered: string[];
  private sessionOrder: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  private sessionAliases: Record<string, string> = Object.create(null) as Record<string, string>;
  private config: Record<string, unknown>;

  /**
   * Loads tags, real-id order and valid dgui aliases while retaining unrelated config keys.
   * @param configPath Config file path; tests may provide an isolated location.
   * @returns A store used as the sole conductor-config writer.
   */
  constructor(readonly configPath = path.join(os.homedir(), '.config', 'devin-conductor', 'config.json')) {
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      parsed = {};
    }
    this.config = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    const configured = this.config.tags;
    const valid =
      Array.isArray(configured) &&
      configured.length > 0 &&
      configured.every((tag) => typeof tag === 'string' && tag.trim().length > 0 && tag === tag.trim()) &&
      new Set(configured.map((tag) => (tag as string).toLocaleLowerCase())).size === configured.length;
    this.ordered = valid ? [...(configured as string[])] : [...SEEDED_TAGS];
    const configuredOrder = this.config.session_order;
    if (typeof configuredOrder === 'object' && configuredOrder !== null && !Array.isArray(configuredOrder)) {
      for (const [tag, value] of Object.entries(configuredOrder)) {
        if (!tag.trim() || !Array.isArray(value)) continue;
        const ids = value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0 && id === id.trim());
        this.sessionOrder[tag] = [...new Set(ids)];
      }
    }
    const configuredAliases = this.config.session_aliases;
    if (typeof configuredAliases === 'object' && configuredAliases !== null && !Array.isArray(configuredAliases)) {
      for (const [id, value] of Object.entries(configuredAliases)) {
        if (!id.trim() || id !== id.trim() || typeof value !== 'string') continue;
        const alias = value.trim();
        if (alias && alias.length <= SESSION_ALIAS_MAX_LENGTH) this.sessionAliases[id] = alias;
      }
    }
    if (!valid) this.persist({ ...this.config, tags: this.ordered, session_order: this.sessionOrder, session_aliases: this.sessionAliases });
  }

  /**
   * Exposes the current canonical tag order for pickers and ACTIVE grouping.
   * @returns Read-only ordered tag names.
   */
  get tags(): readonly string[] {
    return this.ordered;
  }

  /** Returns the Haein-only sidebar grouping preference, defaulting to pipeline stages. */
  get haeinSidebarGrouping(): 'tag' | 'pipeline_stage' {
    return this.config.haein_sidebar_grouping === 'tag' ? 'tag' : 'pipeline_stage';
  }

  /** Persists the Haein-only sidebar grouping without changing normal-mode tag settings. */
  setHaeinSidebarGrouping(grouping: 'tag' | 'pipeline_stage'): void {
    this.persist({ ...this.config, tags: this.ordered, session_order: this.sessionOrder, session_aliases: this.sessionAliases, haein_sidebar_grouping: grouping });
  }

  /**
   * Returns persisted real Devin ids for one tag in relative sidebar order.
   * @param tag Canonical session tag whose saved order is requested.
   * @returns Copy of the saved id list, or an empty array when none is valid.
   */
  getSessionOrder(tag: string): readonly string[] {
    return [...(this.sessionOrder[tag] ?? [])];
  }

  /**
   * Looks up a persisted dgui-only alias by real Devin session id.
   * @param id Real Devin session id used by discovery and resume.
   * @returns The alias, or undefined when the original title should be shown.
   */
  getSessionAlias(id: string): string | undefined {
    return this.sessionAliases[id];
  }

  /**
   * Validates and atomically sets or clears one real-id dgui alias.
   * @param id Non-empty real Devin session id; conductor ids and pids must not be supplied.
   * @param value Raw alias; trimming to blank clears it.
   * @returns The trimmed alias, or undefined after a clear.
   */
  setSessionAlias(id: string, value: string): string | undefined {
    if (!id.trim() || id !== id.trim()) throw new Error('A real Devin session ID is required');
    const alias = value.trim();
    if (alias.length > SESSION_ALIAS_MAX_LENGTH) throw new Error(`Alias must be ${SESSION_ALIAS_MAX_LENGTH} characters or fewer`);
    const next = { ...this.sessionAliases };
    if (alias) next[id] = alias;
    else delete next[id];
    this.persist({ ...this.config, tags: this.ordered, session_order: this.sessionOrder, session_aliases: next });
    this.sessionAliases = next;
    return alias || undefined;
  }

  /**
   * Trims and validates a proposed custom tag against length and case-insensitive uniqueness.
   * @param name Raw tag name entered by the user.
   * @returns Trimmed canonical name for insertion.
   */
  validateName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Tag name cannot be empty');
    if (trimmed.length > 30) throw new Error('Tag name must be 30 characters or fewer');
    if (this.ordered.some((tag) => tag.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) throw new Error(`Tag already exists: ${trimmed}`);
    return trimmed;
  }

  /**
   * Validates and atomically inserts a custom tag at a zero-based slot, then publishes the
   * new order to managers and pickers.
   * @param name Raw custom tag name.
   * @param position Zero-based insertion position from 0 through the current length.
   * @returns Trimmed inserted tag name.
   */
  insert(name: string, position: number): string {
    if (!Number.isInteger(position) || position < 0 || position > this.ordered.length) throw new RangeError('Tag position is out of range');
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
  assignSessionTag(id: string, tag: string): void {
    if (!id.trim()) return;
    const next = Object.create(null) as Record<string, string[]>;
    let selectedIndex = -1;
    for (const [name, ids] of Object.entries(this.sessionOrder)) {
      if (name === tag) selectedIndex = ids.indexOf(id);
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
  saveSessionOrder(tag: string, ids: readonly string[]): void {
    const active = [...new Set(ids.filter((id) => id.trim().length > 0))];
    const activeSet = new Set(active);
    const next = Object.create(null) as Record<string, string[]>;
    for (const [name, saved] of Object.entries(this.sessionOrder)) next[name] = saved.filter((id) => !activeSet.has(id));
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
  private persist(next: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    const temp = `${this.configPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(temp, this.configPath);
      this.config = next;
    } finally {
      try {
        fs.unlinkSync(temp);
      } catch {}
    }
  }
}
