import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { MAX_INLINE_ATTACHMENT_BYTES } from "../src/attachments.js";
import { BrowserService } from "../src/tools.js";
import { resolvePaths, sessionShotDir } from "../src/paths.js";
import { readJsonSync } from "../src/store.js";
import { tempDir } from "./helpers.mjs";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001",
  "hex",
);

function makeService(temp, runner, { env = {} } = {}) {
  const fakeBrowser = join(temp.dir, "msedge.exe");
  writeFileSync(fakeBrowser, "not a real browser");
  const environment = { PI_EGO_HOME: temp.dir, PI_EGO_BROWSER_PATH: fakeBrowser, PI_EGO_HEADLESS: "1", ...env };
  const paths = resolvePaths(environment);
  const service = new BrowserService({ env: environment, paths, runner });
  return { service, paths, fakeBrowser };
}

function cmdOf(script) {
  const match = /^const PI_CMD = (\{.*\});$/m.exec(script);
  return match ? JSON.parse(match[1]) : {};
}

function kindOf(script) {
  return cmdOf(script).kind || "unknown";
}

const baseResult = { ok: true, details: {} };

test("open binds the session space and reports url/title", async () => {
  const temp = tempDir("tools-open");
  try {
    const seen = [];
    const { service } = makeService(temp, async ({ script }) => {
      seen.push(kindOf(script));
      return { ok: true, spaceId: 5, spaceName: "pi-ego-browser s1", ownership: "agent", pageLabel: "p1", url: "http://127.0.0.1:9/", title: "Fixture Home", tabs: [{ label: "p1", active: true }] };
    });
    const outcome = await service.open({ sessionKey: "s1", url: "http://127.0.0.1:9/" });
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /Fixture Home/);
    assert.match(outcome.text, /http:\/\/127\.0\.0\.1:9\//);
    assert.equal(outcome.details.spaceId, 5);
    assert.deepEqual(seen, ["open"]);
  } finally {
    temp.cleanup();
  }
});

