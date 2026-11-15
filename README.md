# devin-conductor

A Conductor-style terminal session manager for the Devin CLI: one fullscreen TUI that runs
multiple embedded `devin` REPL sessions side by side, with a sidebar showing live status and
unread-notification badges, and a right pane showing the live terminal of the selected session.
The sidebar also discovers `devin` REPLs running in other terminal windows (adoptable) and
recently active sessions (resumable).

## Install & run

Requires Node >= 20 and `devin` on your PATH.

```sh
npm install
npm run build
npm start
```

`npm start` runs the stable `bin/dgui` launcher. Install a shell alias that points to that
launcher rather than directly to `node dist/index.js`:

```sh
alias dgui='/absolute/path/to/devin-conductor/bin/dgui'
```

After installing or updating the alias, quit any already-running dgui instance and invoke `dgui`
once. This one-time bootstrap puts the stable launcher in the foreground job; subsequent uppercase
`R` refreshes stay inside that same shell job. `npm run dev` still starts TypeScript directly for
development and intentionally cannot perform in-app refresh.

## Keybindings

| Key | Mode | Action |
| --- | --- | --- |
| `j` / `k` | sidebar | move selection down / up (across all sections) |
| `gg` / `G` | sidebar | jump to top / bottom |
| `Ctrl-u` / `Ctrl-d` | sidebar | half page up / down |
| `Enter` | sidebar | ACTIVE: attach (acks notifications) · TERMINAL: choose tag, then adopt (y/n confirm) · RECENT: choose tag, then resume |
| `n` | sidebar | new session (asks working dir, `~` ok, optional name, then required tag) |
| `r` | sidebar | rename any selected ACTIVE, RECENT or TERMINAL row with a persistent dgui-only alias |
| `H` | sidebar | hide or show the RECENT section for the current dgui run |
| `R` | sidebar | confirm an in-app dgui refresh and reconnect every live idle ACTIVE session |
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
| any other key | attached INSERT | forwarded verbatim to the session PTY (including `Esc`, which devin uses to cancel its agent) |
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
lines you are above the live bottom, `p` puts the latest prompt submitted through this dgui
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
`UserPromptSubmit` hook this dgui process observed, so scrollback from before a session was
resumed or adopted — and any turn submitted while the hooks were not installed — has no header.

## Pasting

The app enables bracketed paste on your host terminal, so a multi-line paste arrives as one
block instead of a stream of Enter presses. In attached **INSERT** mode the paste is passed
through to the session: if the child app has bracketed paste enabled (the devin REPL does),
the payload is re-wrapped in `\x1b[200~`/`\x1b[201~` markers so it lands as a single paste;
otherwise (e.g. plain bash) it is forwarded verbatim. In the `n` form, RENAME mode and custom
tag-name screen the paste is inserted into the active text field with control characters
stripped. In the sidebar, tag picker/position list, attached NORMAL mode and confirm prompts, pastes are
ignored entirely — so a stray paste can never trigger destructive keys like `x`, `q` or `y`.

## Sidebar sections

The sidebar is split into three sections (headers are only shown when non-empty), and the
selection cursor moves seamlessly across all of them. Press `r` on any row to assign a dgui-only
alias; this never renames the Devin session itself, writes Devin's database, signals a process or
sends input to a PTY:

- **ACTIVE** — sessions owned by this app, grouped under visible tag subheaders in configured
  tag order. Only non-empty groups are shown; `m` reorders sessions within the selected group,
  and navigation skips subheaders. MOVE previews keep the same session selected and visible;
  `Enter` commits while `Esc` restores the exact original order. Every live row shows
  `<directory> · <memory>` followed by its status. Working sessions animate a synchronized
  bold cyan spinner in the title and `WORKING` detail. Idle sessions show `○ IDLE`; a finished
  turn shows `◆ DONE — NEEDS YOU`; permission requests show `! PERMISSION NEEDED`; and exited
  sessions show `× EXITED` or `× EXITED — NEEDS YOU` when unread. Unread entry blocks use a subtle background highlight,
  prominent names and a red `●N` badge; the selection background takes precedence. Badges
  are cleared only when you attach with `Enter`; moving the selection cursor over a session
  does not ack it. Press `d` to manually flag the selected ACTIVE session as
  `◆ DONE — NEEDS YOU` so you can come back to it later; the flag uses the same highlighted
  row treatment plus a `◆` badge when the session has no unread events (a real unread event
  keeps the red `●N` badge). It never overrides a live `WORKING` or `PERMISSION NEEDED`
  status, and is cleared by pressing `d` again or by attaching to the session.
- **RECENT** — sessions from `devin list` across known directories that are *not* currently
  running anywhere, with activity in the last 24 hours (newest first, max 10). `Enter`
  first asks for a tag, then resumes the session in a new owned PTY via `devin -r <id>`.
  Uppercase `H` hides or shows this entire section without deleting, resuming, acknowledging,
  or changing search/discovery state. Polling continues while hidden, so showing RECENT uses the
  latest rows immediately. Visibility is run-local, is not written to config or restart handoff,
  and resets to visible whenever dgui starts or completes an uppercase-`R` refresh.
