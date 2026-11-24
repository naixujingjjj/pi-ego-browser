import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ATTACHMENT_SCHEMA_VERSION,
  AttachmentLibrary,
  attachmentDetails,
  formatBytes,
  MAX_INLINE_ATTACHMENT_BYTES,
  normalizeRootPath,
  OBJECT_ID,
  publishStagedPng,
  ROOT_ID,
  rootIdFor,
  sha256FileSync,
  sha256Hex,
  shortId,
} from "../src/attachments.js";
import { resolvePaths } from "../src/paths.js";
import { readJsonSync, writeJsonAtomic } from "../src/store.js";
import { tempDir } from "./helpers.mjs";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001",
  "hex",
);
const PNG_OTHER = Buffer.concat([PNG, Buffer.from("a different picture")]);

function libraryFor(temp, env = {}) {
  const environment = { PI_EGO_HOME: temp.dir, ...env };
  const paths = resolvePaths(environment);
  return { library: new AttachmentLibrary(paths), paths, environment };
}

function capture(library, bytes) {
  const staged = library.prepareCapture();
  writeFileSync(staged.stagingFile, bytes);
  const committed = library.commitCapture(staged, { pageLabel: "p1", url: "http://a/", title: "A" });
  return { staged, committed };
}

function stagingFiles(library) {
  const dir = join(library.defaultDir(), "v1", "staging");
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** Files in the stable local staging area, which is outside every library root. */
function localStagingFiles(library) {
  const dir = library.stagingDir();
  return existsSync(dir) ? readdirSync(dir) : [];
}

test("an attachment ID is the SHA-256 of the raw PNG and the staging file is gone", async () => {
  const temp = tempDir("attachments-publish");
  try {
    const { library, paths } = libraryFor(temp);
    const { staged, committed } = capture(library, PNG);

    assert.equal(committed.ok, true);
    assert.match(committed.ref.id, OBJECT_ID);
    assert.equal(committed.ref.id, sha256Hex(PNG));
    assert.equal(committed.ref.bytes, PNG.length);
    assert.equal(committed.ref.mime, "image/png");
    assert.match(committed.ref.rootId, ROOT_ID);
    assert.equal(committed.ref.schemaVersion, ATTACHMENT_SCHEMA_VERSION);
    assert.equal(committed.deduped, false);
    assert.equal(committed.path, join(paths.attachmentsDir, "v1", "objects", `${committed.ref.id}.png`));
    assert.deepEqual(readFileSync(committed.path), PNG);
    assert.equal(existsSync(staged.stagingFile), false, "the staging file must be consumed by the publish");
    assert.deepEqual(stagingFiles(library), []);
    assert.ok(committed.ref.at, "a capture records when it was published");

    const registry = readJsonSync(paths.attachmentsRootsFile);
    assert.equal(registry.roots[committed.ref.rootId].path, normalizeRootPath(paths.attachmentsDir));
    assert.equal(registry.roots[committed.ref.rootId].kind, "default");
  } finally {
    temp.cleanup();
  }
});

test("identical bytes in the same root are stored once", async () => {
  const temp = tempDir("attachments-dedupe");
  try {
    const { library } = libraryFor(temp);
    const first = capture(library, PNG);
    const second = capture(library, PNG);
    const third = capture(library, PNG_OTHER);

    assert.equal(second.committed.ref.id, first.committed.ref.id);
    assert.equal(second.committed.deduped, true);
    assert.equal(second.committed.path, first.committed.path);
    assert.notEqual(third.committed.ref.id, first.committed.ref.id);

    const objects = readdirSync(join(library.defaultDir(), "v1", "objects")).sort();
    assert.equal(objects.length, 2, `expected two objects, got ${objects.join(", ")}`);
    assert.deepEqual(stagingFiles(library), []);
  } finally {
    temp.cleanup();
  }
});

test("a non-PNG or empty staging file is refused and cleaned up", async () => {
  const temp = tempDir("attachments-invalid");
  try {
    const { library } = libraryFor(temp);
    const notPng = library.prepareCapture();
    writeFileSync(notPng.stagingFile, "not a png at all");
    assert.throws(() => library.commitCapture(notPng, {}), /not PNG|不是 PNG|ATTACHMENT_NOT_PNG/);
    library.discardStaging(notPng);
    assert.equal(existsSync(notPng.stagingFile), false);

    const empty = library.prepareCapture();
    writeFileSync(empty.stagingFile, Buffer.alloc(0));
    assert.throws(() => library.commitCapture(empty, {}), /空文件|ATTACHMENT_EMPTY|EMPTY/);
    library.discardStaging(empty);
    assert.deepEqual(stagingFiles(library), []);
  } finally {
    temp.cleanup();
  }
});

test("a preferred directory with spaces is persisted, used, and survives a fresh instance", async () => {
  const temp = tempDir("attachments-preferred");
  try {
    const { library, paths } = libraryFor(temp);
    const preferred = join(temp.dir, "截图 与 素材", "browser shots");
    mkdirSync(preferred, { recursive: true });
    const set = library.setPreferred(preferred);
    assert.equal(set, preferred);
    assert.equal(library.preferredDir(), preferred);
    assert.equal(readJsonSync(paths.attachmentsConfigFile).preferred, preferred);

    const { committed } = capture(library, PNG);
    assert.equal(committed.rootPath, preferred);
    assert.equal(committed.ref.fallback, null);
    assert.ok(committed.path.startsWith(join(preferred, "v1", "objects")));
    assert.equal(existsSync(join(paths.attachmentsDir, "v1", "objects")), false, "the default library stays empty");

    // A new process has no in-memory state: the registry and config are enough.
    const restarted = new AttachmentLibrary(resolvePaths({ PI_EGO_HOME: temp.dir }));
    assert.equal(restarted.preferredDir(), preferred);
    const loaded = restarted.load(committed.ref);
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.data, PNG);
    assert.equal(loaded.rootPath, preferred);

    const reset = restarted.resetPreferred();
    assert.equal(reset, normalizeRootPath(paths.attachmentsDir));
    assert.equal(restarted.preferredDir(), null);
    const afterReset = capture(restarted, PNG_OTHER);
    assert.equal(afterReset.committed.rootPath, normalizeRootPath(paths.attachmentsDir));
    assert.equal(restarted.load(committed.ref).ok, true, "the old reference still resolves through its own root");
    assert.equal(restarted.load(afterReset.committed.ref).ok, true);
  } finally {
    temp.cleanup();
  }
});

