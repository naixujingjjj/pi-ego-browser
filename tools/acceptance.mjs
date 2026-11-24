// End-to-end acceptance for pi-ego-browser, phase by phase.
//
// Run this outside any process sandbox: it must spawn a browser and the Ego
// runtime. Every step asserts on its own, so one failure does not hide the
// rest. Results land in .tmp/acceptance/summary.json and each step's output in
// .tmp/acceptance/*.log.
//
// Usage:
//   node tools/acceptance.mjs                 # all four phases
//   node tools/acceptance.mjs --phase 1       # one phase (1, 2, 3, 4)
//   node tools/acceptance.mjs --quick         # phase 3 without the 215 MB download
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { buildZip } from "../test/helpers.mjs";
import { startFixtureServer } from "../test/fixtures/server.mjs";
import {
  createFakePi,
  freshDir,
  newestTarball,
  provideHostPackages,
  resolvePiPackage,
} from "./harness.mjs";
import { createFauxSession, loadPiHost, scriptedStep } from "./pi-session.mjs";
import { extractTarball } from "./tarball.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const WORK = join(ROOT, ".tmp", "acceptance");
const STATE = mkdtempSync(join(tmpdir(), "pi-ego-acceptance-"));
const args = process.argv.slice(2);
const onlyPhase = args.includes("--phase") ? Number(args[args.indexOf("--phase") + 1]) : null;
const quick = args.includes("--quick");

let moduleCounter = 0;
const results = [];

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    results.push({ name, ok: true, ms, detail: detail ?? null });
    log(`  PASS ${name} (${ms} ms)`);
  } catch (error) {
    const ms = Date.now() - started;
    results.push({ name, ok: false, ms, error: String(error?.stack || error?.message || error) });
    log(`  FAIL ${name} (${ms} ms)\n       ${String(error?.message || error).split("\n").join("\n       ")}`);
  }
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function checkEq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function run(file, argv, { cwd = ROOT, env = process.env, timeoutMs = 300000, input = null } = {}) {
  return new Promise((done) => {
    const child = spawn(file, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: `${stderr}\n${error.message}`, error });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
    if (input !== null) child.stdin.write(input);
    child.stdin.end();
  });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Load the packaged extension exactly as Pi does (its entry module), with Pi's
 * host-provided packages mapped in — the same mapping Pi applies at runtime.
 */
async function loadPackagedExtension({ pi, tarball, instance, env }) {
  const unpackRoot = freshDir(join(WORK, `pkg-${instance}`));
  extractTarball(tarball, unpackRoot);
  const packageDir = join(unpackRoot, "package");
  check(existsSync(join(packageDir, "extensions", "ego-browser.js")), "packaged extension entry is missing");
  provideHostPackages(packageDir, pi.packageRoot);

  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = String(value);
  }
  const notices = [];
  const api = createFakePi(notices);
  const entryUrl = `${pathToFileURL(join(packageDir, "extensions", "ego-browser.js")).href}?instance=${(moduleCounter += 1)}`;
  const module = await import(entryUrl);
  check(typeof module.default === "function", "extension entry does not export a default factory");
  await module.default(api);
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  return { api, notices, packageDir, restore };
}

