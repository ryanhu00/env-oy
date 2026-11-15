# Envoy

A Conductor-style terminal session manager for agent CLIs: one fullscreen TUI that runs
multiple embedded REPL sessions side by side, with a sidebar showing live status and
unread-notification badges, and a right pane showing the live terminal of the selected session.
The sidebar also discovers REPLs running in other terminal windows (adoptable) and
recently active sessions (resumable).

Envoy works with **Devin**, **Claude Code** and **Codex**, in any mix. You only need the ones you
use.

## Install & run

Requires Node >= 20 and at least one supported CLI (`devin`, `claude` or `codex`) on your PATH.

```sh
npm install
npm run build
npm start
```

`npm start` runs the stable `bin/envoy` launcher. Install a shell alias that points to that
launcher rather than directly to `node dist/index.js`:

```sh
alias envoy='/absolute/path/to/envoy/bin/envoy'
```

After installing or updating the alias, quit any already-running Envoy instance and invoke `envoy`
once. This one-time bootstrap puts the stable launcher in the foreground job; subsequent uppercase
`R` refreshes stay inside that same shell job. `npm run dev` still starts TypeScript directly for
development and intentionally cannot perform in-app refresh.

## Keybindings

| Key | Mode | Action |
| --- | --- | --- |
| `j` / `k`, arrows | sidebar · MOVE · tag lists | move the selection down / up (sidebar: across all sections; MOVE: preview one position within the tag group; tag lists: through tags or insertion slots) |
| `gg` / `G` | sidebar · MOVE · tag lists · attached NORMAL | jump to the first / last row (attached NORMAL: top of scrollback / back to the live bottom) |
| `Ctrl-u` / `Ctrl-d` | sidebar · attached NORMAL | half page up / down (attached NORMAL: through scrollback, down = newest) |
| `Enter` | sidebar | ACTIVE: attach (acks notifications) · TERMINAL: choose tag, then adopt (y/n confirm) · RECENT: choose tag, then resume |
| `n` | sidebar | new session: working dir (`~` ok), optional name, then a required tag |
| `←` / `→`, `Tab` | new-session form | `←` / `→` changes the CLI (only when several are enabled); `Tab` switches between the directory and name fields |
| `r` | sidebar | rename any selected ACTIVE, RECENT or TERMINAL row with a persistent Envoy-only alias |
| text / paste, `Backspace`, `Ctrl-u`, `Enter`, `Esc` | RENAME | edit the alias, delete a character, clear the field, save (blank clears the alias), cancel |
| `H` | sidebar | hide or show the RECENT section for the current Envoy run |
| `R` | sidebar | confirm an in-app Envoy refresh and reconnect every live idle ACTIVE session |
| `m` | sidebar | enter MOVE mode for the selected ACTIVE session within its current tag |
| `Enter` / `Esc` | MOVE | commit and persist the preview / cancel and restore the original order |
| `d` | sidebar | flag or unflag the selected ACTIVE session as `DONE — NEEDS YOU` |
| `x` | sidebar | kill the selected ACTIVE session (y/n confirm) |
| `,` | sidebar | open the settings screen (theme, koi, default directory and CLI, enabled CLIs, RECENT rows, notifications) |
| `q` | sidebar | quit and kill all sessions (y/n confirm) |
| `i` / `a`, `p` | attached NORMAL | `i` / `a` enters INSERT (snaps back to the live bottom); `p` jumps to the most recently submitted prompt |
| `Ctrl-q` | attached | INSERT → NORMAL, and NORMAL → back to the sidebar |
| any other key | attached | NORMAL: ignored. INSERT: forwarded verbatim to the session (including `Esc`, which the agent CLI uses to cancel) |
| `Enter` | tag picker / tag position | select an existing tag, or persist and select a new tag at the chosen slot |
| `n` | tag picker | enter a custom tag name |
| `Esc` | tag picker · tag name / tag position | picker: cancel the whole pending create/resume/adopt action · name / position: return to the previous tag screen |

## Notification hooks

Status changes and badges are driven by CLI lifecycle hooks. On first launch the app
offers (y/n prompt) to install four hook entries (`UserPromptSubmit`, `Stop`,
`PermissionRequest`, `SessionEnd`) for each supported CLI that is **installed** (its binary is
on `PATH`); CLIs you do not have are never offered or touched. Each config is backed up to
`<file>.bak-envoy` first and existing hooks and keys are preserved. A config that is not a valid
JSON object is left untouched and reported instead of overwritten. Each hook runs
`bin/envoy-hook.sh <EventName>`.

| CLI | Config file |
| --- | --- |
| Devin | `~/.config/devin/config.json` |
| Claude | `~/.claude/settings.json` |
| Codex | `~/.codex/hooks.json` (hooks are on by default, but Codex must trust new hooks once: run `/hooks`) |

The hook payload's `session_id` is used to learn a session's real id as soon as its first hook
fires, instead of waiting for the next discovery poll. Duplicate deliveries (identical event,
session and payload within one second, e.g. Devin also reading `~/.claude/settings.json`) are
collapsed into one event.

`bin/envoy-hook.sh` exits 0 immediately when `ENVOY_ID` is unset, so sessions launched outside
this app are unaffected. For sessions spawned by the app it appends JSON lines to
`$ENVOY_EVENTS_DIR/events.jsonl` (default `~/.local/share/envoy/`), which the app tails to
update statuses.

