// Windows' own "browse for folder" dialog, without a runtime dependency.
//
// The dialog is the one Windows ships: the .NET WinForms `FolderBrowserDialog`,
// driven by a short PowerShell script. Nothing is added to the package, and no
// program is installed: the shell and its WinForms are part of Windows. It is
// started as `pwsh` first, because that hosts .NET 6+ WinForms where
// `AutoUpgradeEnabled` is the Explorer-style common item dialog; Windows
// PowerShell 5.1 (.NET Framework) is the fallback, where Windows' classic folder
// dialog is all that framework has.
//
// Three rules keep the hand-off safe and predictable:
//
//  * the directory name never reaches a command line. The starting directory
//    travels in `input.json` beside the script and is read with
//    `Get-Content -LiteralPath`, so spaces, Chinese and `\\server\share` paths
//    cannot be re-parsed as PowerShell syntax or quoting;
//  * the answer comes back through `result.json`, written by .NET as BOM-less
//    UTF-8, so the console code page and the terminal's own encoding never
//    touch a path character;
//  * the child is a normal `pi.exec()` run with a timeout, so a dialog the user
//    leaves open is closed instead of hanging the command, and nothing here
//    holds the run lock while a human decides.
//
// What the caller gets back is deliberately boring: one of
//   { ok: true, path }                                picked a folder
//   { ok: false, cancelled: true }                    the user cancelled
//   { ok: false, available: false, message }          no Windows/WinForms/exec
//   { ok: false, available: true, code, message }     the dialog failed
// so the command can validate and store a real choice, keep the old one on
// cancel or failure, and fall back to a typed path only when the dialog itself
// is unusable on this machine.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { tmpdir } from "node:os";
import { sleepSync } from "./store.js";

export const PICKER_SCRIPT_NAME = "pick-folder.ps1";
export const PICKER_INPUT_NAME = "input.json";
export const PICKER_RESULT_NAME = "result.json";
// PowerShell 7 hosts the .NET 6+ WinForms, whose FolderBrowserDialog is the
// Explorer-style common item dialog by default. Windows PowerShell 5.1 hosts
// .NET Framework, which has the classic folder dialog and no AutoUpgradeEnabled
// property, so it is only the fallback: the first shell that starts is used.
export const PICKER_SHELLS = ["pwsh.exe", "powershell.exe"];
export const PICKER_TIMEOUT_MS = 300000;
export const PICKER_DESCRIPTION = "选择截图附件目录（Esc 或“取消”保持当前设置）";

/**
 * The PowerShell program. Kept ASCII-only on purpose: PowerShell 5.1 reads a
 * script file as the ANSI code page unless it has a BOM, and every value this
 * script needs arrives as UTF-8 JSON rather than as source text.
 */
