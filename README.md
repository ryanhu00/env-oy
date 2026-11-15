# Envoy

A Conductor-style terminal session manager for agent CLIs: one fullscreen TUI that runs
multiple embedded REPL sessions side by side, with a sidebar showing live status and
unread-notification badges, and a right pane showing the live terminal of the selected session.
The sidebar also discovers REPLs running in other terminal windows (adoptable) and
recently active sessions (resumable).

Envoy works with **Devin**, **Claude Code** and **Codex**, in any mix. You only need the ones you
use.

## Supported CLIs

| CLI | Spawn / resume | Running in another window | RECENT (24h) |
| --- | --- | --- | --- |
| Devin | `devin` / `devin -r <id>` | `session_locks` via `lsof` | `devin list` (SQLite fallback) |
| Claude Code | `claude` / `claude --resume <id>` | `~/.claude/sessions/<pid>.json`, only for pids `ps` shows as a Claude REPL | `~/.claude/projects/*/<id>.jsonl` (cwd and title read from the file) |
| Codex | `codex` / `codex resume <id>` | the open `rollout-*-<id>.jsonl` file of the process via `lsof` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (cwd and first prompt read from the file, name from `session_index.jsonl`) |

### Which CLIs Envoy drives

Every CLI whose executable is on your `PATH`, or exactly the list in `enabled_adapters` if you set
one (see [Configuration](#configuration)). The list is read at startup, so restart Envoy after
installing a CLI.

With more than one CLI enabled:

- the `n` form gets a CLI picker (`←` / `→`), preselecting `default_adapter`;
- every sidebar row shows a short badge: `DV` Devin, `CL` Claude, `CX` Codex;
- the bottom bar breaks the AGENTS memory total down per CLI.

With a single CLI none of that is shown, because there is nothing to choose.

### Per-CLI notes

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

## Working in other repositories (creating PRs)

Envoy never runs `git` or `gh` and never touches a repository itself. Each session is simply the
agent CLI running in a directory you choose, and **the agent** creates branches and PRs from
there, in whichever repository that directory belongs to. So the question is only where the
session starts and what the session's environment allows.

**No shared base directory is needed.** Envoy can live anywhere and the session's directory can be
any existing directory on the machine, in a different repository from Envoy's own or from your
other sessions:

- In the `n` form, type the repository's path (`~` is expanded; a relative path is resolved
  against the directory Envoy was launched from). Anything that is not an existing directory is
  rejected.
- A RECENT session resumes in the directory it was recorded with, and adopting a TERMINAL session
  keeps that window's directory.
- Set `default_cwd` in the config (see [Configuration](#configuration)) to your usual code root so
  the form starts there instead of the launch directory.

**Recommended setup: one session per repository.** Start a session in each repo's directory. The
agent's git commands, branch and PR then all target that repo, and the sidebar tags and aliases
keep them apart.

**What the session needs in order to push and open a PR.** A session inherits the environment of
the shell that launched Envoy (plus `ENVOY_ID` and `ENVOY_EVENTS_DIR`). Before starting Envoy,
check from that same terminal:

```sh
git -C ~/code/other-repo remote -v   # a remote you can push to
gh auth status                       # or export GH_TOKEN / GITHUB_TOKEN before launching Envoy
```

Credentials that exist only in another shell, or in a different `PATH`, will not be visible to
the sessions. The agent CLI's own permission settings also decide whether it may run `git push`
and `gh pr create` without asking, and some CLIs sandbox network access or writes by default
(Codex's sandbox and approval modes, Claude Code's permission prompts, Devin's permission
prompts). Configure that in each CLI. Envoy only shows the "permission needed" state when the CLI
asks.

**One session that needs to change two repositories.** Start it in a parent directory that holds
both, or in the main repository, and give the CLI extra writable directories with its own option
(Codex has `--add-dir <DIR>`; run `claude --help` / `devin --help` for the equivalent). Envoy
passes no extra arguments, so put the flag in a small wrapper script and point `adapter_commands`
at it:

```sh
#!/bin/sh
# ~/bin/codex-wrapper  (chmod +x)
exec codex --add-dir ~/code/other-repo "$@"
```

```json
{ "adapter_commands": { "codex": "~/bin/codex-wrapper" } }
```

Use `exec` so the CLI itself is the process Envoy sees, and keep `"$@"` so resume arguments such as
`resume <id>` are passed through. Environment variables like `GH_TOKEN` can also be set inside
such a wrapper when you want them for Envoy's sessions only.

**RECENT and other repositories.** Claude and Codex RECENT list sessions from any directory. Devin
lists sessions per directory, so Devin RECENT only covers `default_cwd`, the directory Envoy was
launched from, and the directories of Devin sessions currently running in other windows. Start
Envoy from, or set `default_cwd` to, a directory Devin used if an older Devin session in another
repo is missing.

## Keybindings

| Key | Mode | Action |
| --- | --- | --- |
| `j` / `k` | sidebar | move selection down / up (across all sections) |
| `gg` / `G` | sidebar | jump to top / bottom |
| `Ctrl-u` / `Ctrl-d` | sidebar | half page up / down |
| `Enter` | sidebar | ACTIVE: attach (acks notifications) · TERMINAL: choose tag, then adopt (y/n confirm) · RECENT: choose tag, then resume |
| `n` | sidebar | new session (asks working dir, `~` ok, optional name, then required tag; `←` / `→` picks the CLI when several are enabled) |
| `←` / `→` | new-session form | change the CLI (only when more than one CLI is enabled) |
| `Tab` | new-session form | switch between the working directory and name fields |
| `r` | sidebar | rename any selected ACTIVE, RECENT or TERMINAL row with a persistent Envoy-only alias |
| `H` | sidebar | hide or show the RECENT section for the current Envoy run |
| `R` | sidebar | confirm an in-app Envoy refresh and reconnect every live idle ACTIVE session |
| text / paste, `Backspace`, `Ctrl-u` | RENAME | edit the alias, delete one character, or clear the field |
| `Enter` / `Esc` | RENAME | save the trimmed alias (blank clears it) / cancel unchanged |
| `m` | sidebar | enter MOVE mode for the selected ACTIVE session within its current tag (other rows flash a hint) |
| `j` / `k`, arrows | MOVE | preview one position down / up within the current tag group |
| `gg` / `G` | MOVE | preview at the first / last position in the current tag group |
| `Enter` / `Esc` | MOVE | commit and persist the preview / cancel and restore the exact original order |
| `d` | sidebar | flag or unflag the selected ACTIVE session as `DONE — NEEDS YOU` (other rows just flash a hint) |
| `x` | sidebar | kill selected ACTIVE session (y/n confirm; other rows just flash a hint) |
| `q` | sidebar | quit and kill all sessions (y/n confirm) |
| `j` / `k`, `Ctrl-d` / `Ctrl-u` | attached NORMAL | scroll half a pane down (newest) / up (oldest) through scrollback |
| `gg` / `G` | attached NORMAL | jump to top of scrollback / back to the live bottom |
| `p` | attached NORMAL | jump to the start of the most recently submitted prompt; show a transient notice if unavailable |
| `i` / `a` | attached NORMAL | enter INSERT mode (snaps back to the live bottom) |
| `Ctrl-q` | attached NORMAL | detach back to the sidebar |
| any other key | attached NORMAL | ignored (never forwarded to the session) |
| `Ctrl-q` | attached INSERT | back to NORMAL mode |
| any other key | attached INSERT | forwarded verbatim to the session PTY (including `Esc`, which the agent CLI uses to cancel) |
| `j` / `k`, arrows | tag picker / tag position | move through tags or insertion slots |
| `gg` / `G` | tag picker / tag position | jump to the first / last row |
| `Enter` | tag picker / tag position | select an existing tag, or persist and select a new tag at the chosen slot |
| `n` | tag picker | enter a custom tag name |
| `Esc` | tag picker | cancel the whole pending create/resume/adopt action and return to the sidebar |
| `Esc` | tag name / tag position | return to the previous tag screen |

## Attached modes

Attaching opens the session with vim-style submodes. Plain `Enter` on an ACTIVE row,
resuming a RECENT session and adopting a TERMINAL session all land in **NORMAL** mode,
where you can read scrollback first (a `↑N` indicator in the status bar shows how many
lines you are above the live bottom, `p` puts the latest prompt submitted through this Envoy
process at the top of the pane when it remains in scrollback, and the terminal cursor is
hidden). Sessions created via the `n` form instead land directly in **INSERT** mode, since
a brand-new session needs its first prompt typed immediately. Typing any input, entering
INSERT, or pressing `G` snaps the view back to the live bottom.

While you are scrolled up in NORMAL mode, the top row of the right pane is replaced by a pinned
header showing the user message of the turn you are currently looking at, so you always know
which prompt the visible output belongs to. The header updates as scrolling crosses a turn
boundary, takes one pane row (the bottom-most row of the scrolled view is hidden while it is
shown), and disappears at the live bottom — which is also where INSERT mode always sits, so it
never covers a line you are typing into. It only covers turns whose
`UserPromptSubmit` hook this Envoy process observed, so scrollback from before a session was
resumed or adopted — and any turn submitted while the hooks were not installed — has no header.

## Pasting

The app enables bracketed paste on your host terminal, so a multi-line paste arrives as one
block instead of a stream of Enter presses. In attached **INSERT** mode the paste is passed
through to the session: if the child app has bracketed paste enabled, the payload is
re-wrapped in `\x1b[200~`/`\x1b[201~` markers so it lands as a single paste; otherwise
(e.g. plain bash) it is forwarded verbatim. In the `n` form, RENAME mode and custom
tag-name screen the paste is inserted into the active text field with control characters
stripped. In the sidebar, tag picker/position list, attached NORMAL mode and confirm prompts, pastes are
ignored entirely — so a stray paste can never trigger destructive keys like `x`, `q` or `y`.

## Sidebar sections

The sidebar is split into three sections (headers are only shown when non-empty), and the
selection cursor moves seamlessly across all of them. Press `r` on any row to assign an
Envoy-only alias; this never renames the underlying CLI session itself:

- **ACTIVE** — sessions owned by this app, grouped under visible tag subheaders in configured
  tag order.
- **RECENT** — sessions from each enabled CLI's own history that are *not* currently running
  anywhere, with activity in the last 24 hours (newest first). At most `recent_limit` rows
  (default 10) are shown in total; the slots are dealt across CLIs so one busy CLI cannot push
  every other CLI out of the list, and slots a quiet CLI does not use go to the others.
- **TERMINAL** — REPL processes of any enabled CLI running in *other* terminal windows,
  discovered every ~5s.

## In-app refresh

Press uppercase `R` in the sidebar to load newly built Envoy code without manually quitting and
relaunching. Refresh is always confirmed. It is allowed only when every non-exited ACTIVE session
is `waiting` and has a real session ID.

`bin/envoy` remains the shell's foreground job for the whole invocation and runs one Node process at
a time. It creates a unique private restart-channel pathname under
`~/.local/share/envoy/`, keeps the directory mode 0700, and passes the path through the
environment without creating the file. On confirmed refresh, Node atomically writes versioned state
to that exact channel with mode 0600 before stopping anything.

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

Config at `~/.config/envoy/config.json`:

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

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ENVOY_CMD` | command spawned for Devin sessions (default `devin`; useful for testing) |
| `ENVOY_CLAUDE_CMD` | command spawned for Claude sessions (default `claude`) |
| `ENVOY_CODEX_CMD` | command spawned for Codex sessions (default `codex`) |
| `ENVOY_EVENTS_DIR` | override the events directory |
| `ENVOY_NO_HOOK_PROMPT=1` | skip the hook-install prompt at startup |
| `ENVOY_RESTART_CHANNEL` | internal validated launcher channel retained across refreshes |

## Troubleshooting

**The `n` form has no CLI picker.** The picker only appears when more than one CLI is enabled, and
by default only CLIs found on `PATH` are enabled. Check with `command -v devin claude codex`, or
list the CLIs you want in `enabled_adapters`. Restart Envoy after changing either.

**A CLI is missing from the picker or never offered hooks.** It is not on `PATH` and not in
`enabled_adapters`. If its executable lives elsewhere, point `adapter_commands` at it.

**A Codex session running in another window is not listed.** Codex only opens its session file
after the first message, so the session has no id Envoy can read before that. It appears under
TERMINAL after you send a message.

**Status never leaves IDLE or no badges appear.** Status comes from the CLI hooks. Accept the
hook prompt at startup (or set up the hook file listed under Notification hooks). Codex also
needs a one-time trust review: open Codex and run `/hooks`.

**RECENT is missing a session.** Only sessions active in the last 24 hours that are not already
running or open in Envoy are listed, capped by `recent_limit`. Codex sessions are found only in
day folders from the last 14 days.

**Adopting a session closes it in the other window.** That is intended: Envoy sends it SIGTERM and
resumes it here so only one process owns the session.

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
per CLI (`devin.ts`, `claude.ts`, `codex.ts`), and `registry.ts` decides which are enabled. To add
a CLI, implement the interface, add it to `createAdapters`, add its id to `ADAPTER_IDS`, and add a
hook entry for it in `src/hooks/installer.ts`. Session ids are stored per CLI as
`sessionKey(adapterId, id)` (Devin bare, others prefixed `claude:` / `codex:`), so ids from
different CLIs never collide in aliases, saved order or refresh state.

The tests spawn real PTYs with fake CLI scripts and need to run outside restrictive sandboxes (they
use `ps`, `lsof` and Unix sockets).