async function invoke(api, name, params, sessionKey) {
  const definition = api.tools.get(name);
  if (!definition) throw new Error(`tool ${name} is not registered`);
  const ctx = {
    sessionManager: { getSessionId: () => sessionKey, getEntries: () => [] },
    ui: { notify() {}, setStatus() {}, setWidget() {} },
    cwd: ROOT,
  };
  const onUpdate = (update) => {
    for (const part of update.content || []) {
      if (part.type === "text") api.events.emit("tool_update", { message: part.text });
    }
  };
  const outcome = await definition.execute(`call-${name}-${Date.now()}`, params, undefined, onUpdate, ctx);
  const text = (outcome.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const images = (outcome.content || []).filter((part) => part.type === "image");
  return { ...outcome, text, images };
}

async function invokeCommand(api, name, argsText, sessionKey) {
  const command = api.commands.get(name);
  if (!command) throw new Error(`command /${name} is not registered`);
  const ctx = {
    sessionManager: { getSessionId: () => sessionKey, getEntries: () => [] },
    ui: { notify() {}, setStatus() {}, setWidget() {} },
    cwd: ROOT,
  };
  const text = await command.handler(argsText, ctx);
  return { text: String(text ?? "") };
}

function expectOk(outcome, label) {
  if (outcome.isError) {
    throw new Error(`${label} failed: ${outcome.text}\n${JSON.stringify(outcome.details, null, 2)}`);
  }
  return outcome;
}

/** `[#7]` for the line that carries this role and accessible name. */
function numberFor(readText, role, name) {
  const lines = readText.split("\n").filter((line) => line.includes(`- ${role} "${name}"`));
  for (const line of lines) {
    const match = /\[#(\d+)\]/.exec(line);
    if (match) return `#${match[1]}`;
  }
  throw new Error(`no number for ${role} "${name}" in:\n${readText}`);
}

async function probeEndpoint(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function checkOnlyOpenPage(port, url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
  check(response.ok, "the browser did not return its tabs");
  const tabs = (await response.json()).filter((entry) => entry.type === "page");
  checkEq(tabs.length, 1, `browser startup left extra tabs: ${tabs.map((tab) => tab.url).join(", ")}`);
  checkEq(tabs[0].url, url, "the only tab must be the requested page");
}

/** Close the browser this suite started on `port` (never touches other browsers). */
async function closeBrowser(port, stateDir, logPath) {
  const info = await probeEndpoint(port);
  if (!info?.webSocketDebuggerUrl) return false;
  const endpointFile = join(stateDir, "browser-endpoint.json");
  if (!existsSync(endpointFile)) return false;
  const { url } = JSON.parse(readFileSync(endpointFile, "utf8"));
  if (url !== info.webSocketDebuggerUrl) return false;
  const socket = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((done) => {
    const timer = setTimeout(() => {
      socket.close();
      done();
    }, 5000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Browser.close" })));
    socket.addEventListener("message", () => {
      clearTimeout(timer);
      done();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      done();
    });
  });
  if (logPath) writeFileSync(logPath, JSON.stringify(info, null, 2));
  return true;
}

/**
 * The user acting in the browser window does not go through Ego's bridge; it is
 * a plain CDP client on the loopback port. That is what this simulates while a
 * task space is handed off.
 */
async function userEditInPage(port, urlPrefix, expression) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((entry) => entry.type === "page" && String(entry.url).startsWith(urlPrefix));
  if (!target) throw new Error(`no page target starting with ${urlPrefix}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const result = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error("user edit timed out")), 10000);
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data));
      if (payload.id === 1) {
        clearTimeout(timer);
        done(payload);
      }
    });
    socket.addEventListener("error", (error) => {
      clearTimeout(timer);
      fail(new Error(String(error?.message || error)));
    });
  });
  socket.close();
  if (result.error) throw new Error(JSON.stringify(result.error));
  if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
  return result.result?.result?.value ?? null;
}

// ---------------------------------------------------------------- phases

async function phase1({ pi, tarball, fixture }) {
  log("\n== Phase 1: install from the tarball, load in an isolated Pi, open/read/screenshot ==");
  const agentDir = freshDir(join(WORK, "pi-agent"));
  const projectDir = freshDir(join(WORK, "pi-project"));
  const installEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
  };

  await step("1.1 the environment has no ego-browser on PATH and no Ego skill in the isolated config", async () => {
    const found = String(process.env.PATH || "")
      .split(";")
      .filter(Boolean)
      .map((dir) => join(dir, "ego-browser.cmd"))
      .some((candidate) => existsSync(candidate));
    check(!found, "ego-browser.cmd is on PATH; the check would not prove self-containment");
    check(!existsSync(join(agentDir, "skills", "ego-browser")), "the isolated Pi config already has an Ego skill");
    return { agentDir, projectDir };
  });

  await step("1.2 pi install from the local tarball writes the isolated settings", async () => {
    const spec = `npm:pi-ego-browser@file:${tarball.replace(/\\/g, "/")}`;
    const installed = await run(process.execPath, [pi.cli, "install", spec], { cwd: projectDir, env: installEnv, timeoutMs: 300000 });
    writeFileSync(join(WORK, "install.log"), `${installed.stdout}\n${installed.stderr}`);
    checkEq(installed.code, 0, `pi install exited ${installed.code}\n${installed.stdout}\n${installed.stderr}`);
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    const packages = (settings.packages || []).map((entry) => (typeof entry === "string" ? entry : entry.source));
    check(
      packages.some((source) => String(source).includes("pi-ego-browser")),
      `settings.json does not declare the package: ${JSON.stringify(packages)}`,
    );
    return { spec, packages };
  });

  await step("1.3 a fresh Pi session registers the browser tools and only the /ego-settings command", async () => {
    const rpc = spawn(process.execPath, [pi.cli, "--mode", "rpc"], {
      cwd: projectDir,
      env: installEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    rpc.stdout.setEncoding("utf8");
    rpc.stderr.setEncoding("utf8");
    rpc.stdout.on("data", (chunk) => (out += chunk));
    rpc.stderr.on("data", (chunk) => (err += chunk));
    rpc.stdin.write(`${JSON.stringify({ id: "r1", type: "get_commands" })}\n`);
    rpc.stdin.write(`${JSON.stringify({ id: "r2", type: "prompt", message: "/ego-settings status" })}\n`);
    await new Promise((done) => setTimeout(done, 12000));
    rpc.kill();
    writeFileSync(join(WORK, "rpc.log"), `${out}\n--- stderr ---\n${err}`);
    const responses = out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const commandsResponse = responses.find((entry) => entry.command === "get_commands");
    check(commandsResponse?.success, `get_commands failed: ${out.slice(0, 4000)}`);
    const command = (commandsResponse.data.commands || []).find((entry) => entry.name === "ego-settings");
    check(command, `the ego-settings command is not registered; commands: ${JSON.stringify(commandsResponse.data.commands)}`);
    checkEq(command.source, "extension", "the ego-settings command should come from an extension");
    const removed = (commandsResponse.data.commands || []).find((entry) => entry.name === "ego");
    check(!removed, `the removed /ego command is still offered: ${JSON.stringify(removed)}`);
    check(
      command.sourceInfo?.origin !== "builtin",
      `the ego-settings command resolved to a built-in resource instead of the installed package: ${JSON.stringify(command.sourceInfo)}`,
    );
    check(
      !/failed to load|extension error|cannot find module/i.test(err),
      `Pi reported a loading problem: ${err.slice(0, 800)}`,
    );
    const handled = responses.find((entry) => entry.command === "prompt");
    const sawStatusText = /浏览器：/.test(out);
    return {
      command: command.name,
      commandPath: command.sourceInfo?.path ?? null,
      promptDisposition: handled?.data?.disposition ?? "(no prompt response)",
      statusTextSeen: sawStatusText,
    };
  });

  const port = 9540;
  const stateDir = freshDir(join(STATE, "state-p1"));
  const env = {
    PI_EGO_HOME: stateDir,
    PI_EGO_DEBUG_PORT: String(port),
    PI_EGO_HEADLESS: "1",
    PI_EGO_RUN_TIMEOUT_MS: "120000",
  };
  const loaded = await loadPackagedExtension({ pi, tarball, instance: "p1", env });
  const sessionKey = "accept-phase1";
  const shot = {};

  try {
    await step("1.4 the packaged tools start the isolated browser with only the requested tab", async () => {
      const outcome = expectOk(await invoke(loaded.api, "browser_open", { url: `${fixture.origin}/` }, sessionKey), "browser_open");
      check(outcome.details.url === `${fixture.origin}/`, `opened the wrong url: ${outcome.details.url}`);
      check(outcome.details.title.includes("Fixture"), `title missing: ${outcome.details.title}`);
      check(existsSync(join(stateDir, "profile")), "the dedicated browser profile was not created");
      const info = await probeEndpoint(port);
      check(info, "no CDP endpoint answered on the extension's port");
      await checkOnlyOpenPage(port, `${fixture.origin}/`);
      return { url: outcome.details.url, title: outcome.details.title, spaceId: outcome.details.spaceId, browser: info.Browser, pageTabs: 1 };
    });

    await step("1.5 browser_read returns a numbered element tree", async () => {
      const outcome = expectOk(await invoke(loaded.api, "browser_read", {}, sessionKey), "browser_read");
      check(outcome.text.includes("Pi Ego fixture"), `snapshot misses the heading:\n${outcome.text}`);
      check(/\[#\d+\]/.test(outcome.text), `no numbered elements in:\n${outcome.text}`);
      const button = numberFor(outcome.text, "button", "Bump counter");
      const link = numberFor(outcome.text, "link", "Open the form");
      return { elements: outcome.details.elements, button, link, firstLines: outcome.text.split("\n").slice(0, 12) };
    });

    await step("1.6 browser_screenshot publishes one attachment instead of image bytes", async () => {
      const outcome = expectOk(await invoke(loaded.api, "browser_screenshot", {}, sessionKey), "browser_screenshot");
      const attachment = outcome.details.attachment;
      check(attachment?.id, `no attachment metadata in the result: ${JSON.stringify(outcome.details)}`);
      check(/^[a-f0-9]{64}$/.test(attachment.id), `attachment ID is not a SHA-256: ${attachment.id}`);
      check(outcome.images.length === 0, "the tool result must not embed an image content block");
      const path = outcome.details.path;
      check(path && existsSync(path), `attachment file missing: ${path}`);
      checkEq(path, join(stateDir, "attachments", "v1", "objects", `${attachment.id}.png`), "attachment is outside the default library");
      checkEq(readFileSync(path).subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "attachment is not a PNG");
      checkEq(sha256(path), attachment.id, "the attachment ID is not the SHA-256 of the PNG bytes");
      const staging = join(stateDir, "attachments", "v1", "staging");
      check(!existsSync(staging) || readdirSync(staging).length === 0, "the staging file was not cleaned up");
      check(!existsSync(join(stateDir, "screenshots")), "a capture must not create a second copy anywhere");
      const detailsJson = JSON.stringify(outcome.details);
      check(detailsJson.length < 4000, `tool details grew to ${detailsJson.length} bytes`);
      check(!/"data"|base64|data:image/.test(detailsJson), "tool details must stay small metadata");
      shot.id = attachment.id;
      shot.path = path;
      shot.bytes = attachment.bytes;
      return { path, bytes: attachment.bytes, inlineImages: outcome.images.length };
    });

    await step("1.7 the same picture is stored once and saving it returns that one original", async () => {
      const original = readFileSync(shot.path);
      const again = expectOk(await invoke(loaded.api, "browser_screenshot", {}, sessionKey), "second capture");
      checkEq(again.details.attachment.id, shot.id, "identical bytes must share one attachment ID");
      checkEq(again.details.deduped, true, "the second capture should report a deduplicated publish");
      const objects = readdirSync(join(stateDir, "attachments", "v1", "objects"));
      checkEq(objects.length, 1, `expected one library object, found ${objects.join(", ")}`);
      check(readFileSync(shot.path).equals(original), "the library object was rewritten");

      // A normal "save this" is the original: no second file, no export root.
      const saved = expectOk(await invoke(loaded.api, "browser_save_screenshot", {}, sessionKey), "save this");
      checkEq(saved.details.path, shot.path, "a normal save must return the library original");
      checkEq(saved.details.savedOriginal, true, "a normal save must report the original, not a copy");
      checkEq(saved.details.copied, undefined, "a normal save must not copy the picture");
      check(!existsSync(join(stateDir, "screenshots")), "a normal save created an export directory");
      const repeated = expectOk(await invoke(loaded.api, "browser_save_screenshot", {}, sessionKey), "save this again");
      checkEq(repeated.details.path, shot.path, "saving twice points at the same original");
      checkEq(readdirSync(join(stateDir, "attachments", "v1", "objects")).length, 1, "saving added a library object");

      // Only a destination the user names is copied, and it holds the same bytes.
      const targetDir = join(STATE, "p1 用户 指定");
      mkdirSync(targetDir, { recursive: true });
      const target = join(targetDir, "页面 截图.png");
      const copied = expectOk(await invoke(loaded.api, "browser_save_screenshot", { path: target }, sessionKey), "copy to a named path");
      checkEq(copied.details.path, target, "the copy went somewhere else");
      checkEq(copied.details.copied, true, "the named destination is a copy");
      check(readFileSync(target).equals(original), "the copied file does not match the picture");
      check(readFileSync(shot.path).equals(original), "the library original changed during the copy");
      const refused = await invoke(loaded.api, "browser_save_screenshot", { path: target }, sessionKey);
      checkEq(refused.details.reused, true, "an identical destination is recognised, not refused");
      const listed = await invokeCommand(loaded.api, "ego-settings", "attachments", sessionKey);
      check(listed.text.includes(shot.id.slice(0, 12)), `the settings listing does not name the capture:\n${listed.text}`);
      return { id: shot.id, objects: objects.length, original: shot.path, copy: target };
    });
  } finally {
    await closeBrowser(port, stateDir, join(WORK, "p1-browser.json"));
    loaded.restore();
  }
}

async function phase2({ pi, tarball, fixture }) {
  log("\n== Phase 2: click, fill, hand-off, /ego-settings resume, tabs, two sessions, stale numbers ==");
  const port = 9541;
  const stateDir = freshDir(join(STATE, "state-p2"));
  const env = {
    PI_EGO_HOME: stateDir,
    PI_EGO_DEBUG_PORT: String(port),
    PI_EGO_HEADLESS: "1",
    PI_EGO_RUN_TIMEOUT_MS: "120000",
  };
  const sessionA = "accept-phase2-a";
  const sessionB = "accept-phase2-b";
  const loaded = await loadPackagedExtension({ pi, tarball, instance: "p2", env });
  const api = loaded.api;
  const formUrl = `${fixture.origin}/form.html`;
  const homeUrl = `${fixture.origin}/`;
  let resumeSnapshot = "";

  try {
    await step("2.1 the agent fills half of the form", async () => {
      expectOk(await invoke(api, "browser_open", { url: formUrl }, sessionA), "browser_open(form)");
      const read = expectOk(await invoke(api, "browser_read", {}, sessionA), "browser_read(form)");
      const nameField = numberFor(read.text, "textbox", "Full name");
      const filled = expectOk(await invoke(api, "browser_fill", { target: nameField, text: "张三" }, sessionA), "browser_fill(name)");
      check(filled.text.includes("已填写"), `fill did not confirm: ${filled.text}`);
      return { nameField, outcome: filled.text.split("\n")[0] };
    });

    await step("2.2 browser_handoff hands the tab to the user and pauses the tools", async () => {
      const handoff = expectOk(
        await invoke(api, "browser_handoff", { instruction: "请把邮箱改成 user@example.com，并把页面上的 original 点成 edited by user" }, sessionA),
        "browser_handoff",
      );
      check(handoff.text.includes("/ego-settings"), `hand-off does not name /ego-settings: ${handoff.text}`);
      check(handoff.text.includes("恢复浏览器控制"), `hand-off does not name the row that resumes: ${handoff.text}`);
      const refused = await invoke(api, "browser_open", { url: homeUrl }, sessionA);
      check(refused.isError, "browser tools must refuse while the user has control");
      check(refused.text.includes("/ego-settings"), `refusal message should point at /ego-settings: ${refused.text}`);
      // The Ego runtime itself must be enforcing it too, not only the extension.
      const hostScript = await run(
        process.execPath,
        [
          join(ROOT, "vendor", "ego-windows-host", "bin", "ego-windows-host.mjs"),
          "-e",
          'const s = (await listTaskSpaces())[0]; const t = await taskSpace(s.id); await t.page("p1").snapshot(); console.log("NO-ERROR");',
        ],
        {
          env: { ...process.env, EGO_HOST_STATE_DIR: stateDir, EGO_HOST_DEBUG_PORT: String(port), EGO_HOST_HEADLESS: "1" },
          timeoutMs: 60000,
        },
      );
      writeFileSync(join(WORK, "p2-handoff-host.log"), `${hostScript.stdout}\n--- stderr ---\n${hostScript.stderr}`);
      check(
        /USER_IN_CONTROL|user is controlling this task space/i.test(`${hostScript.stdout}${hostScript.stderr}`),
        `the runtime did not enforce user control: ${hostScript.stdout}${hostScript.stderr}`,
      );
      return { visible: handoff.details.visible, refusedCode: refused.details?.code ?? refused.text.slice(0, 80) };
    });

    await step("2.3 the user edits the page by hand (a plain CDP client, not the extension)", async () => {
      const expression = `(() => {
        document.getElementById("email").value = "user@example.com";
        document.getElementById("email").dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("user-slot").click();
        return document.getElementById("user-slot").textContent;
      })()`;
      const value = await userEditInPage(port, formUrl, expression);
      checkEq(value, "edited by user", "the hand edit did not reach the page");
      return { userSlot: value };
    });

    await step("2.4 /ego-settings resume takes control back and re-reads the same tab", async () => {
      const resumed = await invokeCommand(api, "ego-settings", "resume", sessionA);
      check(resumed.text.includes("已恢复浏览器控制权"), `resume output unexpected: ${resumed.text}`);
      check(resumed.text.includes("edited by user"), `resume snapshot misses the hand edit:\n${resumed.text}`);
      check(resumed.text.includes("user@example.com"), `resume snapshot misses the hand-typed value:\n${resumed.text}`);
      resumeSnapshot = resumed.text;
      const status = await invokeCommand(api, "ego-settings", "status", sessionA);
      check(status.text.includes("浏览器"), `status output unexpected: ${status.text}`);
      check(status.text.includes("Pi 持有"), `status should report agent control after resume: ${status.text}`);
      return { resumeHead: resumed.text.split("\n").slice(0, 4), statusHead: status.text.split("\n")[0] };
    });

    await step("2.5 the agent continues on the resumed page and submits", async () => {
      const read = expectOk(await invoke(api, "browser_read", {}, sessionA), "browser_read(after resume)");
      const notes = numberFor(read.text, "textbox", "Notes");
      expectOk(await invoke(api, "browser_fill", { target: notes, text: "填写完成" }, sessionA), "browser_fill(notes)");
      const submit = numberFor(read.text, "button", "Sign up");
      const clicked = expectOk(await invoke(api, "browser_click", { target: submit }, sessionA), "browser_click(Sign up)");
      check(clicked.details.url === formUrl, `unexpected url after submit: ${clicked.details.url}`);
      const after = expectOk(await invoke(api, "browser_read", {}, sessionA), "browser_read(after submit)");
      check(after.text.includes("submitted"), `the submit outcome is missing:\n${after.text}`);
      const notesVisible = after.text.includes("填写完成");
      const shot = expectOk(await invoke(api, "browser_screenshot", { fullPage: true }, sessionA), "browser_screenshot");
      check(existsSync(shot.details.path), "screenshot file missing");
      return { submitted: true, notesVisible, screenshot: shot.details.path };
    });

    await step("2.6 a second Pi session gets its own task space and tabs", async () => {
      const [openingB, readingA] = await Promise.all([
        invoke(api, "browser_tabs", { action: "new", url: `${fixture.origin}/second.html` }, sessionB),
        invoke(api, "browser_read", { scope: "viewport" }, sessionA),
      ]);
      const firstB = expectOk(openingB, "browser_tabs(new, B)");
      checkEq(expectOk(readingA, "browser_read(A during open B)").details.url, formUrl, "session A read the wrong page");
      check(firstB.details.url.endsWith("/second.html"), `session B opened the wrong page: ${firstB.details.url}`);
      const tabsB = expectOk(await invoke(api, "browser_tabs", { action: "list" }, sessionB), "browser_tabs(list, B again)");
      checkEq(tabsB.details.tabs.length, 1, "session B should own exactly one tab");
      const tabsA = expectOk(await invoke(api, "browser_tabs", { action: "list" }, sessionA), "browser_tabs(list, A)");
      checkEq(tabsA.details.tabs.length, 1, "session A's tab must not be shared with session B");
      check(
        tabsA.details.tabs[0].url === formUrl,
        `session A's tab changed: ${tabsA.details.tabs[0].url}`,
      );
      check(tabsA.details.spaceId !== tabsB.details.spaceId, "both sessions ended up in the same task space");
      return { spaceA: tabsA.details.spaceId, spaceB: tabsB.details.spaceId, urlA: tabsA.details.tabs[0].url, urlB: tabsB.details.tabs[0].url };
    });

    await step("2.7 a new tab is created and switched, and numbers follow the active tab", async () => {
      const created = expectOk(await invoke(api, "browser_tabs", { action: "new", url: `${fixture.origin}/third.html` }, sessionA), "browser_tabs(new)");
      checkEq(created.details.tabs.length, 2, "session A should now have two tabs");
      const list = expectOk(await invoke(api, "browser_tabs", { action: "list" }, sessionA), "browser_tabs(list)");
      check(list.details.labels.length === 2, `expected two labels: ${JSON.stringify(list.details.labels)}`);
      const switched = expectOk(await invoke(api, "browser_tabs", { action: "switch", pageLabel: list.details.labels[0] }, sessionA), "browser_tabs(switch)");
      check(switched.details.url === formUrl, `switching did not move to the form tab: ${switched.details.url}`);
      const read = expectOk(await invoke(api, "browser_read", {}, sessionA), "browser_read(switched)");
      check(read.text.includes("submitted"), "the switched tab does not show the submitted form");
      const closed = expectOk(await invoke(api, "browser_tabs", { action: "close", pageLabel: list.details.labels[1] }, sessionA), "browser_tabs(close)");
      checkEq(closed.details.tabs.length, 1, "closing a tab should leave one");
      return { labels: list.details.labels, closed: closed.details.closed };
    });

    await step("2.8 a number from an older page state is refused", async () => {
      expectOk(await invoke(api, "browser_open", { url: homeUrl }, sessionA), "browser_open(home)");
      const homeRead = expectOk(await invoke(api, "browser_read", {}, sessionA), "browser_read(home)");
      const link = numberFor(homeRead.text, "link", "Second page");
      const navigated = expectOk(await invoke(api, "browser_click", { target: link }, sessionA), "browser_click(link)");
      check(navigated.text.includes("页面已跳转"), `navigation not reported: ${navigated.text}`);
      const stale = await invoke(api, "browser_click", { target: link }, sessionA);
      check(stale.isError, "a number from the pre-navigation read must be refused");
      check(
        /失效|browser_read|重新读取/.test(stale.text),
        `the stale-number message should tell the model to read again: ${stale.text}`,
      );
      expectOk(await invoke(api, "browser_read", {}, sessionA), "browser_read(after stale)");
      return { staleMessage: stale.text.split("\n")[0] };
    });
  } finally {
    await closeBrowser(port, stateDir, join(WORK, "p2-browser.json"));
    loaded.restore();
  }
}

