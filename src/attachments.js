// Content-addressed attachment library for screenshots.
//
// A capture writes exactly one PNG into the stable local staging area under the
// Pi state root (never inside a library root, so an unplugged drive cannot take
// the only copy with it). On success that file is verified, digested, and
// renamed to `<root>/v1/objects/<sha256>.png`: the SHA-256 of the raw PNG bytes
// is the attachment ID, so identical content published into the same root is
// stored once. The session record and the tool result only ever hold that ID, the
// byte count, the MIME type and the ID of the storage root, never image bytes.
//
// The root registry is what makes an ID resolvable later: a reference stores the
// root ID it was published under, the registry maps that ID to the absolute
// directory it was written to, and resolution refuses an unregistered or moved
// root instead of guessing. Changing the preferred directory therefore only
// affects new captures; older references keep resolving through their own root.
//
// Size is a storage decision, not a correctness one: a large PNG is stored,
// verified, opened and copied explicitly like any other. Only the inline
// surfaces (the
// model request and the TUI row) apply the 6 MiB limit, and they check the file
// size before reading, so a big screenshot is never pulled into memory for them.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { readJsonSync, writeJsonAtomic } from "./store.js";

/** Version of the metadata this module writes into session records and details. */
export const ATTACHMENT_SCHEMA_VERSION = 1;
export const ATTACHMENT_MIME = "image/png";
/** A raw PNG is identified by the lowercase hex SHA-256 of its bytes. */
export const OBJECT_ID = /^[a-f0-9]{64}$/;
/** `r-` plus the first 16 hex characters of the SHA-256 of the root's path. */
export const ROOT_ID = /^r-[a-f0-9]{16}$/;
/**
 * Largest image that may be attached inline (one model request, one expanded
 * TUI row). Anything bigger is still stored, and can still be opened by ID or
 * built-in surfaces. A picture bigger than the limit is still stored, opened by
 * ID and copied to a destination the user names.
 */
export const MAX_INLINE_ATTACHMENT_BYTES = 6 * 1024 * 1024;
/** Former name of the inline limit, kept for callers that still import it. */
export const MAX_ATTACHMENT_BYTES = MAX_INLINE_ATTACHMENT_BYTES;
/** Layout version below a library root; a new layout gets a new directory. */
export const LIBRARY_VERSION = "v1";

const PNG_MAGIC = Buffer.from("89504e470d0a1a0a", "hex");
const OBJECTS = "objects";
const STAGING = "staging";
const MIN_ID_PREFIX = 8;
const DIGEST_CHUNK = 1024 * 1024;
/**
 * Only files this extension creates as staging are ever scanned or deleted.
 * Everything else in a directory is left alone, whoever owns it.
 */
const OWNED_STAGING_FILE = /^(?:capture|copy|publish|probe)-[a-z0-9-]+\.(?:png|tmp)$/i;
/** A staging file this old is a leftover, not somebody's in-flight capture. */
const STALE_STAGING_MS = 24 * 60 * 60 * 1000;

export class AttachmentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AttachmentError";
    this.code = code;
    this.details = details;
  }
}

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * SHA-256 of a file, read in fixed-size chunks.
 * A large original is never held in memory just to be identified.
 */
