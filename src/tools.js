// Tool behaviour, independent of the Pi command surface.
//
// `BrowserService` turns one tool call into: prepare the browser, run one Ego
// script, then interpret the structured result (numbering, session binding,
// screenshots). The Pi entry point only adapts this to `pi.registerTool`.
import { randomUUID } from "node:crypto";
import { closeSync, constants, copyFileSync, linkSync, openSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import {
  attachmentDetails,
  AttachmentError,
  AttachmentLibrary,
  describeFileError,
  formatBytes,
  normalizeRootPath,
  sha256FileSync,
  shortId,
} from "./attachments.js";
import { readBrowserState, recordBrowserState, resolveBrowser } from "./chromium.js";
import { resolvePaths, sessionShotDir } from "./paths.js";
import { selectSessionReference, sessionReferences } from "./review.js";
import { assertEndpointIsOurs, parseDoctor, readSpaces, runDoctor, runScript } from "./runtime.js";
import {
  numberSnapshot,
  resolveSessionKey,
  SessionStore,
  spaceNameFor,
  STALE_NO_SNAPSHOT,
} from "./session.js";
import { readJsonSync } from "./store.js";
import {
  buildClickScript,
  buildFillScript,
  buildHandoffScript,
  buildOpenScript,
  buildReadScript,
  buildResumeScript,
  buildScreenshotScript,
  buildTabsScript,
} from "./script.js";

const MAX_TEXT_BYTES = 48000;
const SCREENSHOT_NAME = /^shot-[\dTZ-]+-[0-9a-f-]{36}\.png$/;
/** How many recent references the session record keeps for the status list. */
const ATTACHMENT_LIST_LIMIT = 30;

function removeScreenshotFile(file) {
  try {
    rmSync(file, { force: true });
    return true;
  } catch {
    // Best effort when Windows still holds a handle to the file.
    return false;
  }
}

/**
 * The destination of one explicit copy: a full absolute path to a .png file.
 * Nothing is appended, resolved relative to the working directory, or replaced
 * by a default directory — a user who asks for a copy names where it goes.
 */
function normalizeCopyTarget(value) {
  const text = String(value ?? "").trim();
  if (!text) throw new AttachmentError("ATTACHMENT_PATH_INVALID", "A copy needs a full destination path.");
  const expanded = text.replace(/^~(?=$|[\\/])/, () => homedir());
  const { root } = parse(expanded);
  if (!isAbsolute(expanded) || (process.platform === "win32" && root.length === 1)) {
    throw new AttachmentError("ATTACHMENT_PATH_INVALID", `The copy destination must be an absolute path; received "${text}".`);
  }
  if (process.platform === "win32" && expanded.slice(root.length).includes(":")) {
    throw new AttachmentError("ATTACHMENT_PATH_INVALID", "The copy destination must be a plain PNG file path.");
  }
  const resolved = resolve(expanded);
  if (!/\.png$/i.test(resolved)) {
    throw new AttachmentError("ATTACHMENT_PATH_INVALID", `The copy destination must end in .png: ${resolved}`);
  }
  return resolved;
}

export function truncate(text, maxBytes = MAX_TEXT_BYTES) {
  const value = String(text ?? "");
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  const keep = Math.floor(maxBytes / 2);
  return {
    text: `${value.slice(0, keep)}\n\n[... truncated ${value.length - keep} characters; ask for a narrower scope (pageLabel, or browser_read after scrolling) ...]`,
    truncated: true,
  };
}

function lineCount(text) {
  return String(text ?? "").split("\n").length;
}

const BROWSER_STAGE_CODES = {
  "browser-detect": "BROWSER_NOT_FOUND",
  "browser-lock": "BROWSER_LOCK_INVALID",
  "browser-download": "BROWSER_DOWNLOAD_FAILED",
  "browser-unpack": "BROWSER_UNPACK_FAILED",
  "browser-managed": "BROWSER_UNAVAILABLE",
  "browser-attach": "FOREIGN_BROWSER",
};

/**
 * The Ego runtime hides script output entirely when a hard-stop error fires
 * (`EGO_TASK_SPACE_USER_IN_CONTROL` / `EGO_TASK_SPACE_INACTIVE`): the buffered
 * lines, sentinel included, are dropped and only the stop message is written.
 * Translate that into the tool-level hand-off state instead of reporting a
 * mysterious missing result.
 */
export function hardStopOf(result) {
  if (!result || result.ok !== false) return null;
  if (result.code !== "RUNTIME_NO_RESULT" && result.code !== "RUNTIME_FAILED") return null;
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (!/EGO_TASK_SPACE_USER_IN_CONTROL|user is controlling this task space|EGO_TASK_SPACE_INACTIVE/i.test(text)) {
    return null;
  }
  return {
    ok: false,
    code: "HANDED_TO_USER",
    message:
      "The user is controlling this browser task space. Wait until the user finishes and resumes from /ego-settings (Resume Browser Control), then continue; do not retry now.\n(Ego said: " +
      text.trim().split("\n")[0] +
      ")",
    details: { handedOff: true, hardStop: true },
  };
}

export class BrowserService {
  constructor({ env = process.env, paths = null, notify = () => {}, runner = null } = {}) {
    this.env = env;
    this.paths = paths || resolvePaths(env);
    this.store = new SessionStore(this.paths);
    this.notify = notify;
    this.runner = runner;
    this.browserCache = { path: null, source: null, checkedAt: 0 };
  }

  key(sessionKey) {
    return resolveSessionKey(sessionKey, this.env);
  }

  /** Resolve the browser once per process, then reuse the decision. */
  async browser(force = false) {
    if (!force && this.browserCache.path && Date.now() - this.browserCache.checkedAt < 60000) {
      return { ok: true, path: this.browserCache.path, source: this.browserCache.source };
    }
    const resolved = await resolveBrowser({
      paths: this.paths,
      env: this.env,
      log: (message) => this.notify(message),
      onProgress: (message) => this.notify(message),
    });
    if (resolved.ok) {
      this.browserCache = { path: resolved.path, source: resolved.source, checkedAt: Date.now() };
    } else {
      this.browserCache = { path: null, source: null, checkedAt: 0 };
    }
    return resolved;
  }

  async #prepare() {
    const resolved = await this.browser();
    if (!resolved.ok) {
      return {
        ok: false,
        code: BROWSER_STAGE_CODES[resolved.stage] || "BROWSER_UNAVAILABLE",
        message: resolved.message || "browser preparation failed",
        stage: resolved.stage,
        details: { stage: resolved.stage, source: resolved.source, path: resolved.path || null },
      };
    }
    return { ok: true, browser: resolved.path };
  }

  async #run(sessionKey, script) {
    const prepared = await this.#prepare();
    if (!prepared.ok) return prepared;
    const result = this.runner
      ? await this.runner({ paths: this.paths, script, browser: prepared.browser })
      : await runScript({
          paths: this.paths,
          script,
          browser: prepared.browser,
          onProgress: (line) => this.notify(line),
        });
    const hardStop = hardStopOf(result);
    if (hardStop) {
      this.store.setHandoff(sessionKey, true);
      return hardStop;
    }
    const browserState = readBrowserState(this.paths);
    if (result.stage && result.ok === false) {
      recordBrowserState(this.paths, { ...browserState, ok: false, stage: result.stage, message: result.message });
    } else if (result.ok && browserState?.ok === false) {
      recordBrowserState(this.paths, { ...browserState, ok: true, stage: "runtime-ready", message: "Ego is connected" });
    }
    if (result.code === "HANDED_TO_USER") this.store.setHandoff(sessionKey, true);
    return result;
  }

  #spaceFor(record) {
    return { id: record.spaceId ?? null, name: record.spaceName || spaceNameFor("default") };
  }

  #handoffGuard(record) {
    if (!record.handedOff) return null;
    return {
      ok: false,
      code: "HANDED_TO_USER",
      message:
        "The user is controlling this browser task space. Wait until the user finishes and resumes from /ego-settings (Resume Browser Control), then continue; do not retry now.",
      details: { handedOff: true, url: record.url, pageLabel: record.pageLabel },
    };
  }

  #bindResult(key, result) {
    this.store.bind(key, {
      spaceId: result.spaceId ?? null,
      spaceName: result.spaceName || undefined,
      pageLabel: result.pageLabel ?? null,
      url: result.url ?? null,
      title: result.title ?? null,
      handedOff: false,
    });
  }

  #failure(result) {
    return {
      ok: false,
      code: result.code || "EGO_ERROR",
      message: result.message || "ego runtime reported a failure",
      details: {
        code: result.code || "EGO_ERROR",
        stdout: result.stdout ? truncate(result.stdout).text : "",
        stderr: result.stderr ? truncate(result.stderr).text : "",
        exitCode: result.exitCode ?? null,
        mayHaveLateEffects: Boolean(result.mayHaveLateEffects),
      },
    };
  }

  #spaceDetails(result) {
    return {
      spaceId: result.spaceId ?? null,
      spaceName: result.spaceName ?? null,
      ownership: result.ownership ?? null,
      pageLabel: result.pageLabel ?? null,
      url: result.url ?? null,
      title: result.title ?? null,
      tabs: Array.isArray(result.tabs) ? result.tabs : [],
    };
  }

  async open({ sessionKey, url }) {
    const key = this.key(sessionKey);
    const record = this.store.get(key);
    const guard = this.#handoffGuard(record);
    if (guard) return guard;
    const result = await this.#run(key, buildOpenScript({ space: this.#spaceFor(record), url }));
    if (result.ok === false) return this.#failure(result);
    this.#bindResult(key, result);
    const space = this.#spaceDetails(result);
    return {
      ok: true,
      text: `Opened ${result.title || "(untitled)"}\nURL: ${result.url}\nTab: ${result.pageLabel || "?"} (task space ${result.spaceId ?? "?"}, ${result.tabs?.length ?? 1} tabs)\nNext: call browser_read before clicking or filling to get element numbers; skip browser_read if you only need a screenshot.`,
      details: space,
    };
  }

  async read({ sessionKey, pageLabel = null, scope = "viewport" }) {
    const key = this.key(sessionKey);
    const record = this.store.get(key);
    const guard = this.#handoffGuard(record);
    if (guard) return guard;
    const result = await this.#run(key, buildReadScript({ space: this.#spaceFor(record), pageLabel, scope }));
    if (result.ok === false) return this.#failure(result);
    const numbered = numberSnapshot(result.snapshot);
    const seq = this.store.nextSeq(key);
    this.store.recordSnapshot(key, {
      spaceId: result.spaceId ?? null,
      pageLabel: result.pageLabel ?? null,
      url: result.url ?? null,
      title: result.title ?? null,
      seq,
      items: numbered.items,
    });
    const header = `[${result.pageLabel || "page"} · ${result.url || "?"} · ${result.title || "(untitled)"}]\n[Element numbers #1..#${numbered.items.length} are valid only for the page state of this read; read again after a navigation or a tab switch]`;
    const body = truncate(`${header}\n${numbered.text}`);
    return {
      ok: true,
      text: `${body.text}\n[Read complete: ${numbered.items.length} actionable element numbers, read #${seq}]`,
      details: {
        ...this.#spaceDetails(result),
        seq,
        elements: numbered.items.length,
        truncated: body.truncated || lineCount(numbered.text) > 1500,
        elementList: numbered.items.slice(0, 200),
      },
    };
  }

  #resolve(sessionKey, target) {
    const key = this.key(sessionKey);
    const record = this.store.get(key);
    const resolved = this.store.resolveTarget(key, target);
    if (resolved.kind === "stale") {
      return {
        ok: false,
        code: resolved.code || STALE_NO_SNAPSHOT,
        message: resolved.message,
        details: { stale: true, code: resolved.code || STALE_NO_SNAPSHOT, invalidReason: record.invalidReason || null },
      };
    }
    return { ok: true, key, resolved };
  }

  async click({ sessionKey, target, timeoutMs }) {
    const resolution = this.#resolve(sessionKey, target);
    if (!resolution.ok) return resolution;
    const { key, resolved } = resolution;
    const record = this.store.get(key);
    const guard = this.#handoffGuard(record);
    if (guard) return guard;
    const result = await this.#run(
      key,
      buildClickScript({
        space: this.#spaceFor(record),
        selector: resolved.value,
        expect: resolved.expect || null,
        timeoutMs,
      }),
    );
    if (result.ok === false) return this.#actionFailure(key, result, resolved);
    this.#bindResult(key, result);
    const navigated = Boolean(result.navigated);
    if (navigated) this.store.invalidateSnapshot(key, "the page navigated");
    return {
      ok: true,
      text: `Clicked ${resolved.number ? `#${resolved.number}` : resolved.value} (${result.pageLabel || "?"})\nNow: ${result.title || "(untitled)"} · ${result.url}${navigated ? "\nThe page navigated, so element numbers are stale; call browser_read next." : ""}`,
      details: { ...this.#spaceDetails(result), navigated, target: resolved.number ? `#${resolved.number}` : resolved.value, receipt: result.receipt ?? null },
    };
  }

  async fill({ sessionKey, target, text, timeoutMs }) {
    const resolution = this.#resolve(sessionKey, target);
    if (!resolution.ok) return resolution;
    const { key, resolved } = resolution;
    const record = this.store.get(key);
    const guard = this.#handoffGuard(record);
    if (guard) return guard;
    const result = await this.#run(
      key,
      buildFillScript({
        space: this.#spaceFor(record),
        selector: resolved.value,
        text,
        expect: resolved.expect || null,
        timeoutMs,
      }),
    );
    if (result.ok === false) return this.#actionFailure(key, result, resolved);
    this.#bindResult(key, result);
    if (result.navigated) this.store.invalidateSnapshot(key, "the page navigated");
    return {
      ok: true,
      text: `Filled ${resolved.number ? `#${resolved.number}` : resolved.value} (${resolved.role || "element"}${resolved.name ? ` "${resolved.name}"` : ""})\nNow: ${result.title || "(untitled)"} · ${result.url}`,
      details: { ...this.#spaceDetails(result), target: resolved.number ? `#${resolved.number}` : resolved.value, navigated: Boolean(result.navigated) },
    };
  }

  #actionFailure(key, result, resolved) {
    const staleHint = /stale|not found|no such|detached|element/i.test(`${result.code} ${result.message}`);
    if (staleHint) {
      this.store.invalidateSnapshot(key, "element numbers are possibly stale");
    }
    const failure = this.#failure(result);
    const hint =
      result.code === "EGO_PAGE_UNRESPONSIVE" || result.mayHaveLateEffects
        ? "\nUncertain result: the action may already have taken effect. Call browser_read to see the current page state before deciding whether to retry."
        : staleHint
          ? "\nThe element number or the element itself may be stale: call browser_read to read the page again."
          : "";
    return {
      ...failure,
      message: `${failure.message}${hint}`,
      details: { ...failure.details, target: resolved.number ? `#${resolved.number}` : resolved.value },
    };
  }

  async tabs({ sessionKey, action, url = null, pageLabel = null, index = null }) {
    const key = this.key(sessionKey);
    const record = this.store.get(key);
    const guard = action === "list" ? null : this.#handoffGuard(record);
    if (guard) return guard;
    const result = await this.#run(key, buildTabsScript({ space: this.#spaceFor(record), action, url, pageLabel, index }));
    if (result.ok === false) return this.#failure(result);
    this.#bindResult(key, result);
    if (action !== "list") this.store.invalidateSnapshot(key, "the tabs changed");
    const tabLines = (result.tabs || [])
      .map((tab, position) => `  ${position}: ${tab.label || "(unmanaged)"} ${tab.active ? "← active" : ""} ${tab.title || ""} ${tab.url || ""}`.trimEnd())
      .join("\n");
    const labels = `Tabs (task space ${result.spaceId ?? "?"}):\n${tabLines || "  (none)"}`;
    if (action === "list") {
      return { ok: true, text: labels, details: { ...this.#spaceDetails(result), labels: result.labels || [] } };
    }
    if (action === "new") {
      return {
        ok: true,
        text: `Opened new tab ${result.pageLabel || "?"}: ${result.url || "about:blank"}\n${labels}\nElement numbers are stale now; call browser_read next.`,
        details: { ...this.#spaceDetails(result), created: true },
      };
    }
    if (action === "switch") {
      return {
        ok: true,
        text: `Switched to ${result.pageLabel || "?"}: ${result.title || ""} ${result.url || ""}\n${labels}\nElement numbers are stale now; call browser_read next.`,
        details: { ...this.#spaceDetails(result), activated: true },
      };
    }
    return {
      ok: true,
      text: `Closed ${result.closed || "the tab"}\n${labels}\nElement numbers are stale now; call browser_read next.`,
      details: { ...this.#spaceDetails(result), closed: result.closed || null },
    };
  }

  /**
   * One capture: one staging PNG inside the attachment library, then a
   * content-addressed publish. The result carries the attachment reference, not
   * the image, so nothing that reaches the session transcript holds PNG bytes.
   */
  async screenshot({ sessionKey, fullPage = false, pageLabel = null }) {
    const key = this.key(sessionKey);
    const record = this.store.get(key);
    const guard = this.#handoffGuard(record);
    if (guard) return guard;

    const library = new AttachmentLibrary(this.paths);
    let staged;
    try {
      staged = library.prepareCapture();
    } catch (error) {
      return {
        ok: false,
        code: error?.code || "ATTACHMENT_UNWRITABLE",
        message: error?.message || "The attachment library is not writable, so the screenshot could not be saved.",
        details: { attachment: null, ...(error?.details || {}) },
      };
    }

    let ready = false;
    try {
      const result = await this.#run(
        key,
        buildScreenshotScript({ space: this.#spaceFor(record), path: staged.stagingFile, fullPage, pageLabel }),
      );
      if (result.ok === false) return this.#failure(result);
      const captured = statSync(staged.stagingFile, { throwIfNoEntry: false });
      if (!captured?.isFile() || captured.size === 0) {
        return { ok: false, code: "SCREENSHOT_UNAVAILABLE", message: "The browser produced no usable screenshot." };
      }

      const ingested = this.ingestCapture({
        sessionKey: key,
        staged,
        pageLabel: result.pageLabel ?? null,
        url: result.url ?? null,
        title: result.title ?? null,
        fullPage: Boolean(fullPage),
      });
      if (!ingested.ok) return ingested;
      ready = true;
      this.#bindResult(key, result);

      const ref = ingested.ref;
      const fallback = ingested.fallback;
      const lines = [
        "Screenshot saved to the attachment library: the original is the file below, so no second copy is needed.",
        `Attachment ID: ${ref.id}`,
        `File: ${ingested.path}`,
        `Page: ${ref.title || "(untitled)"} · ${ref.url || "?"}${ref.pageLabel ? ` (tab ${ref.pageLabel})` : ""}`,
        `Size: ${formatBytes(ref.bytes)}; storage root: ${ref.rootId}`,
        ingested.deduped ? "The same image was already in the attachment library; no second copy was stored." : "",
        fallback
          ? `The preferred folder ${fallback.path} was unavailable this time (${fallback.reason}), so this capture went to ${ingested.rootPath}; the preferred setting is kept and will be used again once that folder is back.`
          : "",
        "When the user says to save this, this is the original: reply with the path above and do not copy it again. Only when the user explicitly asks for a copy in another folder and gives a full .png path, use browser_save_screenshot { path }.",
        "To look at an older screenshot of this session: browser_show_screenshot (model); the user can open it under Session Screenshots in /ego-settings.",
      ].filter(Boolean);
      return {
        ok: true,
        text: lines.join("\n"),
        details: {
          spaceId: result.spaceId ?? null,
          attachment: attachmentDetails(ref),
          path: ingested.path,
          bytes: ref.bytes,
          saved: true,
          deduped: ingested.deduped,
          rootPath: ingested.rootPath,
          fallback: fallback ? { path: fallback.path, reason: fallback.reason } : null,
        },
      };
    } finally {
      // The publish removes the staging file itself; a failed or unused capture
      // must not leave one behind.
      if (!ready) library.discardStaging(staged);
    }
  }

  /**
   * Publish one already captured staging PNG and record its reference.
   * Split out of `screenshot()` so the publish-and-record half is testable
   * without a browser: it is the only part that touches the attachment library.
   */
  ingestCapture({ sessionKey, staged, pageLabel = null, url = null, title = null, fullPage = false, record = true }) {
    const key = this.key(sessionKey);
    const library = new AttachmentLibrary(this.paths);
    let committed;
    try {
      committed = library.commitCapture(staged, { pageLabel, url, title, fullPage });
    } catch (error) {
      return {
        ok: false,
        code: error?.code || "ATTACHMENT_UNWRITABLE",
        message: error?.message || "This screenshot was not saved.",
        details: { attachment: null, ...(error?.details || {}) },
      };
    }
    if (record) this.store.recordAttachment(key, committed.ref);
    return {
      ok: true,
      ref: committed.ref,
      path: committed.path,
      deduped: committed.deduped,
      rootPath: committed.rootPath,
      fallback: committed.fallback,
    };
  }

/**
   * "Save this" has already happened by the time anyone asks: the capture
   * published the picture into the attachment library, and that file is the
   * original. Without a destination this method verifies the original and
   * returns it — it copies nothing, reads no old export map and never creates a
   * second copy of the same picture. Only a destination the user explicitly
   * named is written, and only when it does not already hold a different file.
   *
   * A preview cached by 0.1.1 is the one thing that was never in the library, so
   * it is published through the ordinary capture path into the library in effect
   * now (the settings decide that), and the old cache file is copied, never
   * moved, rewritten or deleted.
   */
  saveScreenshot({ sessionKey, path: destination = null }) {
    const key = this.key(sessionKey);
    const record = this.store.get(key);
    const library = new AttachmentLibrary(this.paths);
    const target = typeof destination === "string" && destination.trim() ? destination.trim() : null;

    let ref = record.latestAttachment;
    let original = null;
    let legacy = false;

    if (ref?.id) {
      // Verification reads the file in chunks: a screenshot of any size is
      // returned or copied without holding the image in memory.
      original = library.verify(ref);
      if (!original.ok) {
        return {
          ok: false,
          code: original.code || "ATTACHMENT_UNAVAILABLE",
          message: `Could not find the original of this screenshot: ${original.message}`,
          details: { attachment: attachmentDetails(ref), path: original.path || null },
        };
      }
    } else {
      const cached = this.#legacyPreviewFile(key);
      if (!cached) {
        return { ok: false, code: "NO_SCREENSHOT", message: "This session has no screenshot to save; call browser_screenshot first." };
      }
      // Publish through the ordinary capture path so the library in effect now
      // (preferred directory, or the default with its usual fallback) holds the
      // picture. The 0.1.1 cache file is copied, never moved or rewritten.
      let staged;
      try {
        staged = library.prepareCapture();
        copyFileSync(cached, staged.stagingFile);
      } catch (error) {
        if (staged) library.discardStaging(staged);
        return {
          ok: false,
          code: error?.code || "ATTACHMENT_UNWRITABLE",
          message: `This 0.1.1 preview could not be saved: ${error?.message || describeFileError(error)}`,
        };
      }
      const ingested = this.ingestCapture({ sessionKey: key, staged });
      if (!ingested.ok) return ingested;
      ref = ingested.ref;
      original = library.verify(ref);
      if (!original.ok) {
        return {
          ok: false,
          code: original.code || "ATTACHMENT_UNAVAILABLE",
          message: `This 0.1.1 preview was written to the attachment library but cannot be read now: ${original.message}`,
          details: { attachment: attachmentDetails(ref), path: original.path || null },
        };
      }
      legacy = true;
    }

    if (!target) {
      return {
        ok: true,
        text: [
          `The screenshot original is already in the attachment library: ${original.path}`,
          `Attachment ID: ${ref.id}`,
          ...(legacy ? ["(This one is a 0.1.1 preview; it was copied into the attachment library and the old cache file is unchanged.)"] : []),
          "This is the original to save: no second copy was made. Only an explicit request for another folder uses a copy with a full .png path.",
        ].join("\n"),
        details: {
          attachment: attachmentDetails(ref),
          path: original.path,
          saved: true,
          savedOriginal: true,
          bytes: original.bytes,
          ...(legacy ? { legacy: true } : {}),
        },
      };
    }
    return this.#copyToDestination({ ref, original, target, legacy });
  }

  /** A 0.1.1 preview this session recorded, if its cache file is still there. */
  #legacyPreviewFile(sessionKey) {
    const record = this.store.get(sessionKey);
    const name = record.previewScreenshot;
    if (typeof name !== "string" || !SCREENSHOT_NAME.test(name)) return null;
    const file = join(sessionShotDir(this.paths.screenshotCacheDir, sessionKey), name);
    return statSync(file, { throwIfNoEntry: false })?.isFile() ? file : null;
  }

  /**
   * Copy one verified original to the absolute PNG path the user named.
   *
   * Nothing is guessed: the destination must be absolute, end in `.png`, and
   * live in a directory that already exists (no directory is created and no
   * default root is substituted). An existing file is accepted only when it is
   * already this picture (same digest); a different file is refused, never
   * overwritten. Verify a temporary copy in the destination directory and
   * publish it with an operation that fails if the final name already exists.
   */
  #copyToDestination({ ref, original, target, legacy = false }) {
    let destination;
    try {
      destination = normalizeCopyTarget(target);
    } catch (error) {
      return {
        ok: false,
        code: error?.code || "ATTACHMENT_PATH_INVALID",
        message: `Not copied: ${error?.message || `invalid destination path: ${target}`}`,
        details: { attachment: attachmentDetails(ref), path: null },
      };
    }
    if (destination.toLowerCase() === normalizeRootPath(original.path).toLowerCase()) {
      return {
        ok: true,
        text: `This file is the original in the attachment library: ${original.path}\nAttachment ID: ${ref.id}`,
        details: { attachment: attachmentDetails(ref), path: original.path, saved: true, savedOriginal: true, bytes: original.bytes },
      };
    }
    const existing = statSync(destination, { throwIfNoEntry: false });
    if (existing) {
      if (!existing.isFile()) {
        return {
          ok: false,
          code: "ATTACHMENT_PATH_IS_FILE",
          message: `The copy destination ${destination} already exists and is not a file; nothing was overwritten.`,
          details: { attachment: attachmentDetails(ref), path: destination },
        };
      }
      let digest = null;
      try {
        digest = sha256FileSync(destination);
      } catch {
        digest = null;
      }
      if (digest === original.id) {
        return {
          ok: true,
          text: `This screenshot is already in this file: ${destination}\nAttachment ID: ${ref.id}; the original is still at ${original.path}`,
          details: { attachment: attachmentDetails(ref), path: destination, saved: true, copied: true, reused: true, bytes: original.bytes },
        };
      }
      return {
        ok: false,
        code: "ATTACHMENT_EXISTS",
        message: `The copy destination ${destination} already exists with different content; nothing was overwritten. Try another file name.`,
        details: { attachment: attachmentDetails(ref), path: destination },
      };
    }
    const directory = dirname(destination);
    if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
      return {
        ok: false,
        code: "ATTACHMENT_MISSING",
        message: `The copy destination folder does not exist: ${directory}. Create it first, then give a full .png path; this tool does not create folders.`,
        details: { attachment: attachmentDetails(ref), path: destination },
      };
    }

    const temporary = join(directory, `.pi-ego-copy-${randomUUID()}.tmp`);
    let ownsTemporary = false;
    try {
      const fd = openSync(temporary, "wx");
      ownsTemporary = true;
      closeSync(fd);
      copyFileSync(original.path, temporary);
      if (sha256FileSync(temporary) !== original.id) {
        throw new AttachmentError("ATTACHMENT_CORRUPT", "The copied file's content does not match the attachment ID.");
      }
      try {
        linkSync(temporary, destination);
      } catch (error) {
        if (error?.code === "EEXIST") throw error;
        // Some removable drives and network shares do not allow hard links.
        copyFileSync(temporary, destination, constants.COPYFILE_EXCL);
      }
    } catch (error) {
      const occupied = ownsTemporary && error?.code === "EEXIST";
      return {
        ok: false,
        code: occupied ? "ATTACHMENT_EXISTS" : error?.code || "ATTACHMENT_COPY_FAILED",
        message: occupied
          ? `The copy destination ${destination} appeared in the meantime; nothing was overwritten. Try another file name.`
          : `Copy failed: ${describeFileError(error)} (destination ${destination})`,
        details: { attachment: attachmentDetails(ref), path: destination },
      };
    } finally {
      if (ownsTemporary) removeScreenshotFile(temporary);
    }
    return {
      ok: true,
      text: [
        `Copied to: ${destination}`,
        `Attachment ID: ${ref.id}; the original stays in the attachment library: ${original.path}`,
        ...(legacy ? ["(This one is a 0.1.1 preview; the old cache file is unchanged.)"] : []),
      ].join("\n"),
      details: {
        attachment: attachmentDetails(ref),
        path: destination,
        saved: true,
        copied: true,
        bytes: original.bytes,
        originalPath: original.path,
        ...(legacy ? { legacy: true } : {}),
      },
    };
  }

  /**
   * This session's screenshots, located but not probed. The settings menu asks
   * for it on every screen, so it writes no probe file and creates no
   * directory: it only maps the recorded references through the root registry.
   */
  sessionScreenshots({ sessionKey }) {
    const key = this.key(sessionKey);
    const record = this.store.get(key);
    const library = new AttachmentLibrary(this.paths);
    const refs = Array.isArray(record.attachments) && record.attachments.length
      ? record.attachments
      : record.latestAttachment
        ? [record.latestAttachment]
        : [];
    return refs.map((ref) => {
      const located = library.locate(ref);
      return {
        ...attachmentDetails(ref),
        path: located.ok ? located.path : null,
        available: Boolean(located.ok),
        message: located.ok ? null : located.message,
      };
    });
  }

  /**
   * Directory, registry and per-session attachment status. This is the text
   * `/ego-settings attachments` prints, and the same rows fill the TUI's
   * `Session Screenshots` page (each row carries its file and whether it is usable).
   */
  attachments({ sessionKey }) {
    const key = this.key(sessionKey);
    const record = this.store.get(key);
    const library = new AttachmentLibrary(this.paths);
    const config = library.configState();
    const defaultDir = library.defaultDir();
    const preferred = config.preferred;
    const probes = [];
    if (preferred) probes.push({ role: "preferred", ...library.probe(preferred, { create: false }) });
    probes.push({ role: "default", ...library.probe(defaultDir, { create: true }) });
    const roots = Object.values(library.roots());
    const refs = Array.isArray(record.attachments) && record.attachments.length
      ? record.attachments
      : record.latestAttachment
        ? [record.latestAttachment]
        : [];

    const lines = ["Screenshot Library"];
    lines.push(`Preferred folder: ${preferred || "(using the default folder)"}`);
    lines.push(`Default folder: ${defaultDir}`);
    lines.push(`Temporary capture folder: ${library.stagingDir()}`);
    if (config.invalid) lines.push(`Invalid preferred folder (${config.invalid}: ${config.error || "expected an absolute path"}). Using the default folder.`);
    for (const probe of probes) {
      const counts = probe.objects ? `, ${probe.objects.objects} screenshots / ${formatBytes(probe.objects.bytes)}` : "";
      lines.push(`${probe.role === "preferred" ? "Preferred" : "Default"} folder ${probe.ok ? "is writable" : "is not writable"}: ${probe.path}${probe.ok ? counts : ` (${probe.reason})`}`);
    }
    lines.push(`Registered library folders:${roots.length ? "" : " (none)"}`);
    for (const root of roots) lines.push(`  ${root.id} → ${root.path} (${root.kind})`);
    if (record.latestAttachment) {
      const located = library.locate(record.latestAttachment);
      lines.push(
        `Last screenshot saved to: ${located.ok ? located.rootPath : `(${located.message})`}${record.latestAttachment.fallback ? ` (preferred folder unavailable: ${record.latestAttachment.fallback.reason})` : ""}`,
      );
    }
    lines.push(`Session Screenshots: ${refs.length}`);
    if (!refs.length) lines.push("  (no screenshots)");
    if (refs.length >= ATTACHMENT_LIST_LIMIT) {
      lines.push(`  Showing the latest ${ATTACHMENT_LIST_LIMIT}. Open older screenshots by ID.`);
    }
    refs.forEach((ref, position) => {
      const located = library.locate(ref);
      const when = ref.at ? new Date(ref.at).toLocaleString("en-US") : "";
      lines.push(`  ${position + 1}. ${shortId(ref.id)}… ${formatBytes(ref.bytes)} ${when} ${ref.pageLabel || ""} ${ref.title || ""}`.trimEnd());
      lines.push(located.ok ? `     File: ${located.path}` : `     Unavailable: ${located.message}`);
    });
    lines.push("Open older screenshots by ID under Session Screenshots in /ego-settings. Pi can look them up with browser_show_screenshot.");
    lines.push("Find IDs for older screenshots in this session’s tool results.");
    lines.push("Use Screenshot Folder in /ego-settings to select a folder. Without a menu, use /ego-settings attachments set <absolute path> or /ego-settings attachments reset.");
    const shots = this.sessionScreenshots({ sessionKey });
    return {
      ok: true,
      text: lines.join("\n"),
      details: {
        preferred,
        preferredInvalid: config.invalid || null,
        defaultDir,
        stagingDir: library.stagingDir(),
        probes: probes.map((probe) => ({ role: probe.role, path: probe.path, ok: probe.ok, reason: probe.reason || null, objects: probe.objects || null })),
        roots: roots.map((root) => ({ id: root.id, path: root.path, kind: root.kind })),
        attachments: shots,
        legacyPreview: record.previewScreenshot || null,
      },
    };
  }

  /** Persist the preferred attachment directory (created and written to first). */
  setAttachmentsDir({ dir }) {
    const library = new AttachmentLibrary(this.paths);
    try {
      const path = library.setPreferred(dir);
      return {
        ok: true,
        text: `Preferred screenshot folder set to: ${path}\nNew screenshots use this folder. Existing screenshots keep their original locations.\nDefault folder: ${library.defaultDir()}`,
        details: { preferred: path, rootId: library.registerRoot(path, "preferred").id, defaultDir: library.defaultDir() },
      };
    } catch (error) {
      return {
        ok: false,
        code: error?.code || "ATTACHMENT_UNWRITABLE",
        message: error?.message || `Could not set the preferred screenshot folder to ${dir}.`,
        details: { ...(error?.details || {}), current: library.preferredDir() },
      };
    }
  }

  /** Go back to the default attachment library for new captures. */
  resetAttachmentsDir() {
    const library = new AttachmentLibrary(this.paths);
    const dir = library.resetPreferred();
    return {
      ok: true,
      text: `New screenshots will use the default folder: ${dir}\nExisting screenshots keep their original locations.`,
      details: { preferred: null, defaultDir: dir },
    };
  }

  /**
   * Resolve one ID for lookback. The ID must appear in this session's own record:
   * either in its short reference list or in a screenshot tool result of the
   * current Pi session branch. The file must still match its digest, so a model
   * argument can never point at an arbitrary path.
   */
  #sessionAttachment(sessionKey, id, entries = null) {
    const key = this.key(sessionKey);
    const record = this.store.get(key);
    const candidates = [
      ...sessionReferences(entries),
      record.latestAttachment,
      ...(Array.isArray(record.attachments) ? record.attachments : []),
    ].filter(Boolean);
    const selected = selectSessionReference(candidates, id);
    if (!selected.ok) {
      return {
        ok: false,
        code: selected.code || "ATTACHMENT_NOT_IN_SESSION",
        message: selected.message,
        ...(selected.ids ? { details: { ambiguous: selected.ids } } : {}),
      };
    }
    const library = new AttachmentLibrary(this.paths);
    // The same digest can have rows under several roots. Each row keeps the root
    // it was recorded with; the first one whose original file still verifies wins.
    let lastFailure = null;
    for (const ref of selected.matches) {
      const verified = library.verify(ref);
      if (verified.ok) return { ok: true, key, ref, located: verified, library };
      lastFailure = { ref, located: verified };
    }
    return {
      ok: false,
      code: lastFailure.located.code || "ATTACHMENT_UNAVAILABLE",
      message: `Cannot open screenshot ${shortId(selected.id)}…: ${lastFailure.located.message}`,
      details: { attachment: attachmentDetails(lastFailure.ref), path: lastFailure.located.path || null },
    };
  }

  /** Model lookback: pick one older screenshot to ride along with this turn. */
  reviewScreenshot({ sessionKey, id, entries = null }) {
    const resolved = this.#sessionAttachment(sessionKey, id, entries);
    if (!resolved.ok) return resolved;
    const { ref, located } = resolved;
    return {
      ok: true,
      text: [
        `Looking up attachment ${shortId(ref.id)}… (${formatBytes(ref.bytes)})`,
        `File: ${located.path}`,
        `Page: ${ref.title || "(untitled)"} · ${ref.url || "?"}`,
        `Storage root: ${ref.rootId} (${located.rootPath})`,
        "A vision model sees this image in the next model requests of this user turn: it is attached to this tool result and never written into the conversation.",
        "A text-only model gets the path and ID above only; your own window can open it by ID under Session Screenshots in /ego-settings.",
      ].join("\n"),
      details: { attachment: attachmentDetails(ref), path: located.path, review: true },
    };
  }

  /** Resolve one ID to an absolute file path for the OS viewer. */
  attachmentFile({ sessionKey, id, entries = null }) {
    const resolved = this.#sessionAttachment(sessionKey, id, entries);
    if (!resolved.ok) return resolved;
    return {
      ok: true,
      text: resolved.located.path,
      details: { attachment: attachmentDetails(resolved.ref), path: resolved.located.path },
    };
  }

  async handoff({ sessionKey, instruction = null }) {
    const key = this.key(sessionKey);
    const record = this.store.get(key);
    if (record.handedOff) {
      return {
        ok: true,
        text: `The browser is handed to the user; waiting for the user to choose Resume Browser Control in /ego-settings.\nCurrent page: ${record.title || ""} ${record.url || ""}`,
        details: { handedOff: true, alreadyHandedOff: true },
      };
    }
    const result = await this.#run(key, buildHandoffScript({ space: this.#spaceFor(record) }));
    if (result.ok === false) return this.#failure(result);
    this.store.bind(key, {
      spaceId: result.spaceId ?? record.spaceId,
      spaceName: result.spaceName || record.spaceName,
      pageLabel: result.pageLabel ?? record.pageLabel,
      url: result.url ?? record.url,
      title: result.title ?? record.title,
      handedOff: true,
    });
    this.store.invalidateSnapshot(key, "control was handed to the user");
    // The runtime's task.handOff() returns nothing, so visibility comes from
    // how this extension launched the browser, not from the call's reply.
    const visible = !this.paths.headless;
    return {
      ok: true,
      text: [
        "The browser is handed to the user.",
        `Current page: ${result.title || "(untitled)"} · ${result.url || "?"} (tab ${result.pageLabel || "?"})`,
        instruction ? `Ask the user to handle: ${instruction}` : "Ask the user to complete the manual steps in the browser window.",
        visible ? "" : "Note: the browser runs headless, so the user cannot see the window; set PI_EGO_HEADLESS=0 and restart Pi before handing it over.",
        "When the user is done, open /ego-settings, choose Resume Browser Control, and continue the task; do not call browser tools before that.",
      ]
        .filter(Boolean)
        .join("\n"),
      details: { ...this.#spaceDetails(result), handedOff: true, visible },
    };
  }

  async resume({ sessionKey }) {
    const key = this.key(sessionKey);
    const record = this.store.get(key);
    const result = await this.#run(key, buildResumeScript({ space: this.#spaceFor(record) }));
    if (result.ok === false) {
      if (result.code === "SPACE_GONE" || result.code === "PAGES_CLOSED") {
        this.store.update(key, { spaceId: result.code === "SPACE_GONE" ? null : record.spaceId, handedOff: false, snapshot: null });
      }
      return this.#failure(result);
    }
    const numbered = numberSnapshot(result.snapshot);
    const seq = this.store.nextSeq(key);
    this.store.recordSnapshot(key, {
      spaceId: result.spaceId ?? null,
      pageLabel: result.pageLabel ?? null,
      url: result.url ?? null,
      title: result.title ?? null,
      seq,
      items: numbered.items,
    });
    this.store.setHandoff(key, false);
    return {
      ok: true,
      text: `Resumed browser control (previous owner: ${result.resumedFrom || "user"}).\nCurrent page: ${result.title || "(untitled)"} · ${result.url}\nElement numbers #1..#${numbered.items.length} are ready (snapshot ${seq}).\n${truncate(numbered.text, 20000).text}`,
      details: { ...this.#spaceDetails(result), resumed: true, seq, elements: numbered.items.length },
    };
  }

  async status({ sessionKey, doctor = null }) {
    const key = this.key(sessionKey);
    const record = this.store.get(key);
    const guard = await assertEndpointIsOurs({ paths: this.paths });
    const endpoint = guard.foreign ? null : guard.endpoint;
    const browserState = readBrowserState(this.paths);
    const spaces = readSpaces(this.paths);
    const space = record.spaceId == null ? null : spaces.spaces.find((entry) => entry.id === record.spaceId) || null;
    const doctorResult = doctor || (endpoint ? await runDoctor({ paths: this.paths, env: this.env }) : null);
    const doctorParsed = doctorResult?.raw ? parseDoctor(doctorResult.raw) : doctorResult && doctorResult.browser ? doctorResult : null;
    const lines = [];
    const browserStatus = guard.foreign
      ? `Port ${this.paths.port} is in use by another browser`
      : endpoint
        ? `Running on port ${this.paths.port}`
        : "Stopped. Starts when a browser tool is used.";
    lines.push(`Browser: ${browserStatus}`);
    if (browserState) {
      lines.push(`Browser source: ${browserState.source || "?"}${browserState.version ? ` ${browserState.version}` : ""}${browserState.path ? ` → ${browserState.path}` : ""}`);
      if (browserState.ok === false) lines.push(`Last browser setup error: ${browserState.stage} — ${browserState.message}`);
    } else {
      lines.push("Browser source: determined on first use");
    }
    lines.push(`State folder: ${this.paths.stateRoot}`);
    {
      const library = new AttachmentLibrary(this.paths);
      const config = library.configState();
      lines.push(
        `Screenshot library: ${config.preferred || library.defaultDir()}${config.preferred ? ` (preferred, default: ${library.defaultDir()})` : " (default)"}`,
      );
    }
    if (doctorParsed) {
      lines.push(`Diagnostics: browser ${doctorParsed.browser || "?"}, endpoint ${doctorParsed.endpoint || "?"}, task spaces ${doctorParsed.spaces.length}`);
    }
    lines.push(
      `Session: ${record.spaceId == null ? "No browser task space yet" : `Task space ${record.spaceId} (${record.spaceName})`}${
        space ? `, owner: ${space.ownership}, tabs: ${space.targetIds?.length ?? 0}` : ""
      }`,
    );
    if (record.url) lines.push(`Current page: ${record.title || ""} ${record.url}`);
    if (record.pageLabel) lines.push(`Current tab: ${record.pageLabel}`);
    lines.push(
      record.handedOff
        ? "Control: your turn. Select Resume Browser Control in /ego-settings when ready."
        : "Control: Pi",
    );
    if (record.snapshot?.items?.length) lines.push(`Element numbers: #1..#${record.snapshot.items.length} (snapshot ${record.snapshot.seq}).`);
    else if (record.invalidReason) lines.push(`Element numbers are stale. Run browser_read to refresh them.`);
    return {
      ok: true,
      text: lines.join("\n"),
      details: {
        endpointRunning: Boolean(endpoint),
        browserState,
        session: {
          spaceId: record.spaceId,
          spaceName: record.spaceName,
          handedOff: Boolean(record.handedOff),
          pageLabel: record.pageLabel,
          url: record.url,
          title: record.title,
        },
        spaces: spaces.spaces.map((entry) => ({ id: entry.id, name: entry.name, ownership: entry.ownership, tabs: entry.targetIds?.length ?? 0 })),
        doctor: doctorParsed,
      },
    };
  }
}

export function readPackageInfo(paths) {
  return readJsonSync(join(paths.root, "package.json"), null);
}