test("a capture that is not a PNG is refused instead of being republished elsewhere", async () => {
  const temp = tempDir("attachments-not-png-fallback");
  try {
    const { library, paths } = libraryFor(temp);
    const preferred = join(temp.dir, "preferred");
    library.setPreferred(preferred);
    const staged = library.prepareCapture();
    assert.equal(staged.rootPath, preferred);
    writeFileSync(staged.stagingFile, "not a png");
    assert.throws(
      () => library.commitCapture(staged, {}),
      (error) => {
        assert.equal(error.code, "ATTACHMENT_NOT_PNG");
        return true;
      },
    );
    library.discardStaging(staged);
    const objectsDir = join(paths.attachmentsDir, "v1", "objects");
    assert.deepEqual(existsSync(objectsDir) ? readdirSync(objectsDir) : [], [], "a bad capture must not reach the fallback library");
  } finally {
    temp.cleanup();
  }
});

test("a broken preferred directory falls back for that capture and is kept for later", async () => {
  const temp = tempDir("attachments-fallback");
  try {
    const { library, paths } = libraryFor(temp);
    const preferred = join(temp.dir, "usb-shot-library");
    library.setPreferred(preferred);

    // The drive/directory is gone; the path itself is now a file.
    rmSync(preferred, { recursive: true, force: true });
    writeFileSync(preferred, "not a directory");

    const { committed } = capture(library, PNG);
    assert.equal(committed.rootPath, normalizeRootPath(paths.attachmentsDir));
    assert.equal(committed.ref.fallback?.stage, "staging");
    assert.match(committed.ref.fallback?.reason || "", /\S/);
    assert.ok(committed.path.startsWith(join(paths.attachmentsDir, "v1", "objects")));
    assert.equal(library.load(committed.ref).ok, true, "the fallback copy is a normal attachment");
    assert.equal(library.preferredDir(), preferred, "the user's choice must survive a fallback");

    // The directory comes back: the next capture uses it again.
    rmSync(preferred, { force: true });
    mkdirSync(preferred, { recursive: true });
    const second = capture(library, PNG_OTHER);
    assert.equal(second.committed.rootPath, preferred);
    assert.equal(second.committed.ref.fallback, null);
  } finally {
    temp.cleanup();
  }
});

