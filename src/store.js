// Small filesystem helpers: atomic JSON, run lock, staged writes.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

export function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, ms);
}

export function readJsonSync(path, fallback = null) {
  try {
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Write JSON through a temp file and rename, retrying briefly because Windows
 * refuses to rename onto a file another process still holds open.
 */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Math.floor(performance.now() * 1000)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      const code = error?.code;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!transient || attempt >= 12) {
        try {
          rmSync(temp, { force: true });
        } catch {
          // best effort; the original error matters more
        }
        throw error;
      }
      sleepSync(20);
    }
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Cross-process lock around one Ego run.
 *
 * Two Pi sessions share one browser and one `spaces.json`; the Ego host rewrites
 * that file on every tab change, so concurrent runs can lose each other's tab
 * bookkeeping. Serializing runs per state root keeps sessions independent.
 * A live owner keeps its lock. An abandoned or malformed lock can be reclaimed.
 */
export async function acquireLock(lockPath, { timeoutMs = 120000, staleMs = 120000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  mkdirSync(dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      const payload = JSON.stringify({ pid: process.pid, at: Date.now() });
      writeFileSync(lockPath, payload, { encoding: "utf8", flag: "wx" });
      return () => {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // releasing is best effort
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const held = readLock(lockPath);
      if (held && (held.pid > 0 ? !processAlive(held.pid) : held.age > staleMs)) {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // another process may have cleared it first
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `another pi-ego-browser run has held ${lockPath} for too long (pid ${held?.pid ?? "unknown"})`,
        );
      }
      await delay(120);
    }
  }
}

export function readLock(lockPath) {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    const age = Date.now() - Number(parsed.at || 0);
    return { pid: Number(parsed.pid), age, stale: age > 120000 };
  } catch {
    try {
      const info = statSync(lockPath);
      return { pid: 0, age: Date.now() - info.mtimeMs, stale: Date.now() - info.mtimeMs > 120000 };
    } catch {
      return null;
    }
  }
}