async function phase3({ pi, tarball, fixture }) {
  log("\n== Phase 3: managed Chrome for Testing — first use, cache reuse, interrupted download, bad checksum ==");
  const port = 9542;
  const stateDir = freshDir(join(STATE, "state-p3-empty"));
  const lock = JSON.parse(readFileSync(join(ROOT, "vendor", "chromium-lock.json"), "utf8"));
  const env = {
    PI_EGO_HOME: stateDir,
    PI_EGO_DEBUG_PORT: String(port),
    PI_EGO_HEADLESS: "1",
    PI_EGO_NO_SYSTEM_BROWSER: "1",
    PI_EGO_RUN_TIMEOUT_MS: "180000",
  };
  const loaded = await loadPackagedExtension({ pi, tarball, instance: "p3", env });
  const exe = join(stateDir, "browsers", `chrome-win64-${lock.version}`, "chrome-win64", "chrome.exe");

  try {
    await step("3.1 an empty cache downloads, verifies, unpacks and launches the managed browser", async () => {
      const started = Date.now();
      const outcome = expectOk(await invoke(loaded.api, "browser_open", { url: `${fixture.origin}/` }, "accept-p3"), "browser_open(managed)");
      const elapsed = Date.now() - started;
      check(existsSync(exe), `managed browser missing at ${exe}`);
      check(existsSync(join(stateDir, "browsers", `chrome-win64-${lock.version}`, ".complete")), "no .complete marker");
      const state = JSON.parse(readFileSync(join(stateDir, "browser-state.json"), "utf8"));
      checkEq(state.source, "managed", "browser-state.json should report the managed source");
      checkEq(state.version, lock.version, "browser-state.json reports the wrong version");
      check(outcome.details.title.includes("Fixture"), `managed browser opened the wrong page: ${outcome.details.title}`);
      await checkOnlyOpenPage(port, `${fixture.origin}/`);
      check(/download verified|preparing Chrome/i.test(loaded.notices.join("\n")), `no download progress was reported: ${loaded.notices.join(" | ")}`);
      check(!existsSync(join(stateDir, "downloads", `chrome-win64-${lock.version}.zip`)), "the archive should be removed after unpacking");
      return { elapsedMs: elapsed, exe, version: lock.version, sha256: lock.sha256.slice(0, 16), notices: loaded.notices.slice(0, 6), pageTabs: 1 };
    });

    await step("3.2 the cached build is reused without downloading again", async () => {
      const before = statSync(exe).mtimeMs;
      const downloadsBefore = existsSync(join(stateDir, "downloads")) ? readdirSync(join(stateDir, "downloads")) : [];
      const second = await loadPackagedExtension({ pi, tarball, instance: "p3-cache", env });
      try {
        const started = Date.now();
        expectOk(
          await invoke(second.api, "browser_open", { url: `${fixture.origin}/second.html` }, "accept-p3-cache"),
          "browser_open(cached)",
        );
        checkEq(statSync(exe).mtimeMs, before, "the managed browser was reinstalled");
        checkEq(second.notices.filter((line) => /downloading/i.test(line)).length, 0, "the cached run downloaded again");
        check(
          second.notices.some((line) => /reusing cached/i.test(line)),
          `no cache-reuse message: ${second.notices.join(" | ")}`,
        );
        check(!existsSync(join(stateDir, "downloads", `chrome-win64-${lock.version}.zip.part`)), "a partial download is left behind");
        return { reuseMs: Date.now() - started, downloadsBefore, notices: second.notices };
      } finally {
        second.restore();
      }
    });

    await closeBrowser(port, stateDir, join(WORK, "p3-browser.json"));

    if (!quick) {
      await step("3.3 an interrupted download resumes with a Range request and still verifies", async () => {
        const resumeState = freshDir(join(STATE, "state-p3-resume"));
        const downloads = freshDir(join(resumeState, "downloads"));
        const localArchive = await ensureLocalArchive(lock);
        check(localArchive, "no local copy of the pinned archive to seed a partial download from");
        const partPath = join(downloads, `chrome-win64-${lock.version}.zip.part`);
        const full = readFileSync(localArchive);
        const seeded = full.subarray(0, Math.min(full.length, 40 * 1024 * 1024));
        writeFileSync(partPath, seeded);
        const resumeEnv = { ...env, PI_EGO_HOME: resumeState, PI_EGO_DEBUG_PORT: String(port + 1) };
        const resumed = await loadPackagedExtension({ pi, tarball, instance: "p3-resume", env: resumeEnv });
        try {
          const outcome = expectOk(await invoke(resumed.api, "browser_open", { url: `${fixture.origin}/` }, "accept-p3-resume"), "browser_open(resumed download)");
          const resumedExe = join(resumeState, "browsers", `chrome-win64-${lock.version}`, "chrome-win64", "chrome.exe");
          check(existsSync(resumedExe), "the resumed download did not install");
          check(
            resumed.notices.some((line) => /resuming browser download/i.test(line)),
            `the download did not resume: ${resumed.notices.join(" | ")}`,
          );
          check(!existsSync(partPath), "the .part file should be gone after a successful install");
          check(outcome.details.title.includes("Fixture"), `the resumed browser failed to open the page: ${outcome.details.title}`);
          return { seededBytes: seeded.length, archiveBytes: full.length, notices: resumed.notices.slice(0, 8) };
        } finally {
          await closeBrowser(port + 1, resumeState, join(WORK, "p3-resume-browser.json"));
          resumed.restore();
        }
      });
    }

    await step("3.4 a bad checksum is rejected and never enabled", async () => {
      const zip = buildZip([
        { name: "chrome-win64/", data: "" },
        { name: "chrome-win64/chrome.exe", data: "not a browser" },
      ]);
      const server = createServer((request, response) => {
        response.writeHead(200, { "content-type": "application/zip", "content-length": String(zip.length) });
        response.end(zip);
      });
      await new Promise((done) => server.listen(0, "127.0.0.1", done));
      const { port: fakePort } = server.address();
      const badState = freshDir(join(STATE, "state-p3-badhash"));
      const badEnv = {
        ...env,
        PI_EGO_HOME: badState,
        PI_EGO_DEBUG_PORT: String(port + 2),
        PI_EGO_CHROMIUM_URL: `http://127.0.0.1:${fakePort}/chrome-win64.zip`,
        PI_EGO_CHROMIUM_SHA256: "0".repeat(64),
        PI_EGO_CHROMIUM_VERSION: "test-bad-checksum",
      };
      const bad = await loadPackagedExtension({ pi, tarball, instance: "p3-badhash", env: badEnv });
      try {
        const outcome = await invoke(bad.api, "browser_open", { url: `${fixture.origin}/` }, "accept-p3-bad");
        check(outcome.isError, "a mismatched checksum must fail the tool call");
        checkEq(outcome.details?.code, "BROWSER_DOWNLOAD_FAILED", `unexpected failure code: ${outcome.details?.code}`);
        check(/SHA-256/.test(outcome.text), `the failure should name the checksum: ${outcome.text}`);
        check(!existsSync(join(badState, "browsers")), "a rejected download must not be installed");
        const state = JSON.parse(readFileSync(join(badState, "browser-state.json"), "utf8"));
        checkEq(state.ok, false, "browser-state.json should record the failure");
        checkEq(state.stage, "browser-download", `browser-state.json stage: ${state.stage}`);
        return { code: outcome.details.code, message: outcome.text.split("\n")[0] };
      } finally {
        server.close();
        bad.restore();
      }
    });
  } finally {
    await closeBrowser(port, stateDir, join(WORK, "p3-browser-final.json"));
    loaded.restore();
  }
}