test("read numbers the snapshot and records it for later actions", async () => {
  const temp = tempDir("tools-read");
  try {
    const { service } = makeService(temp, async () => ({
      ok: true,
      spaceId: 5,
      spaceName: "space",
      ownership: "agent",
      pageLabel: "p1",
      url: "http://127.0.0.1:9/form.html",
      title: "Fixture Form",
      snapshot: '- heading "Controlled form" [@3]\n- textbox "Full name" [@21]\n- button "Sign up" [@30]',
      tabs: [],
    }));
    const outcome = await service.read({ sessionKey: "s1" });
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /#1\.\.#3/);
    assert.match(outcome.text, /textbox "Full name" \[#2\]/);
    assert.equal(outcome.details.elements, 3);
    assert.equal(outcome.details.seq, 1);

    const stored = readJsonSync(join(temp.dir, "sessions.json"));
    const record = stored.sessions.s1;
    assert.equal(record.snapshot.items[1].ref, 21);
    assert.equal(record.url, "http://127.0.0.1:9/form.html");
  } finally {
    temp.cleanup();
  }
});

test("click resolves a read number to the Ego ref and guards the page state", async () => {
  const temp = tempDir("tools-click");
  try {
    const scripts = [];
    const { service } = makeService(temp, async ({ script }) => {
      scripts.push(script);
      const kind = kindOf(script);
      return {
        ok: true,
        spaceId: 5,
        spaceName: "space",
        ownership: "agent",
        pageLabel: "p1",
        url: "http://127.0.0.1:9/",
        title: "Fixture Home",
        navigated: false,
        tabs: [],
        ...(kind === "read" ? { snapshot: '- button "Bump counter" [@42]' } : {}),
      };
    });
    const seeded = await service.read({ sessionKey: "s1" });
    assert.equal(seeded.ok, true);

    const outcome = await service.click({ sessionKey: "s1", target: "#1" });
    assert.equal(outcome.ok, true);
    const clickScript = scripts.find((script) => kindOf(script) === "click");
    assert.match(clickScript, /"selector":"@42"/);
    assert.match(clickScript, /"expect":\{"pageLabel":"p1","url":"http:\/\/127\.0\.0\.1:9\/"\}/);

    const stale = await service.click({ sessionKey: "s1", target: "#7" });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, "UNKNOWN_NUMBER");
    assert.match(stale.message, /browser_read/);
  } finally {
    temp.cleanup();
  }
});

test("a bare selector passes through without needing a read", async () => {
  const temp = tempDir("tools-selector");
  try {
    const scripts = [];
    const { service } = makeService(temp, async ({ script }) => {
      scripts.push(script);
      return { ok: true, spaceId: 5, pageLabel: "p1", url: "http://a/", title: "A", tabs: [] };
    });
    const outcome = await service.fill({ sessionKey: "s2", target: "loc=role:textbox[name='Email']", text: "a@b.c" });
    assert.equal(outcome.ok, true);
    const fillScript = scripts.find((script) => kindOf(script) === "fill");
    assert.match(fillScript, /"selector":"loc=role:textbox\[name='Email'\]"/);
    assert.match(fillScript, /"text":"a@b.c"/);
    assert.match(fillScript, /"expect":null/);
  } finally {
    temp.cleanup();
  }
});

test("navigation after a click invalidates the numbering", async () => {
  const temp = tempDir("tools-navigate");
  try {
    let phase = "read";
    const { service } = makeService(temp, async ({ script }) => {
      if (kindOf(script) === "read") {
        return { ok: true, spaceId: 5, pageLabel: "p1", url: "http://a/", title: "A", snapshot: '- link "Next" [@8]', tabs: [] };
      }
      return { ok: true, spaceId: 5, pageLabel: "p1", url: "http://a/after", title: "After", navigated: true, tabs: [] };
    });
    await service.read({ sessionKey: "s3" });
    const click = await service.click({ sessionKey: "s3", target: "#1" });
    assert.equal(click.ok, true);
    assert.match(click.text, /The page navigated/);
    phase = "done";
    assert.equal(phase, "done");
    const after = await service.click({ sessionKey: "s3", target: "#1" });
    assert.equal(after.ok, false);
    assert.equal(after.code, "NO_SNAPSHOT");
  } finally {
    temp.cleanup();
  }
});

test("tabs switching invalidates numbering and lists the session's tabs", async () => {
  const temp = tempDir("tools-tabs");
  try {
    const { service } = makeService(temp, async ({ script }) => {
      const current = kindOf(script);
      if (current === "read") {
        return { ok: true, spaceId: 5, pageLabel: "p1", url: "http://a/", title: "A", snapshot: '- button "One" [@1]', tabs: [] };
      }
      return {
        ok: true,
        spaceId: 5,
        pageLabel: cmdOf(script).pageLabel === "p2" ? "p2" : "p1",
        url: "http://a/",
        title: "A",
        tabs: [
          { label: "p1", title: "One", url: "http://a/", active: false },
          { label: "p2", title: "Two", url: "http://b/", active: true },
        ],
        labels: ["p1", "p2"],
        activated: true,
      };
    });
    await service.read({ sessionKey: "s4" });
    const switched = await service.tabs({ sessionKey: "s4", action: "switch", pageLabel: "p2" });
    assert.equal(switched.ok, true);
    assert.match(switched.text, /Switched to p2/);
    assert.match(switched.text, /p1 .*http:\/\/a\//);
    const listed = await service.tabs({ sessionKey: "s4", action: "list" });
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.details.labels, ["p1", "p2"]);
    const blocked = await service.click({ sessionKey: "s4", target: "#1" });
    assert.equal(blocked.code, "NO_SNAPSHOT");
  } finally {
    temp.cleanup();
  }
});

test("a capture publishes a content-addressed attachment and leaves no staging file", async () => {
  const temp = tempDir("tools-shot");
  try {
    const { service, paths } = makeService(temp, async ({ script }) => {
      const path = cmdOf(script).path;
      writeFileSync(path, PNG);
      return { ok: true, spaceId: 5, pageLabel: "p1", url: "http://a/", title: "A", path, tabs: [{ label: "p1", active: true }] };
    });
    const sessionKey = "session:a";
    assert.equal(service.saveScreenshot({ sessionKey }).code, "NO_SCREENSHOT");

    const first = await service.screenshot({ sessionKey });
    assert.equal(first.ok, true);
    assert.match(first.text, /attachment library/i);
    assert.match(first.text, /Attachment ID/);
    assert.match(first.text, /no second copy is needed/);
    assert.equal(first.image, undefined, "a screenshot result must not carry image bytes");
    assert.equal(first.details.saved, true, "a capture is saved, not temporary");
    assert.equal(first.details.attachment.id, createHash("sha256").update(PNG).digest("hex"));
    assert.ok(first.details.path.startsWith(join(paths.attachmentsDir, "v1", "objects")));
    assert.deepEqual(readFileSync(first.details.path), PNG);
    assert.deepEqual(readdirSync(join(paths.attachmentsDir, "v1", "staging")), [], "the staging file must be consumed");
    assert.equal(existsSync(paths.screenshotCacheDir), false, "0.1.2 does not use the 0.1.1 preview cache");
    assert.equal(existsSync(join(temp.dir, "screenshots")), false, "a capture is not copied to an export directory");

    const detailsJson = JSON.stringify(first.details);
    assert.ok(detailsJson.length < 2000, `details grew to ${detailsJson.length} bytes`);
    assert.equal(/"data"|"base64"|data:image/.test(detailsJson), false, "details must stay small metadata");

    const record = readJsonSync(join(temp.dir, "sessions.json")).sessions[sessionKey];
    assert.equal(record.latestAttachment.id, first.details.attachment.id);
    assert.equal(record.attachments.length, 1);
    assert.equal(JSON.stringify(record).includes(PNG.toString("base64")), false, "the session record holds no bytes");
  } finally {
    temp.cleanup();
  }
});

test("identical captures are stored once and a normal save returns that original", async () => {
  const temp = tempDir("tools-shot-dedupe");
  try {
    const { service, paths } = makeService(temp, async ({ script }) => {
      const path = cmdOf(script).path;
      writeFileSync(path, PNG);
      return { ok: true, spaceId: 5, pageLabel: "p1", url: "http://a/", title: "A", path, tabs: [] };
    });
    const sessionKey = "session:same";
    const first = await service.screenshot({ sessionKey });
    const second = await service.screenshot({ sessionKey });
    assert.equal(second.details.attachment.id, first.details.attachment.id);
    assert.equal(second.details.deduped, true);
    assert.match(second.text, /no second copy was stored/);
    assert.equal(readdirSync(join(paths.attachmentsDir, "v1", "objects")).length, 1);

    // "Save this" without a destination is the original, not a copy.
    const saved = service.saveScreenshot({ sessionKey });
    assert.equal(saved.ok, true);
    assert.equal(saved.details.path, second.details.path);
    assert.equal(saved.details.savedOriginal, true);
    assert.equal(saved.details.copied, undefined, "a normal save must not copy anything");
    assert.match(saved.text, /original is already in the attachment library/);
    assert.deepEqual(readFileSync(saved.details.path), PNG);
    assert.deepEqual(readFileSync(second.details.path), PNG, "the library object stays available after a save");
    assert.equal(existsSync(join(temp.dir, "screenshots")), false, "no export directory is created by a save");

    // Asking twice is the same answer about the same file, with nothing added.
    const again = service.saveScreenshot({ sessionKey });
    assert.equal(again.details.path, saved.details.path);
    assert.equal(readdirSync(join(paths.attachmentsDir, "v1", "objects")).length, 1);
  } finally {
    temp.cleanup();
  }
});

test("an explicit destination is the only thing copied, and it is never overwritten", async (t) => {
  const temp = tempDir("tools-shot-copy");
  try {
    const { service, paths } = makeService(temp, async ({ script }) => {
      const path = cmdOf(script).path;
      writeFileSync(path, PNG);
      return { ok: true, spaceId: 5, pageLabel: "p1", url: "http://a/", title: "A", path, tabs: [] };
    });
    const sessionKey = "explicit-copy";
    const shot = await service.screenshot({ sessionKey });
    const destinationDir = join(temp.dir, "用户 指定", "pictures");
    mkdirSync(destinationDir, { recursive: true });
    const destination = join(destinationDir, "页面 截图.png");

    const copied = service.saveScreenshot({ sessionKey, path: destination });
    assert.equal(copied.ok, true, copied.message);
    assert.equal(copied.details.path, destination);
    assert.equal(copied.details.copied, true);
    assert.deepEqual(readFileSync(destination), PNG, "the copy is the verified original's bytes");
    assert.deepEqual(readFileSync(shot.details.path), PNG, "the library original stays in place");

    // The same destination again: recognised as this picture, nothing rewritten.
    const before = statSync(destination).mtimeMs;
    const reused = service.saveScreenshot({ sessionKey, path: destination });
    assert.equal(reused.ok, true);
    assert.equal(reused.details.reused, true);
    assert.equal(statSync(destination).mtimeMs, before, "an identical existing file is not rewritten");

    // A different file at the destination is refused, never overwritten.
    const other = join(destinationDir, "other.png");
    writeFileSync(other, Buffer.from("not this picture"));
    const refused = service.saveScreenshot({ sessionKey, path: other });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "ATTACHMENT_EXISTS");
    assert.equal(readFileSync(other, "utf8"), "not this picture", "the existing file keeps its bytes");

    const concurrent = join(destinationDir, "concurrent.png");
    const link = fs.linkSync;
    const simulated = t.mock.method(fs, "linkSync", (source, target) => {
      assert.equal(target, concurrent);
      writeFileSync(target, "concurrent writer", { flag: "wx" });
      return link(source, target);
    });
    syncBuiltinESMExports();
    try {
      const result = service.saveScreenshot({ sessionKey, path: concurrent });
      assert.equal(simulated.mock.callCount(), 1);
      assert.equal(result.code, "ATTACHMENT_EXISTS");
      assert.equal(readFileSync(concurrent, "utf8"), "concurrent writer");
      assert.equal(readdirSync(destinationDir).some(name => name.startsWith(".pi-ego-copy-")), false);
    } finally {
      simulated.mock.restore();
      syncBuiltinESMExports();
    }

    // A destination the user did not make absolute, is not a .png, or whose
    // directory is missing is refused instead of being resolved or created.
    const relative = service.saveScreenshot({ sessionKey, path: "shots/copy.png" });
    assert.equal(relative.code, "ATTACHMENT_PATH_INVALID");
    assert.match(relative.message, /absolute path/);
    const wrongType = service.saveScreenshot({ sessionKey, path: join(destinationDir, "copy.jpg") });
    assert.equal(wrongType.code, "ATTACHMENT_PATH_INVALID");
    assert.match(wrongType.message, /\.png/);
    const missing = join(temp.dir, "not there", "copy.png");
    const noDir = service.saveScreenshot({ sessionKey, path: missing });
    assert.equal(noDir.code, "ATTACHMENT_MISSING");
    assert.equal(existsSync(join(temp.dir, "not there")), false, "the destination directory is never created");

    // Naming the library original itself is not a copy at all.
    const itself = service.saveScreenshot({ sessionKey, path: shot.details.path });
    assert.equal(itself.ok, true);
    assert.equal(itself.details.savedOriginal, true);
    assert.equal(itself.details.path, shot.details.path);
  } finally {
    temp.cleanup();
  }
});

