import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, readLock } from "../src/store.js";
import {
  assertEndpointIsOurs,
  parseDoctor,
  parseResult,
  probeEndpoint,
  readSpaces,
  RESULT_SENTINEL,
} from "../src/runtime.js";
import { tempDir } from "./helpers.mjs";

test("parseResult reads the last sentinel line and tolerates noise", () => {
  const stdout = [
    "noise from the runtime",
    `${RESULT_SENTINEL}{"ok":true,"pageLabel":"p1"}`,
    "trailing log line",
    `${RESULT_SENTINEL}{"ok":false,"code":"STALE_PAGE"}`,
  ].join("\n");
  assert.deepEqual(parseResult(stdout), { ok: false, code: "STALE_PAGE" });
  assert.equal(parseResult("nothing here"), null);
  const broken = parseResult(`${RESULT_SENTINEL}{not json`);
  assert.equal(broken.ok, false);
  assert.equal(broken.code, "BAD_RESULT_JSON");
});

test("parseDoctor reads browser, endpoint, state dir and spaces", () => {
  const raw = [
    "browser: C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "endpoint: not running (will launch on port 9522 at next call)",
    "state dir: C:\\Users\\x\\AppData\\Local\\pi-ego-browser",
    "task spaces: 1",
    '  #2 "pi-ego-browser session1" ownership=agent tabs=2',
  ].join("\n");
  const parsed = parseDoctor(raw);
  assert.match(parsed.browser, /msedge\.exe$/);
  assert.equal(parsed.endpoint, "not running (will launch on port 9522 at next call)");
  assert.equal(parsed.stateDir, "C:\\Users\\x\\AppData\\Local\\pi-ego-browser");
  assert.deepEqual(parsed.spaces, [{ id: 2, name: "pi-ego-browser session1", ownership: "agent", tabs: 2 }]);
});

test("probeEndpoint reports null for a dead port and the info for a live one", async () => {
  const dead = await probeEndpoint(1);
  assert.equal(dead, null);
  const live = await probeEndpoint(9, async () => ({
    ok: true,
    async json() {
      return { webSocketDebuggerUrl: "ws://127.0.0.1:9/devtools/browser/abc" };
    },
  }));
  assert.equal(live.webSocketDebuggerUrl, "ws://127.0.0.1:9/devtools/browser/abc");
});

test("only the recorded CDP endpoint is accepted, even if our profile already exists", async () => {
  const temp = tempDir("foreign");
  try {
    const paths = { port: 9, profileDir: join(temp.dir, "profile"), endpointFile: join(temp.dir, "endpoint.json") };
    const live = async () => ({ ok: true, async json() { return { webSocketDebuggerUrl: "ws://127.0.0.1:9/devtools/browser/abc" }; } });
    const foreign = await assertEndpointIsOurs({ paths, fetchImpl: live });
    assert.equal(foreign.foreign, true);
    assert.match(foreign.message, /was not started by pi-ego-browser/);

    mkdirSync(paths.profileDir, { recursive: true });
    writeFileSync(paths.endpointFile, JSON.stringify({ url: "ws://127.0.0.1:9/devtools/browser/other" }));
    assert.equal((await assertEndpointIsOurs({ paths, fetchImpl: live })).foreign, true);
    writeFileSync(paths.endpointFile, JSON.stringify({ url: "ws://127.0.0.1:9/devtools/browser/abc" }));
    const ours = await assertEndpointIsOurs({ paths, fetchImpl: live });
    assert.equal(ours.foreign, false);

    const idle = await assertEndpointIsOurs({ paths, fetchImpl: async () => ({ ok: false }) });
    assert.equal(idle.foreign, false, "nothing listening is never foreign");
  } finally {
    temp.cleanup();
  }
});

test("readSpaces tolerates a missing or corrupt spaces file", () => {
  const temp = tempDir("spaces");
  try {
    const paths = { spacesFile: join(temp.dir, "spaces.json") };
    assert.deepEqual(readSpaces(paths), { currentId: null, spaces: [] });
    writeFileSync(paths.spacesFile, "{ not json");
    assert.deepEqual(readSpaces(paths), { currentId: null, spaces: [] });
    writeFileSync(
      paths.spacesFile,
      JSON.stringify({ nextId: 3, currentId: 2, spaces: [{ id: 2, name: "a", ownership: "agent", targetIds: ["t1"] }] }),
    );
    const state = readSpaces(paths);
    assert.equal(state.currentId, 2);
    assert.equal(state.spaces.length, 1);
  } finally {
    temp.cleanup();
  }
});

test("the run lock serializes callers without blocking the event loop and reclaims a dead owner's lock", async () => {
  const temp = tempDir("lock");
  try {
    const lockPath = join(temp.dir, "run.lock");
    const release = await acquireLock(lockPath);
    assert.equal(readLock(lockPath).pid, process.pid);
    await assert.rejects(acquireLock(lockPath, { timeoutMs: 300 }), /held/);
    setTimeout(release, 25);
    const again = await acquireLock(lockPath, { timeoutMs: 1000 });
    again();

    writeFileSync(lockPath, JSON.stringify({ pid: 999999, at: Date.now() }));
    const afterStale = await acquireLock(lockPath, { timeoutMs: 1000 });
    afterStale();
    assert.equal(readLock(lockPath), null);
  } finally {
    temp.cleanup();
  }
});