- **TERMINAL** — `devin` REPLs running in *other* terminal windows, discovered every ~5s
  via `ps` + `lsof` (each REPL holds its `session_locks/<id>.lock` open) and enriched with
  title/last-activity metadata from `devin list --format json`. These rows are read-only
  and show `<directory> · <memory>` above `terminal` (cyan `⇄` icon, no badges). `Enter` asks for a tag, then offers to **adopt**
  the session: after a y/n confirm the external process is sent SIGTERM, the app waits for
  it to exit (up to 5s, never SIGKILL), then resumes it here with `devin -r <id>` in its
  original working directory. Cancelling anywhere in the tag flow leaves the external
  process untouched. If the process does not exit in time, adoption is aborted and you can
  retry.

Memory is the RSS of each main `devin` REPL process from the same 5-second discovery `ps`
sample. Child processes and the dgui Node process are excluded. The bottom status bar always
shows the total main-process RSS across every discovered Devin REPL, including allowed processes
that do not yet map to a session lock; the last successful sample remains visible if `ps` fails.
Immediately left of that DEVIN total, the bar also always shows how long ago the last user message
was submitted to any session, in the same `just now` / `Nm ago` / `Nh ago` form RECENT rows use.
This value is global rather than per-row, so it never depends on the selection or attachment, and it
comes from the authoritative `UserPromptSubmit` hook: it reads `—` until the first prompt of the run,
and a session resumed from history shows nothing until you prompt it again. It refreshes at least
every 15 seconds and is preserved across an in-app `R` refresh.

## In-app refresh

Press uppercase `R` in the sidebar to load newly built dgui code without manually quitting and
relaunching. Refresh is always confirmed. It is allowed only when every non-exited ACTIVE session
is `waiting` and has a real Devin session ID; `working`, permission-blocked, and not-yet-resolved
sessions produce a blocker notice without changing or stopping anything. Waiting sessions remain
refreshable when they have unread notifications. Exited ACTIVE rows are not reconnected and may
reappear under RECENT after discovery.

`bin/dgui` remains the shell's foreground job for the whole invocation and runs one Node process at
a time. It creates a unique private restart-channel pathname under
`~/.local/share/devin-conductor/`, keeps the directory mode 0700, and passes the path through the
environment without creating the file. On confirmed refresh, Node atomically writes versioned state
to that exact channel with mode 0600 before stopping anything. A write failure is shown as a notice
and leaves the current app and sessions running.

After the successful write, dgui stops rendering, discovery, event tailing, and parent stdin,
terminates only its owned PTYs, waits up to 5 seconds for their processes and locks to clear, restores
the terminal, and exits with the dedicated refresh status. It never sends SIGKILL or spawns an
orphan replacement. The launcher observes the status and channel file, starts the next Node process
in the foreground with the same cwd, environment, and stdio, and otherwise returns the original exit
status. A refresh status without a channel is an error instead of an infinite loop.

The replacement immediately consumes and deletes the channel file, validates its version and
records, resumes each valid session with its original source name, cwd, tag, status, unread
notification list, and manual `d` DONE flag, then returns to the sidebar without attaching or
acknowledging anything. The global last-user-message time shown in the status bar is carried over
too, so the `PROMPT` segment keeps counting from the same prompt after the refresh.
The channel environment remains available for the next refresh. Persisted
aliases and saved per-tag order continue to apply by real Devin ID, and the selected ACTIVE session
is restored when possible.
Invalid records and records whose tag no longer exists are skipped; one failed resume does not abort
the others.

A process restart cannot preserve unsent draft text, local xterm scrollback, `p` prompt markers, or
an in-flight agent turn. The idle-only guard prevents refreshing during working or permission turns,
and the confirmation explicitly warns that drafts and local scrollback will be lost. Devin's saved
conversation history is preserved and resumed. If dgui is run directly with `node dist/index.js` or
`npm run dev`, uppercase `R` reports that one launcher-enabled restart is required and leaves the
current app untouched.

## Notification hooks

Status changes and badges are driven by Devin CLI lifecycle hooks. On first launch the app
offers (y/n prompt) to install four hook entries into `~/.config/devin/config.json`, backing
the file up to `config.json.bak-devin-conductor` first and appending to any existing hooks
without touching other keys:

```json
{
  "hooks": {
    "UserPromptSubmit":  [{ "matcher": "", "hooks": [{ "type": "command", "command": "<repo>/bin/conductor-hook.sh UserPromptSubmit" }] }],
    "Stop":              [{ "matcher": "", "hooks": [{ "type": "command", "command": "<repo>/bin/conductor-hook.sh Stop" }] }],
    "PermissionRequest": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<repo>/bin/conductor-hook.sh PermissionRequest" }] }],
    "SessionEnd":        [{ "matcher": "", "hooks": [{ "type": "command", "command": "<repo>/bin/conductor-hook.sh SessionEnd" }] }]
  }
}
```