test("a failed capture leaves the last attachment available for export", async () => {
  const temp = tempDir("tools-shot-retry");
  try {
    let fail = false;
    const { service, paths } = makeService(temp, async ({ script }) => {
      const path = cmdOf(script).path;
      writeFileSync(path, PNG);
      return fail ? { ok: false, code: "EGO_PAGE_UNRESPONSIVE" } : { ok: true, path, spaceId: 5, pageLabel: "p1", url: "http://a/", title: "A", tabs: [] };
    });
    const sessionKey = "retry";
    const first = await service.screenshot({ sessionKey });
    fail = true;
    assert.equal((await service.screenshot({ sessionKey })).ok, false);
    assert.deepEqual(readdirSync(join(paths.attachmentsDir, "v1", "staging")), [], "a failed capture cleans its staging file");
    assert.equal(readdirSync(join(paths.attachmentsDir, "v1", "objects")).length, 1);
    assert.deepEqual(readFileSync(service.saveScreenshot({ sessionKey }).details.path), PNG);    assert.equal(readJsonSync(join(temp.dir, "sessions.json")).sessions[sessionKey].latestAttachment.id, first.details.attachment.id);
  } finally {
    temp.cleanup();
  }
});

test("a broken preferred directory falls back, and the recovered one is used again", async () => {
  const temp = tempDir("tools-shot-fallback");
  try {
    const { service, paths } = makeService(temp, async ({ script }) => {
      const path = cmdOf(script).path;
      writeFileSync(path, PNG);
      return { ok: true, path, spaceId: 5, pageLabel: "p1", url: "http://a/", title: "A", tabs: [] };
    });
    const sessionKey = "fallback";
    const preferred = join(temp.dir, "shots 目录", "ego pics");
    const set = service.setAttachmentsDir({ dir: preferred });
    assert.equal(set.ok, true);
    assert.ok(set.details.preferred.endsWith(join("shots 目录", "ego pics")));

    const first = await service.screenshot({ sessionKey });
    assert.equal(first.ok, true);
    assert.ok(first.details.path.startsWith(preferred));
    assert.equal(first.details.fallback, null);

    // The directory is gone; the configured path is now a file.
    rmSync(preferred, { recursive: true, force: true });
    writeFileSync(preferred, "blocked");
    const second = await service.screenshot({ sessionKey });
    assert.equal(second.ok, true);
    assert.ok(second.details.path.startsWith(paths.attachmentsDir), "the fallback capture lands in the default library");
    assert.ok(second.details.fallback?.reason);
    assert.match(second.text, /preferred folder/i);
    const summary = service.attachments({ sessionKey });
    assert.match(summary.text, /Preferred folder is not writable/);
    assert.match(summary.text, /Default folder is writable/);
    assert.match(summary.text, /Last screenshot saved to:/);
    assert.match(summary.text, /File:/);
    assert.equal(summary.details.preferred?.endsWith(join("shots 目录", "ego pics")), true, "the choice is kept");

    // Both pictures still resolve: the old one through its own root.
    const third = await service.reviewScreenshot({ sessionKey, id: first.details.attachment.id });
    assert.equal(third.ok, true);
    assert.equal(service.attachmentFile({ sessionKey, id: second.details.attachment.id }).ok, true);

    rmSync(preferred, { force: true });
    mkdirSync(preferred, { recursive: true });
    const fourth = await service.screenshot({ sessionKey });
    assert.equal(fourth.ok, true);
    assert.ok(fourth.details.path.startsWith(preferred), "the preferred directory is used again once writable");

    const reset = service.resetAttachmentsDir();
    assert.equal(reset.ok, true);
    assert.equal(reset.details.preferred, null);
    assert.equal(service.attachments({ sessionKey }).details.preferred, null);
  } finally {
    temp.cleanup();
  }
});