test("a root that breaks between capture and publish keeps the screenshot in the default library", async () => {
  const temp = tempDir("attachments-publish-fallback");
  try {
    const { library, paths } = libraryFor(temp);
    const preferred = join(temp.dir, "removable", "shots");
    library.setPreferred(preferred);

    const staged = library.prepareCapture();
    assert.equal(staged.rootPath, preferred);
    writeFileSync(staged.stagingFile, PNG);
    // The library directory is replaced by a file after the capture was staged.
    rmSync(join(preferred, "v1", "objects"), { recursive: true, force: true });
    writeFileSync(join(preferred, "v1", "objects"), "blocked");

    const committed = library.commitCapture(staged, { pageLabel: "p2", url: "http://b/", title: "B" });
    assert.equal(committed.rootPath, normalizeRootPath(paths.attachmentsDir));
    assert.equal(committed.ref.fallback?.stage, "publish");
    assert.ok(committed.ref.fallback?.reason);
    assert.deepEqual(readFileSync(committed.path), PNG);
    assert.equal(existsSync(staged.stagingFile), false);
  } finally {
    temp.cleanup();
  }
});

test("with neither root writable the capture fails clearly and creates no reference", async () => {
  const temp = tempDir("attachments-unwritable");
  try {
    const { library, paths } = libraryFor(temp);
    const preferred = join(temp.dir, "preferred");
    library.setPreferred(preferred);
    rmSync(preferred, { recursive: true, force: true });
    writeFileSync(preferred, "file");

    mkdirSync(paths.stateRoot, { recursive: true });
    rmSync(paths.attachmentsDir, { recursive: true, force: true });
    writeFileSync(paths.attachmentsDir, "file");

    assert.throws(
      () => library.prepareCapture(),
      (error) => {
        assert.equal(error.code, "ATTACHMENT_UNWRITABLE");
        assert.match(error.message, new RegExp(preferred.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
        assert.match(error.message, /attachments/);
        assert.equal(error.details.failures.length, 2);
        return true;
      },
    );
    const registry = readJsonSync(paths.attachmentsRootsFile);
    const defaultRootId = rootIdFor(normalizeRootPath(paths.attachmentsDir));
    assert.equal(registry.roots[defaultRootId], undefined, "a failed capture must not register a root");
  } finally {
    temp.cleanup();
  }
});

test("references resolve only through the root registry and are verified by digest", async () => {
  const temp = tempDir("attachments-resolve");
  try {
    const { library, paths } = libraryFor(temp);
    const { committed } = capture(library, PNG);
    const ref = committed.ref;

    assert.equal(library.locate({ id: ref.id.toUpperCase(), rootId: ref.rootId }).ok, true);

    const traversal = library.locate({ id: "../../../etc/passwd", rootId: ref.rootId });
    assert.equal(traversal.ok, false);
    assert.equal(traversal.code, "ATTACHMENT_ID_INVALID");

    const unknownRoot = library.locate({ id: ref.id, rootId: "r-0000000000000000" });
    assert.equal(unknownRoot.ok, false);
    assert.equal(unknownRoot.code, "ATTACHMENT_ROOT_UNKNOWN");
    assert.match(unknownRoot.message, /不会去别的目录找/);

    const badRootId = library.locate({ id: ref.id, rootId: "..\\..\\windows" });
    assert.equal(badRootId.code, "ATTACHMENT_ROOT_INVALID");

    // A registry entry that no longer matches its path is not trusted.
    const registry = readJsonSync(paths.attachmentsRootsFile);
    const originalPath = registry.roots[ref.rootId].path;
    registry.roots[ref.rootId].path = join(temp.dir, "somewhere else");
    writeJsonAtomic(paths.attachmentsRootsFile, registry);
    const moved = library.locate(ref);
    assert.equal(moved.ok, false);
    assert.equal(moved.code, "ATTACHMENT_ROOT_INVALID");

    registry.roots[ref.rootId].path = originalPath;
    writeJsonAtomic(paths.attachmentsRootsFile, registry);
    assert.equal(library.locate(ref).ok, true);

    // Same ID, different bytes: refuse instead of showing another picture.
    writeFileSync(committed.path, PNG_OTHER);
    const corrupt = library.load(ref);
    assert.equal(corrupt.ok, false);
    assert.equal(corrupt.code, "ATTACHMENT_CORRUPT");

    rmSync(committed.path, { force: true });
    const missing = library.locate(ref);
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "ATTACHMENT_MISSING");
    assert.match(missing.message, /离线|不存在/);
  } finally {
    temp.cleanup();
  }
});

test("a path that is a file is refused when set as the preferred directory", async () => {
  const temp = tempDir("attachments-set-file");
  try {
    const { library } = libraryFor(temp);
    const file = join(temp.dir, "not-a-directory");
    writeFileSync(file, "x");
    assert.throws(() => library.setPreferred(file), (error) => {
      assert.equal(error.code, "ATTACHMENT_PATH_IS_FILE");
      return true;
    });
    assert.throws(() => library.setPreferred(file), /is a file\. Choose a folder/);
    assert.equal(library.preferredDir(), null);
  } finally {
    temp.cleanup();
  }
});

test("path normalization and root IDs are stable and refuse relative input", async () => {
  const temp = tempDir("attachments-ids");
  try {
    assert.throws(() => normalizeRootPath(""), /Enter a screenshot folder/);
    assert.throws(() => normalizeRootPath("   "), /Enter a screenshot folder/);
    assert.throws(() => normalizeRootPath("relative/dir"), /absolute path/);
    assert.equal(normalizeRootPath(temp.dir), normalizeRootPath(`${temp.dir}\\`));
    const driveRoot = normalizeRootPath("F:/");
    assert.match(driveRoot, /^F:\\$/);
    const id = rootIdFor(temp.dir);
    assert.match(id, ROOT_ID);
    assert.equal(id, rootIdFor(`${temp.dir.toUpperCase()}\\`), "Windows paths are case-insensitive");
    assert.notEqual(id, rootIdFor(join(temp.dir, "other")));

    assert.equal(shortId("a".repeat(64)), "aaaaaaaaaaaa");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(2048), "2.0 KB");

    const details = attachmentDetails({
      schemaVersion: 1,
      id: "a".repeat(64),
      rootId: "r-0123456789abcdef",
      bytes: 10,
      mime: "image/png",
      pageLabel: "p1",
      url: "http://a/",
      title: "A",
      at: "2026-01-01T00:00:00.000Z",
      path: "C:/secret/path.png",
      data: "base64",
    });
    assert.equal(JSON.stringify(details).includes("base64"), false);
    assert.equal(JSON.stringify(details).includes("C:/secret"), false);
    assert.equal(details.id, "a".repeat(64));
  } finally {
    temp.cleanup();
  }
});
test("captures are staged in the stable local area, outside every library root", async () => {
  const temp = tempDir("attachments-staging-area");
  try {
    const { library, paths } = libraryFor(temp);
    const preferred = join(temp.dir, "removable", "shots");
    library.setPreferred(preferred);

    const staged = library.prepareCapture();
    assert.equal(staged.rootPath, preferred, "the capture targets the preferred root");
    assert.ok(staged.stagingFile.startsWith(paths.stagingDir), `staging file escaped the local area: ${staged.stagingFile}`);
    assert.equal(staged.stagingFile.startsWith(preferred), false, "the only copy must not start on the removable root");
    assert.equal(staged.stagingFile.startsWith(paths.attachmentsDir), false);

    writeFileSync(staged.stagingFile, PNG);
    const committed = library.commitCapture(staged, { pageLabel: "p1" });
    assert.equal(committed.ok, true);
    assert.deepEqual(readFileSync(committed.path), PNG);
    assert.deepEqual(localStagingFiles(library), [], "the local staging file is consumed");
    assert.deepEqual(stagingFiles(library), []);
  } finally {
    temp.cleanup();
  }
});

