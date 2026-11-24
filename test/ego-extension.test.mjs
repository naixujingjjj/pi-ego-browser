// Loads the real extension entry through the same host-package mapping Pi uses,
// then drives its tools and the one `/ego-settings` command with a fake
// ExtensionAPI. No browser and no model are involved: this is the wiring layer
// above the unit-tested library.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AttachmentLibrary, shortId } from "../src/attachments.js";
import { resolvePaths } from "../src/paths.js";
import { SessionStore } from "../src/session.js";
import { readJsonSync } from "../src/store.js";
import { BrowserService } from "../src/tools.js";
import { createFakePi, freshDir, provideHostPackages, resolvePiPackage, stageSourcePackage } from "../tools/harness.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001",
  "hex",
);

const theme = { fg: (_token, text) => text, bold: (text) => text };

let stagedEntry = null;
function stagedExtension() {
  if (stagedEntry) return stagedEntry;
  const dir = freshDir(join(ROOT, ".tmp", "unit-extension-package"));
  stageSourcePackage(dir);
  provideHostPackages(dir, resolvePiPackage().packageRoot);
  stagedEntry = join(dir, "extensions", "ego-browser.js");
  return stagedEntry;
}

let counter = 0;
async function loadExtension({ stateRoot, env = {} }) {
  const entry = stagedExtension();
  const environment = {
    PI_EGO_HOME: stateRoot,
    // Deliberately missing: every browser tool stops at browser detection, so
    // no runtime is spawned and the attachment half is what gets exercised.
    PI_EGO_BROWSER_PATH: join(stateRoot, "no-such-browser.exe"),
    PI_EGO_DEBUG_PORT: "9597",
    PI_EGO_HEADLESS: "1",
    PI_EGO_RUN_TIMEOUT_MS: "5000",
    ...env,
  };
  const previous = {};
  for (const [key, value] of Object.entries(environment)) {
    previous[key] = process.env[key];
    process.env[key] = String(value);
  }
  const api = createFakePi();
  const module = await import(`${pathToFileURL(entry).href}?unit=${(counter += 1)}`);
  await module.default(api);
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  return { api, stateRoot, environment, restore };
}

function toolContext(cwd, sessionKey) {
  return {
    sessionManager: { getSessionId: () => sessionKey, getEntries: () => [], getCwd: () => cwd },
    ui: { notify() {}, setStatus() {}, setWidget() {} },
    cwd,
  };
}

async function callTool(api, name, params, ctx) {
  const definition = api.tools.get(name);
  assert.ok(definition, `tool ${name} is not registered`);
  const outcome = await definition.execute(`unit-${name}`, params, undefined, undefined, ctx);
  const parts = outcome.content || [];
  return { ...outcome, parts, text: parts.filter((part) => part.type === "text").map((part) => part.text).join("\n") };
}

async function runSettings(api, args, ctx) {
  const command = api.commands.get("ego-settings");
  assert.ok(command, "/ego-settings is not registered");
  const text = await command.handler(args, ctx);
  return { text: String(text ?? "") };
}

/** Publish one PNG as if browser_screenshot had captured it. */
function publishShot(stateRoot, sessionKey, bytes = PNG) {
  const paths = resolvePaths({ PI_EGO_HOME: stateRoot });
  const service = new BrowserService({ env: { PI_EGO_HOME: stateRoot }, paths });
  const library = new AttachmentLibrary(paths);
  const staged = library.prepareCapture();
  writeFileSync(staged.stagingFile, bytes);
  const ingested = service.ingestCapture({
    sessionKey,
    staged,
    pageLabel: "p1",
    url: "http://fixture/",
    title: "Fixture Home",
  });
  assert.equal(ingested.ok, true, JSON.stringify(ingested));
  return { paths, service, library, ref: ingested.ref, path: ingested.path };
}