test("a 0.1.1 cached preview is published into the current library and the old file is untouched", async () => {
  const temp = tempDir("tools-shot-legacy");
  try {
    const { service, paths } = makeService(temp, async () => ({ ok: true }));
    const sessionKey = "legacy";
    const legacyName = "shot-2026-01-01T00-00-00-000Z-11111111-2222-3333-4444-555555555555.png";
    const dir = sessionShotDir(paths.screenshotCacheDir, sessionKey);
    mkdirSync(dir, { recursive: true });
    const legacyFile = join(dir, legacyName);
    writeFileSync(legacyFile, PNG);
    const legacyStat = statSync(legacyFile);
    service.store.update(sessionKey, { previewScreenshot: legacyName });

    const saved = service.saveScreenshot({ sessionKey });
    assert.equal(saved.ok, true, saved.message);
    assert.equal(saved.details.legacy, true);
    assert.ok(saved.details.path.startsWith(join(paths.attachmentsDir, "v1", "objects")), "the preview joins the library in effect now");
    assert.deepEqual(readFileSync(saved.details.path), PNG);
    assert.equal(saved.details.attachment.id, createHash("sha256").update(PNG).digest("hex"));
    assert.ok(existsSync(legacyFile), "0.1.1 files are not moved or deleted");
    assert.deepEqual(readFileSync(legacyFile), PNG);
    assert.equal(statSync(legacyFile).mtimeMs, legacyStat.mtimeMs, "the 0.1.1 cache file is not touched");
    assert.equal(existsSync(join(temp.dir, "screenshots")), false, "no export directory is created");

    // The same session now asks again: the library original is returned, once.
    const again = service.saveScreenshot({ sessionKey });
    assert.equal(again.ok, true);
    assert.equal(again.details.path, saved.details.path);
    assert.equal(readdirSync(join(paths.attachmentsDir, "v1", "objects")).length, 1);
  } finally {
    temp.cleanup();
  }
});