test("a preferred directory that disappears is not recreated, and the capture still lands", async () => {
  const temp = tempDir("attachments-preferred-gone");
  try {
    const { library, paths } = libraryFor(temp);
    const preferred = join(temp.dir, "usb", "shots");
    library.setPreferred(preferred);
    assert.equal(statSync(preferred).isDirectory(), true, "set may create the chosen directory");

    // The whole path is gone: not a file, not a directory, just missing.
    rmSync(preferred, { recursive: true, force: true });
    assert.equal(existsSync(preferred), false);

    const probed = library.probe(preferred);
    assert.equal(probed.ok, false);
    assert.match(probed.reason, /不存在|离线/);
    assert.equal(existsSync(preferred), false, "a status probe must not recreate the preferred path");

    const staged = library.prepareCapture();
    assert.equal(staged.rootPath, normalizeRootPath(paths.attachmentsDir));
    assert.equal(staged.kind, "default");
    assert.equal(staged.fallbackReason?.path, preferred);
    assert.equal(existsSync(preferred), false, "a capture must not recreate the preferred path either");
    writeFileSync(staged.stagingFile, PNG);
    const committed = library.commitCapture(staged, {});
    assert.equal(committed.ok, true);
    assert.equal(committed.ref.fallback?.stage, "staging");
    assert.ok(committed.path.startsWith(join(paths.attachmentsDir, "v1", "objects")));
    assert.equal(library.load(committed.ref).ok, true);
    assert.equal(library.preferredDir(), preferred, "the choice survives the fallback");

    // The directory is back: the very next capture uses it again.
    mkdirSync(preferred, { recursive: true });
    const second = library.prepareCapture();
    assert.equal(second.rootPath, preferred);
    assert.equal(second.fallbackReason, null);
    writeFileSync(second.stagingFile, PNG_OTHER);
    assert.equal(library.commitCapture(second, {}).rootPath, preferred);
  } finally {
    temp.cleanup();
  }
});

