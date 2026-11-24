# Acceptance run

Border-to-border verification for `pi-ego-browser`. It spawns a real browser and
the bundled Ego runtime, so run it **outside any process sandbox** (the sandbox
this package was developed in refuses `CreateProcess` from Node, which no browser
runtime can work around). Phase 4 also drives real Pi SDK sessions on a local
faux provider, so it needs no model, no API key and no network.

Logs and the isolated Pi configuration live under `.tmp/acceptance/`. The
test browsers and their profiles live in a new `pi-ego-acceptance-*` directory
under the Windows temp directory. The suite uses its own Pi configuration,
browser profiles, and npm package directory.

## 0. Prerequisites

| Requirement | Why |
| --- | --- |
| Windows 10/11 | the vendored runtime is `ego-windows-host` |
| Node 22+ | the runtime and the extension both require it |
| Pi 1.6.0 or newer on `PATH` | `pi install` and `pi --mode rpc` are used |
| ~1 GB free disk in `%TEMP%` | phase 3 unpacks the managed browser twice |
| network access to `storage.googleapis.com` | phase 3 downloads the pinned browser once |

## 1. Build the tarball and check its contents

```powershell
cd F:\dsh\pi-ego-browser
npm install --ignore-scripts --cache .npm-cache     # only typebox, a devDependency
npm run pack:build                                   # -> dist\pi-ego-browser-0.1.7.tgz
npm run pack:check                                   # reads the tarball, no unpacking
npm run pack:load                                    # packaged entry loads with Pi's host packages
npm run smoke:pi                                     # pi install + pi --mode rpc in a throwaway config
```