export const PICKER_SCRIPT = `# pi-ego-browser: Windows' own folder browser dialog.
#
# Input   : input.json beside this file  ({ initial, description })
# Output  : result.json beside this file
#           { cancelled: true }
#           { cancelled: false, path: "<absolute directory>" }
#           { error: "<message>", stage: "assembly" | "dialog" }
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$inFile = Join-Path -Path $root -ChildPath 'input.json'
$outFile = Join-Path -Path $root -ChildPath 'result.json'
$settings = $null

function Write-PickerResult([hashtable]$payload) {
  $json = $payload | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($outFile, $json, [System.Text.UTF8Encoding]::new($false))
}

try {
  $settings = Get-Content -LiteralPath $inFile -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  $settings = $null
}

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
} catch {
  Write-PickerResult @{ error = ('System.Windows.Forms: ' + $_.Exception.Message); stage = 'assembly' }
  exit 3
}

$dialog = $null
$owner = $null
try {
  try { [System.Windows.Forms.Application]::EnableVisualStyles() } catch { }

  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  # AutoUpgradeEnabled is the Explorer-style (Vista+) common item dialog instead
  # of the legacy tree. It exists in .NET 6+ WinForms (PowerShell 7); .NET
  # Framework (Windows PowerShell 5.1) does not have it, and there the classic
  # folder dialog is still the right thing to show.
  try { $dialog.AutoUpgradeEnabled = $true } catch { }
  try { $dialog.UseDescriptionForTitle = $true } catch { }
  $dialog.ShowNewFolderButton = $true
  if ($null -ne $settings -and -not [string]::IsNullOrEmpty($settings.description)) {
    $dialog.Description = [string]$settings.description
  }
  if ($null -ne $settings -and -not [string]::IsNullOrEmpty($settings.initial)) {
    $start = [string]$settings.initial
    try {
      if (Test-Path -LiteralPath $start -PathType Container) { $dialog.SelectedPath = $start }
    } catch { }
  }

  # A tiny, invisible, topmost owner form keeps the dialog in front of the
  # terminal window instead of behind it. If it cannot be created the dialog is
  # still shown, just without an owner.
  try {
    $owner = New-Object System.Windows.Forms.Form
    $owner.Text = 'pi-ego-browser'
    $owner.ShowInTaskbar = $false
    $owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $owner.Size = [System.Drawing.Size]::new(1, 1)
    $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $owner.TopMost = $true
    $owner.Opacity = 0
    $owner.Show()
  } catch {
    if ($owner) { try { $owner.Dispose() } catch { } }
    $owner = $null
  }

  if ($owner) { $result = $dialog.ShowDialog($owner) } else { $result = $dialog.ShowDialog() }

  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    $picked = [string]$dialog.SelectedPath
    if ([string]::IsNullOrWhiteSpace($picked)) {
      Write-PickerResult @{ cancelled = $true }
    } else {
      Write-PickerResult @{ cancelled = $false; path = [System.IO.Path]::GetFullPath($picked) }
    }
  } else {
    Write-PickerResult @{ cancelled = $true }
  }
} catch {
  Write-PickerResult @{ error = $_.Exception.Message; stage = 'dialog' }
  exit 4
} finally {
  if ($owner) { try { $owner.Close() } catch { }; try { $owner.Dispose() } catch { } }
  if ($dialog) { try { $dialog.Dispose() } catch { } }
}
exit 0
`;

function outcome({ ok, available = true, cancelled = false, code = null, message = "", ...rest }) {
  return { ok, available, cancelled, code, message, ...rest };
}

function unavailable(message) {
  return outcome({ ok: false, available: false, code: "PICKER_UNAVAILABLE", message });
}

function failure(message, code = "PICKER_FAILED", extra = {}) {
  return outcome({ ok: false, available: true, code, message, ...extra });
}

function firstLine(text, limit = 300) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ? line.slice(0, limit) : "";
}

function readPayload(path) {
  try {
    const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Remove the temporary directory; Windows may still hold a file for a moment. */
function cleanup(dir) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      if (attempt === 3) return; // best effort; a temp directory is not a failure
      sleepSync(40);
    }
  }
}

/** The shells to try, in order: an override wins, otherwise PowerShell 7 then 5.1. */
function shellCandidates(env, shell) {
  const override = String(shell || env?.PI_EGO_PICKER_SHELL || "").trim();
  return override ? [override] : [...PICKER_SHELLS];
}

/**
 * Show the native folder picker and return the user's choice.
 *
 * `exec` is Pi's own `pi.exec(command, args, options)`; there is no shell, the
 * script path is the only argument that is not a fixed flag, and the dialog runs
 * inside that child process.
 */
