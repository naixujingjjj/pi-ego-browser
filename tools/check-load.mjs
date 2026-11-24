// Loads the packaged extension the way Pi does, without a browser and without
// spawning: checks that the tarball's entry imports cleanly against Pi's own
// host-provided packages and registers the expected tools and command.
//
// Usage: node tools/check-load.mjs [path/to/tarball.tgz]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createFakePi,
  freshDir,
  newestTarball,
  provideHostPackages,
  resolvePiPackage,
} from "./harness.mjs";
import { extractTarball } from "./tarball.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const WORK = join(ROOT, ".tmp", "load-check");

const EXPECTED_TOOLS = [
  "browser_open",
  "browser_read",
  "browser_click",
  "browser_fill",
  "browser_tabs",
  "browser_screenshot",
  "browser_show_screenshot",
  "browser_save_screenshot",
  "browser_handoff",
];

const tarball = process.argv[2] ? resolve(process.argv[2]) : newestTarball(ROOT);
if (!tarball) {
  console.error("no tarball in dist/; run: npm run pack:build");
  process.exit(2);
}

const pi = resolvePiPackage();
freshDir(WORK);
extractTarball(tarball, WORK);
const packageDir = join(WORK, "package");
if (!existsSync(join(packageDir, "extensions", "ego-browser.js"))) {
  throw new Error("the tarball does not contain extensions/ego-browser.js");
}
provideHostPackages(packageDir, pi.packageRoot);

// State and browser paths must be in place before the extension factory runs:
// BrowserService resolves them once, at construction.
const stateDir = freshDir(join(ROOT, ".tmp", "load-check-state"));
const fakeBrowser = join(stateDir, "fake-browser.exe");
writeFileSync(fakeBrowser, "not a real browser");
process.env.PI_EGO_HOME = stateDir;
process.env.PI_EGO_BROWSER_PATH = fakeBrowser;
process.env.PI_EGO_DEBUG_PORT = "9599";
process.env.PI_EGO_HEADLESS = "1";
process.env.PI_EGO_RUN_TIMEOUT_MS = "15000";

const notices = [];
const api = createFakePi(notices);
const module = await import(pathToFileURL(join(packageDir, "extensions", "ego-browser.js")).href);
if (typeof module.default !== "function") throw new Error("extension entry has no default factory");
const settings = module.default(api);
if (settings && typeof settings.then === "function") await settings;

const problems = [];
for (const name of EXPECTED_TOOLS) {
  const definition = api.tools.get(name);
  if (!definition) {
    problems.push(`tool not registered: ${name}`);
    continue;
  }
  if (!definition.parameters || definition.parameters.type !== "object") {
    problems.push(`tool ${name} has no object parameter schema`);
  }
  if (typeof definition.execute !== "function") problems.push(`tool ${name} has no execute()`);
  if (!definition.description || definition.description.length < 20) {
    problems.push(`tool ${name} description is too short`);
  }
  if (!definition.promptSnippet) problems.push(`tool ${name} has no promptSnippet`);
}
if (!api.commands.has("ego-settings")) problems.push("command /ego-settings is not registered");
if (api.commands.has("ego")) problems.push("the removed /ego command is still registered");
if ([...api.commands.keys()].length !== 1) problems.push(`unexpected extra commands: ${[...api.commands.keys()].join(", ")}`);

// The settings command must be wired in the packaged copy: outside the TUI it
// explains the menu and answers the same small actions the menu rows perform.
const settingsCommand = api.commands.get("ego-settings");
if (settingsCommand) {
  const hint = await settingsCommand.handler("", { mode: "rpc", ui: { notify() {} }, sessionManager: { getSessionId: () => "load-check" } });
  if (!/interactive terminal/.test(String(hint ?? ""))) problems.push(`/ego-settings outside the TUI: ${String(hint ?? "")}`);
  if (!/Browser:/.test(String(hint ?? ""))) problems.push(`/ego-settings outside the TUI printed no status: ${String(hint ?? "")}`);
  if (typeof settingsCommand.description !== "string" || settingsCommand.description.length < 10) {
    problems.push("/ego-settings has no description");
  }
  const saveTool = api.tools.get("browser_save_screenshot");
  const saveParams = saveTool?.parameters?.properties || {};
  if (!saveParams.path) problems.push("browser_save_screenshot lost its explicit destination parameter");
}

// The attachment library is a real code path: it must be able to publish, and
// the packaged entry must not carry an image content block in tool results.
const flatTarball = readFileSync(join(packageDir, "extensions", "ego-browser.js"), "utf8");
if (/type:\s*"image"/.test(flatTarball)) problems.push("the extension entry still builds an image content block");
const extra = [...api.tools.keys()].filter((name) => !EXPECTED_TOOLS.includes(name));
if (extra.length) problems.push(`unexpected extra tools: ${extra.join(", ")}`);

const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));

// Call two tools without a browser: one must fail on an unknown number before
// anything is spawned, the other must fail in a structured way (or open a page
// when the process is allowed to spawn). Neither may crash the extension.
const ctx = { sessionManager: { getSessionId: () => "load-check" }, ui: { notify() {} }, cwd: ROOT };
const callTool = async (name, params) => {
  const definition = api.tools.get(name);
  const outcome = await definition.execute(`load-${name}`, params, undefined, undefined, ctx);
  const text = (outcome.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
  return { ...outcome, text };
};

const staleCall = await callTool("browser_click", { target: "#3" });
if (!staleCall.isError) problems.push("browser_click with an unknown number must be an error");
if (staleCall.details?.code !== "NO_SNAPSHOT") {
  problems.push(`stale-number failure code: ${JSON.stringify(staleCall.details)}`);
}
if (!/browser_read/.test(staleCall.text)) problems.push(`stale-number message should ask for browser_read: ${staleCall.text}`);

const openCall = await callTool("browser_open", { url: "http://127.0.0.1:1/" });
const openCode = openCall.details?.code ?? null;
const allowed = [
  "RUNTIME_SPAWN_FAILED",
  "RUNTIME_FAILED",
  "RUNTIME_NO_RESULT",
  "FOREIGN_BROWSER",
  "BROWSER_NOT_FOUND",
  "BROWSER_DOWNLOAD_FAILED",
  "BROWSER_UNPACK_FAILED",
  "BROWSER_LOCK_INVALID",
];
if (openCall.isError && !allowed.includes(openCode)) {
  problems.push(`browser_open failed with an unexpected code: ${openCode} / ${openCall.text}`);
}

console.log(
  JSON.stringify(
    {
      tarball,
      piPackage: pi.packageRoot,
      packageVersion: manifest.version,
      tools: [...api.tools.keys()],
      parameters: Object.fromEntries(
        [...api.tools.entries()].map(([name, definition]) => [name, Object.keys(definition.parameters.properties || {})]),
      ),
      commands: [...api.commands.keys()],
      settingsHint: settingsCommand ? "checked" : "missing",
      toolCalls: {
        unknownNumber: { isError: Boolean(staleCall.isError), code: staleCall.details?.code ?? null },
        open: { isError: Boolean(openCall.isError), code: openCode, spawned: !openCall.isError },
      },
      problems,
      ok: problems.length === 0,
    },
    null,
    2,
  ),
);
process.exit(problems.length === 0 ? 0 : 1);