test("lookback accepts only this session's attachment IDs", async () => {
  const temp = tempDir("tools-shot-review");
  try {
    const { service } = makeService(temp, async ({ script }) => {
      const path = cmdOf(script).path;
      writeFileSync(path, PNG);
      return { ok: true, path, spaceId: 5, pageLabel: "p1", url: "http://a/", title: "A", tabs: [] };
    });
    const sessionKey = "review";
    const shot = await service.screenshot({ sessionKey });
    const id = shot.details.attachment.id;

    const looked = service.reviewScreenshot({ sessionKey, id });
    assert.equal(looked.ok, true);
    assert.equal(looked.details.review, true);
    assert.match(looked.text, /never written into the conversation/);
    assert.equal(looked.details.attachment.id, id);

    const prefix = service.reviewScreenshot({ sessionKey, id: id.slice(0, 12) });
    assert.equal(prefix.ok, true, "a unique prefix of a session ID is accepted");

    const foreign = service.reviewScreenshot({ sessionKey, id: "f".repeat(64) });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.code, "ATTACHMENT_NOT_IN_SESSION");

    const traversal = service.reviewScreenshot({ sessionKey, id: "../../../../Windows/win.ini" });
    assert.equal(traversal.ok, false);
    assert.equal(traversal.code, "ATTACHMENT_NOT_IN_SESSION");

    // Another session cannot use this ID either.
    const other = service.reviewScreenshot({ sessionKey: "someone-else", id });
    assert.equal(other.ok, false);
    assert.equal(other.code, "ATTACHMENT_NOT_IN_SESSION");
  } finally {
    temp.cleanup();
  }
});

