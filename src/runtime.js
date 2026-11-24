// Runs one Ego script through the vendored ego-windows-host runtime.
//
// Every call is its own short-lived Node process; the browser itself is the
// state holder, so task spaces, tabs and logins survive between calls. The
// extension adds three things the raw host does not do for us:
//   * it refuses to attach to a CDP endpoint this extension did not launch
//   * it turns the script's sentinel line into a structured result
import { spawn } from "node:child_process";
import { readJsonSync, writeJsonAtomic } from "./store.js";

export const RESULT_SENTINEL = "__PI_EGO_RESULT__";

export async function probeEndpoint(port, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const info = await response.json();
    return typeof info?.webSocketDebuggerUrl === "string" ? info : null;
  } catch {
    return null;
  }
}

/**
 * Verify the identity reported by the browser that this extension launched.
 * A persisted profile can outlive its browser, so the directory alone does
 * not identify a process currently listening on this port.
 */
export async function assertEndpointIsOurs({ paths, fetchImpl = fetch }) {
  const endpoint = await probeEndpoint(paths.port, fetchImpl);
  if (!endpoint) return { endpoint: null, foreign: false };
  const previous = readJsonSync(paths.endpointFile);
  if (previous?.url === endpoint.webSocketDebuggerUrl) return { endpoint, foreign: false };
  return {
    endpoint,
    foreign: true,
    message: `port ${paths.port} already answers CDP for a browser that was not started by pi-ego-browser. Set PI_EGO_DEBUG_PORT to a free port.`,
  };
}

export function parseResult(stdout) {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const at = line.indexOf(RESULT_SENTINEL);
    if (at === -1) continue;
    const payload = line.slice(at + RESULT_SENTINEL.length);
    try {
      return JSON.parse(payload);
    } catch (error) {
      return { ok: false, code: "BAD_RESULT_JSON", message: `runtime emitted unparsable result: ${error.message}`, raw: payload };
    }
  }
  return null;
}

/**
 * Spawn the host with `script` on stdin and collect its result line.
 * `browser` is the resolved executable path; `headless` mirrors the config.
 */
export async function runScript(options) {
  const { paths } = options;
  const guard = await assertEndpointIsOurs({ paths });
  if (guard.foreign) {
    return { ok: false, code: "FOREIGN_BROWSER", message: guard.message, stage: "browser-attach" };
  }
  const result = await executeScript(options);
  if (!guard.endpoint && /^\[ego-windows-host\] launched /m.test(result.stderr)) {
    const endpoint = await probeEndpoint(paths.port);
    if (endpoint) writeJsonAtomic(paths.endpointFile, { url: endpoint.webSocketDebuggerUrl });
  }
  return result;
}

function executeScript({
  paths,
  script,
  browser,
  headless = paths.headless,
  env = process.env,
  timeoutMs = paths.runTimeoutMs,
  onProgress = null,
  spawnImpl = spawn,
}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawnImpl(process.execPath, [paths.hostEntry], {
        env: {
          ...env,
          EGO_HOST_STATE_DIR: paths.stateRoot,
          EGO_HOST_DEBUG_PORT: String(paths.port),
          EGO_HOST_HEADLESS: headless ? "1" : "0",
          ...(browser ? { EGO_HOST_BROWSER_PATH: browser } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish({ ok: false, code: "RUNTIME_SPAWN_FAILED", stage: "runtime-start", message: String(error?.message || error), stdout: "", stderr: "" });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      stderr += `\n[pi-ego-browser] run timed out after ${timeoutMs}ms\n`;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (onProgress) {
        for (const line of String(chunk).split(/\r?\n/)) {
          const text = line.trim();
          if (text) onProgress(text);
        }
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, code: "RUNTIME_SPAWN_FAILED", stage: "runtime-start", message: String(error?.message || error), stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = parseResult(stdout);
      if (!result) {
        const launchFailure = /browser did not expose CDP|at ensureBrowser/.test(stderr);
        const connectFailure = /CdpConnection\.open/.test(stderr);
        finish({
          ok: false,
          code: code === 0 ? "RUNTIME_NO_RESULT" : "RUNTIME_FAILED",
          stage: launchFailure ? "browser-launch" : connectFailure ? "runtime-connect" : "runtime-execute",
          message: stderr.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith("Error:")) ??
            `ego runtime exited with code ${code} without a result line`,
          stdout,
          stderr,
          exitCode: code,
        });
        return;
      }
      finish({ ...result, stdout, stderr, exitCode: code });
    });
    child.stdin.on("error", () => {
      // The child may exit before reading all of stdin; its exit code governs.
    });
    child.stdin.end(script, "utf8");
  });
}

/** `--doctor` output from the host, used by `/ego-settings status`. */
export function runDoctor({ paths, env = process.env, timeoutMs = 20000, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawnImpl(process.execPath, [paths.hostEntry, "--doctor"], {
        env: { ...env, EGO_HOST_STATE_DIR: paths.stateRoot, EGO_HOST_DEBUG_PORT: String(paths.port) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ok: false, message: String(error?.message || error), raw: "" });
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, message: String(error?.message || error), raw: stdout });
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ ok: true, raw: stdout.trim(), stderr: stderr.trim(), ...parseDoctor(stdout) });
    });
  });
}

export function parseDoctor(raw) {
  const out = { browser: null, endpoint: null, stateDir: null, spaces: [] };
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("browser:")) out.browser = trimmed.slice("browser:".length).trim();
    else if (trimmed.startsWith("endpoint:")) out.endpoint = trimmed.slice("endpoint:".length).trim();
    else if (trimmed.startsWith("state dir:")) out.stateDir = trimmed.slice("state dir:".length).trim();
    else if (trimmed.startsWith("#")) {
      const match = /^#(\d+)\s+"?([^"]*)"?\s+ownership=(\w+)\s+tabs=(\d+)/.exec(trimmed);
      if (match) out.spaces.push({ id: Number(match[1]), name: match[2], ownership: match[3], tabs: Number(match[4]) });
    }
  }
  return out;
}

export function readSpaces(paths) {
  const state = readJsonSync(paths.spacesFile, null);
  if (!state || !Array.isArray(state.spaces)) return { currentId: null, spaces: [] };
  return { currentId: state.currentId ?? null, spaces: state.spaces };
}
