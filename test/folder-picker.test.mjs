// The folder picker is Windows' own dialog driven by a PowerShell script, so
// there is no dialog to click in a test. What is tested here is everything the
// package itself owns: the script that asks for the dialog, the transport of the
// path in and out (never a command line, always UTF-8 files), and every result a
// real dialog can produce — a pick, a cancel, a timeout, a non-zero exit, an
// unusable WinForms, a host that cannot start a process at all, and a path the
// script should never have returned.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import {
  PICKER_RESULT_NAME,
  PICKER_SCRIPT,
  pickFolder,
} from "../src/folder-picker.js";

/** A `pi.exec()` stand-in: records the call and runs the behaviour inline. */
function fakeExec(behavior = () => ({ code: 0, stdout: "", stderr: "", killed: false })) {
  const calls = [];
  const exec = async (command, args = [], options = {}) => {
    const call = { command, args, options };
    calls.push(call);
    return behavior(call);
  };
  return { calls, exec };
}

/** Where the dialog's own files live, derived the way the script finds them. */
function dialogDir(call) {
  return dirname(call.args[call.args.length - 1]);
}

function answer(call, payload) {
  writeFileSync(join(dialogDir(call), PICKER_RESULT_NAME), JSON.stringify(payload), "utf8");
  return { code: 0, stdout: "", stderr: "", killed: false };
}

test("the picker script asks Windows for the Explorer-style dialog and keeps values out of source text", () => {
  assert.equal(/[^\u0000-\u007f]/.test(PICKER_SCRIPT), false, "ASCII only: PowerShell 5.1 reads .ps1 as the ANSI code page");
  assert.match(PICKER_SCRIPT, /FolderBrowserDialog/);
  assert.match(PICKER_SCRIPT, /FolderBrowserDialog/);
  assert.match(PICKER_SCRIPT, /try \{ \$dialog\.AutoUpgradeEnabled = \$true \} catch \{ \}/, "the modern dialog is asked for without breaking .NET Framework");
  assert.match(PICKER_SCRIPT, /ShowNewFolderButton = \$true/);
  assert.match(PICKER_SCRIPT, /FolderBrowserDialog/);
  assert.match(PICKER_SCRIPT, /Test-Path -LiteralPath \$start -PathType Container/, "a noisy path is still a literal path");
  assert.match(PICKER_SCRIPT, /input\.json/);
  assert.match(PICKER_SCRIPT, /result\.json/);
  assert.match(PICKER_SCRIPT, /UTF8Encoding/);
  assert.match(PICKER_SCRIPT, /cancelled = \$true/);
  assert.match(PICKER_SCRIPT, /stage = 'assembly'/);
  assert.equal(/Invoke-Expression|Add-Type -TypeDefinition/.test(PICKER_SCRIPT), false, "no dynamic code is compiled");
});

test("the chosen directory comes back unchanged and the starting directory never reaches the command line", async () => {
  const initial = "C:\\Users\\19434\\截图 与 素材";
  const chosen = "D:\\截图 与 素材\\ego shots";
  let dialog = null;
  const { calls, exec } = fakeExec((call) => {
    dialog = {
      dir: dialogDir(call),
      script: readFileSync(call.args[call.args.length - 1], "utf8"),
      input: JSON.parse(readFileSync(join(dialogDir(call), "input.json"), "utf8")),
    };
    return answer(call, { cancelled: false, path: chosen });
  });

  const picked = await pickFolder({ exec, initialDir: initial, platform: "win32" });
  assert.equal(picked.ok, true);
  assert.equal(picked.path, chosen);
  assert.equal(picked.cancelled, false);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "pwsh.exe", "PowerShell 7 hosts the Explorer-style dialog");
  assert.deepEqual(calls[0].args.slice(0, 6), ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File"]);
  assert.equal(calls[0].args.length, 7, "the script path is the only variable argument");
  assert.equal(calls[0].args.join(" ").includes("截图"), false, "the directory is not on the command line");
  assert.equal(calls[0].args.join(" ").includes(initial), false);
  assert.equal(calls[0].options.timeout > 0, true, "an overdue dialog is closed, not awaited forever");

  assert.equal(dialog.input.initial, initial, "the starting directory travels in the input file");
  assert.match(dialog.input.description, /Choose a screenshot folder/);
  assert.match(dialog.script, /FolderBrowserDialog/);
  assert.equal(existsSync(dialog.dir), false, "the temporary dialog directory is removed");
});