export async function pickFolder({
  exec,
  initialDir = "",
  description = PICKER_DESCRIPTION,
  timeoutMs = PICKER_TIMEOUT_MS,
  platform = process.platform,
  env = process.env,
  shell = "",
} = {}) {
  if (typeof exec !== "function") {
    return unavailable("这个运行环境不能启动 Windows 文件夹选择器；请手动输入目录。");
  }
  if (platform !== "win32") {
    return unavailable("Windows 文件夹选择器只在 Windows 上可用；请手动输入目录。");
  }
  const started = performance.now();
  const shells = shellCandidates(env, shell);

  let dir = "";
  try {
    dir = mkdtempSync(join(tmpdir(), "pi-ego-picker-"));
    const scriptPath = join(dir, PICKER_SCRIPT_NAME);
    const resultPath = join(dir, PICKER_RESULT_NAME);
    writeFileSync(scriptPath, PICKER_SCRIPT, "utf8");
    writeFileSync(
      join(dir, PICKER_INPUT_NAME),
      `${JSON.stringify({ initial: String(initialDir || ""), description: String(description || "") })}\n`,
      "utf8",
    );
    const args = ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptPath];

    // PowerShell 7 gives the Explorer-style dialog; Windows PowerShell 5.1 is
    // the fallback when the first shell is not installed. Only a shell that
    // could not be started at all falls through to the next one: a real dialog
    // result, a cancel or an error is final.
    const tried = [];
    for (const shellExe of shells) {
      let run = null;
      try {
        run = await exec(shellExe, args, { timeout: timeoutMs });
      } catch (error) {
        return failure(`启动系统文件夹选择器失败（${error?.message || error}）；目录保持不变。`, "PICKER_SPAWN_FAILED");
      }

      const payload = readPayload(resultPath);
      const exitCode = Number.isInteger(run?.code) ? run.code : null;
      const stderr = firstLine(run?.stderr);
      const killed = run?.killed === true;

      if (killed) {
        return failure("文件夹选择器等待超时，已经关闭；目录保持不变。", "PICKER_TIMEOUT", { exitCode, shell: shellExe });
      }
      if (!payload && /ENOENT|not recognized|not found/i.test(stderr)) {
        tried.push(`${shellExe}: ${stderr}`);
        continue; // this shell could not be started; try the next one
      }

      if (payload?.error) {
        const detail = String(payload.error).slice(0, 300);
        if (payload.stage === "assembly") {
          return unavailable(`系统文件夹选择器不可用（${detail}）；请手动输入目录。`);
        }
        return failure(`文件夹选择器出错：${detail}；目录保持不变。`, "PICKER_DIALOG_FAILED", { exitCode, shell: shellExe });
      }
      if (exitCode !== null && exitCode !== 0) {
        return failure(
          `文件夹选择器失败（退出码 ${exitCode}）${stderr ? `：${stderr}` : ""}；目录保持不变。`,
          "PICKER_EXIT_CODE",
          { exitCode, shell: shellExe },
        );
      }
      if (!payload) {
        return failure(
          `文件夹选择器没有返回结果${exitCode === null ? "" : `（退出码 ${exitCode}）`}${stderr ? `：${stderr}` : ""}；目录保持不变。`,
          "PICKER_NO_RESULT",
          { exitCode, shell: shellExe },
        );
      }
      if (payload.cancelled === true) {
        return outcome({
          ok: false,
          available: true,
          cancelled: true,
          code: "PICKER_CANCELLED",
          message: "已取消，截图附件目录保持不变。",
          shell: shellExe,
          exitCode,
          durationMs: Math.round(performance.now() - started),
        });
      }

      const path = typeof payload.path === "string" ? payload.path.trim() : "";
      const invalid = !path || path.includes('"') || /[\u0000-\u001f]/.test(path) || !win32.isAbsolute(path);
      if (invalid) {
        return failure(
          `文件夹选择器返回的路径无效（${JSON.stringify(payload.path ?? null)}）；目录保持不变。`,
          "PICKER_INVALID_PATH",
          { exitCode, shell: shellExe },
        );
      }
      return outcome({
        ok: true,
        available: true,
        cancelled: false,
        code: null,
        message: "",
        path,
        shell: shellExe,
        exitCode,
        durationMs: Math.round(performance.now() - started),
      });
    }

    return unavailable(`系统文件夹选择器不可用（${tried.join("；") || shells.join("、")}）；请手动输入目录。`);
  } catch (error) {
    return failure(`文件夹选择器失败（${error?.message || error}）；目录保持不变。`, "PICKER_FAILED");
  } finally {
    if (dir) cleanup(dir);
  }
}