export function sha256FileSync(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(DIGEST_CHUNK);
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(read === buffer.length ? buffer : buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Short form of an attachment ID, for text that a human reads. */
export function shortId(id) {
  return String(id ?? "").slice(0, 12);
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** Strip a trailing separator, keeping a drive or UNC root intact. */
function withoutTrailingSeparator(value) {
  if (!value) return value;
  const collapsed = value.length > 1 ? value.replace(/[\\/]+$/, "") : value;
  if (/^[A-Za-z]:$/.test(collapsed)) return `${collapsed[0].toUpperCase()}:\\`;
  return collapsed || value;
}

/**
 * Turn user input into an absolute, normalized library directory.
 * Relative paths, empty values and unreadable input are refused; the caller
 * gets a message it can show instead of a path that silently means something
 * else (`resolve()` would anchor a relative path to the current directory).
 */
export function normalizeRootPath(value) {
  const text = String(value ?? "").trim();
  if (!text) throw new AttachmentError("ATTACHMENT_PATH_INVALID", "Enter a screenshot folder.");
  const expanded = text.replace(/^~(?=$|[\\/])/, () => homedir());
  if (!isAbsolute(expanded)) {
    throw new AttachmentError("ATTACHMENT_PATH_INVALID", `The screenshot folder must be an absolute path. Received: ${text}.`);
  }
  return withoutTrailingSeparator(resolve(expanded));
}

export function rootIdFor(rootPath) {
  const normalized = normalizeRootPath(rootPath);
  const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return `r-${sha256Hex(key).slice(0, 16)}`;
}

/** Human-readable reason for a failed filesystem operation, for the user. */
export function describeFileError(error) {
  const code = String(error?.code || "");
  // An AttachmentError already carries a message written for the user.
  if (code && !/^E[A-Z0-9]+$/.test(code)) return String(error?.message || code);
  const known = {
    ENOENT: "the folder does not exist, or the drive is offline",
    ENOTDIR: "part of the path is a file, not a folder",
    EACCES: "no write permission",
    EPERM: "no write permission",
    EROFS: "the drive is read-only",
    ENOSPC: "not enough free space",
    EBUSY: "another program is holding the file",
    EEXIST: "a file with that name already exists",
    EMFILE: "too many open files",
    EIO: "the disk read failed",
    ENOBUFS: "not enough system buffers",
    EXDEV: "the destination is on another drive",
  };
  const label = known[code] || String(error?.message || error || "unknown error");
  return code ? `${label} (${code})` : label;
}

function statOf(path) {
  try {
    return statSync(path, { throwIfNoEntry: false }) || null;
  } catch {
    return null;
  }
}

/** Real path with junctions resolved. `native` is what resolves a Windows junction. */
function realPathOf(path) {
  const realpath = typeof realpathSync.native === "function" ? realpathSync.native : realpathSync;
  return realpath(path);
}

function isPng(data) {
  return Buffer.isBuffer(data) && data.length > PNG_MAGIC.length && data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

/** PNG signature check that reads the first eight bytes only. */
function isPngFile(path) {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.allocUnsafe(PNG_MAGIC.length);
    const read = readSync(fd, head, 0, head.length, 0);
    return read === PNG_MAGIC.length && head.equals(PNG_MAGIC);
  } finally {
    closeSync(fd);
  }
}

function objectPathOf(rootPath, id) {
  return join(rootPath, LIBRARY_VERSION, OBJECTS, `${id}.png`);
}

function libraryDirFor(rootPath) {
  return join(rootPath, LIBRARY_VERSION);
}

/** Create the object and staging directories below an existing library root. */
function ensureLibraryDir(rootPath) {
  mkdirSync(join(rootPath, LIBRARY_VERSION, OBJECTS), { recursive: true });
  mkdirSync(join(rootPath, LIBRARY_VERSION, STAGING), { recursive: true });
  return libraryDirFor(rootPath);
}

/** Is `child` inside `parent` (both absolute, normalized)? */
function isInside(parent, child) {
  const within = relative(parent, child);
  return Boolean(within) && !within.startsWith("..") && !isAbsolute(within);
}

function removeQuietly(path) {
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

function sameDevice(a, b) {
  const left = statOf(a);
  const right = statOf(b);
  if (!left || !right) return false;
  return left.dev === right.dev;
}

/**
 * Verify, digest and publish one staged PNG into one library root.
 *
 * The same volume is a single atomic rename. A different volume (a removable
 * library root) first copies the bytes onto a unique staging file inside the
 * target library, then renames inside that volume: the object appears
 * atomically and no half-written PNG is ever addressable by its ID. `forceCopy`
 * exercises that path without needing a second volume.
 */
export function publishStagedPng({ stagingFile, rootPath, forceCopy = false, createRoot = true }) {
  const info = statOf(stagingFile);
  if (!info?.isFile()) {
    throw new AttachmentError("ATTACHMENT_MISSING", "The staging file is gone, so this screenshot cannot be saved.", { stagingFile });
  }
  if (info.size === 0) throw new AttachmentError("ATTACHMENT_EMPTY", "The screenshot file is empty.", { stagingFile });
  if (!isPngFile(stagingFile)) throw new AttachmentError("ATTACHMENT_NOT_PNG", "The screenshot is not a PNG file.", { bytes: info.size });

  const id = sha256FileSync(stagingFile);
  const resolvedRoot = normalizeRootPath(rootPath);
  const rootInfo = statOf(resolvedRoot);
  if (rootInfo && !rootInfo.isDirectory()) {
    throw new AttachmentError("ATTACHMENT_PATH_IS_FILE", `"${resolvedRoot}" is a file, not a folder.`, { path: resolvedRoot });
  }
  if (!rootInfo && !createRoot) {
    throw new AttachmentError(
      "ATTACHMENT_ROOT_UNAVAILABLE",
      `The attachment library ${resolvedRoot} is unavailable right now: the folder does not exist, or the drive / mount point is offline.`,
      { path: resolvedRoot },
    );
  }
  const libraryDir = ensureLibraryDir(resolvedRoot);
  const target = objectPathOf(resolvedRoot, id);
  const result = (deduped) => ({
    id,
    rootId: rootIdFor(resolvedRoot),
    rootPath: resolvedRoot,
    path: target,
    bytes: info.size,
    mime: ATTACHMENT_MIME,
    deduped,
  });

  if (existsSync(target)) {
    const existing = statOf(target);
    if (!existing?.isFile() || existing.size !== info.size || sha256FileSync(target) !== id) {
      throw new AttachmentError("ATTACHMENT_CORRUPT", `The attachment library already holds ${id.slice(0, 12)}…, but its content does not match the ID.`, { path: target });
    }
    removeQuietly(stagingFile);
    return result(true);
  }

  const publishByCopy = () => {
    const local = join(libraryDir, STAGING, `publish-${Date.now().toString(36)}-${randomUUID()}.tmp`);
    try {
      copyFileSync(stagingFile, local);
      renameSync(local, target);
    } catch (error) {
      removeQuietly(local);
      throw error;
    }
    removeQuietly(stagingFile);
  };

  try {
    if (forceCopy || !sameDevice(stagingFile, resolvedRoot)) publishByCopy();
    else renameSync(stagingFile, target);
  } catch (error) {
    // A failed rename can still leave a usable source (permissions, a drive that
    // changed its mind, EXDEV). One copy-through-local-staging retry covers all
    // of those; only then is this a publish failure.
    let second = null;
    try {
      publishByCopy();
    } catch (copyError) {
      second = copyError;
    }
    if (!second) return result(false);
    // The name is the digest, so a concurrent publish of identical bytes is
    // harmless: accept the object that is already there.
    if (existsSync(target)) {
      const existing = statOf(target);
      if (existing?.isFile() && existing.size === info.size && sha256FileSync(target) === id) {
        removeQuietly(stagingFile);
        return result(true);
      }
    }
    throw new AttachmentError(
      "ATTACHMENT_PUBLISH_FAILED",
      `Writing to the attachment library ${resolvedRoot} failed: ${describeFileError(second)}`,
      { path: resolvedRoot, reason: describeFileError(second), cause: String(second?.code || "") },
    );
  }
  return result(false);
}

/**
 * The attachment library of one state root. All writes are staged-then-renamed;
 * config and root registry writes reuse `writeJsonAtomic()`.
 */
export class AttachmentLibrary {
  constructor(paths) {
    if (!paths?.attachmentsDir) throw new Error("AttachmentLibrary needs resolvePaths() output");
    this.paths = paths;
  }

  defaultDir() {
    return normalizeRootPath(this.paths.attachmentsDir);
  }

  /** The stable local staging area; never inside a library root. */
  stagingDir() {
    return this.paths.stagingDir
      ? normalizeRootPath(this.paths.stagingDir)
      : join(normalizeRootPath(this.paths.stateRoot), STAGING);
  }

  #config() {
    const state = readJsonSync(this.paths.attachmentsConfigFile, null);
    if (!state || typeof state !== "object" || typeof state.preferred !== "string" || !state.preferred.trim()) {
      return { preferred: null, updatedAt: state?.updatedAt || null, invalid: state?.preferred ?? null };
    }
    try {
      return { preferred: normalizeRootPath(state.preferred), updatedAt: state.updatedAt || null, invalid: null };
    } catch (error) {
      return { preferred: null, updatedAt: state.updatedAt || null, invalid: state.preferred, error: describeFileError(error) };
    }
  }

  /** The configured preferred directory, or null when the default is used. */
  preferredDir() {
    return this.#config().preferred;
  }

  configState() {
    const config = this.#config();
    return { preferred: config.preferred, invalid: config.invalid, error: config.error || null, updatedAt: config.updatedAt };
  }

  roots() {
    const state = readJsonSync(this.paths.attachmentsRootsFile, null);
    const roots = state && typeof state.roots === "object" && state.roots ? state.roots : {};
    return roots;
  }

  /** Register (or refresh) the absolute directory a root ID stands for. */
  registerRoot(rootPath, kind = "preferred") {
    const path = normalizeRootPath(rootPath);
    const id = rootIdFor(path);
    const roots = this.roots();
    const existing = roots[id];
    roots[id] = {
      id,
      path,
      kind: existing && existing.path === path && existing.kind ? existing.kind : kind,
      createdAt: existing && existing.createdAt ? existing.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomic(this.paths.attachmentsRootsFile, { version: 1, roots });
    return roots[id];
  }

  /**
   * Persist the preferred directory and prove it accepts writes before the
   * choice is stored, so a typo cannot silently break every later capture.
   * This is the one place that may create the directory tree the user names.
   */
  setPreferred(dir) {
    const path = normalizeRootPath(dir);
    const before = statOf(path);
    if (before && !before.isDirectory()) {
      throw new AttachmentError("ATTACHMENT_PATH_IS_FILE", `${path} is a file. Choose a folder.`);
    }
    try {
      this.#useLibraryDir(path, { create: true });
    } catch (error) {
      throw new AttachmentError(
        "ATTACHMENT_UNWRITABLE",
        `Could not write to ${path} (${describeFileError(error)}). The screenshot folder is unchanged.`,
        { path, reason: describeFileError(error) },
      );
    }
    this.registerRoot(path, "preferred");
    writeJsonAtomic(this.paths.attachmentsConfigFile, { version: 1, preferred: path, updatedAt: new Date().toISOString() });
    return path;
  }

  /** Drop the preferred directory: new captures go to the default library. */
  resetPreferred() {
    writeJsonAtomic(this.paths.attachmentsConfigFile, { version: 1, preferred: null, updatedAt: new Date().toISOString() });
    return this.defaultDir();
  }

  /**
   * Make one root usable for a capture and prove it is writable right now.
   *
   * `create: false` (the preferred directory) never creates the named directory
   * itself: if the user's drive or folder is gone, the choice is reported as
   * unavailable and left in place, so it is used again once it is back. Only the
   * default library and an explicit `set` may create their directory tree.
   */
  #useLibraryDir(rootPath, { create = true } = {}) {
    const info = statOf(rootPath);
    if (!info) {
      if (!create) {
        throw new AttachmentError("ATTACHMENT_MISSING", "the folder does not exist, or the drive is offline", { path: rootPath });
      }
      mkdirSync(rootPath, { recursive: true });
    } else if (!info.isDirectory()) {
      throw new AttachmentError("ATTACHMENT_PATH_IS_FILE", "this path is a file, not a folder", { path: rootPath });
    }
    const libraryDir = ensureLibraryDir(rootPath);
    const probe = join(libraryDir, STAGING, `probe-${process.pid}-${randomUUID()}.tmp`);
    writeFileSync(probe, "probe", "utf8");
    removeQuietly(probe);
    return libraryDir;
  }

  /**
   * Delete only this extension's own abandoned staging files, and only when they
   * are old enough not to be a capture that is still in flight. Foreign files in
   * those directories are never touched.
   */
  sweepStaging(now = Date.now()) {
    const dirs = [this.stagingDir()];
    for (const root of [this.defaultDir(), this.preferredDir()]) {
      if (root) dirs.push(join(root, LIBRARY_VERSION, STAGING));
    }
    for (const dir of dirs) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !OWNED_STAGING_FILE.test(entry.name)) continue;
        const path = join(dir, entry.name);
        const info = statOf(path);
        if (!info || now - info.mtimeMs < STALE_STAGING_MS) continue;
        removeQuietly(path);
      }
    }
  }

  /**
   * Choose the root for one capture and create its staging file.
   *
   * The preferred directory is tried first; if it is gone, read-only, offline or
   * not a directory, the default library takes this capture and the reason is
   * reported. The user's choice is never discarded, so the preferred directory
   * is used again as soon as it is writable. The staging file itself lives in the
   * stable local staging area, which no library root change can take away.
   */
  prepareCapture() {
    this.sweepStaging();
    const preferred = this.preferredDir();
    const fallbackDir = this.defaultDir();
    const candidates = [];
    if (preferred) candidates.push({ path: preferred, kind: "preferred", create: false });
    if (!preferred || preferred.toLowerCase() !== fallbackDir.toLowerCase()) {
      candidates.push({ path: fallbackDir, kind: "default", create: true });
    }

    const failures = [];
    let chosen = null;
    for (const candidate of candidates) {
      try {
        this.#useLibraryDir(candidate.path, { create: candidate.create });
        chosen = candidate;
        break;
      } catch (error) {
        failures.push({ path: candidate.path, kind: candidate.kind, reason: describeFileError(error) });
      }
    }
    if (!chosen) {
      throw new AttachmentError(
        "ATTACHMENT_UNWRITABLE",
        `The attachment library is not writable, so this screenshot cannot be saved:\n${failures.map((entry) => `- ${entry.path}: ${entry.reason}`).join("\n")}\nPick another location with Screenshot Folder in /ego-settings (headless: /ego-settings attachments set <writable path>), or fix the folders above and retry.`,
        { failures },
      );
    }

    const stagingDir = this.stagingDir();
    let stagingFile;
    try {
      mkdirSync(stagingDir, { recursive: true });
      stagingFile = join(stagingDir, `capture-${Date.now().toString(36)}-${randomUUID()}.png`);
      writeFileSync(stagingFile, Buffer.alloc(0));
    } catch (error) {
      throw new AttachmentError(
        "ATTACHMENT_UNWRITABLE",
        `The local staging folder ${stagingDir} is not writable (${describeFileError(error)}), so this screenshot cannot be saved.`,
        { path: stagingDir, reason: describeFileError(error), failures },
      );
    }

    const fallbackReason = chosen.kind === "default" && failures.length ? failures[0] : null;
    return {
      ok: true,
      rootPath: chosen.path,
      rootId: rootIdFor(chosen.path),
      kind: chosen.kind,
      stagingDir,
      stagingFile,
      fallbackReason: fallbackReason ? { path: fallbackReason.path, reason: fallbackReason.reason } : null,
      failures,
    };
  }

  /** Remove one staging file this library created; anything else is left alone. */
  discardStaging(staged) {
    const file = staged?.stagingFile;
    if (!file) return false;
    if (!OWNED_STAGING_FILE.test(basename(file))) return false;
    const parents = [this.stagingDir(), join(this.defaultDir(), LIBRARY_VERSION, STAGING)];
    const preferred = this.preferredDir();
    if (preferred) parents.push(join(preferred, LIBRARY_VERSION, STAGING));
    if (!parents.some((parent) => isInside(parent, file))) return false;
    return removeQuietly(file);
  }

  #publishStagingFile(stagingFile, rootPath, { createRoot = true } = {}) {
    try {
      return publishStagedPng({ stagingFile, rootPath, createRoot });
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      throw new AttachmentError("ATTACHMENT_PUBLISH_FAILED", `Writing to the attachment library ${rootPath} failed: ${describeFileError(error)}`, {
        path: rootPath,
        reason: describeFileError(error),
        cause: String(error?.code || ""),
      });
    }
  }

  /**
   * Publish one capture and describe the storage it ended up in.
   *
   * A root that breaks between the capture and the rename (drive unplugged,
   * permissions changed) must not lose the screenshot: the same staging file is
   * published into the default library and the reason is reported.
   */
  commitCapture(staged, meta = {}) {
    const preferredRoot = normalizeRootPath(staged.rootPath);
    const stagingFile = staged.stagingFile;
    let published = null;
    let fallback = staged.fallbackReason ? { stage: "staging", ...staged.fallbackReason } : null;
    // A chosen preferred root that vanished after the capture is not recreated:
    // the publish fails, the capture falls back, and the choice stays pending.
    const createRoot = staged.kind ? staged.kind === "default" : this.#sameAsDefault(preferredRoot);

    try {
      published = this.#publishStagingFile(stagingFile, preferredRoot, { createRoot });
    } catch (error) {
      // A corrupt or unreadable capture cannot be republished elsewhere: only a
      // root that broke after the capture is worth a second attempt.
      const code = String(error?.code || "");
      const captureProblem =
        code === "ATTACHMENT_NOT_PNG" || code === "ATTACHMENT_EMPTY" || code === "ATTACHMENT_MISSING";
      if (captureProblem) throw error;
      const info = statOf(stagingFile);
      if (!info?.isFile()) throw error;
      const defaultDir = this.defaultDir();
      if (this.#sameAsDefault(preferredRoot)) throw error;
      try {
        published = this.#publishStagingFile(stagingFile, defaultDir, { createRoot: true });
        fallback = { stage: "publish", path: preferredRoot, reason: describeFileError(error) };
      } catch (fallbackError) {
        throw new AttachmentError(
          "ATTACHMENT_UNWRITABLE",
          `The attachment library ${preferredRoot} failed (${describeFileError(error)}) and so did the default library ${defaultDir} (${describeFileError(fallbackError)}); this screenshot was not saved.`,
          { path: preferredRoot, reason: describeFileError(error), fallbackPath: defaultDir, fallbackReason: describeFileError(fallbackError) },
        );
      }
    } finally {
      this.discardStaging(staged);
    }

    this.registerRoot(published.rootPath, published.rootPath === this.defaultDir() ? "default" : "preferred");
    const ref = {
      schemaVersion: ATTACHMENT_SCHEMA_VERSION,
      id: published.id,
      rootId: published.rootId,
      bytes: published.bytes,
      mime: published.mime,
      pageLabel: typeof meta.pageLabel === "string" ? meta.pageLabel.slice(0, 32) : null,
      url: typeof meta.url === "string" ? meta.url.slice(0, 512) : null,
      title: typeof meta.title === "string" ? meta.title.slice(0, 160) : null,
      fullPage: Boolean(meta.fullPage),
      at: new Date().toISOString(),
      fallback: fallback || null,
    };
    return { ok: true, ref, path: published.path, deduped: published.deduped, rootPath: published.rootPath, fallback };
  }

  #sameAsDefault(rootPath) {
    return normalizeRootPath(rootPath).toLowerCase() === this.defaultDir().toLowerCase();
  }

  /**
   * Map one reference back to its file without reading image bytes.
   * Every check here is about trust: ID shape, a registered root ID, a path that
   * stays inside that root (lexically and after realpath, so a junction or
   * symlink cannot point the reader outside it), and a file that is there.
   */
  locate(ref) {
    const id = String(ref?.id ?? "").trim().toLowerCase();
    if (!OBJECT_ID.test(id)) {
      return { ok: false, code: "ATTACHMENT_ID_INVALID", message: `The attachment ID has the wrong shape (expected 64 lowercase hex characters): ${String(ref?.id ?? "").slice(0, 80)}` };
    }
    const rootId = String(ref?.rootId ?? "").trim().toLowerCase();
    if (!ROOT_ID.test(rootId)) {
      return { ok: false, code: "ATTACHMENT_ROOT_INVALID", message: `The attachment storage root ID has the wrong shape: ${String(ref?.rootId ?? "").slice(0, 80)}` };
    }
    const roots = this.roots();
    const root = roots[rootId];
    if (!root || typeof root.path !== "string") {
      return {
        ok: false,
        code: "ATTACHMENT_ROOT_UNKNOWN",
        message: `The attachment storage root ${rootId} is not registered on this machine, so it cannot be located; no other folder is searched for a file of the same name.`,
      };
    }
    let rootPath;
    try {
      rootPath = normalizeRootPath(root.path);
    } catch (error) {
      return { ok: false, code: "ATTACHMENT_ROOT_INVALID", message: `The path registered for the attachment storage root ${rootId} is invalid: ${root.path}`, path: root.path };
    }
    if (rootIdFor(rootPath) !== rootId) {
      return { ok: false, code: "ATTACHMENT_ROOT_INVALID", message: `The registration of the attachment storage root ${rootId} does not match its path ${rootPath}; refusing to use it.`, path: rootPath };
    }
    const objectsDir = join(rootPath, LIBRARY_VERSION, OBJECTS);
    const path = objectPathOf(rootPath, id);
    const within = relative(objectsDir, path);
    if (!within || within.startsWith("..") || isAbsolute(within)) {
      return { ok: false, code: "ATTACHMENT_ID_INVALID", message: `The path of attachment ${id.slice(0, 12)}… leaves its storage root; refusing to use it.` };
    }
    if (!statOf(rootPath)?.isDirectory()) {
      return {
        ok: false,
        code: "ATTACHMENT_MISSING",
        message: `The storage root ${rootPath} of attachment ${id.slice(0, 12)}… is unavailable right now: the folder does not exist, or the drive / mount point is offline. Restore the folder if the original file is still there; no other folder is searched for a file of the same name.`,
        path,
        rootId,
        rootPath,
      };
    }
    const info = statOf(path);
    if (!info) {
      return {
        ok: false,
        code: "ATTACHMENT_MISSING",
        message: `Attachment ${id.slice(0, 12)}… is not inside the storage root ${rootPath}: the file does not exist (it may have been deleted, or the drive / mount point is offline).`,
        path,
        rootId,
        rootPath,
      };
    }
    if (!info.isFile()) {
      return { ok: false, code: "ATTACHMENT_MISSING", message: `The location ${path} of attachment ${id.slice(0, 12)}… is not a file.`, path, rootId, rootPath };
    }
    if (info.size <= 0) return { ok: false, code: "ATTACHMENT_EMPTY", message: `Attachment ${id.slice(0, 12)}… is an empty file.`, path, rootId, rootPath };

    let realPath;
    let realRoot;
    try {
      realPath = realPathOf(path);
      realRoot = realPathOf(rootPath);
    } catch (error) {
      return {
        ok: false,
        code: "ATTACHMENT_UNREADABLE",
        message: `The real path of attachment ${id.slice(0, 12)}… cannot be resolved: ${describeFileError(error)}`,
        path,
        rootId,
        rootPath,
      };
    }
    const realWithin = relative(realRoot, realPath);
    if (!realWithin || realWithin.startsWith("..") || isAbsolute(realWithin)) {
      return {
        ok: false,
        code: "ATTACHMENT_OUTSIDE_ROOT",
        message: `The real path ${realPath} of attachment ${id.slice(0, 12)}… leaves the registered storage root ${rootPath} (junction / symlink); refusing to read it.`,
        path,
        realPath,
        rootId,
        rootPath,
      };
    }
    return { ok: true, id, rootId, rootPath, path, realPath, bytes: info.size, mime: ATTACHMENT_MIME };
  }

  /**
   * Locate one reference and check its digest, without holding the image.
   * This is what "open by ID" and an explicit copy to a user-named path need,
   * and it works for a screenshot of any size.
   */
  verify(ref) {
    const located = this.locate(ref);
    if (!located.ok) return located;
    let digest;
    try {
      digest = sha256FileSync(located.realPath || located.path);
    } catch (error) {
      return {
        ok: false,
        code: "ATTACHMENT_UNREADABLE",
        message: `Reading attachment ${shortId(located.id)}… failed: ${describeFileError(error)}`,
        path: located.path,
      };
    }
    if (digest !== located.id) {
      return {
        ok: false,
        code: "ATTACHMENT_CORRUPT",
        message: `The content of attachment ${shortId(located.id)}… does not match its ID; refusing to use it (${located.path}).`,
        path: located.path,
      };
    }
    return located;
  }

  /**
   * Locate, verify and read one reference.
   * `maxBytes` is the inline limit: it is checked from the file size first, so an
   * oversized picture is skipped without ever being read into memory.
   */
  load(ref, { maxBytes = null } = {}) {
    const located = this.locate(ref);
    if (!located.ok) return located;
    if (maxBytes && located.bytes > maxBytes) {
      return {
        ok: false,
        code: "ATTACHMENT_TOO_LARGE",
        message: `Attachment ${shortId(located.id)}… has ${located.bytes} bytes, over the ${maxBytes}-byte inline display limit; the image is still in the attachment library, so it can be opened by path or explicitly copied to a destination the user named.`,
        path: located.path,
        bytes: located.bytes,
      };
    }
    let data;
    try {
      data = readFileSync(located.path);
    } catch (error) {
      return { ok: false, code: "ATTACHMENT_UNREADABLE", message: `Reading attachment ${shortId(located.id)}… failed: ${describeFileError(error)}`, path: located.path };
    }
    if (sha256Hex(data) !== located.id) {
      return {
        ok: false,
        code: "ATTACHMENT_CORRUPT",
        message: `The content of attachment ${shortId(located.id)}… does not match its ID; refusing to use it (${located.path}).`,
        path: located.path,
      };
    }
    if (!isPng(data)) return { ok: false, code: "ATTACHMENT_NOT_PNG", message: `Attachment ${shortId(located.id)}… is not a PNG.`, path: located.path };
    return { ...located, bytes: data.length, data };
  }

  /** Objects stored below one root, for the `/ego-settings` attachment listing. */
  counts(rootPath) {
    try {
      const dir = join(rootPath, LIBRARY_VERSION, OBJECTS);
      const entries = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && OBJECT_ID.test(entry.name.replace(/\.png$/, "")));
      let bytes = 0;
      for (const entry of entries) {
        const info = statOf(join(dir, entry.name));
        if (info?.isFile()) bytes += info.size;
      }
      return { objects: entries.length, bytes };
    } catch {
      return null;
    }
  }

  /**
   * Check whether a directory can be written right now, without publishing.
   * Used by the `/ego-settings` attachment listing so a user sees a broken
   * preferred directory before the next screenshot falls back. `create: false`
   * matters here: a status check must never recreate a preferred directory that
   * went offline.
   */
  probe(rootPath, { create = false } = {}) {
    let path;
    try {
      path = normalizeRootPath(rootPath);
    } catch (error) {
      return { ok: false, path: String(rootPath ?? ""), reason: describeFileError(error), code: "ATTACHMENT_PATH_INVALID" };
    }
    const before = statOf(path);
    if (before && !before.isDirectory()) {
      return { ok: false, path, reason: "this path is a file, not a folder", code: "ATTACHMENT_PATH_IS_FILE" };
    }
    if (!before && !create) {
      return { ok: false, path, reason: "the folder does not exist, or the drive is offline", code: "ATTACHMENT_MISSING", objects: null };
    }
    try {
      this.#useLibraryDir(path, { create });
      return { ok: true, path, objects: this.counts(path) };
    } catch (error) {
      return { ok: false, path, reason: describeFileError(error), code: error?.code || "ATTACHMENT_UNWRITABLE", objects: this.counts(path) };
    }
  }
}

/** Accept a full ID or a unique prefix of one of the session's references. */
export function matchesReferenceId(ref, wanted) {
  const id = String(ref?.id ?? "").toLowerCase();
  const needle = String(wanted ?? "").trim().toLowerCase();
  if (!OBJECT_ID.test(id) || !needle) return false;
  return needle.length >= MIN_ID_PREFIX ? id.startsWith(needle) : id === needle;
}

/** The small metadata every screenshot result carries (no image bytes). */
export function attachmentDetails(ref) {
  if (!ref) return null;
  return {
    schemaVersion: ATTACHMENT_SCHEMA_VERSION,
    id: ref.id,
    rootId: ref.rootId,
    bytes: ref.bytes,
    mime: ref.mime || ATTACHMENT_MIME,
    pageLabel: ref.pageLabel ?? null,
    url: ref.url ?? null,
    title: ref.title ?? null,
    at: ref.at ?? null,
    fullPage: Boolean(ref.fullPage),
  };
}

/** Keep a reference list short: newest first, one entry per object. */
export function pushReference(list, ref, max = 30) {
  const kept = Array.isArray(list) ? list.filter((entry) => entry && entry.id !== ref.id) : [];
  kept.unshift(ref);
  return kept.slice(0, max);
}