test("a UNC or otherwise awkward directory survives the round trip", async () => {
  const initial = "\\\\fileserver\\团队 共享\\截图 目录";
  const chosen = "\\\\fileserver\\团队 共享\\截图 目录\\ego shots";
  const { exec } = fakeExec((call) => answer(call, { cancelled: false, path: `  ${chosen}  ` }));
  const picked = await pickFolder({ exec, initialDir: initial, platform: "win32" });
  assert.equal(picked.ok, true);
  assert.equal(picked.path, chosen);
  assert.equal(win32.isAbsolute(picked.path), true);
});

test("cancel is reported as a cancel, keeps the choice, and still cleans up", async () => {
  let dir = "";
  const { exec } = fakeExec((call) => {
    dir = dialogDir(call);
    return answer(call, { cancelled: true });
  });
  const picked = await pickFolder({ exec, initialDir: "F:\\somewhere", platform: "win32" });
  assert.equal(picked.ok, false);
  assert.equal(picked.cancelled, true);
  assert.equal(picked.available, true);
  assert.match(picked.message, /folder is unchanged/);
  assert.equal(existsSync(dir), false);
});

test("a non-zero exit without a result is a failure that names the exit code and the stderr line", async () => {
  let dir = "";
  const { exec } = fakeExec((call) => {
    dir = dialogDir(call);
    return { code: 5, stdout: "", stderr: "  \r\nAccess is denied.\r\nat line:12\r\n", killed: false };
  });
  const picked = await pickFolder({ exec, platform: "win32" });
  assert.equal(picked.ok, false);
  assert.equal(picked.cancelled, false);
  assert.equal(picked.available, true);
  assert.equal(picked.code, "PICKER_EXIT_CODE");
  assert.match(picked.message, /exit code 5/);
  assert.match(picked.message, /Access is denied\./);
  assert.equal(existsSync(dir), false, "a failed dialog leaves nothing behind");
});

test("a dialog closed by the test timeout is reported with its shell", async () => {
  const { exec } = fakeExec(() => ({ code: null, stdout: "", stderr: "", killed: true }));
  const picked = await pickFolder({ exec, timeoutMs: 25, platform: "win32" });
  assert.equal(picked.ok, false);
  assert.equal(picked.code, "PICKER_TIMEOUT");
  assert.match(picked.message, /timed out/);
  assert.match(picked.message, /folder is unchanged/);
});

test("a non-zero exit cannot return a directory even when it wrote a selection", async () => {
  const { exec } = fakeExec((call) => ({
    ...answer(call, { cancelled: false, path: "C:\\shots" }),
    code: 5,
  }));
  const picked = await pickFolder({ exec, platform: "win32" });
  assert.equal(picked.ok, false);
  assert.equal(picked.code, "PICKER_EXIT_CODE");
  assert.equal(picked.path, undefined);
});

test("a missing PowerShell 7 falls back to Windows PowerShell 5.1, and the dialog result stands", async () => {
  const { calls, exec } = fakeExec((call) => {
    if (calls.length === 1) return { code: 1, stdout: "", stderr: "spawn pwsh.exe ENOENT", killed: false };
    return answer(call, { cancelled: false, path: "C:\\shots" });
  });
  const picked = await pickFolder({ exec, platform: "win32" });
  assert.equal(picked.ok, true);
  assert.equal(picked.path, "C:\\shots");
  assert.equal(picked.shell, "powershell.exe");
  assert.deepEqual(calls.map((call) => call.command), ["pwsh.exe", "powershell.exe"]);
});

test("a dialog that is open too long is closed and not reopened in the other shell", async () => {
  const { calls, exec } = fakeExec(() => ({ code: null, stdout: "", stderr: "", killed: true }));
  const picked = await pickFolder({ exec, platform: "win32" });
  assert.equal(picked.ok, false);
  assert.equal(picked.code, "PICKER_TIMEOUT");
  assert.equal(calls.length, 1, "no second window after the first one was killed");
});

