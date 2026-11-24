// Isolated Pi load of the built tarball: `pi install` into a throwaway config,
// then a real `pi --mode rpc` session that is asked for its command list and for
// the one `/ego-settings` entry point (its status, attachment listing and
// non-TUI answer). No browser tool is called and no window opens.
//
// Usage: node tools/iso-pi-smoke.mjs [path/to/tarball.tgz]
//
// The child's stdio is a file descriptor and a log file rather than a pipe: the
// development sandbox this package was built in refuses piped child stdio
// (EPERM at spawn), and a file says exactly the same thing for reading back.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { newestTarball, resolvePiPackage } from "./harness.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const WORK = join(ROOT, ".tmp", "iso-pi-smoke");
const tarball = process.argv[2] ? resolve(process.argv[2]) : newestTarball(ROOT);
if (!tarball || !existsSync(tarball)) {
  console.error("no tarball found; run: npm run pack:build");
  process.exit(2);
}

const agentDir = join(WORK, "agent");
const projectDir = join(WORK, "project");
const stateDir = join(WORK, "state");
const outLog = join(WORK, "rpc.log");
const inLog = join(WORK, "rpc-in.jsonl");

function fresh(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

const pi = resolvePiPackage();
const env = {
  ...process.env,
  PI_CODING_AGENT_DIR: agentDir,
  PI_EGO_HOME: stateDir,
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  npm_config_cache: join(ROOT, ".npm-cache"),
};

fresh(WORK);
fresh(agentDir);
fresh(projectDir);
fresh(stateDir);

const problems = [];
const steps = {};

function runInherited(command, args, options) {
  return new Promise((done) => {
    const child = spawn(command, args, { ...options, stdio: options.stdio ?? "inherit" });
    child.on("error", (error) => done({ code: null, error: error.code || error.message }));
    child.on("close", (code) => done({ code, error: null }));
  });
}

// 1. Install the tarball into the isolated Pi config.
const spec = `npm:pi-ego-browser@file:${tarball.replace(/\\/g, "/")}`;
const installed = await runInherited(process.execPath, [pi.cli, "install", spec], { cwd: projectDir, env });
const settingsPath = join(agentDir, "settings.json");
const packages = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")).packages ?? [] : [];
steps.install = {
  spec,
  exitCode: installed.code,
  error: installed.error,
  declaresPackage: packages.some((entry) => JSON.stringify(entry).includes("pi-ego-browser")),
};
if (installed.code !== 0) problems.push(`pi install exited ${installed.code}`);

// 2. Ask a fresh RPC session what it registered, and drive the commands.
if (installed.code === 0) {
  writeFileSync(
    inLog,
    [
      { id: "r1", type: "get_commands" },
      { id: "r2", type: "prompt", message: "/ego-settings status" },
      { id: "r3", type: "prompt", message: "/ego-settings attachments" },
      { id: "r4", type: "prompt", message: "/ego-settings" },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
    "utf8",
  );
  const input = openSync(inLog, "r");
  const output = openSync(outLog, "w");
  const rpc = await runInherited(process.execPath, [pi.cli, "--mode", "rpc"], {
    cwd: projectDir,
    env,
    stdio: [input, output, output],
  });
  const raw = readFileSync(outLog, "utf8");
  const responses = raw
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
  const commands = responses.find((entry) => entry.command === "get_commands")?.data?.commands ?? [];
  const byName = (name) => commands.find((entry) => entry.name === name);
  const notifies = responses
    .filter((entry) => entry.type === "extension_ui_request" && entry.method === "notify")
    .map((entry) => entry.message);

  steps.rpc = {
    exitCode: rpc.code,
    error: rpc.error,
    commands: commands.map((entry) => entry.name),
    egoSettings: byName("ego-settings")?.sourceInfo ?? null,
    removedEgo: byName("ego") ?? null,
    promptsHandled: responses.filter((entry) => entry.command === "prompt" && entry.data?.disposition === "handled").length,
    statusNotify: notifies.find((message) => /浏览器：/.test(message)) ?? null,
    attachmentsNotify: notifies.find((message) => /附件库：|首选附件库|首选目录/.test(message)) ?? null,
    settingsHint: notifies.find((message) => /交互终端/.test(message)) ?? null,
    loadingProblem: /failed to load|extension error|cannot find module/i.test(raw),
    stateRoot: stateDir,
  };

  if (!steps.rpc.egoSettings || steps.rpc.egoSettings.origin !== "package") {
    problems.push("/ego-settings is not registered from the installed package");
  }
  if (steps.rpc.removedEgo) problems.push("the removed /ego command is still visible to Pi");
  if (steps.rpc.promptsHandled !== 3) problems.push(`expected 3 handled prompts, got ${steps.rpc.promptsHandled}`);
  if (!steps.rpc.statusNotify) problems.push("/ego-settings status printed no browser status");
  if (!steps.rpc.attachmentsNotify) problems.push("/ego-settings attachments printed no directory listing");
  if (!steps.rpc.settingsHint) problems.push("/ego-settings did not answer outside the TUI");
  if (steps.rpc.loadingProblem) problems.push("Pi reported a loading problem for the extension");
}
if (!steps.install.declaresPackage) problems.push("the isolated settings.json does not declare the package");

const summary = { tarball, piPackage: pi.packageRoot, steps, problems, ok: problems.length === 0 };
writeFileSync(join(WORK, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);