test("handoff pauses the session until resume", async () => {
  const temp = tempDir("tools-handoff");
  try {
    let calls = 0;
    const { service } = makeService(temp, async ({ script }) => {
      calls += 1;
      if (kindOf(script) === "resume") {
        return { ok: true, spaceId: 5, pageLabel: "p1", url: "http://a/", title: "A", resumedFrom: "agentDelegatedToUser", snapshot: '- textbox "Notes" [@9]', tabs: [] };
      }
      return { ok: true, spaceId: 5, pageLabel: "p1", url: "http://a/", title: "A", handedOff: true, visible: true, tabs: [] };
    });
    const handoff = await service.handoff({ sessionKey: "s6", instruction: "fill the email field with a@b.c" });
    assert.equal(handoff.ok, true);
    assert.match(handoff.text, /\/ego-settings/);
    assert.match(handoff.text, /Resume Browser Control/);
    assert.match(handoff.text, /fill the email field with a@b\.c/);
    assert.equal(calls, 1);

    const refused = await service.open({ sessionKey: "s6", url: "http://b/" });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "HANDED_TO_USER");
    assert.equal(calls, 1, "no Ego run happens while the user has control");

    const status = await service.status({ sessionKey: "s6", doctor: { browser: "edge", endpoint: "running", spaces: [] } });
    assert.match(status.text, /Control: your turn/);

    const resumed = await service.resume({ sessionKey: "s6" });
    assert.equal(resumed.ok, true);
    assert.match(resumed.text, /Resumed browser control/);
    assert.match(resumed.text, /#1\.\.#1/);
    const after = await service.open({ sessionKey: "s6", url: "http://b/" });
    assert.equal(after.ok, true, "the session works again after resume");
  } finally {
    temp.cleanup();
  }
});

test("an uncertain click reports the late-effects hint", async () => {
  const temp = tempDir("tools-uncertain");
  try {
    const { service } = makeService(temp, async () => ({
      ok: false,
      code: "EGO_PAGE_UNRESPONSIVE",
      message: "page did not respond",
      mayHaveLateEffects: true,
      url: "http://a/",
      pageLabel: "p1",
      stdout: "",
      stderr: "",
    }));
    const outcome = await service.click({ sessionKey: "s7", target: "css=button" });
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /Uncertain result/);
    assert.equal(outcome.details.mayHaveLateEffects, true);
  } finally {
    temp.cleanup();
  }
});

test("status summarises browser, state root and session", async () => {
  const temp = tempDir("tools-status");
  try {
    const { service, paths } = makeService(temp, async () => baseResult);
    writeFileSync(
      paths.browserStateFile,
      JSON.stringify({ ok: true, source: "managed", version: "158.0.8127.88", path: "C:/chrome.exe", at: "2026-01-01T00:00:00Z" }),
    );
    writeFileSync(
      paths.spacesFile,
      JSON.stringify({ nextId: 2, currentId: 1, spaces: [{ id: 1, name: "space", ownership: "agent", targetIds: ["t1", "t2"] }] }),
    );
    const outcome = await service.status({ sessionKey: "never-used", doctor: { browser: "edge", endpoint: "not running", spaces: [{ id: 1, name: "space", ownership: "agent", tabs: 2 }] } });
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /Browser:/);
    assert.match(outcome.text, /management|managed/);
    assert.match(outcome.text, /No browser task space yet/);
    assert.match(outcome.text, /Control: Pi/);
    assert.equal(outcome.details.endpointRunning, false);
  } finally {
    temp.cleanup();
  }
});

