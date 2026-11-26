import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  numberSnapshot,
  resolveSessionKey,
  SessionStore,
  spaceNameFor,
} from "../src/session.js";
import { tempDir } from "./helpers.mjs";

test("numberSnapshot rewrites Ego refs into document-order numbers", () => {
  const text = [
    "[p1 | space \"demo\"(1)]",
    "- heading \"Pi Ego fixture\" [@7]",
    "- button \"Bump counter\" [@42]",
    "- textbox \"Full name\" [@51]",
    "- text: \"plain text\"",
  ].join("\n");
  const { text: numbered, items } = numberSnapshot(text);
  assert.match(numbered, /- button "Bump counter" \[#2\]/);
  assert.match(numbered, /- textbox "Full name" \[#3\]/);
  assert.equal(items.length, 3);
  assert.deepEqual(items[1], { n: 2, ref: 42, role: "button", name: "Bump counter" });
  assert.ok(!numbered.includes("[@"), "no raw Ego refs survive numbering");
});

test("numberSnapshot handles a snapshot with no refs", () => {
  const { items, text } = numberSnapshot("- text: \"nothing to act on\"");
  assert.equal(items.length, 0);
  assert.match(text, /nothing to act on/);
});

test("session keys and space names are stable and isolated", () => {
  assert.equal(resolveSessionKey(null, { PI_EGO_SESSION_KEY: "abc" }), "abc");
  assert.equal(resolveSessionKey("explicit", { PI_EGO_SESSION_KEY: "abc" }), "explicit");
  assert.equal(resolveSessionKey(undefined, {}), "default");
  const name = spaceNameFor("shared-session-prefix-a");
  assert.match(name, /^pi-ego-browser [0-9a-f]{32}$/);
  assert.equal(name, spaceNameFor("shared-session-prefix-a"));
  assert.notEqual(name, spaceNameFor("shared-session-prefix-b"));
});

test("numbers are rejected when no read happened yet", () => {
  const temp = tempDir("session-noread");
  try {
    const paths = { sessionsFile: join(temp.dir, "nested", "sessions.json") };
    mkdirSync(join(temp.dir, "nested"), { recursive: true });
    const store = new SessionStore(paths);
    const resolved = store.resolveTarget("s1", "#3");
    assert.equal(resolved.kind, "stale");
    assert.equal(resolved.code, "NO_SNAPSHOT");
  } finally {
    temp.cleanup();
  }
});

test("numbers resolve only against the read that printed them", () => {
  const temp = tempDir("session-resolve");
  try {
    const paths = { sessionsFile: join(temp.dir, "sessions.json") };
    const store = new SessionStore(paths);
    store.bind("s1", { spaceId: 4, spaceName: "space", pageLabel: "p1", url: "http://a/", title: "A" });
    store.recordSnapshot("s1", {
      spaceId: 4,
      pageLabel: "p1",
      url: "http://a/",
      title: "A",
      seq: 1,
      items: [
        { n: 1, ref: 21, role: "button", name: "Bump counter" },
        { n: 2, ref: 22, role: "textbox", name: "Full name" },
      ],
    });

    const ok = store.resolveTarget("s1", "#2");
    assert.equal(ok.kind, "ref");
    assert.equal(ok.value, "@22");
    assert.deepEqual(ok.expect, { pageLabel: "p1", url: "http://a/" });

    const byPlainNumber = store.resolveTarget("s1", "1");
    assert.equal(byPlainNumber.value, "@21");

    const unknown = store.resolveTarget("s1", "#9");
    assert.equal(unknown.code, "UNKNOWN_NUMBER");
    assert.match(unknown.message, /#1\.\.#2/);

    const selector = store.resolveTarget("s1", "loc=role:button[name='Save']");
    assert.equal(selector.kind, "selector");
    assert.equal(selector.value, "loc=role:button[name='Save']");

    // A navigation in the session invalidates the numbering it came from.
    store.bind("s1", { spaceId: 4, pageLabel: "p1", url: "http://a/next", title: "Next" });
    const stale = store.resolveTarget("s1", "#1");
    assert.equal(stale.code, "PAGE_CHANGED");
    assert.match(stale.message, /browser_read/);
  } finally {
    temp.cleanup();
  }
});

test("a new read supersedes older numbers and sequence numbers grow", () => {
  const temp = tempDir("session-seq");
  try {
    const paths = { sessionsFile: join(temp.dir, "sessions.json") };
    const store = new SessionStore(paths);
    store.bind("s1", { spaceId: 1, spaceName: "space", pageLabel: "p1", url: "http://a/", title: "A" });
    assert.equal(store.nextSeq("s1"), 1);
    store.recordSnapshot("s1", {
      spaceId: 1,
      pageLabel: "p1",
      url: "http://a/",
      title: "A",
      seq: 1,
      items: [{ n: 1, ref: 5, role: "button", name: "One" }],
    });
    assert.equal(store.nextSeq("s1"), 2);
    store.recordSnapshot("s1", {
      spaceId: 1,
      pageLabel: "p1",
      url: "http://a/",
      title: "A",
      seq: 2,
      items: [{ n: 1, ref: 99, role: "button", name: "One" }],
    });
    const resolved = store.resolveTarget("s1", "#1");
    assert.equal(resolved.value, "@99", "the newest read wins");
  } finally {
    temp.cleanup();
  }
});

test("invalidateSnapshot drops numbering and keeps the reason for later reads", () => {
  const temp = tempDir("session-invalidate");
  try {
    const paths = { sessionsFile: join(temp.dir, "sessions.json") };
    const store = new SessionStore(paths);
    store.recordSnapshot("s1", { spaceId: 1, pageLabel: "p1", url: "http://a/", title: "A", seq: 1, items: [{ n: 1, ref: 1, role: "button", name: "" }] });
    store.invalidateSnapshot("s1", "the tabs changed");
    const record = store.get("s1");
    assert.equal(record.snapshot, null);
    assert.equal(record.invalidReason, "the tabs changed");
    const resolved = store.resolveTarget("s1", "#1");
    assert.equal(resolved.code, "NO_SNAPSHOT");
    assert.match(resolved.message, /the tabs changed/);
  } finally {
    temp.cleanup();
  }
});

test("sessions are stored independently", () => {
  const temp = tempDir("session-independent");
  try {
    const paths = { sessionsFile: join(temp.dir, "sessions.json") };
    const store = new SessionStore(paths);
    store.bind("a", { spaceId: 1, spaceName: "space a", pageLabel: "p1", url: "http://a/", title: "A" });
    store.bind("b", { spaceId: 2, spaceName: "space b", pageLabel: "p1", url: "http://b/", title: "B" });
    assert.equal(store.get("a").spaceId, 1);
    assert.equal(store.get("b").spaceId, 2);
    store.setHandoff("a", true);
    assert.equal(store.get("a").handedOff, true);
    assert.equal(store.get("b").handedOff, false);
  } finally {
    temp.cleanup();
  }
});
