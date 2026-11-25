# pi-ego-browser

Browser tools for [Pi](https://pi.dev): open a page, read it as numbered
elements, click, fill, manage tabs, take a screenshot, and hand the browser to
the user when they need to log in by hand.

The package ships the built [Ego](https://github.com/opencue/agenticbrowser)
runtime (`vendor/ego-windows-host`, pinned release `v2.3.0-linux.1`), so
installing the package is the whole setup. You do **not** need the ego lite
desktop app, an `ego-browser` command on `PATH`, or an Ego skill.

Platform: Windows 10/11, Node 22+ (the Node that runs Pi).

## Install

The Ego runtime is vendored in this repository, so installing from the GitHub
source is the whole setup: no tarball to build, no runtime dependency to add.

```powershell
pi install git:github.com/naixujingjjj/pi-ego-browser
```

Try it without touching your settings:

```powershell
pi -e git:github.com/naixujingjjj/pi-ego-browser
```

Pi clones the package into its own directory. Restart Pi or run `/reload`
afterwards; `pi list` shows the entry and `pi remove <source>` removes it. Pin a
version by appending `@<tag>`, `@<branch>` or `@<commit>` to the source (this
repository has no tags yet, so use a commit hash when you need a fixed version).

### From a tarball

Build output is not committed (it is git-ignored), so build a tarball from a
clone:

```powershell
git clone https://github.com/naixujingjjj/pi-ego-browser.git
cd pi-ego-browser
npm install --ignore-scripts --cache .npm-cache     # only typebox, a devDependency
npm run pack:build                                   # -> dist/pi-ego-browser-<version>.tgz
pi install "npm:pi-ego-browser@file:dist/pi-ego-browser-<version>.tgz"
```

`<version>` is the version `pack:build` printed (the one in `package.json`). The
`npm:<name>@file:<path>` form matters with Pi 1.6.0: a bare `.tgz` path is
recorded, but Pi cannot find the extension on the next start.

The first browser tool call prepares the browser:

1. `PI_EGO_BROWSER_PATH`, if you set it.
2. an installed Microsoft Edge, Google Chrome or Chromium;
3. otherwise a pinned **Chrome for Testing** build, downloaded from Google,
   verified against the SHA-256 in `vendor/chromium-lock.json`, unpacked, and
   cached (an interrupted download resumes or restarts on the next call).

The browser runs from its own profile directory. On a fresh launch, the first
task opens the requested page without leaving a separate startup tab.

## Use

Just ask: “Open this page, fill in the email, then take a screenshot.” The model gets these tools:

| Tool | What it does |
| --- | --- |
| `browser_open` | Open or navigate a URL in this session's tab |
| `browser_read` | Read the page as a numbered element tree (`#1`, `#2`, …) |
| `browser_click` | Click `#4`, `@12`, `text=Save`, `loc=role:button[name='Save']` or CSS |
| `browser_fill` | Fill a field with text |
| `browser_tabs` | `list`, `new`, `switch`, `close` the tabs of this session |
| `browser_screenshot` | Capture into the attachment library; returns the attachment ID, size, MIME and storage root |
| `browser_show_screenshot` | Bring one earlier screenshot of this session back into view by its ID |
| `browser_save_screenshot` | Return the already-saved original of a capture; copy it only to the one absolute `.png` path the user names |
| `browser_handoff` | Give the tab to the user (login, CAPTCHA, 2FA) and pause |

Commands — one command, no separate `/ego`:

```
/ego-settings                                  the settings menu (TUI)
/ego-settings info                             browser status (the menu's `info` row)
/ego-settings status                           the same status text
/ego-settings resume                           take control back after the user finished by hand
/ego-settings attachments [list]               preferred/default directory, registered roots, this session's shots
/ego-settings attachments set <absolute path>  choose the preferred attachment directory
/ego-settings attachments reset                go back to the default library
/ego-settings attachments open <ID>            open one screenshot with the OS viewer
/ego-settings help
```

The arguments exist for hosts without an interactive terminal (RPC, a script):
`status`/`info`, `resume` and the `attachments` sub-commands are exactly the
actions the menu rows perform. Inside the TUI, a bare `/ego-settings` opens the
menu and an explicit action prints its result without opening it.

In Pi's interactive terminal, open `/ego-settings` from the slash menu. The list
has up to five rows:

| Row | What Enter does |
| --- | --- |
| `Info` | Shows exactly the browser status `/ego-settings status` prints (running?, which tab, handed off?). Esc returns to the list; Esc in the list closes the settings. |
| `Screenshot Folder` | Opens Windows' own folder browser dialog and stores the folder you pick. Cancel leaves the stored choice exactly as it was. |
| `Restore Default Folder` | Shown only while a preferred directory is set; goes back to the default library. |
| `Session Screenshots` | This session's pictures, newest first, each row naming its ID, size, page and absolute file path. Enter opens the row with the OS viewer; `Open by ID…` takes a full 64-character ID or a unique prefix, so a picture older than the short list still opens. |
| `Resume Browser Control` | Shown only while the user holds the browser: takes control back, re-reads the current tab, and sends Pi a follow-up so the task continues. |

The directory row uses the native dialog — no extra program is installed for
it. When PowerShell 7 (`pwsh`) is installed the dialog is the Explorer-style
one (WinForms' `FolderBrowserDialog` with `AutoUpgradeEnabled` on .NET 6+); with
only Windows PowerShell 5.1 it is Windows' classic folder dialog, which cannot
show the modern style. The starting folder is the directory in use right now
(the preferred one if it still exists, otherwise the default library), and the
start path never passes through a command line: it travels in a UTF-8 JSON file
next to the PowerShell script, and the answer comes back in a UTF-8 result file,
so spaces, Chinese names and `\\server\share` paths are carried unchanged.
`PI_EGO_PICKER_SHELL` can force one shell. If the dialog cannot be shown at all
(no Windows, no WinForms, a host that cannot start a process, or a non-zero exit)
the command says why and falls back to the typed path prompt; cancel or failure
never changes the stored directory. The browser run lock is not held while the
dialog is open.

## Screenshots are attachments

A capture writes exactly one staging PNG into the stable local staging area
(`staging\` under the state root, never inside an attachment library root), then
publishes it under the attachment library as `<sha256>.png`. The SHA-256 of the
raw PNG bytes **is** the attachment ID, so the same picture is stored once per
library root, and the session record keeps only the ID, the size, the MIME type,
the storage-root ID and the page it came from. No image bytes, base64 or data URI
ever reach the session JSONL or the tool result details.

The digest is computed in chunks, so a large screenshot is never pulled into
memory just to identify it. The 6 MiB limit belongs to the **inline** surfaces
only: a bigger picture is still stored, still opens by ID in the OS viewer and
is still copied to a destination the user names; it is not put into a model
request or an expanded TUI row.

- **The picture reaches the model, not the transcript.** Right before a model
  request, the extension looks at the screenshot tool results that actually
  appear after the last user message of that request — by message order, not by
  timestamps — and attaches each picture back onto its own tool result. Two
  images at most, none above 6 MiB, and a model whose declared input is text-only
  gets the text form instead. The next user turn starts without the picture.
- **The user sees it too.** In the TUI, expand the screenshot row (`app.tools.expand`)
  to load the PNG from disk; with images disabled, over RPC, or in a plain-text
  terminal the row shows the attachment ID and the absolute file path, which the
  OS viewer or `browser_show_screenshot` can open.
- **Lookback is ID-only.** `browser_show_screenshot` accepts a full 64-character
  attachment ID (or a unique prefix) that this session returned. The ID may come
  from any earlier screenshot of this Pi session, not only the last 30 the status
  list shows: the compact reference every screenshot tool result already holds is
  the lookup index. A prefix that matches two different pictures is refused
  instead of opening the first. Unknown IDs, IDs from another session and paths
  are refused. Before any file is read the extension checks the ID shape, the
  explicitly registered storage root, that the file's real path (junctions and
  symlinks resolved) stays inside that root, and the file digest.
- **A normal “save this” makes no copy.** The capture already wrote the one
  permanent copy into the attachment library. `browser_save_screenshot` without
  `path` verifies that original (file size, then the digest, in chunks) and
  returns its absolute path and attachment ID; it writes nothing anywhere. So
  a plain “save the screenshot” / “keep this one” never yields a second file — in
  particular never another file in an old `screenshots\<session>\` folder.
- **An explicit destination is the only thing copied.** `browser_save_screenshot
  { path }` is for a user who names a separate copy: the argument must be a full
  absolute path ending in `.png`, and its directory must already exist (none is
  created). An existing file is never overwritten: a different file is refused
  with `ATTACHMENT_EXISTS`, and an identical one is reported as already holding
  this picture. The copy is written under a temporary name inside the
  destination directory, digested, and renamed.
- **Old data is read, never rewritten.** A preview cached by 0.1.1 is the one
  thing that was never in the library, so it is published through the ordinary
  capture path into the library in effect now (preferred directory, or the
  default with its usual fallback), and the cache file itself is only read.
  Pictures an older version saved under `screenshots\<session>\` stay exactly as
  they are: 0.1.6 never writes there, and nothing is migrated, rewritten or
  deleted.

If the preferred directory disappears, becomes read-only, goes offline or turns
into a file, that one capture is written to the default library and the tool
result names both paths and the reason. Checking status and taking that capture
never recreate the vanished preferred path: the choice itself is kept, so the
next capture uses the preferred directory again as soon as it is writable. Only
Setting the directory in `/ego-settings` or with `/ego-settings attachments set`
creates the directory you name. When the default library
is not writable either, the capture fails with a clear message and no reference
is created — nothing is recorded that cannot be opened later.

The staging area only ever holds files this extension wrote as staging, and a
leftover is swept after a day. Files a user or another program put in those
directories are never scanned away.

**Element numbers.** `browser_read` prints `[#1]`-style numbers. A number is
valid only for the page state that printed it: after a navigation, a tab switch
or an action that changes the page, Pi must read again, and a stale number is
refused with a message saying so rather than clicking something else.

**Hand off.** When a step needs a human, `browser_handoff` pauses this
session's browser tools and tells the user what to do in the browser window.
After the user is done, the `Resume Browser Control` row of `/ego-settings` (or
`/ego-settings resume` where the menu is unavailable) takes control back,
re-reads the same tab, and sends Pi a follow-up so the task continues. If the tab
was closed in the meantime, Pi says so instead of pretending.

**Sessions.** Each Pi session owns one Ego *task space*: its own tabs and its
own ownership state. Two Pi sessions share the browser process and its login
state (same dedicated profile), but their tabs do not mix. Runs are serialized
per state root so concurrent sessions cannot corrupt the shared bookkeeping.

## Where things live

Everything is under one root: `%LOCALAPPDATA%\pi-ego-browser`
(`PI_EGO_HOME` overrides it).

| Path | What |
| --- | --- |
| `profile\` | the dedicated browser profile (logins you do by hand persist here) |
| `sessions.json` | per-session space id, current tab, numbering |
| `spaces.json` | Ego's task-space registry (owned by the runtime) |
| `browser-state.json` | last browser-preparation result and stage |
| `browser-endpoint.json` | identity of the browser launched for this profile |
| `browsers\` | the managed Chrome for Testing build, once installed |
| `downloads\` | in-flight `.part` of the browser download (removed once the build is unpacked) |
| `staging\` | stable local staging for one in-flight capture; a file here is the only copy until it is published, so it lives on this computer, never on a removable library root |
| `attachments\` | default content-addressed attachment library (`attachments\v1\objects\<sha256>.png`) |
| `attachments-config.json` | the preferred attachment directory (`/ego-settings attachments set`) |
| `attachments-roots.json` | registered storage roots: root ID → absolute directory, written with each publish |
| `screenshots\<session>\` | files older versions exported; 0.1.6 never writes here and never deletes them |
| `screenshot-cache\<session>\` | 0.1.1's temporary previews; read once for an explicit save, never created or migrated |

Deleting the root removes logins, tabs, the attachment library and the cached
browser; the next call starts clean. Deleting one library object only breaks the
references that point at it — the extension reports that instead of opening a
lookalike file from another directory.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_EGO_HOME` | `%LOCALAPPDATA%\pi-ego-browser` | state root (profile, sessions, browser cache) |
| `PI_EGO_BROWSER_PATH` | unset | force one browser executable |
| `PI_EGO_DEBUG_PORT` | `9522` | CDP port of the dedicated browser |
| `PI_EGO_HEADLESS` | `0` | `1` runs the browser headless (hand-off needs a visible window) |
| `PI_EGO_NO_SYSTEM_BROWSER` | `0` | `1` skips Edge/Chrome discovery and uses the managed build |
| `PI_EGO_RUN_TIMEOUT_MS` | `180000` | per-call limit for one Ego script |

## What was verified

Run in this checkout on 2026-11-24 (Windows 11, Node 24.20.0, Pi 1.6.0, Edge
158.0.4370.33; the 0.1.4 `/ego-settings` additions re-verified on Windows 11 build
26100 with PowerShell 7.6.9 and Windows PowerShell 5.1.26100; the 0.1.6 changes
re-verified the same day — see [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) §6 for
what ran inside the development sandbox and what it cannot run):

| Check | Command | Result |
| --- | --- | --- |
| Unit + contract suite | `npm run test:unit` | 125 tests: content-addressed publish, dedupe, preferred-directory fallback, ID/root validation, request-time injection, a normal save returning the one original, explicit copies that never overwrite, the `info` panel, the screenshot panel, native-picker pick/cancel/failure, real Pi sessions on a faux provider |
| Tarball contents | `npm run pack:check` | required runtime files and licenses included |
| Packaged entry loads with Pi's own `typebox` / `@earendil-works` mapping | `npm run pack:load` | 9 tools + the single `/ego-settings` command (no `/ego` alias) |
| Isolated Pi load of the tarball: `pi install` into a throwaway config, then `pi --mode rpc` | `npm run smoke:pi` | the installed package supplies `/ego-settings`, `status` and `attachments` answer against the isolated `PI_EGO_HOME`, bare `/ego-settings` answers outside the TUI, and no removed `/ego` command is visible to Pi |
| Real browser, real Ego runtime, end-to-end | `npm run test:acceptance` | see [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md); writes `.tmp/acceptance/summary.json` |

What each part covers:

`npm test` runs the unit suite through Node's test runner (one child process per
test file); `npm run test:unit` runs the same tests in a single process, which is
the variant a restricted Windows sandbox can run (a sandboxed Node cannot spawn
children, and neither can the browser runtime it would launch).

| Check | How |
| --- | --- |
| Numbering and staleness rules | `test/session.test.mjs` |
| Generated Ego scripts (single result line, refs, tabs, hand-off, resume) | `test/script.test.mjs`, executed against a stubbed runtime |
| Tool flows against a fake runtime (open/read/click/fill/tabs/screenshot/handoff/resume/status) | `test/tools.test.mjs` |
| Attachment IDs, dedupe, staging cleanup, stable local staging outside every root, preferred-directory fallback without recreating a vanished path, offline originals that come back, root registry and realpath/digest validation, large files over the inline limit, cross-volume publish, plugin-owned staging sweep | `test/attachments.test.mjs` |
| Per-request image selection: message order instead of timestamps, pixels attached to the screenshot tool result, this turn only, vision models only, count and byte limits, unique-prefix/ambiguous-prefix lookup, references recovered from session entries | `test/review.test.mjs` |
| `/ego-settings attachments` parsing (quotes, spaces) | `test/command.test.mjs` |
| The native folder picker: what the PowerShell script asks Windows for, the UTF-8 file transport of the start directory and the choice, a pick, a cancel, a timeout, a non-zero exit, an unusable WinForms, an unusable host and a path the script should never return | `test/folder-picker.test.mjs` |
| Lazy TUI image loading and text fallback | `test/render.test.mjs` |
| Loaded extension entry: tool inventory, only the `/ego-settings` command, no image content block, `/ego-settings attachments` wiring, row renderer, the `info` panel repeating the status text verbatim (`info` and `status` are one action), the directory row driving the picker, cancel, reset, the typed-path fallback, the screenshot panel with `Open by ID…`, and the resume row | `test/ego-extension.test.mjs` |
| Real Pi session on a local faux provider: transcript size, vision request bound to the tool result, next turn, lookback legality, text-only model, two sessions, new process | `test/pi-session.test.mjs` |
| Browser resolution, download, SHA-256, resume-after-interrupt, unpack | `test/chromium.test.mjs` against a local HTTP server |
| Run lock, result parsing, foreign-endpoint guard | `test/runtime.test.mjs` |
| Packaged file set, pinned licenses and notices | `test/packaging.test.mjs` |
| Install into an isolated Pi config, open/read/screenshot, hand-off + `/ego-settings resume`, two sessions, stale numbers, managed-browser first use/cache/resume/checksum | `tools/acceptance.mjs` phases 1–3 |
| Attachment library end to end with real PNGs: small transcript, this-turn image on the tool result, next turn, dedupe, lookback legality, second session, new process, `set` with spaces, fallback and recovery without recreating the missing path, unwritable default, a normal save returning the library original, one explicit copy, untouched 0.1.1 and old exported files | `tools/acceptance.mjs` phase 4 |

The Ego runtime this package embeds was also probed directly before the
extension was written; `tools/probe-runtime.mjs` is that probe, and it is what
told us the runtime injects `snapshot` as a script parameter (a `const snapshot`
in a generated script is a `SyntaxError`) and that `page.targetId` is not a
reliable way to activate a tab.

## How it works

```
Pi tool call ──► extension (extensions/ego-browser.js)
                   │  resolve browser, build one Ego script
                   ▼
                  node vendor/ego-windows-host/bin/ego-windows-host.mjs   (one
                   │  process per call, script on stdin, result on one JSON line)
                   ▼
              CDP over loopback ──► Edge/Chrome/Chromium with its own profile
```

- **One process per call.** Tabs, page labels and logins live in the browser and
  in the runtime's state files, not in JavaScript variables, so every call
  re-enters this session's task space.
- **One task space per Pi session.** The runtime tracks a named set of tabs with
  an owner. Two sessions share the browser and its logins but never a tab.
- **Numbers belong to a read.** `browser_read` rewrites Ego's `[@id]` refs into
  `[#n]` and stores space + tab + URL + a sequence number with them; an action
  resolving a number is refused unless all four still match.
- **Ownership is enforced twice.** The extension refuses tools while a session is
  handed off, and the runtime rejects page operations with
  `EGO_TASK_SPACE_USER_IN_CONTROL` — only the user's `Resume Browser Control` row (or
  `/ego-settings resume`) takes control back.
- **One run at a time per state root.** A lock file serializes runs — and attachment
  config writes and publishes — so two sessions cannot interleave writes to the
  shared `spaces.json`, `attachments-config.json` or one library root.
- **Attachments are content-addressed.** A capture is staged, verified as PNG,
  digested, and renamed to `<root>\v1\objects\<sha256>.png`. The reference stores
  the ID and the registered root, so an ID resolves through the root it was
  written under, never through a directory guess.
- **Dedicated browser profile.** The extension uses its own profile directory
  and verifies the identity of a running browser before reconnecting to it.

## Limits of the first version

- Windows only. The vendored runtime is `ego-windows-host`; Linux/macOS need
  their own host package and their own acceptance run.
- `browser_read` shows Chromium's accessibility tree as projected by the Ego
  Windows host. Deeply nested iframes and canvas-heavy pages are weaker than a
  native snapshot; use `browser_screenshot` there.
- Images ride along with the **current user turn** only. A model that needs an
  older picture mid-task must call `browser_show_screenshot` again; a text-only
  model only ever gets the ID and the path.
- A screenshot above 6 MiB is stored and can be opened by ID or copied to a
  destination the user names, but it
  is not put into a model request or an expanded TUI row.
- The attachment library has no automatic garbage collection: every published
  object stays until you delete it, and a deleted object is reported as missing
  rather than replaced by a file from another root.
- No Spaces UI: ownership is enforced at the bridge, and `/ego-settings status`
  (plus the `info` row of the settings menu) is the only place that shows it.
- The folder dialog is a visible Windows window, so it cannot be clicked by an
  automated test: the suite verifies the PowerShell script, the file transport
  and every outcome (pick, cancel, timeout, non-zero exit, unusable WinForms)
  around it, and the window itself is checked by hand (section 5 of
  `docs/ACCEPTANCE.md`). The Explorer-style variant needs PowerShell 7; only
  Windows PowerShell 5.1 installed means Windows' classic folder dialog.
- The CDP port is loopback-only and accessible to processes running on this
  computer.
- If Windows blocks the managed browser from a custom `PI_EGO_HOME` location,
  use the default directory under `%LOCALAPPDATA%` and retry.