/** One Pi session entry holding a screenshot tool result, as getBranch() returns it. */
function toolResultEntry(ref, toolName = "browser_screenshot") {
  return {
    type: "message",
    id: `entry-${ref.id.slice(0, 8)}`,
    message: {
      role: "toolResult",
      toolCallId: `call-${ref.id.slice(0, 8)}`,
      toolName,
      isError: false,
      content: [{ type: "text", text: `Attachment ID: ${ref.id}` }],
      details: { attachment: { ...ref }, path: null },
      timestamp: 1,
    },
  };
}

test("a lookback older than the short reference list is found through the session's own tool results", async () => {
  const temp = tempDir("tools-lookback-history");
  try {
    let counter = 0;
    const { service } = makeService(temp, async ({ script }) => {
      const path = cmdOf(script).path;
      counter += 1;
      writeFileSync(path, Buffer.concat([PNG, Buffer.from(`picture-${counter}`)]));
      return { ok: true, path, spaceId: 5, pageLabel: "p1", url: "http://a/", title: "A", tabs: [] };
    });
    const sessionKey = "history";
    const first = await service.screenshot({ sessionKey });
    await service.screenshot({ sessionKey });
    const third = await service.screenshot({ sessionKey });
    const id = first.details.attachment.id;
    assert.notEqual(id, third.details.attachment.id);

    // A long session: the short list has moved on to the newest pictures only.
    const record = readJsonSync(join(temp.dir, "sessions.json")).sessions[sessionKey];
    service.store.update(sessionKey, { attachments: [record.attachments[0]], latestAttachment: record.latestAttachment });
    const entries = [toolResultEntry(first.details.attachment), toolResultEntry(third.details.attachment)];

    // Without the session API the old row is genuinely gone from the record.
    const dropped = service.reviewScreenshot({ sessionKey, id });
    assert.equal(dropped.ok, false);
    assert.equal(dropped.code, "ATTACHMENT_NOT_IN_SESSION");

    // The session's own tool results locate it, and each row keeps its own root.
    const recovered = service.reviewScreenshot({ sessionKey, id, entries });
    assert.equal(recovered.ok, true, recovered.message);
    assert.equal(recovered.details.path, first.details.path);
    const byPrefix = service.attachmentFile({ sessionKey, id: id.slice(0, 10), entries });
    assert.equal(byPrefix.ok, true);
    assert.equal(byPrefix.details.path, first.details.path);
    assert.equal(service.attachmentFile({ sessionKey, id: first.details.attachment.id.slice(0, 6), entries }).ok, false, "a short prefix is still not a guess");
  } finally {
    temp.cleanup();
  }
});

test("a prefix shared by two different screenshots is refused instead of opening the first", async () => {
  const temp = tempDir("tools-ambiguous-prefix");
  try {
    const { service } = makeService(temp, async () => baseResult);
    const sessionKey = "ambiguous";
    const first = `${"deadbeef"}${"1".repeat(56)}`;
    const second = `${"deadbeef"}${"2".repeat(56)}`;
    const ref = (id) => ({
      schemaVersion: 1,
      id,
      rootId: "r-0123456789abcdef",
      bytes: 10,
      mime: "image/png",
      at: "2026-01-01T00:00:00.000Z",
    });
    service.store.update(sessionKey, { attachments: [ref(first), ref(second)], latestAttachment: ref(first) });

    const ambiguous = service.reviewScreenshot({ sessionKey, id: "deadbeef" });
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.code, "ATTACHMENT_ID_AMBIGUOUS");
    assert.match(ambiguous.message, /matches 2 different screenshots/);
    assert.equal(service.attachmentFile({ sessionKey, id: "deadbeef" }).code, "ATTACHMENT_ID_AMBIGUOUS");

    // One more character names exactly one digest; it then fails on the file, not on the prefix.
    const one = service.reviewScreenshot({ sessionKey, id: "deadbeef1" });
    assert.notEqual(one.code, "ATTACHMENT_ID_AMBIGUOUS");
  } finally {
    temp.cleanup();
  }
});

