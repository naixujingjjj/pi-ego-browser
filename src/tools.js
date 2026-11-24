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
  if (!text) throw new AttachmentError("ATTACHMENT_PATH_INVALID", "另存需要一个完整的目标路径。");
  const expanded = text.replace(/^~(?=$|[\\/])/, () => homedir());
  const { root } = parse(expanded);
  if (!isAbsolute(expanded) || (process.platform === "win32" && root.length === 1)) {
    throw new AttachmentError("ATTACHMENT_PATH_INVALID", `另存的目标必须是绝对路径，收到的是“${text}”。`);
  }
  if (process.platform === "win32" && expanded.slice(root.length).includes(":")) {
    throw new AttachmentError("ATTACHMENT_PATH_INVALID", "另存的目标必须是普通 PNG 文件路径。");
  }
  const resolved = resolve(expanded);
  if (!/\.png$/i.test(resolved)) {
    throw new AttachmentError("ATTACHMENT_PATH_INVALID", `另存的目标要以 .png 结尾：${resolved}`);
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
      "用户正在控制这个浏览器任务空间。等用户处理完并在 Pi 里从 /ego-settings 的「恢复浏览器控制」恢复后再继续；现在不要重试。\n（Ego 原文：" +
      text.trim().split("\n")[0] +
      "）",
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
        "用户正在控制这个浏览器任务空间。等用户处理完并在 Pi 里从 /ego-settings 的「恢复浏览器控制」恢复后再继续；现在不要重试。",
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
      text: `已打开 ${result.title || "(无标题)"}\n地址：${result.url}\n标签页：${result.pageLabel || "?"}（任务空间 ${result.spaceId ?? "?"}，共 ${result.tabs?.length ?? 1} 个标签页）\n下一步：browser_read 读取页面元素编号。`,
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
    const header = `[${result.pageLabel || "page"} · ${result.url || "?"} · ${result.title || "(无标题)"}]\n[编号 #1..#${numbered.items.length} 只对这次读取的页面状态有效；页面跳转或标签页切换后要重新 browser_read]`;
    const body = truncate(`${header}\n${numbered.text}`);
    return {
      ok: true,
      text: `${body.text}\n[读取完成：${numbered.items.length} 个可操作编号，第 ${seq} 次读取]`,
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
    if (navigated) this.store.invalidateSnapshot(key, "页面已跳转");
    return {
      ok: true,
      text: `已点击 ${resolved.number ? `#${resolved.number}` : resolved.value}（${result.pageLabel || "?"}）\n当前：${result.title || "(无标题)"} · ${result.url}${navigated ? "\n页面已跳转，编号已失效，下一步先 browser_read。" : ""}`,
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
    if (result.navigated) this.store.invalidateSnapshot(key, "页面已跳转");
    return {
      ok: true,
      text: `已填写 ${resolved.number ? `#${resolved.number}` : resolved.value}（${resolved.role || "element"}${resolved.name ? ` "${resolved.name}"` : ""}）\n当前：${result.title || "(无标题)"} · ${result.url}`,
      details: { ...this.#spaceDetails(result), target: resolved.number ? `#${resolved.number}` : resolved.value, navigated: Boolean(result.navigated) },
    };
  }

  #actionFailure(key, result, resolved) {
    const staleHint = /stale|not found|no such|detached|element/i.test(`${result.code} ${result.message}`);
    if (staleHint) {
      this.store.invalidateSnapshot(key, "元素编号可能已失效");
    }
    const failure = this.#failure(result);
    const hint =
      result.code === "EGO_PAGE_UNRESPONSIVE" || result.mayHaveLateEffects
        ? "\n结果不确定：动作可能已经生效。先 browser_read 看页面当前状态，再决定是否重试。"
        : staleHint
          ? "\n编号或元素可能已失效：先 browser_read 重新读取页面。"
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
    if (action !== "list") this.store.invalidateSnapshot(key, "标签页已变化");
    const tabLines = (result.tabs || [])
      .map((tab, position) => `  ${position}: ${tab.label || "(未管理)"} ${tab.active ? "← 当前" : ""} ${tab.title || ""} ${tab.url || ""}`.trimEnd())
      .join("\n");
    const labels = `标签页（任务空间 ${result.spaceId ?? "?"}）：\n${tabLines || "  （空）"}`;
    if (action === "list") {
      return { ok: true, text: labels, details: { ...this.#spaceDetails(result), labels: result.labels || [] } };
    }
    if (action === "new") {
      return {
        ok: true,
        text: `已新建标签页 ${result.pageLabel || "?"}：${result.url || "about:blank"}\n${labels}\n编号已失效，下一步先 browser_read。`,
        details: { ...this.#spaceDetails(result), created: true },
      };
    }
    if (action === "switch") {
      return {
        ok: true,
        text: `已切换到 ${result.pageLabel || "?"}：${result.title || ""} ${result.url || ""}\n${labels}\n编号已失效，下一步先 browser_read。`,
        details: { ...this.#spaceDetails(result), activated: true },
      };
    }
    return {
      ok: true,
      text: `已关闭 ${result.closed || "标签页"}\n${labels}\n编号已失效，下一步先 browser_read。`,
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
        message: error?.message || "附件库不可写，无法保存截图。",
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
        return { ok: false, code: "SCREENSHOT_UNAVAILABLE", message: "浏览器没有生成可用的截图。" };
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
        "截图已保存在附件库（原件就在下面这个文件里，不需要再另存一份）。",
        `附件 ID：${ref.id}`,
        `文件：${ingested.path}`,
        `页面：${ref.title || "(无标题)"} · ${ref.url || "?"}${ref.pageLabel ? `（标签页 ${ref.pageLabel}）` : ""}`,
        `大小：${formatBytes(ref.bytes)}；存储根：${ref.rootId}`,
        ingested.deduped ? "同一画面已经在附件库里，没有多存一份。" : "",
        fallback
          ? `首选目录 ${fallback.path} 这次不可用（${fallback.reason}），这张写进了 ${ingested.rootPath}；首选设置保留，目录恢复后下次截图会继续用它。`
          : "",
        "用户说「保存这张」时这就是原件：回答上面的路径即可，不要再复制一份。只有用户明确要求存到别的目录并给出完整 .png 路径时，才用 browser_save_screenshot { path }。",
        "要回看本会话旧截图：browser_show_screenshot（模型）；用户可在 /ego-settings 的「本会话截图」里打开。",
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
        message: error?.message || "这张截图没有保存成功。",
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
          message: `没有找到这张截图的原件：${original.message}`,
          details: { attachment: attachmentDetails(ref), path: original.path || null },
        };
      }
    } else {
      const cached = this.#legacyPreviewFile(key);
      if (!cached) {
        return { ok: false, code: "NO_SCREENSHOT", message: "当前会话没有可保存的截图，请先 browser_screenshot。" };
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
          message: `这张 0.1.1 预览没有保存成功：${error?.message || describeFileError(error)}`,
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
          message: `这张 0.1.1 预览已经写入附件库，但现在读不到：${original.message}`,
          details: { attachment: attachmentDetails(ref), path: original.path || null },
        };
      }
      legacy = true;
    }

    if (!target) {
      return {
        ok: true,
        text: [
          `截图原件已经在附件库：${original.path}`,
          `附件 ID：${ref.id}`,
          ...(legacy ? ["（这张来自 0.1.1 的预览；已经复制进附件库，旧缓存文件没有改动。）"] : []),
          "这就是要保存的原件：没有复制第二份。只有用户明确要求存到其它目录时，才用带完整 .png 路径的另存。",
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
        message: `没有另存：${error?.message || `目标路径无效：${target}`}`,
        details: { attachment: attachmentDetails(ref), path: null },
      };
    }
    if (destination.toLowerCase() === normalizeRootPath(original.path).toLowerCase()) {
      return {
        ok: true,
        text: `这个文件就是附件库里的原件：${original.path}\n附件 ID：${ref.id}`,
        details: { attachment: attachmentDetails(ref), path: original.path, saved: true, savedOriginal: true, bytes: original.bytes },
      };
    }
    const existing = statSync(destination, { throwIfNoEntry: false });
    if (existing) {
      if (!existing.isFile()) {
        return {
          ok: false,
          code: "ATTACHMENT_PATH_IS_FILE",
          message: `另存的目标 ${destination} 已经存在，而且不是文件；没有覆盖。`,
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
          text: `这张截图已经在这个文件里：${destination}\n附件 ID：${ref.id}；原件仍在 ${original.path}`,
          details: { attachment: attachmentDetails(ref), path: destination, saved: true, copied: true, reused: true, bytes: original.bytes },
        };
      }
      return {
        ok: false,
        code: "ATTACHMENT_EXISTS",
        message: `另存的目标 ${destination} 已经存在，内容和这张截图不同；没有覆盖。换一个文件名再试。`,
        details: { attachment: attachmentDetails(ref), path: destination },
      };
    }
    const directory = dirname(destination);
    if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
      return {
        ok: false,
        code: "ATTACHMENT_MISSING",
        message: `另存的目标目录不存在：${directory}。先建好目录，再给出完整的 .png 路径；不会替你创建目录。`,
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
        throw new AttachmentError("ATTACHMENT_CORRUPT", "另存的文件内容和附件 ID 对不上。");
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
          ? `另存的目标 ${destination} 在这期间出现了；没有覆盖。换一个文件名再试。`
          : `另存失败：${describeFileError(error)}（目标 ${destination}）`,
        details: { attachment: attachmentDetails(ref), path: destination },
      };
    } finally {
      if (ownsTemporary) removeScreenshotFile(temporary);
    }
    return {
      ok: true,
      text: [
        `已另存一份：${destination}`,
        `附件 ID：${ref.id}；原件仍在附件库：${original.path}`,
        ...(legacy ? ["（这张来自 0.1.1 的预览；旧缓存文件没有改动。）"] : []),
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
   * `本会话截图` page (each row carries its file and whether it is usable).
   */
  attachments({ sessionKey }) {
    const key = this.key(sessionKey);
    const record = this.store.get(key);
    const library = new AttachmentLibrary(this.paths);
    const config = library.configState();
    const defaultDir = library.defaultDir();
    const preferred = config.preferred;
    const probes = [];
    if (preferred) probes.push({ role: "首选", ...library.probe(preferred, { create: false }) });
    probes.push({ role: "默认", ...library.probe(defaultDir, { create: true }) });
    const roots = Object.values(library.roots());
    const refs = Array.isArray(record.attachments) && record.attachments.length
      ? record.attachments
      : record.latestAttachment
        ? [record.latestAttachment]
        : [];

    const lines = ["附件库"];
    lines.push(`首选目录：${preferred || "（未设置，用默认目录）"}`);
    lines.push(`默认目录：${defaultDir}`);
    lines.push(`本机暂存区：${library.stagingDir()}（截图先写这里，发布到附件库时删掉）`);
    if (config.invalid) lines.push(`注意：配置里记录的目录无效（${config.invalid}：${config.error || "不是绝对路径"}），现在按未设置处理。`);
    for (const probe of probes) {
      const counts = probe.objects ? `，${probe.objects.objects} 张 / ${formatBytes(probe.objects.bytes)}` : "";
      lines.push(`${probe.role}目录${probe.ok ? "可写" : "不可写"}：${probe.path}${probe.ok ? counts : `（${probe.reason}）`}`);
    }
    lines.push(`登记的存储根：${roots.length ? "" : "（还没有）"}`);
    for (const root of roots) lines.push(`  ${root.id} → ${root.path}（${root.kind}）`);
    if (record.latestAttachment) {
      const located = library.locate(record.latestAttachment);
      lines.push(
        `最近一张实际写入：${located.ok ? located.rootPath : `（${located.message}）`}${record.latestAttachment.fallback ? `；首选目录上一次失败：${record.latestAttachment.fallback.reason}` : ""}`,
      );
    }
    lines.push(`本会话截图：${refs.length} 张`);
    if (!refs.length) lines.push("  （还没有截图）");
    if (refs.length >= ATTACHMENT_LIST_LIMIT) {
      lines.push(`  （列表只留最近 ${ATTACHMENT_LIST_LIMIT} 张；更早的截图仍可用 ID 回看，见下面的命令）`);
    }
    refs.forEach((ref, position) => {
      const located = library.locate(ref);
      const when = ref.at ? new Date(ref.at).toLocaleString("zh-CN") : "";
      lines.push(`  ${position + 1}. ${shortId(ref.id)}… ${formatBytes(ref.bytes)} ${when} ${ref.pageLabel || ""} ${ref.title || ""}`.trimEnd());
      lines.push(located.ok ? `     文件：${located.path}` : `     不可用：${located.message}`);
    });
    lines.push("回看旧截图：browser_show_screenshot { id }（模型请求里带上图），或在 /ego-settings 的「本会话截图」里按 ID 打开（打开文件）");
    lines.push("没有列传的旧截图也能用 ID 回看：本会话的工具结果里存着每张图的紧凑引用");
    lines.push("设置：/ego-settings 的「截图附件目录」用 Windows 选择器；非交互环境用 /ego-settings attachments set <绝对路径>（可带引号和空格）或 /ego-settings attachments reset（回到默认目录）");
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
        text: `首选附件目录已设置为：${path}\n新的截图会写到 ${path}；已经存在的附件仍按保存时登记的存储根定位，不搬迁文件。\n默认目录保持为：${library.defaultDir()}`,
        details: { preferred: path, rootId: library.registerRoot(path, "preferred").id, defaultDir: library.defaultDir() },
      };
    } catch (error) {
      return {
        ok: false,
        code: error?.code || "ATTACHMENT_UNWRITABLE",
        message: error?.message || `无法把首选目录设置为 ${dir}。`,
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
      text: `首选附件目录已清除，新截图写默认库：${dir}\n已有附件仍按保存时登记的存储根定位。`,
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
      message: `附件 ${shortId(selected.id)}… 现在打不开：${lastFailure.located.message}`,
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
        `回看附件 ${shortId(ref.id)}…（${formatBytes(ref.bytes)}）`,
        `文件：${located.path}`,
        `页面：${ref.title || "(无标题)"} · ${ref.url || "?"}`,
        `存储根：${ref.rootId}（${located.rootPath}）`,
        "视觉模型会在本次用户轮的下一批模型请求里看到这张图：挂在这次工具结果上，不写进会话。",
        "纯文字模型只拿到上面的路径和 ID；你自己的窗口可以在 /ego-settings 的「本会话截图」里按 ID 打开它。",
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
        text: `浏览器已经交给用户，正在等待用户在 /ego-settings 里选「恢复浏览器控制」。\n当前页面：${record.title || ""} ${record.url || ""}`,
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
    this.store.invalidateSnapshot(key, "控制权已交给用户");
    // The runtime's task.handOff() returns nothing, so visibility comes from
    // how this extension launched the browser, not from the call's reply.
    const visible = !this.paths.headless;
    return {
      ok: true,
      text: [
        "已把浏览器交给用户。",
        `当前页面：${result.title || "(无标题)"} · ${result.url || "?"}（标签页 ${result.pageLabel || "?"}）`,
        instruction ? `请用户处理：${instruction}` : "请用户在浏览器窗口里完成需要人工的步骤。",
        visible ? "" : "注意：浏览器是无头模式，用户看不到窗口；设置 PI_EGO_HEADLESS=0 后重启 Pi 才能交给用户操作。",
        "用户完成后在 Pi 里打开 /ego-settings，选「恢复浏览器控制」，再继续任务；在此之前不要再调用浏览器工具。",
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
      text: `已恢复浏览器控制权（从 ${result.resumedFrom || "用户"} 接手）。\n当前页面：${result.title || "(无标题)"} · ${result.url}\n编号 #1..#${numbered.items.length}（第 ${seq} 次读取），可以直接继续操作。\n${truncate(numbered.text, 20000).text}`,
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
      ? `端口 ${this.paths.port} 已被其他浏览器占用`
      : endpoint
        ? `正在运行（端口 ${this.paths.port}）`
        : "未运行（下次调用浏览器工具时启动）";
    lines.push(`浏览器：${browserStatus}`);
    if (browserState) {
      lines.push(`浏览器来源：${browserState.source || "?"}${browserState.version ? ` ${browserState.version}` : ""}${browserState.path ? ` → ${browserState.path}` : ""}`);
      if (browserState.ok === false) lines.push(`上次准备失败：${browserState.stage} — ${browserState.message}`);
    } else {
      lines.push("浏览器来源：尚未准备（首次使用时会发现本机浏览器或下载 Chrome for Testing）");
    }
    lines.push(`状态目录：${this.paths.stateRoot}`);
    {
      const library = new AttachmentLibrary(this.paths);
      const config = library.configState();
      lines.push(
        `附件库：${config.preferred || library.defaultDir()}${config.preferred ? `（首选；默认 ${library.defaultDir()}）` : "（默认目录）"}；/ego-settings attachments 看详情`,
      );
    }
    if (doctorParsed) {
      lines.push(`doctor：浏览器 ${doctorParsed.browser || "?"}；端点 ${doctorParsed.endpoint || "?"}；任务空间 ${doctorParsed.spaces.length} 个`);
    }
    lines.push(
      `本会话：${record.spaceId == null ? "还没有浏览器任务空间" : `任务空间 ${record.spaceId}（${record.spaceName}）`}${
        space ? `，ownership=${space.ownership}，标签 ${space.targetIds?.length ?? 0} 个` : ""
      }`,
    );
    if (record.url) lines.push(`当前页面：${record.title || ""} ${record.url}`);
    if (record.pageLabel) lines.push(`当前标签页：${record.pageLabel}`);
    lines.push(
      record.handedOff
        ? "等待用户：控制权在用户手里，在 /ego-settings 里选「恢复浏览器控制」。"
        : "控制权：Pi 持有（可以直接操作浏览器）。",
    );
    if (record.snapshot?.items?.length) lines.push(`编号：#1..#${record.snapshot.items.length} 仍有效（第 ${record.snapshot.seq} 次读取）。`);
    else if (record.invalidReason) lines.push(`编号：已失效（${record.invalidReason}），下次操作前先 browser_read。`);
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
