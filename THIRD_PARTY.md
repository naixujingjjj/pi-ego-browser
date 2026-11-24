# Third-party notices

`pi-ego-browser` is MIT licensed (see `LICENSE`). It ships one prebuilt
third-party runtime and downloads one optional browser at first use.

## Ego runtime (bundled)

| Item | Value |
| --- | --- |
| Project | [agenticbrowser](https://github.com/opencue/agenticbrowser), a Linux/Windows port of [ego lite](https://github.com/citrolabs/ego-lite) |
| Version | `v2.3.0-linux.1` (git tag, commit `78b00eefb91e3e945b6b2b7a17f777f02380c735`) |
| Artifact | `ego-windows-host-v2.3.0-linux.1.zip` from the official GitHub release |
| Archive SHA-256 | `d3f477c1f15f441d109fdae7a16c3622adb1236b6e9bf9886c80ba10ae264792` (matches `SHA256SUMS-hosts.txt` in the release) |
| Bundled path | `vendor/ego-windows-host/` |
| Licence | MIT — `Copyright (c) 2026 CitroLabs`, retained in `vendor/LICENSE-agenticbrowser` |

The bundled tree comes from the release artifact: the built
`ego-windows-host` (bridge, CDP connection, task-space registry, accessibility
snapshot) plus its `node_modules` — `ego-browser-v2` (the upstream v2 runtime
this project builds on), `ego-v2-ext` (the port extensions: locators,
`fastObserve`/`fastAct`, tracing) and `acorn`. Pi Ego Browser patches the
packaged Windows launcher's startup arguments so the first task opens the
only initial tab. The bundled host manifest remains `2.3.0-linux.1`.

## acorn (bundled, inside the Ego runtime)

| Item | Value |
| --- | --- |
| Project | [acorn](https://github.com/acornjs/acorn) |
| Licence | MIT — `vendor/LICENSE-acorn` |
| Bundled path | `vendor/ego-windows-host/node_modules/acorn/` |
| Why | the Ego runtime parses agent scripts with it |

## Chrome for Testing (downloaded at first use, not bundled)

| Item | Value |
| --- | --- |
| Project | [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/), Google's official pinned Chrome build for automation |
| Pinned version | recorded in `vendor/chromium-lock.json` |
| Source | `https://storage.googleapis.com/chrome-for-testing-public/<version>/win64/chrome-win64.zip` |
| Licence | Google Chrome binary; use is subject to Google's terms for that build. It is **not** redistributed in this npm package: the extension downloads it on the user's machine, verifies the pinned SHA-256, and only then enables it. |

Chrome for Testing does not publish per-file checksums. `vendor/chromium-lock.json`
records the URL, size and SHA-256 of the exact artifact this package was built
and verified against, and any download that does not match is rejected. If you
prefer your own binary, set `PI_EGO_BROWSER_PATH`; a locally installed Edge,
Chrome or Chromium is always preferred over the download.

## Not bundled, not required

Microsoft Edge and Google Chrome installed on the machine are used as they are,
through the DevTools protocol, each with a dedicated profile directory owned by
this extension. Nothing from those browsers is redistributed.

Windows' own folder selection dialog is used for `/ego-settings`, through the
WinForms `FolderBrowserDialog` that ships with .NET on Windows, driven by a small
PowerShell script (`src/folder-picker.js`). Neither PowerShell, .NET/WinForms nor
any part of it is redistributed here: the package only starts the shell that is
already installed, and nothing is added to its dependencies. PowerShell 7 is
preferred for its Explorer-style dialog; Windows PowerShell 5.1 gives the classic
folder dialog.