test("the same digest under two roots keeps both rows and reads each row's own root", async () => {
  const temp = tempDir("tools-two-roots");
  try {
    const { service, paths } = makeService(temp, async ({ script }) => {
      const path = cmdOf(script).path;
      writeFileSync(path, PNG);
      return { ok: true, path, spaceId: 5, pageLabel: "p1", url: "http://a/", title: "A", tabs: [] };
    });
    const sessionKey = "two-roots";
    const preferred = join(temp.dir, "external", "shots");
    service.setAttachmentsDir({ dir: preferred });
    const inPreferred = await service.screenshot({ sessionKey });
    assert.ok(inPreferred.details.path.startsWith(preferred));

    service.resetAttachmentsDir();
    const inDefault = await service.screenshot({ sessionKey });
    assert.equal(inDefault.details.attachment.id, inPreferred.details.attachment.id, "identical bytes share one ID");
    assert.notEqual(inDefault.details.attachment.rootId, inPreferred.details.attachment.rootId, "each root has its own root ID");

    const entries = [toolResultEntry(inPreferred.details.attachment), toolResultEntry(inDefault.details.attachment)];

    // The newest row's file is removed; the older row's original root still works.
    rmSync(inDefault.details.path, { force: true });
    const resolved = service.attachmentFile({ sessionKey, id: inPreferred.details.attachment.id, entries });
    assert.equal(resolved.ok, true, resolved.message);
    assert.equal(resolved.details.path, inPreferred.details.path);
    assert.ok(existsSync(join(paths.attachmentsDir, "v1", "objects", `${inPreferred.details.attachment.id}.png`)) === false);
  } finally {
    temp.cleanup();
  }
});

test("a large screenshot is viewable by ID and copied only to a named destination", async () => {
  const temp = tempDir("tools-large-shot");
  try {
    const big = Buffer.concat([PNG, Buffer.alloc(7 * 1024 * 1024, 0x41)]);
    const { service, paths } = makeService(temp, async ({ script }) => {
      const path = cmdOf(script).path;
      writeFileSync(path, big);
      return { ok: true, path, spaceId: 5, pageLabel: "p1", url: "http://a/", title: "Big page", tabs: [] };
    });
    const sessionKey = "large";
    const shot = await service.screenshot({ sessionKey });
    assert.equal(shot.ok, true, shot.message);
    assert.ok(shot.details.attachment.bytes > MAX_INLINE_ATTACHMENT_BYTES);
    assert.equal(JSON.stringify(shot.details).length < 2000, true, "the result stays small metadata");
    assert.equal(shot.details.path, join(paths.attachmentsDir, "v1", "objects", `${shot.details.attachment.id}.png`));

    // By ID for the OS viewer, and a normal save is the original, both without the inline cap.
    const opened = service.attachmentFile({ sessionKey, id: shot.details.attachment.id });
    assert.equal(opened.ok, true);
    assert.equal(opened.details.path, shot.details.path);
    assert.equal(service.reviewScreenshot({ sessionKey, id: shot.details.attachment.id }).ok, true);

    const saved = service.saveScreenshot({ sessionKey });
    assert.equal(saved.ok, true, saved.message);
    assert.equal(saved.details.path, shot.details.path);
    assert.equal(saved.details.savedOriginal, true);

    const targetDir = join(temp.dir, "explicit");
    mkdirSync(targetDir, { recursive: true });
    const copied = service.saveScreenshot({ sessionKey, path: join(targetDir, "big.png") });
    assert.equal(copied.ok, true, copied.message);
    assert.equal(copied.details.path !== shot.details.path, true);
    assert.equal(statSync(copied.details.path).size, big.length);
    assert.equal(readFileSync(copied.details.path).equals(big), true);
  } finally {
    temp.cleanup();
  }
});

test("the status list reports an offline preferred directory without recreating it", async () => {
  const temp = tempDir("tools-status-offline");
  try {
    const { service } = makeService(temp, async () => baseResult);
    const preferred = join(temp.dir, "unplugged", "shots");
    service.setAttachmentsDir({ dir: preferred });
    rmSync(preferred, { recursive: true, force: true });

    const summary = service.attachments({ sessionKey: "offline" });
    assert.match(summary.text, /Preferred folder is not writable/);
    assert.match(summary.text, /Default folder is writable/);
    assert.equal(existsSync(preferred), false, "status must not recreate the configured directory");
    assert.equal(summary.details.preferred, preferred, "the choice is kept");
  } finally {
    temp.cleanup();
  }
});