// ---------------------------------------------------------------- phase 4 helpers

/** The per-session record the extension keeps under the state root. */
function sessionRecord(stateDir, sessionKey) {
  const file = join(stateDir, "sessions.json");
  if (!existsSync(file)) return null;
  const state = JSON.parse(readFileSync(file, "utf8"));
  return state.sessions?.[sessionKey] || null;
}

/** Absolute file for one attachment reference, through the root registry. */
function attachmentFile(stateDir, ref) {
  const registry = JSON.parse(readFileSync(join(stateDir, "attachments-roots.json"), "utf8"));
  const root = registry.roots?.[ref.rootId];
  check(root?.path, `reference ${ref.id?.slice(0, 12)} points at an unregistered root ${ref.rootId}`);
  return join(root.path, "v1", "objects", `${ref.id}.png`);
}

function sessionJsonl(session) {
  const file = session.sessionManager.getSessionFile();
  check(file && existsSync(file), "the Pi session did not write a JSONL file");
  return file;
}

/** A screenshot session must stay small: no image bytes, no huge tool details. */
function tinyTranscript(file, label) {
  const raw = readFileSync(file, "utf8");
  const bytes = Buffer.byteLength(raw);
  check(!raw.includes('"type":"image"'), `${label}: an image content block reached the session file`);
  check(!/[A-Za-z0-9+/]{300,}/.test(raw), `${label}: a base64 blob reached the session file`);
  check(bytes < 60_000, `${label}: the session file grew to ${bytes} bytes`);
  const entries = raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    const text = JSON.stringify(entry.message);
    const toolBytes = Buffer.byteLength(text);
    check(toolBytes < 3_000, `${label}: a tool result grew to ${toolBytes} bytes`);
    check(!/"data"\s*:/.test(text), `${label}: a tool result carries image bytes in details`);
  }
  return { bytes, entries };
}

