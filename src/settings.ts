import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createAdapters, isCommandAvailable } from './adapters/registry';
import { ADAPTER_IDS } from './adapters/types';
import type { AdapterId, CliAdapter } from './adapters/types';
import type { Discovery } from './discovery';
import type { DesktopNotifier } from './notify';
import type { TagStore } from './tags';
import { KOI_MAX_COUNT } from './ui/koi';
import { currentAppearance } from './ui/theme';
import type { ThemeSetting } from './ui/theme';

export type SettingId = 'theme' | 'koi' | 'koi_count' | 'desktop_notifications' | 'default_cwd' | 'default_adapter' | 'recent_limit' | `cli:${AdapterId}`;

/** How a row is edited: `cycle`/`toggle` step with arrows, `number` steps or is typed, `text` is typed. */
export type SettingKind = 'cycle' | 'toggle' | 'number' | 'text';

export interface SettingRow {
  id: SettingId;
  label: string;
  value: string;
  /** Short explanation shown dimmed under the row (e.g. "restart to apply"). */
  note: string;
  kind: SettingKind;
}

/** The slice of SessionManager the settings screen drives. */
export interface SettingsManager {
  readonly adapters: readonly CliAdapter[];
  readonly defaultAdapterId: AdapterId;
  readonly discovery: Pick<Discovery, 'recentLimit' | 'setBaseDirs' | 'refresh'>;
  setDefaultAdapter(id: AdapterId): void;
}

export interface SettingsDeps {
  tagStore: TagStore;
  manager: SettingsManager;
  notifier: Pick<DesktopNotifier, 'enabled'>;
  /** Directory Envoy was launched from; used when `default_cwd` is cleared. */
  launchDir: string;
  /** Receives the resolved default directory after it changes. */
  onDefaultCwd: (dir: string) => void;
  /** Re-resolves and repaints the color scheme after the `theme` setting changes. */
  onThemeChange: () => void;
  /** Starts or stops the koi background after the `koi` setting changes. */
  onKoiChange: (enabled: boolean) => void;
  /** Applies a new fixed koi count (undefined = automatic) to the running pond. */
  onKoiCountChange: (count: number | undefined) => void;
}

const THEMES: readonly ThemeSetting[] = ['auto', 'light', 'dark'];
export const RECENT_LIMIT_MIN = 1;
export const RECENT_LIMIT_MAX = 100;

/**
 * Backs the in-app settings screen: lists the editable settings, applies each change to the
 * running app where possible, and persists it to the config file through TagStore.
 */
export class AppSettings {
  /**
   * @param deps Config store plus the live objects each setting is applied to.
   */
  constructor(private readonly deps: SettingsDeps) {}

  /**
   * Builds the current rows in display order.
   * @returns One row per setting, reflecting the latest saved values.
   */
  rows(): SettingRow[] {
    const { tagStore, manager } = this.deps;
    const theme = tagStore.theme;
    const forced = process.env.ENVOY_THEME === 'light' || process.env.ENVOY_THEME === 'dark';
    const rows: SettingRow[] = [
      {
        id: 'theme',
        label: 'Theme',
        value: theme === 'auto' ? `auto (system, now ${currentAppearance()})` : theme,
        note: forced ? `ENVOY_THEME=${process.env.ENVOY_THEME} overrides this` : 'auto follows the system light/dark setting',
        kind: 'cycle',
      },
      {
        id: 'koi',
        label: 'Koi pond',
        value: tagStore.koi ? 'on' : 'off',
        note: 'swimming koi in the background (turn off on slow terminals or SSH)',
        kind: 'toggle',
      },
      {
        id: 'koi_count',
        label: 'Koi count',
        value: tagStore.koiCount === undefined ? 'auto' : String(tagStore.koiCount),
        note: `auto = 2–6 depending on window size; or choose 1–${KOI_MAX_COUNT}`,
        kind: 'cycle',
      },
      {
        id: 'desktop_notifications',
        label: 'Desktop notifications',
        value: tagStore.desktopNotifications ? 'on' : 'off',
        note: '',
        kind: 'toggle',
      },
      {
        id: 'default_cwd',
        label: 'Default directory',
        value: tagStore.defaultCwdSetting ?? `${this.deps.launchDir} (launch directory)`,
        note: 'offered when creating a new session; blank = launch directory',
        kind: 'text',
      },
      {
        id: 'default_adapter',
        label: 'Default CLI',
        value: manager.adapters.find((adapter) => adapter.id === manager.defaultAdapterId)?.label ?? manager.defaultAdapterId,
        note: manager.adapters.length > 1 ? 'preselected when creating a new session' : 'only one CLI is enabled',
        kind: 'cycle',
      },
      {
        id: 'recent_limit',
        label: 'RECENT rows',
        value: String(tagStore.recentLimit),
        note: `${RECENT_LIMIT_MIN}–${RECENT_LIMIT_MAX}, shared across CLIs`,
        kind: 'number',
      },
    ];
    const enabled = this.pendingEnabled();
    const running = manager.adapters.map((adapter) => adapter.id);
    const changed = enabled.length !== running.length || enabled.some((id) => !running.includes(id));
    const adapters = createAdapters(tagStore.adapterSettings.commands);
    for (const adapter of adapters) {
      const on = enabled.includes(adapter.id);
      const installed = isCommandAvailable(adapter.command());
      rows.push({
        id: `cli:${adapter.id}`,
        label: `CLI: ${adapter.label}`,
        value: on ? 'enabled' : 'disabled',
        note: `${installed ? 'found' : `"${adapter.command()}" not found`}${changed ? ' · restart Envoy to apply CLI changes' : ''}`,
        kind: 'toggle',
      });
    }
    return rows;
  }