test("an offline original fails clearly and resolves again when the drive returns", async () => {
  const temp = tempDir("attachments-offline");
  try {
    const { library } = libraryFor(temp);
    const preferred = join(temp.dir, "offline-disk", "shots");
    library.setPreferred(preferred);
    const { committed } = capture(library, PNG);
    assert.equal(committed.rootPath, preferred);

    const offline = `${preferred}.unplugged`;
    renameSync(preferred, offline);
    const located = library.locate(committed.ref);
    assert.equal(located.ok, false);
    assert.equal(located.code, "ATTACHMENT_MISSING");
    assert.match(located.message, /离线|不存在/);
    assert.equal(library.verify(committed.ref).code, "ATTACHMENT_MISSING");
    assert.equal(library.load(committed.ref).ok, false);
    assert.equal(existsSync(preferred), false, "resolving must not recreate the missing root");

    renameSync(offline, preferred);
    const loaded = library.load(committed.ref);
    assert.equal(loaded.ok, true, loaded.message);
    assert.deepEqual(loaded.data, PNG);
    assert.equal(loaded.rootPath, preferred);
  } finally {
    temp.cleanup();
  }
});

test("a large screenshot is stored, verified and only limited inline", async () => {
  const temp = tempDir("attachments-large");
  try {
    const { library } = libraryFor(temp);
    const big = Buffer.concat([PNG, Buffer.alloc(7 * 1024 * 1024, 0x5a)]);
    assert.ok(big.length > MAX_INLINE_ATTACHMENT_BYTES);
    const { committed } = capture(library, big);

    assert.equal(committed.ref.bytes, big.length);
    assert.equal(committed.ref.id, sha256FileSync(committed.path));
    assert.equal(library.locate(committed.ref).ok, true, "storage itself has no size limit");
    assert.equal(library.verify(committed.ref).ok, true, "the digest is computed in chunks");

    const inline = library.load(committed.ref, { maxBytes: MAX_INLINE_ATTACHMENT_BYTES });
    assert.equal(inline.ok, false);
    assert.equal(inline.code, "ATTACHMENT_TOO_LARGE");
    assert.match(inline.message, /按路径打开/);
    assert.match(inline.message, /另存/);
    assert.equal(inline.data, undefined, "an oversized picture is not read for an inline surface");

    const loaded = library.load(committed.ref);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.data.length, big.length);
  } finally {
    temp.cleanup();
  }
});