/** Resolve references in a separate Node process, against the shipped sources. */
async function resolveInNewProcess(packageDir, stateDir, refs) {
  const probe = join(ROOT, "tools", "attachment-probe.mjs");
  const result = await run(process.execPath, [probe, "--package", packageDir, "--root", stateDir, "--refs", JSON.stringify(refs)], {
    timeoutMs: 60000,
  });
  checkEq(result.code, 0, `the attachment probe exited ${result.code}\n${result.stdout}\n${result.stderr}`);
  const line = result.stdout.trim().split("\n").pop();
  return JSON.parse(line);
}

async function phase4({ pi, tarball, fixture }) {
  log("\n== Phase 4: attachment library, lookback, preferred directory, saving originals ==");
  const port = 9545;
  const stateDir = freshDir(join(STATE, "state-p4"));
  const env = {
    PI_EGO_HOME: stateDir,
    PI_EGO_DEBUG_PORT: String(port),
    PI_EGO_HEADLESS: "1",
    PI_EGO_RUN_TIMEOUT_MS: "120000",
  };
  const loaded = await loadPackagedExtension({ pi, tarball, instance: "p4", env });
  const entryPath = join(loaded.packageDir, "extensions", "ego-browser.js");
  const homeUrl = `${fixture.origin}/`;
  const secondUrl = `${fixture.origin}/second.html`;
  const thirdUrl = `${fixture.origin}/third.html`;
  const formUrl = `${fixture.origin}/form.html`;
  const context = {};
  let sessionA = null;
  let sessionB = null;
  const { ai } = await loadPiHost();

  try {
    await step("4.1 a Pi session with real PNGs keeps them out of the transcript and shows them to a vision model", async () => {
      const received = [];
      sessionA = await createFauxSession({ workDir: join(WORK, "p4-pi-a"), extensionPaths: [entryPath], env });
      sessionA.faux.setResponses([
        scriptedStep(ai, received, { toolCalls: [{ name: "browser_open", arguments: { url: homeUrl } }] }),
        scriptedStep(ai, received, { toolCalls: [{ name: "browser_screenshot", arguments: {} }] }),
        scriptedStep(ai, received, { text: "I can see the fixture page." }),
      ]);
      await sessionA.session.prompt("open the fixture page and take a screenshot");
      checkEq(received.length, 3, "expected three model requests in the first turn");
      checkEq(received[0].images.length, 0, "the first request has no picture yet");
      checkEq(received[1].images.length, 0, "nothing is captured at the second request");
      checkEq(received[2].images.length, 1, "the request after the capture must carry the picture");
      checkEq(received[2].images[0].mimeType, "image/png", "the injected image is a PNG");
      checkEq(received[2].images[0].role, "toolResult", "a browser observation belongs to its tool result");

      sessionA.faux.setResponses([
        scriptedStep(ai, received, { toolCalls: [{ name: "browser_open", arguments: { url: secondUrl } }] }),
        scriptedStep(ai, received, { toolCalls: [{ name: "browser_screenshot", arguments: {} }] }),
        scriptedStep(ai, received, { text: "Second page captured." }),
      ]);
      await sessionA.session.prompt("now the second page");
      checkEq(received[3].images.length, 0, "a new user turn starts without the old picture");
      checkEq(received[4].images.length, 0);
      checkEq(received[5].images.length, 1, "this turn's own capture rides along");

      const sessionKey = sessionA.sessionManager.getSessionId();
      const record = sessionRecord(stateDir, sessionKey);
      checkEq(record.attachments.length, 2, "two captures, two references");
      check(record.attachments[0].id !== record.attachments[1].id, "different pages must produce different IDs");
      for (const ref of record.attachments) {
        const file = attachmentFile(stateDir, ref);
        check(existsSync(file), `attachment file missing: ${file}`);
        checkEq(sha256(file), ref.id, "the attachment ID is not the SHA-256 of its bytes");
        checkEq(readFileSync(file).subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "not a PNG");
      }
      const transcript = tinyTranscript(sessionJsonl(sessionA), "a vision session");
      context.sessionKey = sessionKey;
      context.attachments = record.attachments;
      return { transcriptBytes: transcript.bytes, attachments: record.attachments.map((entry) => entry.id.slice(0, 12)) };
    });

    await step("4.2 the same picture is stored once", async () => {
      const received = [];
      sessionA.faux.setResponses([
        scriptedStep(ai, received, { toolCalls: [{ name: "browser_open", arguments: { url: homeUrl } }] }),
        scriptedStep(ai, received, { toolCalls: [{ name: "browser_screenshot", arguments: {} }] }),
        scriptedStep(ai, received, { text: "Back on the first page." }),
      ]);
      await sessionA.session.prompt("go back to the first page and capture it again");
      const record = sessionRecord(stateDir, context.sessionKey);
      checkEq(record.latestAttachment.id, context.attachments[1].id, "the same page must keep the same attachment ID");
      const objects = readdirSync(join(stateDir, "attachments", "v1", "objects"));
      checkEq(objects.length, 2, `dedupe failed: ${objects.length} objects for two distinct pictures`);
      tinyTranscript(sessionJsonl(sessionA), "after a duplicate capture");
      return { id: record.latestAttachment.id.slice(0, 12), objects: objects.length };
    });

    await step("4.3 lookback works only for a legal ID of this session", async () => {
      const received = [];
      const homeId = context.attachments[1].id;
      sessionA.faux.setResponses([
        scriptedStep(ai, received, { toolCalls: [{ name: "browser_show_screenshot", arguments: { id: homeId } }] }),
        scriptedStep(ai, received, { text: "That is the first page again." }),
      ]);
      await sessionA.session.prompt(`show me the first screenshot again (${homeId})`);
      checkEq(received.length, 2);
      checkEq(received[0].images.length, 0, "asking for a lookback attaches nothing by itself");
      checkEq(received[1].images.length, 1, "the tool's legal ID brings the picture into the request");
      checkEq(received[1].images[0].role, "toolResult", "the reviewed screenshot belongs to its tool result");

      sessionA.faux.setResponses([scriptedStep(ai, received, { text: "Nothing to add." })]);
      await sessionA.session.prompt("an ordinary question");
      checkEq(received[2].images.length, 0, "a plain turn must not carry the looked-back picture");

      sessionA.faux.setResponses([
        scriptedStep(ai, received, { toolCalls: [{ name: "browser_show_screenshot", arguments: { id: "f".repeat(64) } }] }),
        scriptedStep(ai, received, { text: "Unknown ID." }),
      ]);
      await sessionA.session.prompt("look at a made-up ID");
      checkEq(received[4].images.length, 0, "a foreign ID must not attach anything");
      const entries = tinyTranscript(sessionJsonl(sessionA), "after a lookback").entries;
      const results = entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
      const refused = results[results.length - 1];
      checkEq(refused.message.isError, true, "an unknown ID must be reported as an error");
      check(/本会话里没有附件/.test(refused.message.content[0].text), `unexpected refusal text: ${refused.message.content[0].text}`);
      return { lookbackImages: 1, refusal: "ATTACHMENT_NOT_IN_SESSION" };
    });

    await step("4.4 a second session keeps its own references and a new process resolves both", async () => {
      const received = [];
      sessionB = await createFauxSession({ workDir: join(WORK, "p4-pi-b"), extensionPaths: [entryPath], env });
      sessionB.faux.setResponses([
        scriptedStep(ai, received, { toolCalls: [{ name: "browser_open", arguments: { url: formUrl } }] }),
        scriptedStep(ai, received, { toolCalls: [{ name: "browser_screenshot", arguments: {} }] }),
        scriptedStep(ai, received, { text: "Form page captured." }),
      ]);
      await sessionB.session.prompt("open the form and capture it");
      checkEq(received[2].images.length, 1, "the second session sees its own capture");
      const recordB = sessionRecord(stateDir, sessionB.sessionManager.getSessionId());
      check(recordB?.latestAttachment?.id, "the second session has no attachment");
      const recordA = sessionRecord(stateDir, context.sessionKey);
      tinyTranscript(sessionJsonl(sessionB), "the second session");

      const probe = await resolveInNewProcess(loaded.packageDir, stateDir, [recordA.attachments[0], recordB.latestAttachment]);
      checkEq(probe.results.length, 2);
      for (const entry of probe.results) {
        checkEq(entry.ok, true, `a new process could not resolve ${entry.id}: ${entry.code}`);
        checkEq(sha256(entry.path), entry.id, "the new process resolved a file with the wrong digest");
      }
      check(probe.pid !== process.pid, "the probe must be a separate process");
      context.sessionB = sessionB.sessionManager.getSessionId();
      return { pid: probe.pid, ids: probe.results.map((entry) => entry.id.slice(0, 12)) };
    });

    await step("4.5 /ego-settings attachments set keeps spaces, persists, falls back and recovers", async () => {
      const preferred = join(STATE, "p4 首选 目录", "ego shots");
      const set = await invokeCommand(loaded.api, "ego-settings", `attachments set "${preferred}"`, context.sessionKey);
      check(/首选附件目录已设置/.test(set.text), `set failed: ${set.text}`);
      const configFile = join(stateDir, "attachments-config.json");
      checkEq(JSON.parse(readFileSync(configFile, "utf8")).preferred, preferred, "the preferred directory was not persisted");

      const received = [];
      sessionA.faux.setResponses([
        scriptedStep(ai, received, { toolCalls: [{ name: "browser_open", arguments: { url: thirdUrl } }] }),
        scriptedStep(ai, received, { toolCalls: [{ name: "browser_screenshot", arguments: {} }] }),
        scriptedStep(ai, received, { text: "Third page captured." }),
      ]);
      await sessionA.session.prompt("capture the third page");
      const preferredRef = sessionRecord(stateDir, context.sessionKey).latestAttachment;
      const preferredFile = attachmentFile(stateDir, preferredRef);
      check(preferredFile.startsWith(preferred), `the capture did not use the preferred directory: ${preferredFile}`);
      checkEq(sha256(preferredFile), preferredRef.id, "the preferred copy is not the capture");

      // A fresh extension instance reads the same choice, like a Pi restart.
      const reopened = await loadPackagedExtension({ pi, tarball, instance: "p4b", env });
      const listed = await invokeCommand(reopened.api, "ego-settings", "attachments", context.sessionKey);
      check(listed.text.includes(preferred), `the reopened instance forgot the preferred directory:\n${listed.text}`);

      const relativePath = relative(realpathSync(STATE), realpathSync(preferred));
      check(relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath), "test library is outside the isolated state directory");
      const offline = `${preferred}.offline`;
      check(!existsSync(offline), "the offline simulation path is already occupied");
      renameSync(preferred, offline);
      let fallbackRef;
      try {
        const broken = await invokeCommand(reopened.api, "ego-settings", "attachments", context.sessionKey);
        check(/首选目录不可写|首选目录[^\n]*(?:离线|不可用|不存在)/.test(broken.text), `the list should report the broken preferred directory:\n${broken.text}`);
        check(!existsSync(preferred), "checking status should not recreate an offline/missing directory");
        sessionA.faux.setResponses([
          scriptedStep(ai, received, { toolCalls: [{ name: "browser_screenshot", arguments: { fullPage: true } }] }),
          scriptedStep(ai, received, { text: "Captured after the directory went offline." }),
        ]);
        await sessionA.session.prompt("capture the same page with a full-page shot");
        fallbackRef = sessionRecord(stateDir, context.sessionKey).latestAttachment;
        const fallbackFile = attachmentFile(stateDir, fallbackRef);
        check(fallbackFile.startsWith(join(stateDir, "attachments")), `the fallback capture left the default library: ${fallbackFile}`);
        checkEq(sha256(fallbackFile), fallbackRef.id, "the fallback copy is not the capture");
        check(fallbackRef.fallback?.reason, "the reference should record why it fell back");
        checkEq(JSON.parse(readFileSync(configFile, "utf8")).preferred, preferred, "the choice must survive a fallback");

        const probe = await resolveInNewProcess(loaded.packageDir, stateDir, [preferredRef, fallbackRef]);
        checkEq(probe.results[0].ok, false, "the offline original cannot be opened until its directory comes back");
        checkEq(probe.results[1].ok, true, `fallback picture is unreadable: ${probe.results[1].code}`);
      } finally {
        if (!existsSync(preferred)) renameSync(offline, preferred);
      }

      // Restore the original files before checking historical references.
      const probe = await resolveInNewProcess(loaded.packageDir, stateDir, [preferredRef, fallbackRef]);
      for (const entry of probe.results) checkEq(entry.ok, true, `a picture became unreadable: ${entry.code}`);
      sessionA.faux.setResponses([
        scriptedStep(ai, received, { toolCalls: [{ name: "browser_screenshot", arguments: { fullPage: false } }] }),
        scriptedStep(ai, received, { text: "Captured again." }),
      ]);
      await sessionA.session.prompt("capture it once more");
      const recoveredRef = sessionRecord(stateDir, context.sessionKey).latestAttachment;
      check(
        attachmentFile(stateDir, recoveredRef).startsWith(preferred),
        "the preferred directory was not used again after it recovered",
      );

      const reset = await invokeCommand(reopened.api, "ego-settings", "attachments reset", context.sessionKey);
      check(/默认库/.test(reset.text), `reset failed: ${reset.text}`);
      checkEq(JSON.parse(readFileSync(configFile, "utf8")).preferred, null, "reset did not clear the choice");
      return { preferred, fallback: fallbackRef.id.slice(0, 12) };
    });

    await step("4.6 an unwritable default library fails the capture cleanly", async () => {
      const brokenRoot = freshDir(join(STATE, "state-p4-unwritable"));
      writeFileSync(join(brokenRoot, "attachments"), "not a directory");
      const { BrowserService } = await import(pathToFileURL(join(loaded.packageDir, "src", "tools.js")).href);
      const { resolvePaths } = await import(pathToFileURL(join(loaded.packageDir, "src", "paths.js")).href);
      const serviceEnv = { PI_EGO_HOME: brokenRoot };
      const service = new BrowserService({ env: serviceEnv, paths: resolvePaths(serviceEnv) });
      const outcome = await service.screenshot({ sessionKey: "p4-unwritable" });
      checkEq(outcome.ok, false, "a capture with an unwritable library must fail");
      checkEq(outcome.code, "ATTACHMENT_UNWRITABLE", `unexpected failure code: ${outcome.code}`);
      check(/attachments/.test(outcome.message), `the message should name the library: ${outcome.message}`);
      checkEq(sessionRecord(brokenRoot, "p4-unwritable"), null, "a failed capture must not record a reference");
      check(!existsSync(join(brokenRoot, "attachments-roots.json")), "a failed capture must not register a root");
      writeFileSync(join(STATE, "p4-unwritable.log"), `${outcome.message}\n`);
      return { code: outcome.code, message: outcome.message.split("\n")[0] };
    });

    await step("4.7 saving returns the one library original and old exported files are untouched", async () => {
      const legacyDir = join(stateDir, "screenshots", "legacy-0.1.1-session");
      mkdirSync(legacyDir, { recursive: true });
      const legacyFile = join(legacyDir, "shot-2026-01-01T00-00-00-000Z-11111111-2222-3333-4444-555555555555.png");
      writeFileSync(legacyFile, Buffer.from("legacy screenshot bytes"));
      const cacheDir = join(stateDir, "screenshot-cache", "legacy-0.1.1-session");
      mkdirSync(cacheDir, { recursive: true });
      const cacheFile = join(cacheDir, "shot-2025-12-01T00-00-00-000Z-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png");
      writeFileSync(cacheFile, Buffer.from("legacy cached preview"));
      const before = {
        legacy: { bytes: readFileSync(legacyFile), mtime: statSync(legacyFile).mtimeMs },
        cache: { bytes: readFileSync(cacheFile), mtime: statSync(cacheFile).mtimeMs },
        objects: readdirSync(join(stateDir, "attachments", "v1", "objects")).length,
        saved: readdirSync(join(stateDir, "screenshots")).length,
      };

      const record = sessionRecord(stateDir, context.sessionKey);
      const latest = record.latestAttachment;
      const libraryFile = attachmentFile(stateDir, latest);
      const libraryBytes = readFileSync(libraryFile);

      // A normal save is the library original: no copy, no new export file.
      const saved = expectOk(await invoke(loaded.api, "browser_save_screenshot", {}, context.sessionKey), "save this");
      checkEq(saved.details.path, libraryFile, "a normal save must return the library original");
      checkEq(saved.details.savedOriginal, true, "a normal save must report the original, not a copy");
      checkEq(readdirSync(join(stateDir, "screenshots")).length, before.saved, "a normal save wrote a new export file");
      checkEq(readdirSync(join(stateDir, "attachments", "v1", "objects")).length, before.objects, "a normal save added a library object");

      // The only copy is the destination the user named.
      const targetDir = join(STATE, "p4 另存 目录");
      mkdirSync(targetDir, { recursive: true });
      const target = join(targetDir, "页面.png");
      const copied = expectOk(await invoke(loaded.api, "browser_save_screenshot", { path: target }, context.sessionKey), "copy to a named path");
      checkEq(copied.details.path, target, "the explicit copy went somewhere else");
      check(readFileSync(target).equals(libraryBytes), "the explicit copy does not match the picture");
      check(readFileSync(libraryFile).equals(libraryBytes), "the library original changed");

      // A 0.1.1 preview recorded by a session is published into the library in
      // effect now, and the old cache file is neither moved nor rewritten.
      const legacyKey = "legacy-cache-session";
      const { sessionShotDir } = await import(pathToFileURL(join(loaded.packageDir, "src", "paths.js")).href);
      const legacyCacheDir = sessionShotDir(join(stateDir, "screenshot-cache"), legacyKey);
      mkdirSync(legacyCacheDir, { recursive: true });
      const legacyCacheName = "shot-2025-12-01T00-00-00-000Z-11111111-2222-3333-4444-555555555555.png";
      const legacyCacheFile = join(legacyCacheDir, legacyCacheName);
      writeFileSync(legacyCacheFile, libraryBytes);
      const legacyCacheStat = statSync(legacyCacheFile);
      const sessionsFile = join(stateDir, "sessions.json");
      const sessions = JSON.parse(readFileSync(sessionsFile, "utf8"));
      sessions.sessions[legacyKey] = { ...(sessions.sessions[legacyKey] || {}), previewScreenshot: legacyCacheName };
      writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2));
      const legacySaved = expectOk(await invoke(loaded.api, "browser_save_screenshot", {}, legacyKey), "0.1.1 preview save");
      checkEq(legacySaved.details.legacy, true, "the 0.1.1 path should say where it came from");
      check(
        legacySaved.details.path.startsWith(join(stateDir, "attachments", "v1", "objects")),
        `the 0.1.1 preview did not land in the library: ${legacySaved.details.path}`,
      );
      check(readFileSync(legacySaved.details.path).equals(libraryBytes), "the 0.1.1 preview was not published as the same bytes");
      check(readFileSync(legacyCacheFile).equals(libraryBytes), "a 0.1.1 cached preview was modified");
      checkEq(statSync(legacyCacheFile).mtimeMs, legacyCacheStat.mtimeMs, "a 0.1.1 cached preview was touched");

      check(readFileSync(legacyFile).equals(before.legacy.bytes), "an older saved screenshot was modified");
      checkEq(statSync(legacyFile).mtimeMs, before.legacy.mtime, "an older saved screenshot was touched");
      check(readFileSync(cacheFile).equals(before.cache.bytes), "a 0.1.1 cached preview was modified");
      checkEq(statSync(cacheFile).mtimeMs, before.cache.mtime, "a 0.1.1 cached preview was touched");
      return { original: libraryFile, copy: target, bytes: libraryBytes.length };
    });
  } finally {
    sessionA?.dispose();
    sessionB?.dispose();
    await closeBrowser(port, stateDir, join(WORK, "p4-browser.json"));
    loaded.restore();
  }
}