`pack:check` fails if a required runtime file is missing, if `test/`, `tools/`,
`node_modules/` or scratch files leaked into the tarball, or if the licence and
notice files are absent. `npm run pack:load` then loads the packaged entry the
way Pi does (with Pi's own `typebox` / `@earendil-works` mapped in) and asserts
that all nine tools plus the one `/ego-settings` command register — no browser
needed, and no `/ego` alias. `npm run smoke:pi` goes one step further without a
browser: it runs `pi install` into `.tmp/iso-pi-smoke/agent`, starts a real
`pi --mode rpc` session and checks that the command comes from the installed
package, that `/ego-settings status` and `/ego-settings attachments` answer
against that isolated `PI_EGO_HOME`, that bare `/ego-settings` answers outside
the TUI, and that no removed `/ego` command is visible to Pi.

## 2. Run the acceptance suite

```powershell
node tools\acceptance.mjs              # all four phases (~10-15 minutes)
node tools\acceptance.mjs --phase 1    # install + open/read/screenshot
node tools\acceptance.mjs --phase 2    # fill/hand-off/resume/tabs/two sessions/stale numbers
node tools\acceptance.mjs --phase 3    # managed browser: first use, cache reuse, resume, checksum
node tools\acceptance.mjs --phase 4    # attachment library, lookback, preferred directory, export
node tools\acceptance.mjs --phase 3 --quick   # phase 3 without the 215 MB download
```

Exit code 0 means every step passed. A machine-readable report is written to
`.tmp\acceptance\summary.json`, and raw process output to
`.tmp\acceptance\install.log`, `rpc.log`, `p2-handoff-host.log`,
`p*-browser.json`.

Each step asserts on its own, so one failure does not hide the rest:

| Step | Assertion |
| --- | --- |
| 1.1 | no `ego-browser.cmd` on `PATH`, no Ego skill in the isolated config |
| 1.2 | `pi install "npm:pi-ego-browser@file:<abs tgz>"` exits 0 and the isolated `settings.json` declares the package |
| 1.3 | a fresh Pi session (`pi --mode rpc`, `PI_CODING_AGENT_DIR` isolated) reports the `ego-settings` command from the installed package and offers no `ego` command |
| 1.4 | `browser_open` starts the browser from the isolated state root, and CDP reports only the requested tab |
| 1.5 | `browser_read` returns the fixture heading and `[#n]` numbers |
| 1.6 | `browser_screenshot` publishes one PNG under `<state>/attachments/v1/objects/<sha256>.png`, returns that ID with no image content block, and leaves neither a library staging file nor a local staging file |
| 1.7 | a second identical capture keeps one library object; a normal save returns that one original and writes no second file (no export directory appears); only a full `.png` path the test names is copied, and the same path is recognised rather than refused |
| 2.1 | `browser_fill` fills one field of the local form |
| 2.2 | `browser_handoff` pauses the extension **and** the Ego runtime itself rejects page ops (`EGO_TASK_SPACE_USER_IN_CONTROL`) |
| 2.3 | the "user" edits the page through a plain CDP client (not through Ego), as a human in the window would |
| 2.4 | `/ego-settings resume` takes control back and its snapshot shows the hand edit and the hand-typed value |
| 2.5 | the agent continues on the resumed page, submits the form, and screenshots the result |
| 2.6 | a second Pi session gets its own task space and its own tab; neither session sees the other's tab |
| 2.7 | `browser_tabs` new/list/switch/close work and re-reading follows the active tab |
| 2.8 | a number printed before a navigation is refused with a "read again" message |
| 3.1 | with an empty cache and discovery disabled, the pinned Chrome for Testing is downloaded, SHA-256 verified, unpacked, marked `.complete`, and launches the page |
| 3.2 | a second run reuses the cached build: no download, no reinstall, exe mtime unchanged |
| 3.3 | a truncated `.part` file (real bytes, first 40 MB) resumes with a Range request and still verifies |
| 3.4 | a wrong SHA-256 fails with `BROWSER_DOWNLOAD_FAILED`, names the checksum, and installs nothing |
| 4.1 | real Pi SDK sessions on a local faux provider: two real captures, a JSONL under 60 KB with no image block and no base64, the vision request after a capture carries the picture **attached to that screenshot's tool result**, the next user turn does not |
| 4.2 | capturing the same page again keeps the same attachment ID and does not add a second library object |
| 4.3 | a lookback attaches only the picture named by a legal ID of this session inside that turn; a foreign ID is refused and attaches nothing |
| 4.4 | a second Pi session captures its own PNG and both references resolve in a separate Node process (new `pid`), with digest verification |
| 4.5 | A preferred path with spaces persists across reloads. When that directory goes offline, the next capture writes to the default library, and neither the status listing nor that capture recreates the missing path. Once the directory is restored, both historical references resolve and new captures use the preferred path again. `reset` clears the choice. |
| 4.6 | with `PI_EGO_HOME/attachments` present as a file, a capture fails with `ATTACHMENT_UNWRITABLE`, names the library, records no reference and registers no root |
| 4.7 | a normal save returns the library original and writes no new file; an explicit path receives exactly that picture's bytes; a seeded 0.1.1 saved PNG and cached preview keep their bytes and mtime, and a recorded 0.1.1 preview is published into the library that is in effect now |

## 3. Isolation the suite uses

| What | Value |
| --- | --- |
| Pi config | `PI_CODING_AGENT_DIR=.tmp/acceptance/pi-agent` (fresh), `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1` |
| Pi project | `.tmp/acceptance/pi-project` (fresh, nothing else in it) |
| Package under test | the `dist/*.tgz` unpacked to `.tmp/acceptance/pkg-<phase>/package`, with a temporary `node_modules` junction pointing at Pi's own host-provided packages (`typebox`, `@earendil-works/*`) |
| Extension state | one `PI_EGO_HOME` per phase under `%TEMP%/pi-ego-acceptance-*`; see `browserStateRoot` in `summary.json` |
| Browser profile | `<PI_EGO_HOME>/profile` — never a real browser profile |
| CDP ports | 9540 (phase 1), 9541 (phase 2), 9542-9544 (phase 3), 9545 (phase 4) |
| Headless | `PI_EGO_HEADLESS=1` so no windows pop up during the run |
| Test pages | the local HTTP fixture in `test/fixtures/server.mjs`, bound to `127.0.0.1` |
| Model | phase 4 uses the in-process Pi SDK with its local `faux` provider (`tools/pi-session.mjs`): no network, no credentials, and the test can read exactly what each request carried |
| Attachment probe | `tools/attachment-probe.mjs` resolves references in a separate Node process against the unpacked package's `src/` |
| Cleanup | each phase sends `Browser.close` to its own CDP endpoint; nothing else is killed |

The install line the suite runs is the one verified by hand on Pi 1.6.0:

```powershell
pi install "npm:pi-ego-browser@file:F:/dsh/pi-ego-browser/dist/pi-ego-browser-0.1.7.tgz"
```

The `npm:<name>@file:<path>` form matters: a bare `file:` path is recorded but
Pi cannot find the extension on the next start.

## 4. What this suite does not cover by itself

| Gap | How it was covered instead |
| --- | --- |
| A human actually clicking inside the visible browser window | step 2.3 changes the live page through a plain CDP client while the test user owns the tab |
| A machine with no browser installed at all | step 3.1 forces the fallback with `PI_EGO_NO_SYSTEM_BROWSER=1`: same code path, without uninstalling Edge |
| A 20-minute download interruption (network drop) | step 3.3 seeds a truncated `.part` from the real artifact, so the Range resume path runs against the real bytes |
| A model that actually recognizes the picture | phase 4 asserts what the provider received (one PNG with the current turn), not whether a model understood it |
| A real mount disappearing mid-run | step 4.5 temporarily renames the isolated preferred directory and restores its original files, simulating a removable drive going offline |
| A real second volume for a cross-volume publish | the copy-through-target-staging path is unit-tested directly (`publishStagedPng` with `forceCopy`); a real removable drive is not part of the suite |
| A screenshot above the 6 MiB inline limit | unit-tested end to end (store, verify, open by ID, export); the acceptance run keeps its real captures small so the JSONL stays readable |
| An interactive TUI with a Kitty/iTerm image protocol | the row renderer is unit-tested (text, path, ID, lazy read, images off); the terminal protocol path is Pi's own `Image` component |
| A human clicking the visible Windows folder dialog | `test/folder-picker.test.mjs` starts the real PowerShell script's non-visual half on both installed shells (assemblies, dialog construction, properties, the UTF-8 file transport, UNC/space/Chinese paths) and drives every dialog outcome through a stand-in `pi.exec`; the walk-through in section 5 clicks the real dialog once by hand |
| Long real-world pages | out of scope for v1; the snapshot quality caveat is documented in the README |

## 5. By hand, once: `/ego-settings`

The folder dialog is a visible Windows window, so no automated step can click it,
and the screenshot panel and the resume row need a real terminal. Everything
around them is covered by the suite; these eight checks take a minute.

1. Start `pi` with an isolated config and run `/reload` if the package is new.
2. `/ego-settings` shows `Ego 浏览器设置` with the rows `info` and `截图附件目录`;
   `恢复默认目录` only appears while a preferred directory is set, `恢复浏览器控制`
   only while the user holds the browser. No `/ego` command exists in the slash menu.
3. Enter on `info`: every line matches what `/ego-settings status` prints
   (`浏览器：`, `状态目录：`, `控制权：`). Esc returns to the list, not out of the settings.
4. Enter on `截图附件目录`: the Windows folder dialog opens **in front** of the
   terminal, starts in the directory in use, and picking a folder with spaces or
   Chinese characters stores it (`首选附件目录已设置`; `/ego-settings attachments` agrees).
5. Open it again and press Cancel: `已取消` is reported and `/ego-settings attachments`
   still shows the same directory.
6. Pick a directory that cannot be written (e.g. a read-only share or `C:\Windows\System32`):
   the failure is reported, the stored choice is unchanged, and the typed-path
   fallback prompt appears; cancelling it also changes nothing.
7. Take a screenshot, then open `本会话截图`: the row names the ID, size, page and
   absolute file path; Enter opens the PNG in the OS viewer, and `按 ID 打开…` opens
   an older picture typed as a full ID or a unique prefix (a foreign or invented ID
   is refused). `恢复默认目录` returns to `PI_EGO_HOME/attachments`.
8. Call `browser_handoff`, log in by hand, then open `/ego-settings` and pick
   `恢复浏览器控制`: Pi re-reads the tab and continues the task on its own. Esc from
   the list closes the settings with `/ego-settings status` still working.

With PowerShell 7 installed the dialog is the Explorer-style one; with only
Windows PowerShell 5.1 it is Windows' classic folder dialog. `PI_EGO_PICKER_SHELL`
forces one shell if both are present.

## 6. Verification record for 0.1.6

The development sandbox returned `spawn EPERM` for Node subprocesses with
piped stdio. Tests that launch a browser ran on Windows outside that sandbox.

| Check | Command | Result |
| --- | --- | --- |
| Whole unit suite in one process | `node test/run-unit.mjs` | 125 tests, 125 pass, 0 fail |
| Tarball contents | `npm run pack:check` | required runtime files, licenses and notice files present; no `test/`, `tools/`, `node_modules/` or scratch files |
| Packaged entry loads with Pi's host packages | `npm run pack:load` | 9 tools, exactly one command `/ego-settings`, `browser_save_screenshot` still takes `path`, packaged `src/` used for the failure paths; the browser call reports `RUNTIME_SPAWN_FAILED` from the same piped-spawn refusal |
| Isolated real Pi: install + `pi --mode rpc` | `npm run smoke:pi` | ok: `pi install` into `.tmp/iso-pi-smoke/agent` exits 0, the installed package supplies `/ego-settings` (`origin: package`), `get_commands` offers no `ego`, `/ego-settings status`, `/ego-settings attachments` and bare `/ego-settings` all answer (3 handled prompts), no loading problem. Writes `.tmp/iso-pi-smoke/summary.json`. |
| Unit suite on Windows | `npm test` | 125 pass, including another writer occupying the destination during an explicit copy |
| Real browser end to end (phases 1–4) | `node tools\acceptance.mjs` | 26 pass. The final tarball hash and per-step results are in `.tmp/acceptance/summary.json`. |
| Cross-drive screenshot and save on Windows | Isolated browser state on C:, attachment library on F: | One PNG in the library after capture and two normal saves. Both saves returned its path, the old export directory was absent, and staging was empty. |

Nothing from the run touches a real Pi configuration, the real `%LOCALAPPDATA%`
state root or a user attachment library: every step uses `.tmp/` and a
`pi-ego-acceptance-*` temp directory, and the only files the run leaves behind
are the tarball, `dist/SHA256SUMS.txt` and the scratch state under `.tmp/`.

## 7. Reset

```powershell
Remove-Item -Recurse -Force .tmp\acceptance    # state roots, screenshots, unpacked package
Remove-Item -Recurse -Force .cache             # the local copy of the browser archive
```

Phase 4 writes no file outside its own `PI_EGO_HOME` except the unpacked package
under `.tmp/acceptance/`, and the separate-process probe only reads.