`bin/conductor-hook.sh` exits 0 immediately (and silently) when `DEVIN_CONDUCTOR_ID` is unset,
so devin sessions launched outside this app are unaffected, and it never writes to stdout, so
permission prompts keep their normal interactive flow. For sessions spawned by the app it
appends `{"id","event","ts"}` JSON lines to `$DEVIN_CONDUCTOR_EVENTS_DIR/events.jsonl`
(default `~/.local/share/devin-conductor/`), which the app tails to update statuses:
`UserPromptSubmit` -> working, `Stop` -> waiting, `PermissionRequest` -> needs-permission,
`SessionEnd` / PTY exit -> exited. `WORKING` begins only when Devin emits the authoritative
prompt-submission hook; typing, pasting or pressing Enter alone leaves an idle session `IDLE`.
If you decline the hook install, notifications are limited to PTY-exit events.

Each line also carries the hook's stdin payload verbatim as a `payload` field, so a
`UserPromptSubmit` record in `~/.local/share/devin-conductor/events.jsonl` contains your prompt
text (`payload.prompt`), which is what the pinned prompt header in attached NORMAL mode displays.
Payloads that are not a JSON object or are larger than 65536 characters are omitted entirely, so a
record is never written with truncated or invalid JSON; the script still drains its stdin, writes
nothing to stdout, and exits 0. The hook command line is unchanged, so no hook re-install is
needed to pick this up.

Any user interaction in an attached `needs-permission` session pragmatically returns it to
`working`, because permission UI interaction is not a new submitted prompt.

## Configuration

Config at `~/.config/devin-conductor/config.json`:

```json
{
  "default_cwd": "~/code/temp/rox-core",
  "desktop_notifications": true,
  "tags": ["investigation", "planning", "code", "chat"],
  "session_order": {
    "investigation": ["luxurious-seal", "other-real-devin-id"],
    "code": ["another-real-devin-id"]
  },
  "session_aliases": {
    "luxurious-seal": "Auth0 login investigation"
  }
}
```

`default_cwd` (with `~` expansion) pre-fills the working-directory field of the `n`
new-session form and is always included in the directories scanned for RECENT sessions.
When the configured directory does not exist, the launch cwd is used.
`desktop_notifications` (default `true` when absent) toggles the macOS notification
banners and terminal bell described below.

`tags` defines the ACTIVE group and picker order. If it is missing, empty or invalid, the
app initializes and safely persists the seeded order `investigation`, `planning`, `code`,
`chat`. Tag names must be non-empty and unique ignoring case. Press `n` in the tag picker
to create a custom tag (maximum 30 characters), then choose a slot such as “before
investigation”, “between planning and code”, or “after chat”. Custom insertion persists
immediately with a same-directory temporary file plus atomic rename, preserving unrelated
config keys.

`session_order` is maintained automatically when MOVE is committed. It stores only real Devin
session ids, never conductor event ids or process ids, so ordering survives conductor restarts
and applies when those sessions are resumed later. Resumed/adopted sessions provide their id
immediately; fresh sessions are kept in committed runtime order while the existing batched
`ps`/`lsof` discovery learns the id from the lock file held by their PTY process, then the order
is persisted. Choosing a different tag on a later resume removes the id from stale tag lists.
Malformed `session_order` values and entries are ignored without affecting other config keys.

`session_aliases` stores dgui-only display names by real Devin session id. Aliases are trimmed,
must be at most 120 characters, overlay current ACTIVE/RECENT/TERMINAL titles everywhere dgui
shows a session name, and survive conductor restarts and later resume/adoption. Entering a blank
or whitespace-only value in RENAME clears the alias and immediately reveals the latest underlying
Devin title or session id. Fresh ACTIVE sessions can be renamed before discovery learns their real
id; that alias applies immediately in memory and is persisted once the existing owned-process
lock discovery resolves the id. Malformed alias keys/values are ignored while unrelated config,
tags and session order remain intact. No alias operation sends `/rename-session`, edits Devin's
`sessions.db`, injects terminal input or otherwise interferes with a session process.

## Desktop notifications

Whenever a session gains a new unread badge entry (finished turn, permission request or
exit while you are not attached to it), the app fires a macOS notification banner via
`osascript` (`devin-conductor: <session name>: finished its turn / needs permission /
session ended`) and rings the terminal bell so your terminal can badge or bounce the dock
when unfocused. Alerts are debounced to at most one per session per 3 seconds, and
attached sessions never alert (attachment suppresses unread entries). Set
`"desktop_notifications": false` in the config to disable both the banner and the bell.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DEVIN_CONDUCTOR_CMD` | command spawned per session (default `devin`; useful for testing) |
| `DEVIN_CONDUCTOR_EVENTS_DIR` | override the events directory |
| `DEVIN_CONDUCTOR_NO_HOOK_PROMPT=1` | skip the hook-install prompt at startup |
| `DEVIN_CONDUCTOR_RESTART_CHANNEL` | internal validated launcher channel retained across refreshes; its one-shot state file is consumed and removed at startup |