/** A previously downloaded copy of the pinned archive, used to seed a resume test. */
function findLocalArchive(lock) {
  const candidates = [join(ROOT, ".cache", `chrome-win64-${lock.version}.zip`)];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (statSync(candidate).size !== lock.size) continue;
    if (sha256(candidate) !== lock.sha256) continue;
    return candidate;
  }
  return null;
}

/** Download the pinned archive once into `.cache` so the resume test has real bytes. */
async function ensureLocalArchive(lock) {
  const existing = findLocalArchive(lock);
  if (existing) return existing;
  const dir = join(ROOT, ".cache");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `chrome-win64-${lock.version}.zip`);
  log(`  downloading the pinned archive once for the resume test: ${lock.url}`);
  const response = await fetch(lock.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  const chunks = [];
  for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  writeFileSync(target, bytes);
  if (sha256(target) !== lock.sha256) {
    rmSync(target, { force: true });
    throw new Error("the downloaded archive does not match the pinned SHA-256");
  }
  return target;
}

// ---------------------------------------------------------------- main

async function main() {
  mkdirSync(WORK, { recursive: true });
  const tarball = newestTarball(ROOT);
  if (!tarball) throw new Error("no tarball in dist/; run: npm pack --ignore-scripts --pack-destination dist");
  const pi = resolvePiPackage();
  const fixture = await startFixtureServer();
  log(`pi-ego-browser acceptance`);
  log(`  tarball:  ${tarball} (${(statSync(tarball).size / 1024).toFixed(0)} KiB, sha256 ${sha256(tarball).slice(0, 16)}…)`);
  log(`  Pi CLI:   ${pi.cli}`);
  log(`  fixture:  ${fixture.origin}`);
  log(`  work dir: ${WORK}`);
  log(`  browser state dir: ${STATE}`);

  const phases = { 1: phase1, 2: phase2, 3: phase3, 4: phase4 };
  try {
    for (const [id, phase] of Object.entries(phases)) {
      if (onlyPhase && Number(id) !== onlyPhase) continue;
      try {
        await phase({ pi, tarball, fixture });
      } catch (error) {
        results.push({ name: `phase ${id} aborted`, ok: false, error: String(error?.stack || error) });
        log(`  FAIL phase ${id} aborted: ${String(error?.message || error)}`);
      }
    }
  } finally {
    await fixture.close();
  }

  const failed = results.filter((entry) => !entry.ok);
  const summary = {
    ranAt: timestamp(),
    tarball,
    tarballSha256: sha256(tarball),
    browserStateRoot: STATE,
    quick,
    onlyPhase,
    steps: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  };
  writeFileSync(join(WORK, "summary.json"), JSON.stringify(summary, null, 2));
  log(`\nsteps: ${summary.passed}/${summary.steps} passed`);
  if (failed.length) {
    log("failed steps:");
    for (const entry of failed) log(`  - ${entry.name}: ${String(entry.error).split("\n")[0]}`);
  }
  log(`summary: ${join(WORK, "summary.json")}`);
  process.exit(failed.length ? 1 : 0);
}

await main();