test("a junction inside the library cannot point a reference outside its root", async () => {
  const temp = tempDir("attachments-junction");
  try {
    const { library } = libraryFor(temp);
    const { committed } = capture(library, PNG);
    const objectsDir = join(library.defaultDir(), "v1", "objects");
    const outside = join(temp.dir, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, `${committed.ref.id}.png`), PNG);

    const displaced = join(temp.dir, "objects-real");
    renameSync(objectsDir, displaced);
    try {
      symlinkSync(outside, objectsDir, "junction");
    } catch (error) {
      renameSync(displaced, objectsDir);
      // A restricted Windows account may not create junctions at all.
      assert.ok(String(error?.code || "").length > 0);
      return;
    }
    try {
      const loaded = library.load(committed.ref);
      assert.equal(loaded.ok, false, "a junction to another directory must not be read");
      assert.equal(loaded.code, "ATTACHMENT_OUTSIDE_ROOT");
      assert.match(loaded.message, /超出了登记的存储根/);
    } finally {
      rmSync(objectsDir, { recursive: true, force: true });
      renameSync(displaced, objectsDir);
    }
    assert.equal(library.load(committed.ref).ok, true);
  } finally {
    temp.cleanup();
  }
});

test("the staging sweep deletes only this extension's own abandoned files", async () => {
  const temp = tempDir("attachments-sweep");
  try {
    const { library, paths } = libraryFor(temp);
    const local = library.stagingDir();
    const libraryStaging = join(paths.attachmentsDir, "v1", "staging");
    mkdirSync(local, { recursive: true });
    mkdirSync(libraryStaging, { recursive: true });

    const old = Date.now() / 1000 - 48 * 60 * 60;
    const files = {
      owned: join(local, "capture-old.png"),
      foreign: join(local, "keep-me.png"),
      fresh: join(local, `probe-now-${process.pid}.tmp`),
      libraryOwned: join(libraryStaging, "publish-old.tmp"),
      libraryForeign: join(libraryStaging, "someone-elses.tmp"),
    };
    for (const file of Object.values(files)) writeFileSync(file, "x");
    for (const file of [files.owned, files.foreign, files.libraryOwned, files.libraryForeign]) utimesSync(file, old, old);

    library.sweepStaging();
    assert.equal(existsSync(files.owned), false, "an old capture leftover is removed");
    assert.equal(existsSync(files.foreign), true, "an unknown file in the staging area is kept");
    assert.equal(existsSync(files.fresh), true, "a fresh staging file is kept");
    assert.equal(existsSync(files.libraryOwned), false, "an old publish leftover inside a library root is removed");
    assert.equal(existsSync(files.libraryForeign), true);
  } finally {
    temp.cleanup();
  }
});

test("a cross-volume publish lands atomically through the target library's own staging", async () => {
  const temp = tempDir("attachments-cross-device");
  try {
    const { library, paths } = libraryFor(temp);
    mkdirSync(library.stagingDir(), { recursive: true });
    const staging = join(library.stagingDir(), "capture-cross.png");
    writeFileSync(staging, PNG);

    const published = publishStagedPng({ stagingFile: staging, rootPath: paths.attachmentsDir, forceCopy: true });
    assert.equal(published.id, sha256Hex(PNG));
    assert.equal(published.deduped, false);
    assert.deepEqual(readFileSync(published.path), PNG);
    assert.equal(existsSync(staging), false, "the source staging file is consumed");
    assert.deepEqual(stagingFiles(library), [], "no library-local staging file is left behind");
    assert.deepEqual(localStagingFiles(library), []);

    const registry = library.registerRoot(paths.attachmentsDir, "default");
    const loaded = library.load({ id: published.id, rootId: registry.id });
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.data, PNG);
  } finally {
    temp.cleanup();
  }
});

test("a capture into a root that is already gone falls back and keeps the local file", async () => {
  const temp = tempDir("attachments-root-vanished");
  try {
    const { library, paths } = libraryFor(temp);
    const preferred = join(temp.dir, "vanishing", "shots");
    library.setPreferred(preferred);

    const staged = library.prepareCapture();
    assert.equal(staged.rootPath, preferred);
    writeFileSync(staged.stagingFile, PNG);
    // The root is unplugged after the capture: the staging file is still local.
    rmSync(preferred, { recursive: true, force: true });
    const committed = library.commitCapture(staged, { pageLabel: "p9" });
    assert.equal(committed.ok, true);
    assert.equal(committed.ref.fallback?.stage, "publish");
    assert.equal(committed.rootPath, normalizeRootPath(paths.attachmentsDir));
    assert.deepEqual(readFileSync(committed.path), PNG);
    assert.equal(existsSync(preferred), false, "the vanished preferred root is not recreated");
    assert.deepEqual(localStagingFiles(library), []);
  } finally {
    temp.cleanup();
  }
});
