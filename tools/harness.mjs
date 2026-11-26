// Shared scaffolding for the acceptance suite and the load check.
//
// The package ships no runtime dependencies: Pi provides typebox and
// `@earendil-works/*` to extensions through its own module mapping. Outside Pi
// that mapping has to be reproduced, so this harness writes small re-export
// packages under the unpacked package's `node_modules` that point at Pi's own
// copies. Re-export stubs are used instead of symlinks because creating a
// symlink needs a privilege a restricted Windows account may not have.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const HOST_PACKAGES = [
  { name: "typebox", entry: ["node_modules", "typebox", "build", "index.mjs"] },
  { name: "@earendil-works/pi-ai", entry: ["node_modules", "@earendil-works", "pi-ai", "dist", "index.js"] },
  { name: "@earendil-works/pi-tui", entry: ["node_modules", "@earendil-works", "pi-tui", "dist", "index.js"] },
];

/** Locate the installed Pi package from the `pi` shim on PATH. */
export function resolvePiPackage() {
  for (const dir of String(process.env.PATH || "").split(";").filter(Boolean)) {
    for (const name of ["pi.cmd", "pi.ps1", "pi"]) {
      const shim = join(dir, name);
      if (!existsSync(shim)) continue;
      const cli = join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
      if (existsSync(cli)) {
        return { shim, cli, packageRoot: dirname(dirname(dirname(cli))) };
      }
    }
  }
  throw new Error("could not find the installed Pi package next to the `pi` shim on PATH");
}

/** Reproduce Pi's host-package mapping inside an unpacked package directory. */
export function provideHostPackages(packageDir, piRoot) {
  const modules = join(packageDir, "node_modules");
  mkdirSync(modules, { recursive: true });
  const written = [];
  for (const host of HOST_PACKAGES) {
    const target = join(piRoot, ...host.entry);
    if (!existsSync(target)) throw new Error(`the installed Pi package is missing ${host.name} at ${target}`);
    const dir = join(modules, host.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: host.name, version: "harness", type: "module", exports: { ".": "./index.js" } }, null, 2)}\n`,
    );
    writeFileSync(
      join(dir, "index.js"),
      `// Harness stand-in for Pi's module mapping: re-export the installed copy.\nexport * from ${JSON.stringify(pathToFileURL(target).href)};\n`,
    );
    written.push(host.name);
  }
  return written;
}

/**
 * Copy the package sources into a scratch directory so an extension entry can be
 * loaded the way Pi loads it, with Pi's own host packages mapped in.
 */
export function stageSourcePackage(targetDir, root = resolve(import.meta.dirname, "..")) {
  freshDir(targetDir);
  for (const entry of ["package.json", "extensions", "src"]) {
    cpSync(join(root, entry), join(targetDir, entry), { recursive: true });
  }
  return targetDir;
}

/**
 * Fake ExtensionAPI good enough to run the packaged extension without a model.
 *
 * The tool registry mirrors Pi closely enough for the deferred-tool checks:
 * `getAllTools()` answers with `{ name, exposure }` records, `getActiveTools()`
 * with the names currently declared, and `setActiveTools()` replaces that set.
 * `hostTools` is what the host itself provides (`tool_search`, …) — registered
 * tools are added on top, exactly like Pi does for a directly declared tool.
 */
export function createFakePi(notices = [], { hostTools = [] } = {}) {
  const tools = new Map();
  const commands = new Map();
  const events = [];
  const handlers = new Map();
  const executed = [];
  const activeNames = new Set(hostTools.filter((tool) => tool.defaultActive !== false).map((tool) => tool.name));
  const api = {
    tools,
    commands,
    events,
    handlers,
    executed,
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(definition) {
      tools.set(definition.name, definition);
      // Pi declares an extension tool unless its exposure keeps it undeclared.
      if ((definition.exposure ?? "direct") === "direct") activeNames.add(definition.name);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    registerMessageRenderer() {},
    registerRenderer() {},
    registerShortcut() {},
    registerFlag() {},
    registerProvider() {},
    sendMessage() {},
    appendEntry() {},
    setSessionName() {},
    getSessionName: () => null,
    getActiveTools: () => [...activeNames],
    getAllTools: () => [
      ...hostTools.map((tool) => ({ exposure: "direct", ...tool })),
      ...[...tools.values()].map((tool) => ({ name: tool.name, exposure: tool.exposure ?? "direct" })),
    ],
    setActiveTools(names) {
      activeNames.clear();
      for (const name of names || []) activeNames.add(name);
    },
    async exec(command, args = [], options = {}) {
      executed.push({ command, args, options });
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  };
  api.events = {
    emit: (name, payload) => {
      events.push({ name, payload });
      if (payload?.message) notices.push(payload.message);
    },
  };
  return api;
}

export function newestTarball(root) {
  const dir = join(root, "dist");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => join(dir, name));
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] || null;
}

export function freshDir(path) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  return path;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Build the tool context Pi would pass to a tool's execute(). */
export function fakeToolContext({ sessionKey, cwd, notify = () => {} }) {
  return {
    sessionManager: { getSessionId: () => sessionKey, getEntries: () => [], getCwd: () => cwd },
    ui: { notify, setStatus() {}, setWidget() {} },
    cwd,
  };
}