## Configuration

Config at `~/.config/envoy/config.json` (in your home directory, not in this repo):

```json
{
  "default_cwd": "~/code",
  "desktop_notifications": true,
  "enabled_adapters": ["devin", "claude", "codex"],
  "default_adapter": "claude",
  "adapter_commands": { "claude": "~/bin/claude-wrapper" },
  "recent_limit": 10,
  "tags": ["investigation", "planning", "code", "chat"],
  "session_order": {},
  "session_aliases": {}
}
```

Optional keys. Unknown ids and malformed values are ignored, never fatal:

| Key | Meaning |
| --- | --- |
| `enabled_adapters` | CLIs to drive, from `devin`, `claude`, `codex`. When absent, every CLI found on `PATH` is enabled (Devin alone if none is found, so Envoy still starts). Hooks are only offered for enabled CLIs. |
| `default_adapter` | CLI preselected in the `n` form. Falls back to Devin, then to the first enabled CLI, when it is not enabled. |
| `adapter_commands` | Executable per CLI (`~` ok). The matching `ENVOY_*_CMD` variable wins when set. An explicit path counts as installed even when it is not on `PATH`. |
| `recent_limit` | Maximum RECENT rows across all CLIs, a whole number from 1 to 100 (default 10). |
| `default_cwd` | Working directory offered in the `n` form (fallback: the launch directory). |
| `desktop_notifications` | Set to `false` to turn off desktop notifications. |
| `theme` | `light` or `dark` forces the colors; absent (or anything else) follows the system setting. `ENVOY_THEME` wins over it. |
| `koi` | Set to `false` to turn off the swimming-koi background and its water ripples (default on). |
| `koi_count` | Fixed number of koi, 1–12. Absent = automatic: 2–6 depending on the window size. |

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ENVOY_CMD` | command spawned for Devin sessions (default `devin`; useful for testing) |
| `ENVOY_CLAUDE_CMD` | command spawned for Claude sessions (default `claude`) |
| `ENVOY_CODEX_CMD` | command spawned for Codex sessions (default `codex`) |
| `ENVOY_EVENTS_DIR` | override the events directory |
| `ENVOY_NO_HOOK_PROMPT=1` | skip the hook-install prompt at startup |
| `ENVOY_THEME` | `light` or `dark` forces the colors; `auto` (default) follows the system setting |
| `ENVOY_RESTART_CHANNEL` | internal validated launcher channel retained across refreshes |

## Env files

Envoy does not load a `.env` file itself. Every session inherits the environment Envoy was
started with, so put API keys and profiles in a local file outside any git repo, then load it
when you launch Envoy:

```sh
# ~/.config/envoy/keys.env  (chmod 600; keep this out of git)
GH_TOKEN=...
AWS_PROFILE=dev
```

```sh
# shell alias / function
envoy() {
  ( set -a; . ~/.config/envoy/keys.env; set +a; command /absolute/path/to/envoy/bin/envoy "$@" )
}
```

The file stays on your machine. Prefer logged-in CLIs and profiles (`gh auth login`,
`AWS_PROFILE` + `~/.aws`) over raw long-lived secrets when you can.

## Development

```sh
npm install
npm run dev      # run from TypeScript (no in-app refresh)
npm run build    # compile to dist/
npm test         # tsx --test test/*.test.ts
```

Everything CLI-specific lives behind the `CliAdapter` interface in `src/adapters/types.ts`:
how to spawn and resume the CLI, how to recognise its processes in `ps`, how to resolve a process
to its session id and working directory, and how to list its recent sessions. There is one file
per CLI (`devin.ts`, `claude.ts`, `codex.ts`), and `registry.ts` decides which a~re enabled. To add
a CLI, implement the interface, add it to `createAdapters`, add its id to `ADAPTER_IDS`, and add a
hook entry for it in `src/hooks/installer.ts`. Session ids are stored per CLI as
`sessionKey(adapterId, id)` (Devin bare, others prefixed `claude:` / `codex:`), so ids from
different CLIs never collide in aliases, saved order or refresh state.

The tests spawn real PTYs with fake CLI scripts and need to run outside restrictive sandboxes (they
use `ps`, `lsof` and Unix sockets).

## Per-CLI notes

**Claude Code**

- `CLAUDE_CONFIG_DIR` is honoured.
- Headless (`-p`), `mcp`, `--chrome-native-host` and other helper processes are ignored.
- When a hook reports a new `session_id` for a running session (after `/clear`), the same sidebar
  row follows it and keeps its tag, position and alias.

**Codex**

- `CODEX_HOME` is honoured.
- Only the interactive TUI counts. `exec`, `app-server` (including the editor extension's),
  `mcp-server` and other subcommands are ignored.
- Codex opens its rollout file only after the first message, so a brand-new session has no id until
  then. Envoy learns it from the hook's `session_id`. A session started in another window appears
  under TERMINAL once it has sent a message.
- `/new` is followed the same way as Claude's `/clear`.
- RECENT looks at day folders from the last 14 days.

**Devin**

- Session ids come from `session_locks`, so they are known as soon as the session starts. A Devin
  session never changes its id.