  /**
   * Cycles, toggles or nudges one setting.
   * @param id Setting to change.
   * @param direction 1 for next/on/increase, -1 for previous/off/decrease.
   * @returns An error message, or '' on success.
   */
  step(id: SettingId, direction: 1 | -1): string {
    const { tagStore, manager, notifier } = this.deps;
    try {
      if (id === 'theme') {
        const at = THEMES.indexOf(tagStore.theme);
        const next = THEMES[(at + direction + THEMES.length) % THEMES.length];
        tagStore.setSetting('theme', next === 'auto' ? undefined : next);
        this.deps.onThemeChange();
      } else if (id === 'koi') {
        const next = !tagStore.koi;
        tagStore.setSetting('koi', next);
        this.deps.onKoiChange(next);
      } else if (id === 'koi_count') {
        // auto, 1, 2 ... max, wrapping in both directions
        const options = [undefined, ...Array.from({ length: KOI_MAX_COUNT }, (_, i) => i + 1)];
        const at = options.indexOf(tagStore.koiCount);
        const next = options[(at + direction + options.length) % options.length];
        tagStore.setSetting('koi_count', next);
        this.deps.onKoiCountChange(next);
      } else if (id === 'desktop_notifications') {
        const next = !tagStore.desktopNotifications;
        tagStore.setSetting('desktop_notifications', next);
        notifier.enabled = next;
      } else if (id === 'default_adapter') {
        const ids = manager.adapters.map((adapter) => adapter.id);
        if (ids.length < 2) return 'Only one CLI is enabled';
        const next = ids[(Math.max(0, ids.indexOf(manager.defaultAdapterId)) + direction + ids.length) % ids.length];
        manager.setDefaultAdapter(next);
        tagStore.setSetting('default_adapter', next);
      } else if (id === 'recent_limit') {
        return this.applyRecentLimit(tagStore.recentLimit + direction);
      } else if (id.startsWith('cli:')) {
        return this.toggleCli(id.slice(4) as AdapterId);
      } else {
        return 'Press Enter to edit this setting';
      }
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return '';
  }

  /**
   * Gives the text a typed setting starts editing with.
   * @param id A `text` or `number` setting.
   * @returns The current raw value ('' when unset).
   */
  initialText(id: SettingId): string {
    if (id === 'default_cwd') return this.deps.tagStore.defaultCwdSetting ?? '';
    if (id === 'recent_limit') return String(this.deps.tagStore.recentLimit);
    return '';
  }

  /**
   * Validates and saves a typed value.
   * @param id A `text` or `number` setting.
   * @param text Raw text from the editor.
   * @returns An error message to show in the editor, or '' once saved and applied.
   */
  commit(id: SettingId, text: string): string {
    try {
      if (id === 'recent_limit') {
        const value = text.trim();
        return /^\d+$/.test(value) ? this.applyRecentLimit(Number(value)) : `Enter a whole number from ${RECENT_LIMIT_MIN} to ${RECENT_LIMIT_MAX}`;
      }
      if (id === 'default_cwd') return this.applyDefaultCwd(text.trim());
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return 'This setting is not typed';
  }

  private applyRecentLimit(value: number): string {
    if (!Number.isInteger(value) || value < RECENT_LIMIT_MIN || value > RECENT_LIMIT_MAX) {
      return `RECENT rows must be a whole number from ${RECENT_LIMIT_MIN} to ${RECENT_LIMIT_MAX}`;
    }
    this.deps.tagStore.setSetting('recent_limit', value);
    this.deps.manager.discovery.recentLimit = value;
    this.deps.manager.discovery.refresh();
    return '';
  }

  private applyDefaultCwd(raw: string): string {
    let dir = this.deps.launchDir;
    if (raw) {
      dir = path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()));
      let ok = false;
      try {
        ok = fs.statSync(dir).isDirectory();
      } catch {}
      if (!ok) return `Not a directory: ${dir}`;
    }
    this.deps.tagStore.setSetting('default_cwd', raw || undefined);
    this.deps.onDefaultCwd(dir);
    this.deps.manager.discovery.setBaseDirs([...new Set([dir, this.deps.launchDir])]);
    this.deps.manager.discovery.refresh();
    return '';
  }

  /**
   * The CLI set that will be enabled at the next start: an explicit saved list, else the
   * CLIs running now (auto-detected from PATH).
   * @returns Enabled CLI ids in canonical order.
   */
  private pendingEnabled(): AdapterId[] {
    const explicit = this.deps.tagStore.adapterSettings.enabled;
    const ids = explicit && explicit.length > 0 ? explicit : this.deps.manager.adapters.map((adapter) => adapter.id);
    return ADAPTER_IDS.filter((id) => ids.includes(id));
  }

  private toggleCli(id: AdapterId): string {
    const current = this.pendingEnabled();
    const next = current.includes(id) ? current.filter((existing) => existing !== id) : ADAPTER_IDS.filter((existing) => existing === id || current.includes(existing));
    if (next.length === 0) return 'At least one CLI must stay enabled';
    this.deps.tagStore.setSetting('enabled_adapters', next);
    return '';
  }
}