test("the extension registers every browser tool and only the /ego-settings command", async () => {
  const stateRoot = freshDir(join(ROOT, ".tmp", "unit-extension-state", "tools"));
  const { api, restore } = await loadExtension({ stateRoot });
  try {
    const names = [...api.tools.keys()].sort();
    assert.deepEqual(names, [
      "browser_click",
      "browser_fill",
      "browser_handoff",
      "browser_open",
      "browser_read",
      "browser_save_screenshot",
      "browser_screenshot",
      "browser_show_screenshot",
      "browser_tabs",
    ]);
    assert.deepEqual([...api.commands.keys()], ["ego-settings"], "exactly one slash command is registered");
    assert.equal(api.commands.has("ego"), false, "the removed /ego command must not come back, not even as an alias");
    assert.equal((api.handlers.get("context") || []).length, 1, "the attachment context hook is registered");
    for (const name of ["browser_screenshot", "browser_show_screenshot", "browser_save_screenshot"]) {
      assert.equal(typeof api.tools.get(name).renderResult, "function", `${name} needs an image-aware row renderer`);
    }
  } finally {
    restore();
  }
});

test("a screenshot tool result holds text and small metadata, never image bytes", async () => {
  const stateRoot = freshDir(join(ROOT, ".tmp", "unit-extension-state", "shot-failure"));
  const { api, restore } = await loadExtension({ stateRoot });
  try {
    const ctx = toolContext(stateRoot, "unit-shot");
    const outcome = await callTool(api, "browser_screenshot", {}, ctx);
    assert.equal(outcome.isError, true, "without a browser the capture fails");
    assert.equal(outcome.parts.every((part) => part.type === "text"), true, "no image content block in the result");
    assert.equal(outcome.details.attachment ?? null, null);
    const paths = resolvePaths({ PI_EGO_HOME: stateRoot });
    assert.deepEqual(readdirSync(join(paths.attachmentsDir, "v1", "staging")), [], "a failed capture leaves no staging file");
    const objectsDir = join(paths.attachmentsDir, "v1", "objects");
    assert.deepEqual(existsSync(objectsDir) ? readdirSync(objectsDir) : [], [], "nothing was published");
    assert.equal(JSON.stringify(outcome.details).length < 2000, true);
  } finally {
    restore();
  }
});

test("/ego-settings attachments reports the preferred, default and registered directories", async () => {
  const stateRoot = freshDir(join(ROOT, ".tmp", "unit-extension-state", "list"));
  const { api, restore } = await loadExtension({ stateRoot });
  try {
    const ctx = toolContext(stateRoot, "unit-list");
    const listed = await runSettings(api, "attachments", ctx);
    assert.match(listed.text, /首选目录：/);
    assert.match(listed.text, /默认目录：/);
    assert.match(listed.text, /本会话截图：0 张/);
    assert.equal(listed.text.includes("/ego "), false, "the listing must not point at the removed command");
    assert.equal(listed.text.includes("/ego-settings"), true);

    const published = publishShot(stateRoot, "unit-list");
    const withShot = await runSettings(api, "attachments", ctx);
    assert.match(withShot.text, new RegExp(shortId(published.ref.id)));
    assert.match(withShot.text, /文件：/);

    const help = await runSettings(api, "attachments help", ctx);
    assert.match(help.text, /attachments set/);
    assert.match(help.text, /attachments reset/);
    assert.match(help.text, /attachments open/);
  } finally {
    restore();
  }
});

test("/ego-settings attachments set keeps spaces, survives a restart, and resets", async () => {
  const stateRoot = freshDir(join(ROOT, ".tmp", "unit-extension-state", "set"));
  const first = await loadExtension({ stateRoot });
  const preferred = join(stateRoot, "截图 与 素材", "ego shots");
  try {
    const ctx = toolContext(stateRoot, "unit-set");
    const quoted = await runSettings(api(first), `attachments set "${preferred}"`, ctx);
    assert.match(quoted.text, /首选附件目录已设置/);
    const paths = resolvePaths({ PI_EGO_HOME: stateRoot });
    assert.equal(readJsonSync(paths.attachmentsConfigFile).preferred, preferred);

    const relative = await runSettings(api(first), "attachments set relative/dir", ctx);
    assert.match(relative.text, /绝对路径/);
    assert.equal(readJsonSync(paths.attachmentsConfigFile).preferred, preferred, "a failed set keeps the old choice");
  } finally {
    first.restore();
  }

  // A new process reads the choice from disk.
  const second = await loadExtension({ stateRoot });
  try {
    const ctx = toolContext(stateRoot, "unit-set-2");
    const listed = await runSettings(api(second), "attachments", ctx);
    assert.match(listed.text, new RegExp(preferred.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));

    const unquoted = join(stateRoot, "another 目录", "shots");
    const set = await runSettings(api(second), `attachments set ${unquoted}`, ctx);
    assert.match(set.text, /首选附件目录已设置/);
    assert.equal(readJsonSync(resolvePaths({ PI_EGO_HOME: stateRoot }).attachmentsConfigFile).preferred, unquoted);

    const reset = await runSettings(api(second), "attachments reset", ctx);
    assert.match(reset.text, /默认库/);
    assert.equal(readJsonSync(resolvePaths({ PI_EGO_HOME: stateRoot }).attachmentsConfigFile).preferred, null);

    const unknown = await runSettings(api(second), "attachments nope", ctx);
    assert.match(unknown.text, /不认识的子命令/);
  } finally {
    second.restore();
  }
  counter += 0;
});

