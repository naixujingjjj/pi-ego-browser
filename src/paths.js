// Path and environment resolution for pi-ego-browser.
// Everything the extension owns lives under one state root so a user can
// inspect or delete it in one place. The browser profile lives there too, which
// is what keeps this extension away from the user's real browser profile.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function flag(env, name) {
  const value = env[name];
  return value === "1" || value === "true" || value === "yes";
}

export function defaultStateRoot(env = process.env) {
  const base = env.LOCALAPPDATA || join(homedir(), ".local", "share");
  return join(base, "pi-ego-browser");
}

export function resolvePaths(env = process.env) {
  const stateRoot = env.PI_EGO_HOME ? resolve(env.PI_EGO_HOME) : defaultStateRoot(env);
  return {
    root: PACKAGE_ROOT,
    hostEntry: join(PACKAGE_ROOT, "vendor", "ego-windows-host", "bin", "ego-windows-host.mjs"),
    chromiumLock: join(PACKAGE_ROOT, "vendor", "chromium-lock.json"),
    stateRoot,
    profileDir: join(stateRoot, "profile"),
    sessionsFile: join(stateRoot, "sessions.json"),
    browserStateFile: join(stateRoot, "browser-state.json"),
    endpointFile: join(stateRoot, "browser-endpoint.json"),
    spacesFile: join(stateRoot, "spaces.json"),
    lockFile: join(stateRoot, "run.lock"),
    downloadDir: join(stateRoot, "downloads"),
    browsersDir: join(stateRoot, "browsers"),
    // 0.1.1's temporary preview cache. Read-only for this version: an entry left
    // behind by 0.1.1 is copied into the attachment library when the user asks
    // to save it, and the old file itself is never moved, rewritten or deleted.
    screenshotCacheDir: join(stateRoot, "screenshot-cache"),
    // Content-addressed attachment library; every new screenshot lands here.
    // This, or the preferred directory, is where a saved screenshot lives: there
    // is no second export root, and "save this" never copies the picture again.
    attachmentsDir: join(stateRoot, "attachments"),
    attachmentsConfigFile: join(stateRoot, "attachments-config.json"),
    attachmentsRootsFile: join(stateRoot, "attachments-roots.json"),
    // Stable local staging area for captures. It is deliberately outside every
    // attachment library root: the first (and for a while the only) copy of a
    // screenshot must not live on the removable drive that is about to be
    // unplugged, and a library root that disappeared must never take it along.
    stagingDir: join(stateRoot, "staging"),
    port: Number(env.PI_EGO_DEBUG_PORT) || 9522,
    headless: flag(env, "PI_EGO_HEADLESS"),
    browserPathEnv: env.PI_EGO_BROWSER_PATH || "",
    noSystemBrowser: flag(env, "PI_EGO_NO_SYSTEM_BROWSER"),
    chromiumUrl: env.PI_EGO_CHROMIUM_URL || "",
    chromiumSha256: env.PI_EGO_CHROMIUM_SHA256 || "",
    chromiumVersion: env.PI_EGO_CHROMIUM_VERSION || "",
    runTimeoutMs: Number(env.PI_EGO_RUN_TIMEOUT_MS) || 180000,
  };
}

/**
 * One directory per Pi session, used for 0.1.1's preview cache only. New
 * screenshots live in the content-addressed library, not in per-session folders.
 */
export function sessionShotDir(root, sessionKey) {
  const key = String(sessionKey);
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48);
  const id = createHash("sha256").update(key).digest("hex").slice(0, 24);
  return join(root, `${safe}-${id}`);
}