test("a WinForms failure inside the script is unavailable, not a hard error", async () => {
  const { exec } = fakeExec((call) =>
    answer(call, { error: "Could not load file or assembly 'System.Windows.Forms'", stage: "assembly" })
  );
  const picked = await pickFolder({ exec, platform: "win32" });
  assert.equal(picked.ok, false);
  assert.equal(picked.available, false);
  assert.match(picked.message, /unavailable/);
  assert.match(picked.message, /System.Windows.Forms/);
});

test("a dialog error inside the script is a failure with the script's own message", async () => {
  const { exec } = fakeExec((call) => answer(call, { error: "The current thread must be set to single thread apartment", stage: "dialog" }));
  const picked = await pickFolder({ exec, platform: "win32" });
  assert.equal(picked.ok, false);
  assert.equal(picked.available, true);
  assert.equal(picked.code, "PICKER_DIALOG_FAILED");
  assert.match(picked.message, /single thread apartment/);
  assert.match(picked.message, /folder is unchanged/);
});

test("an empty, relative or quoted result is refused instead of being stored", async () => {
  const relative = fakeExec((call) => answer(call, { cancelled: false, path: "relative\\dir" }));
  const relativeResult = await pickFolder({ exec: relative.exec, platform: "win32" });
  assert.equal(relativeResult.ok, false);
  assert.equal(relativeResult.code, "PICKER_INVALID_PATH");

  const quoted = fakeExec((call) => answer(call, { cancelled: false, path: 'F:\\shots" & whoami' }));
  const quotedResult = await pickFolder({ exec: quoted.exec, platform: "win32" });
  assert.equal(quotedResult.ok, false);
  assert.equal(quotedResult.code, "PICKER_INVALID_PATH");

  const empty = fakeExec((call) => answer(call, { cancelled: false, path: "   " }));
  const emptyResult = await pickFolder({ exec: empty.exec, platform: "win32" });
  assert.equal(emptyResult.ok, false);
  assert.equal(emptyResult.code, "PICKER_INVALID_PATH");
});

test("no result file at all is a failure that says so", async () => {
  const { exec } = fakeExec(() => ({ code: 0, stdout: "", stderr: "", killed: false }));
  const picked = await pickFolder({ exec, platform: "win32" });
  assert.equal(picked.ok, false);
  assert.equal(picked.code, "PICKER_NO_RESULT");
  assert.match(picked.message, /returned no result/);
});

test("off Windows, or without a way to start a process, the picker is simply unavailable", async () => {
  const offWindows = fakeExec(() => {
    throw new Error("must not be called off Windows");
  });
  const notWindows = await pickFolder({ exec: offWindows.exec, platform: "linux" });
  assert.equal(notWindows.available, false);
  assert.equal(offWindows.calls.length, 0, "nothing is started on a platform without the dialog");

  const noExec = await pickFolder({ exec: null, platform: "win32" });
  assert.equal(noExec.available, false);
  assert.match(noExec.message, /Enter the folder path/);
});

test("no usable PowerShell at all is unavailable, so the caller can fall back", async () => {
  const { calls, exec } = fakeExec(() => ({
    code: 1,
    stdout: "",
    stderr: "spawn powershell.exe ENOENT",
    killed: false,
  }));
  const picked = await pickFolder({ exec, platform: "win32" });
  assert.equal(picked.ok, false);
  assert.equal(picked.available, false);
  assert.equal(picked.code, "PICKER_UNAVAILABLE");
  assert.match(picked.message, /Enter the folder path/);
  assert.equal(calls.length, 2, "both shells were tried");
});

test("the shell can be pointed elsewhere, but the dialog arguments stay fixed", async () => {
  const { calls, exec } = fakeExec((call) => answer(call, { cancelled: true }));
  await pickFolder({ exec, platform: "win32", env: { PI_EGO_PICKER_SHELL: "powershell.exe" } });
  assert.equal(calls.length, 1, "an explicit shell is used alone");
  assert.equal(calls[0].command, "powershell.exe");
  assert.deepEqual(calls[0].args.slice(0, 6), ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File"]);
});
