// Browser resolution for pi-ego-browser.
//
// Order of preference (the plan's rule):
//   1. PI_EGO_BROWSER_PATH, an explicit user choice
//   2. a browser already installed on this machine (Edge, Chrome, Chromium)
//   3. the managed Chrome for Testing build pinned in vendor/chromium-lock.json:
//      verified against its SHA-256, cached, and only enabled after a
//      successful unpack. An interrupted download resumes or restarts.
//
// The Ego runtime never picks the browser itself here: the extension passes the
// resolved executable path down as EGO_HOST_BROWSER_PATH so every stage can
// report what it did and where it failed.
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdirSync, openSync, closeSync, renameSync, rmSync, writeSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { readJsonSync, writeJsonAtomic } from "./store.js";
import { extractZip } from "./unzip.js";

const SYSTEM_SUFFIXES = [
  join("Microsoft", "Edge", "Application", "msedge.exe"),
  join("Google", "Chrome", "Application", "chrome.exe"),
  join("Chromium", "Application", "chrome.exe"),
];

export function candidateSystemBrowsers(env = process.env) {
  const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
  const out = [];
  for (const suffix of SYSTEM_SUFFIXES) {
    for (const root of roots) out.push(join(root, suffix));
  }
  return out;
}

export function findSystemBrowser(env = process.env, exists = existsSync) {
  for (const candidate of candidateSystemBrowsers(env)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function readChromiumLock(paths) {
  const lock = readJsonSync(paths.chromiumLock, null);
  if (!lock?.url || !lock?.sha256 || !lock?.version) {
    throw new Error(`managed browser lock file is missing or incomplete: ${paths.chromiumLock}`);
  }
  return lock;
}

export function managedBrowserDir(paths, lock) {
  return join(paths.browsersDir, `chrome-win64-${lock.version}`);
}

export function managedBrowserExe(paths, lock) {
  return join(managedBrowserDir(paths, lock), lock.executableRelativePath || join("chrome-win64", "chrome.exe"));
}

/** True only when a previous run unpacked this build completely. */
export function managedBrowserReady(paths, lock, exists = existsSync) {
  return exists(join(managedBrowserDir(paths, lock), ".complete")) && exists(managedBrowserExe(paths, lock));
}

export function recordBrowserState(paths, state) {
  writeJsonAtomic(paths.browserStateFile, { ...state, at: new Date().toISOString() });
}

export function readBrowserState(paths) {
  return readJsonSync(paths.browserStateFile, null);
}

function lockFor(paths, env, overrides) {
  if (overrides?.url && overrides?.sha256) {
    return {
      version: overrides.version || "override",
      url: overrides.url,
      sha256: overrides.sha256,
      size: overrides.size,
      executableRelativePath: lockExecutable(overrides),
    };
  }
  const pinned = readChromiumLock(paths);
  const version = paths.chromiumVersion || pinned.version;
  const versioned = version === pinned.version;
  return {
    ...pinned,
    version,
    url: paths.chromiumUrl || (versioned ? pinned.url : versionedUrl(pinned.url, version)),
    sha256: paths.chromiumSha256 || (versioned ? pinned.sha256 : ""),
    size: versioned ? pinned.size : undefined,
  };
}

function versionedUrl(pinnedUrl, version) {
  return pinnedUrl.replace(/\/chrome-for-testing-public\/[^/]+\//, `/chrome-for-testing-public/${version}/`);
}

function lockExecutable(overrides) {
  if (overrides.executableRelativePath) return overrides.executableRelativePath;
  const name = (overrides.url || "").split("?")[0].split("/").pop() || "";
  const stem = name.replace(/\.zip$/i, "");
  return stem ? join(stem, "chrome.exe") : join("chrome-win64", "chrome.exe");
}

async function sha256File(path) {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

/**
 * Download the pinned archive into the cache, resuming a partial file when the
 * server honours `Range`. Every failure keeps the partial bytes for the next
 * attempt unless the bytes themselves are proven wrong (checksum mismatch).
 */
export async function downloadArchive({
  lock,
  paths,
  log = () => {},
  fetchImpl = fetch,
  attempts = 3,
  onProgress = null,
}) {
  mkdirSync(paths.downloadDir, { recursive: true });
  const finalPath = join(paths.downloadDir, `chrome-win64-${lock.version}.zip`);
  const partPath = `${finalPath}.part`;
  const report = (message) => {
    log(message);
    onProgress?.(message);
  };

  if (existsSync(finalPath)) {
    if (!lock.sha256 || (await sha256File(finalPath)) === lock.sha256) return { path: finalPath, resumed: false };
    report("cached browser archive failed checksum verification, downloading it again");
    await rm(finalPath, { force: true });
  }

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const before = existsSync(partPath) ? statSync(partPath).size : 0;
      if (before > 0) report(`resuming browser download at ${(before / 1048576).toFixed(1)} MiB`);
      const headers = before > 0 ? { range: `bytes=${before}-` } : {};
      const response = await fetchImpl(lock.url, { headers, redirect: "follow" });
      if (before > 0 && response.status === 200) {
        // Server ignored the range request; start over rather than corrupt the file.
        await rm(partPath, { force: true });
        throw new Error("server did not honour the resume request");
      }
      if (before > 0 && response.status === 416) {
        // Nothing left to fetch: the partial file is complete.
        await response.body?.cancel?.();
      } else if (!response.ok) {
        await response.body?.cancel?.();
        throw new Error(`browser download failed: HTTP ${response.status}`);
      } else {
        const fd = openSync(partPath, before > 0 ? "a" : "w");
        let written = before;
        try {
          const total = Number(response.headers.get("content-length") || 0) + before;
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            writeSync(fd, value);
            written += value.length;
            if (total) {
              onProgress?.(`downloading Chrome for Testing ${lock.version}: ${Math.round((written / total) * 100)}%`);
            }
          }
        } finally {
          closeSync(fd);
        }
      }
      const size = statSync(partPath).size;
      if (lock.size && size !== lock.size) {
        throw new Error(`browser archive is ${size} bytes, expected ${lock.size}`);
      }
      if (lock.sha256) {
        const actual = await sha256File(partPath);
        if (actual !== lock.sha256) {
          await rm(partPath, { force: true });
          throw new Error(`browser archive failed SHA-256 verification (got ${actual})`);
        }
      }
      await rename(partPath, finalPath);
      return { path: finalPath, resumed: before > 0 };
    } catch (error) {
      lastError = error;
      report(`browser download attempt ${attempt}/${attempts} failed: ${error?.message || error}`);
    }
  }
  throw new Error(
    `could not download ${lock.url}: ${lastError?.message || "unknown error"}${existsSync(partPath) ? " (partial file kept for the next attempt)" : ""}`,
  );
}

/** Unpack the verified archive into the cache and mark it complete. */
export async function installManagedBrowser({ lock, paths, log = () => {} }) {
  const target = managedBrowserDir(paths, lock);
  const archive = join(paths.downloadDir, `chrome-win64-${lock.version}.zip`);
  if (!existsSync(archive)) throw new Error(`browser archive missing: ${archive}`);
  const staging = `${target}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  log(`unpacking Chrome for Testing ${lock.version}`);
  try {
    extractZip(archive, staging);
    const exe = join(staging, lock.executableRelativePath || join("chrome-win64", "chrome.exe"));
    if (!existsSync(exe)) throw new Error(`archive did not contain ${lock.executableRelativePath || "chrome-win64/chrome.exe"}`);
    writeJsonAtomic(join(staging, ".complete"), {
      version: lock.version,
      sha256: lock.sha256,
      url: lock.url,
      installedAt: new Date().toISOString(),
    });
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    // The verified archive is only needed until the build is installed; keeping
    // 215 MB around after a successful unpack has no upside.
    rmSync(archive, { force: true });
    return managedBrowserExe(paths, lock);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Resolve the browser for this run, doing whatever first-use preparation the
 * machine needs. Returns `{ ok, path, source, stage, message }`; it never opens
 * a window and never touches the user's own browser profile.
 */
export async function resolveBrowser({
  paths,
  env = process.env,
  log = () => {},
  onProgress = null,
  fetchImpl = fetch,
  exists = existsSync,
  overrides = null,
}) {
  const emit = (message) => {
    log(message);
    onProgress?.(message);
  };

  if (paths.browserPathEnv) {
    if (!exists(paths.browserPathEnv)) {
      const state = { ok: false, stage: "browser-detect", source: "env", message: `PI_EGO_BROWSER_PATH does not exist: ${paths.browserPathEnv}` };
      recordBrowserState(paths, state);
      return state;
    }
    const state = { ok: true, stage: "browser-detect", source: "env", path: paths.browserPathEnv, message: "using PI_EGO_BROWSER_PATH" };
    recordBrowserState(paths, state);
    return state;
  }

  if (!paths.noSystemBrowser) {
    const system = findSystemBrowser(env, exists);
    if (system) {
      const state = { ok: true, stage: "browser-detect", source: "system", path: system, message: `using the installed browser at ${system}` };
      recordBrowserState(paths, state);
      emit(`found system browser: ${system}`);
      return state;
    }
    emit("no Edge, Chrome or Chromium found in the standard install locations");
  } else {
    emit("system browser discovery disabled for this run (PI_EGO_NO_SYSTEM_BROWSER=1)");
  }

  let lock;
  try {
    lock = lockFor(paths, env, overrides);
  } catch (error) {
    const state = { ok: false, stage: "browser-lock", source: "managed", message: String(error?.message || error) };
    recordBrowserState(paths, state);
    return state;
  }

  const usingManaged = () => {
    const state = {
      ok: true,
      stage: "browser-managed",
      source: "managed",
      version: lock.version,
      path: managedBrowserExe(paths, lock),
      message: `using cached Chrome for Testing ${lock.version}`,
    };
    recordBrowserState(paths, state);
    return state;
  };

  if (managedBrowserReady(paths, lock, exists)) {
    emit(`reusing cached Chrome for Testing ${lock.version}`);
    return usingManaged();
  }

  emit(`no usable browser yet; preparing Chrome for Testing ${lock.version}`);
  try {
    const downloaded = await downloadArchive({
      lock,
      paths,
      log,
      fetchImpl,
      onProgress,
      attempts: Number(env.PI_EGO_DOWNLOAD_ATTEMPTS) || 3,
    });
    emit(`download verified (${downloaded.path})`);
    const exe = await installManagedBrowser({ lock, paths, log });
    emit(`managed browser ready: ${exe}`);
    return usingManaged();
  } catch (error) {
    const stage = /unpack|archive did not contain/.test(String(error?.message)) ? "browser-unpack" : "browser-download";
    const state = { ok: false, stage, source: "managed", version: lock.version, url: lock.url, message: String(error?.message || error) };
    recordBrowserState(paths, state);
    return state;
  }
}