test("/ego-settings info shows exactly what /ego-settings status prints and Esc goes back to the list", async () => {
  const stateRoot = freshDir(join(ROOT, ".tmp", "unit-attachment-settings", "info"));
  const { api, restore } = await loadExtension({ stateRoot });
  try {
    const hostTui = join(resolvePiPackage().packageRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js");
    const { getKeybindings } = await import(pathToFileURL(hostTui).href);
    const ctx = toolContext(stateRoot, "settings-info");
    ctx.mode = "tui";
    const notices = [];
    ctx.ui.notify = (message, level) => notices.push({ message, level });
    // The reference text: what `/ego-settings status` prints outside the menu.
    ctx.mode = "rpc";
    const status = await runSettings(api, "status", ctx);
    assert.match(status.text, /^浏览器：/);
    assert.match(status.text, /状态目录：/);
    ctx.mode = "tui";
    notices.length = 0; // the status action notifies; the settings menu must not.

    const views = [];
    let screens = 1;
    ctx.ui.custom = async (factory) => {
      screens -= 1;
      assert.equal(screens, 0, "the settings screen opens exactly once");
      const screen = {};
      const component = factory({ requestRender() {} }, theme, getKeybindings(), (value) => {
        screen.action = value;
      });
      views.push(component.render(300).join("\n"));
      component.handleInput("\r"); // Enter on the item called info
      views.push(component.render(300).join("\n"));
      component.handleInput("\x1b[A");
      assert.match(component.render(300).join("\n"), /info · 浏览器状态/);
      component.handleInput("\x1b[27u"); // Extended Escape used by terminals with the Kitty protocol.
      views.push(component.render(300).join("\n"));
      assert.match(views[2], /截图附件目录/);
      component.handleInput("\r");
      component.handleInput("\x1b"); // Legacy Escape also closes the info panel.
      assert.match(component.render(300).join("\n"), /截图附件目录/);
      component.handleInput("\x1b[27;1u"); // Escape in the list leaves the settings.
      assert.ok(Object.hasOwn(screen, "action"), "the settings command was closed");
      return screen.action;
    };
    const command = api.commands.get("ego-settings");
    assert.ok(command);
    assert.equal(await command.handler("", ctx), undefined);

    // The settings list itself: the item is called info and carries the status line.
    assert.match(views[0], /Ego 浏览器设置/);
    assert.match(views[0], /\binfo\b/);
    assert.match(views[0], /截图附件目录/);
    assert.match(views[0], /未运行/);
    assert.equal(views[0].includes("恢复默认目录"), false, "no reset row without a preferred directory");

    // Opening info shows the same lines /ego printed, not a summary of them.
    assert.match(views[1], /info · 浏览器状态/);
    for (const line of status.text.split("\n")) {
      assert.ok(views[1].includes(line), `the info panel repeats the /ego line "${line}"`);
    }
    assert.match(views[1], /Esc 返回/);

    // Esc inside the panel goes back to the list instead of closing the settings.
    assert.match(views[2], /Ego 浏览器设置/);
    assert.match(views[2], /截图附件目录/);
    assert.equal(screens, 0, "only one screen was opened");
    assert.equal(readJsonSync(resolvePaths({ PI_EGO_HOME: stateRoot }).attachmentsConfigFile, null), null, "info changed no setting");
    assert.deepEqual(notices, [], "looking at the status changes nothing and notifies nothing");

    ctx.mode = "rpc";
    assert.match(await command.handler("", ctx), /交互终端/);
  } finally {
    restore();
  }
});

test("/ego-settings info and status are the same action, and the TUI never claims there is no terminal", async () => {
  const stateRoot = freshDir(join(ROOT, ".tmp", "unit-attachment-settings", "info-alias"));
  const { api, restore } = await loadExtension({ stateRoot });
  try {
    const ctx = toolContext(stateRoot, "settings-info-alias");
    const notices = [];
    ctx.ui.notify = (message, level) => notices.push({ message, level });

    // Without an interactive terminal the hint is correct: it says where the
    // menu lives and which arguments this host can use instead.
    ctx.mode = "rpc";
    const status = await runSettings(api, "status", ctx);
    assert.match(status.text, /^浏览器：/);
    assert.match(notices[0].message, /交互终端/);
    const info = await runSettings(api, "info", ctx);
    assert.equal(info.text, status.text, "the menu row's name is the same action as status");
    assert.match(notices[1].message, /交互终端/);

    // Inside the TUI the menu is one Enter away, so that hint would be a lie.
    ctx.mode = "tui";
    notices.length = 0;
    const tuiStatus = await runSettings(api, "status", ctx);
    assert.equal(tuiStatus.text, status.text);
    assert.equal(notices.length, 1, "an explicit action notifies once with the status");
    assert.equal(/交互终端/.test(notices[0].message), false, "the TUI has a terminal");
    assert.match(notices[0].message, /^浏览器：/);
    const tuiInfo = await runSettings(api, "info", ctx);
    assert.equal(tuiInfo.text, status.text);
    assert.equal(/交互终端/.test(notices[1].message), false, "info in the TUI has a terminal too");
  } finally {
    restore();
  }
});

test("/ego-settings directory uses Windows' own folder picker; cancel keeps the choice and reset restores the default", async () => {
  const stateRoot = freshDir(join(ROOT, ".tmp", "unit-attachment-settings", "picker"));
  const { api, restore } = await loadExtension({ stateRoot });
  try {
    const paths = resolvePaths({ PI_EGO_HOME: stateRoot });
    const config = paths.attachmentsConfigFile;
    const preferred = join(stateRoot, "截图 与 素材", "ego shots");
    const notices = [];
    const prompts = [];
    const shellCalls = [];
    const initials = [];
    let answer = { cancelled: true };

    const ctx = toolContext(stateRoot, "settings-picker");
    ctx.mode = "tui";
    ctx.ui.notify = (message, level) => notices.push({ message, level });
    ctx.ui.input = async (title, placeholder) => {
      prompts.push({ title, placeholder });
      return undefined;
    };
    // The dialog itself is Windows' own; this stands in for the PowerShell run.
    api.exec = async (command, args = [], options = {}) => {
      shellCalls.push({ command, args, options });
      const dir = dirname(args[args.length - 1]);
      const input = JSON.parse(readFileSync(join(dir, "input.json"), "utf8"));
      initials.push(input.initial);
      if (answer.fail) return { code: 5, stdout: "", stderr: "Access is denied.\r\n", killed: false };
      writeFileSync(join(dir, "result.json"), JSON.stringify(answer), "utf8");
      return { code: 0, stdout: "", stderr: "", killed: false };
    };

    const screens = [
      { answer: { cancelled: false, path: preferred }, keys: ["\x1b[B", "\r"], value: null },
      { answer: { cancelled: true }, keys: ["\x1b[B", "\r"], value: preferred },
      { keys: ["\x1b[B", "\x1b[B", "\r"], value: preferred },
      { answer: { fail: true }, keys: ["\x1b[B", "\r"], value: null },
      { keys: ["\x1b"], value: null },
    ];
    ctx.ui.custom = async (factory) => {
      const screen = screens.shift();
      assert.ok(screen, "unexpected settings screen");
      if (screen.answer) answer = screen.answer;
      const component = factory({ requestRender() {} }, theme, null, (value) => {
        screen.action = value;
      });
      const view = component.render(240).join("\n");
      const stored = readJsonSync(config, null)?.preferred ?? null;
      assert.equal(stored, screen.value, "the stored choice before this screen");
      assert.match(view, /Ego 浏览器设置/);
      assert.match(view, /\binfo\b/);
      if (stored) assert.match(view, /恢复默认目录/);
      for (const key of screen.keys) component.handleInput(key);
      return screen.action;
    };

    const command = api.commands.get("ego-settings");
    await command.handler("", ctx);
    assert.deepEqual(screens, [], "every planned screen was used");

    // 1. Entering the directory row ran the native dialog, then stored its pick
    //    through the existing validation.
    assert.equal(shellCalls.length, 3, "one dialog run per directory attempt");
    assert.equal(shellCalls[0].command, "pwsh.exe", "the shell that hosts the Explorer-style dialog is tried first");
    assert.deepEqual(shellCalls[0].args.slice(0, 6), [
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
    ]);
    assert.equal(shellCalls[0].args.join(" ").includes(preferred), false, "the path is never on the command line");
    assert.ok(shellCalls[0].options.timeout >= 60000, "an open dialog is closed on a timeout");
    assert.equal(notices[0].level, "info");
    assert.match(notices[0].message, /首选附件目录已设置/);

    // 2. Cancel is not a failure: the stored choice stays and the next dialog
    //    starts where the user already is.
    assert.equal(initials[1], preferred);
    assert.equal(notices[1].level, "info");
    assert.match(notices[1].message, /已取消/);

    // 3. Reset keeps working and leaves no preferred directory behind.
    assert.equal(readJsonSync(config).preferred, null);
    assert.match(notices[2].message, /默认库/);

    // 4. A non-zero exit is reported and falls back to the typed path; cancelling
    //    that prompt changes nothing.
    assert.equal(initials[2], "", "no preferred directory means no stale starting directory");
    assert.equal(notices[3].level, "error");
    assert.match(notices[3].message, /退出码 5/);
    assert.equal(notices[4].level, "info");
    assert.match(notices[4].message, /已取消/);
    assert.equal(prompts.length, 1, "the typed-path fallback is offered once");
    assert.match(prompts[0].title, /绝对路径/);
    assert.equal(readJsonSync(config).preferred, null);
    assert.equal(notices.length, 5);
  } finally {
    restore();
  }
});

test("/ego-settings falls back to the typed path when the native dialog is unavailable", async () => {
  const stateRoot = freshDir(join(ROOT, ".tmp", "unit-attachment-settings", "fallback"));
  const { api, restore } = await loadExtension({ stateRoot });
  try {
    const config = resolvePaths({ PI_EGO_HOME: stateRoot }).attachmentsConfigFile;
    const typed = join(stateRoot, "别的 目录", "shots");
    const notices = [];
    const prompts = [];
    const ctx = toolContext(stateRoot, "settings-fallback");
    ctx.mode = "tui";
    ctx.ui.notify = (message, level) => notices.push({ message, level });
    ctx.ui.input = async (title, placeholder) => {
      prompts.push({ title, placeholder });
      return `"${typed}"`;
    };
    // A host that cannot start a process at all.
    delete api.exec;

    const screens = [
      { keys: ["\x1b[B", "\r"] },
      { keys: ["\x1b"] },
    ];
    ctx.ui.custom = async (factory) => {
      const screen = screens.shift();
      assert.ok(screen, "unexpected settings screen");
      const component = factory({ requestRender() {} }, theme, null, (value) => {
        screen.action = value;
      });
      assert.match(component.render(240).join("\n"), /截图附件目录/);
      for (const key of screen.keys) component.handleInput(key);
      return screen.action;
    };

    await api.commands.get("ego-settings").handler("", ctx);
    assert.deepEqual(screens, []);
    assert.equal(notices[0].level, "info");
    assert.match(notices[0].message, /手动输入目录/);
    assert.equal(prompts.length, 1);
    assert.equal(notices[1].level, "info");
    assert.match(notices[1].message, /首选附件目录已设置/);
    assert.equal(readJsonSync(config).preferred, typed, "the typed path with spaces is stored as typed");
  } finally {
    restore();
  }
});

test("/ego-settings attachments open hands the verified file to the OS viewer", async () => {
  const stateRoot = freshDir(join(ROOT, ".tmp", "unit-extension-state", "open"));
  const { api, restore } = await loadExtension({ stateRoot });
  try {
    const ctx = toolContext(stateRoot, "unit-open");
    const published = publishShot(stateRoot, "unit-open");
    const opened = await runSettings(api, `attachments open ${published.ref.id}`, ctx);
    assert.match(opened.text, /已用系统默认程序打开/);
    assert.equal(api.executed.length, 1);
    assert.equal(api.executed[0].command, "explorer.exe");
    assert.equal(api.executed[0].args[0], published.path);

    const unknown = await runSettings(api, `attachments open ${"f".repeat(64)}`, ctx);
    assert.match(unknown.text, /本会话里没有附件/);
    assert.equal(api.executed.length, 1, "an unknown ID must not open anything");

    const outside = await runSettings(api, "attachments open ../../Windows/win.ini", ctx);
    assert.match(outside.text, /本会话里没有附件/);
    assert.equal(api.executed.length, 1);
  } finally {
    restore();
  }
});

test("the context hook attaches this turn's picture for a vision model only", async () => {
  const stateRoot = freshDir(join(ROOT, ".tmp", "unit-extension-state", "context"));
  const { api, restore } = await loadExtension({ stateRoot });
  try {
    const sessionKey = "unit-context";
    const published = publishShot(stateRoot, sessionKey);
    const [hook] = api.handlers.get("context");
    const attachment = {
      schemaVersion: 1,
      id: published.ref.id,
      rootId: published.ref.rootId,
      bytes: published.ref.bytes,
      mime: "image/png",
    };
    // The picture is attached to the screenshot tool result of this turn, exactly
    // the message Pi persisted for that tool call.
    const messages = [
      { role: "user", content: [{ type: "text", text: "what does it look like?" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", name: "browser_screenshot" }], timestamp: 2 },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "browser_screenshot",
        isError: false,
        content: [{ type: "text", text: `附件 ID：${published.ref.id}` }],
        details: { attachment, path: published.path },
        timestamp: 2,
      },
    ];

    const vision = await hook({ messages }, { ...toolContext(stateRoot, sessionKey), model: { input: ["text", "image"] } });
    assert.ok(vision?.messages, "a vision model gets the picture");
    const injected = vision.messages[2];
    assert.equal(injected.role, "toolResult");
    assert.equal(injected.toolName, "browser_screenshot");
    assert.equal(injected.content.length, 2);
    assert.equal(injected.content[1].type, "image");
    assert.equal(Buffer.from(injected.content[1].data, "base64").compare(PNG), 0);
    assert.equal(messages[2].content.length, 1, "the hook does not mutate the transcript it was given");
    assert.equal(vision.messages[0].content.length, 1, "the user message is untouched");
    assert.equal(vision.messages[1], messages[1]);

    const textOnly = await hook({ messages }, { ...toolContext(stateRoot, sessionKey), model: { input: ["text"] } });
    assert.equal(textOnly, undefined, "a text-only model keeps the tool result's text form");

    // The next user turn starts after the capture: nothing older rides along.
    const laterMessages = [
      ...messages,
      { role: "user", content: [{ type: "text", text: "no picture needed" }], timestamp: 3 },
    ];
    const later = await hook({ messages: laterMessages }, { ...toolContext(stateRoot, sessionKey), model: { input: ["text", "image"] } });
    assert.equal(later, undefined);

    // Not a screenshot observation: an attachment-shaped details object without
    // the capture / lookback shape does not smuggle a picture into a request.
    const other = [
      messages[0],
      { ...messages[2], toolName: "browser_read", details: { attachment } },
    ];
    const none = await hook({ messages: other }, { ...toolContext(stateRoot, sessionKey), model: { input: ["text", "image"] } });
    assert.equal(none, undefined);
  } finally {
    restore();
  }
});

test("a screenshot row shows its ID and path, and reads the image only when expanded", async () => {
  const stateRoot = freshDir(join(ROOT, ".tmp", "unit-extension-state", "render"));
  const { api, restore } = await loadExtension({ stateRoot });
  try {
    const sessionKey = "unit-render";
    const published = publishShot(stateRoot, sessionKey);
    const definition = api.tools.get("browser_screenshot");
    const result = {
      content: [{ type: "text", text: "截图已保存在附件库（原件就在下面这个文件里，不需要再另存一份）。" }],
      details: {
        attachment: {
          schemaVersion: 1,
          id: published.ref.id,
          rootId: published.ref.rootId,
          bytes: published.ref.bytes,
          mime: "image/png",
          pageLabel: "p1",
          url: "http://fixture/",
          title: "Fixture Home",
          at: published.ref.at,
        },
        path: published.path,
        saved: true,
      },
    };
    const collapsed = definition.renderResult(result, { expanded: false, isPartial: false }, theme, { showImages: true });
    const collapsedText = collapsed.render(240).join("\n");
    assert.ok(collapsedText.includes(shortId(published.ref.id)));
    assert.ok(collapsedText.split("\n").some((line) => line.includes("文件：")), `no file line in:\n${collapsedText}`);
    assert.ok(collapsedText.includes(`${published.ref.id}.png`), `no file name in:\n${collapsedText}`);
    assert.ok(collapsedText.includes("展开"));
    assert.equal(collapsedText.includes("[Image:"), false);

    const expanded = definition.renderResult(result, { expanded: true, isPartial: false }, theme, { showImages: true });
    const expandedText = expanded.render(240).join("\n");
    assert.ok(/\[Image:.*objects/.test(expandedText), `no image fallback in:\n${expandedText}`);
    assert.ok(expandedText.includes("截图已保存在附件库"));

    const hidden = definition.renderResult(result, { expanded: true, isPartial: false }, theme, { showImages: false });
    assert.equal(hidden.render(240).join("\n").includes("[Image:"), false);
  } finally {
    restore();
  }
});

test("browser_save_screenshot returns the saved original and copies only to a named path", async () => {
  const stateRoot = freshDir(join(ROOT, ".tmp", "unit-extension-state", "save"));
  const { api, restore } = await loadExtension({ stateRoot });
  try {
    const sessionKey = "unit-save";
    const ctx = toolContext(stateRoot, sessionKey);
    const published = publishShot(stateRoot, sessionKey);

    const definition = api.tools.get("browser_save_screenshot");
    const guidance = `${definition.description}\n${(definition.promptGuidelines || []).join("\n")}`;
    assert.match(guidance, /already/i, "the tool says a capture is already saved");
    assert.equal(/capture.*then browser_save_screenshot/i.test(guidance), false, "it no longer asks for a copy after a capture");

    // No destination: the library original, never a copy.
    const saved = await callTool(api, "browser_save_screenshot", {}, ctx);
    assert.equal(saved.isError, undefined);
    assert.equal(saved.details.path, published.path);
    assert.equal(saved.details.savedOriginal, true);
    assert.match(saved.text, /原件已经在附件库/);
    assert.equal(existsSync(join(stateRoot, "screenshots")), false, "a normal save creates no export directory");
    assert.deepEqual(readFileSync(published.path), PNG);

    // A destination the user names is the only thing copied.
    const targetDir = join(stateRoot, "用户 另存", "pictures");
    mkdirSync(targetDir, { recursive: true });
    const target = join(targetDir, "页面.png");
    const copied = await callTool(api, "browser_save_screenshot", { path: target }, ctx);
    assert.equal(copied.isError, undefined, copied.text);
    assert.equal(copied.details.path, target);
    assert.equal(copied.details.copied, true);
    assert.deepEqual(readFileSync(target), PNG);

    // The same destination again is recognised, not rewritten.
    const reused = await callTool(api, "browser_save_screenshot", { path: target }, ctx);
    assert.equal(reused.isError, undefined);
    assert.equal(reused.details.reused, true);
    assert.equal(readdirSync(targetDir).length, 1, "no temporary or duplicate file is left behind");

    // An invalid destination is a structured tool error, not a fallback.
    const invalid = await callTool(api, "browser_save_screenshot", { path: join(stateRoot, "missing", "x.jpg") }, ctx);
    assert.equal(invalid.isError, true);
    assert.equal(invalid.details.code, "ATTACHMENT_PATH_INVALID");
    assert.equal(existsSync(join(stateRoot, "missing")), false, "the destination directory is never created");
  } finally {
    restore();
  }
});

test("/ego-settings 本会话截图 lists the session's pictures and opens one with the OS viewer", async () => {
  const stateRoot = freshDir(join(ROOT, ".tmp", "unit-extension-state", "shots-panel"));
  const { api, restore } = await loadExtension({ stateRoot });
  try {
    const hostTui = join(resolvePiPackage().packageRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js");
    const { getKeybindings } = await import(pathToFileURL(hostTui).href);
    const sessionKey = "settings-shots";
    const published = publishShot(stateRoot, sessionKey);
    const ctx = toolContext(stateRoot, sessionKey);
    ctx.mode = "tui";
    ctx.ui.notify = () => {};

    // One screen per menu iteration: pick the picture, then open by prefix, then Esc.
    // `after` marks the key presses after which the opened panel is captured.
    const screens = [
      { keys: ["\x1b[B", "\x1b[B", "\r", "\x1b[B", "\r"], after: [0, 3, 4] }, // →本会话截图, open, →the picture, open it
      { keys: ["\x1b[B", "\x1b[B", "\r", "\r"], after: [3] }, // →本会话截图, open, 按 ID 打开…
      { keys: ["\x1b"], after: [] }, // leave the menu
    ];
    const views = [];
    ctx.ui.input = async () => published.ref.id.slice(0, 12);
    ctx.ui.custom = async (factory) => {
      const spec = screens.shift();
      assert.ok(spec, "unexpected extra settings screen");
      const screen = {};
      const component = factory({ requestRender() {} }, theme, getKeybindings(), (value) => {
        screen.action = value;
      });
      if (spec.after.includes(0)) views.push(component.render(300).join("\n"));
      spec.keys.forEach((key, position) => {
        component.handleInput(key);
        if (spec.after.includes(position + 1)) views.push(component.render(300).join("\n"));
      });
      return screen.action;
    };

    await api.commands.get("ego-settings").handler("", ctx);
    assert.deepEqual(screens, [], "every planned screen was used");

    // The main list has a screenshot row; every panel names the ID and offers the ID row.
    assert.match(views[0], /本会话截图/);
    assert.match(views[0], /1 张/);
    for (const panel of [views[1], views[2], views[3]]) {
      assert.match(panel, new RegExp(shortId(published.ref.id)));
      assert.match(panel, /按 ID 打开/);
    }
    // Selecting the picture shows its absolute file path before Enter opens it.
    assert.ok(views[2].includes(published.path), `the panel should name the file:\n${views[2]}`);

    // Both gestures handed a verified file to Windows' viewer, once each.
    assert.equal(api.executed.length, 2, "one open per selected picture");
    assert.equal(api.executed[0].command, "explorer.exe");
    assert.equal(api.executed[0].args[0], published.path);
    assert.equal(api.executed[1].args[0], published.path);
  } finally {
    restore();
  }
});

test("/ego-settings offers 恢复浏览器控制 only while the user holds the browser", async () => {
  const stateRoot = freshDir(join(ROOT, ".tmp", "unit-extension-state", "resume-row"));
  const { api, restore } = await loadExtension({ stateRoot });
  try {
    const hostTui = join(resolvePiPackage().packageRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js");
    const { getKeybindings } = await import(pathToFileURL(hostTui).href);
    const sessionKey = "settings-resume";
    const paths = resolvePaths({ PI_EGO_HOME: stateRoot });
    const store = new SessionStore(paths);
    store.setHandoff(sessionKey, true);

    const notices = [];
    const ctx = toolContext(stateRoot, sessionKey);
    ctx.mode = "tui";
    ctx.ui.notify = (message, level) => notices.push({ message, level });

    const screenKeys = [["\x1b[B", "\x1b[B", "\x1b[B", "\r"], ["\x1b"]];
    const views = [];
    ctx.ui.custom = async (factory) => {
      const keys = screenKeys.shift();
      const screen = {};
      const component = factory({ requestRender() {} }, theme, getKeybindings(), (value) => {
        screen.action = value;
      });
      views.push(component.render(300).join("\n"));
      for (const key of keys) component.handleInput(key);
      return screen.action;
    };

    await api.commands.get("ego-settings").handler("", ctx);

    // The row is there while handed off, and picking it attempted the resume
    // (no browser in this unit test, so it fails cleanly instead of throwing).
    assert.match(views[0], /恢复浏览器控制/);
    assert.match(String(notices[0]?.message), /恢复失败/);
    assert.equal(notices[0].level, "error");
    assert.equal(store.get(sessionKey).handedOff, true, "a failed resume keeps the hand-off state");

    // Once the user is done, the row is not offered at all.
    store.setHandoff(sessionKey, false);
    await api.commands.get("ego-settings").handler("", ctx);
    assert.match(views[1], /本会话截图/);
    assert.equal(views[1].includes("恢复浏览器控制"), false);
  } finally {
    restore();
  }
});

function api(loaded) {
  return loaded.api;
}
