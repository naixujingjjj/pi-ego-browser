// pi-ego-browser: browser tools for Pi, backed by a vendored Ego runtime.
//
// The package ships the built ego-windows-host runtime under `vendor/` and
// launches it per call, so installing this package is the whole setup: no Ego
// desktop app, no PATH change, no skill to load. The extension picks the
// browser (installed Edge/Chrome/Chromium first, then a verified downloaded
// Chrome for Testing), keeps its own dedicated profile under the Pi state root,
// and drives it through the Ego task-space API.
//
// Screenshots are content-addressed attachments: the capture writes one staging
// PNG, the SHA-256 of its bytes is the attachment ID, and what reaches the
// session transcript is text plus that small metadata. The image is attached to
// a deep copy of the model request only (see `pi.on("context")`), and the TUI
// row reads it from disk when expanded.
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { AttachmentLibrary, formatBytes, MAX_INLINE_ATTACHMENT_BYTES, shortId } from "../src/attachments.js";
import { parseAttachmentsCommand, parsePathArgument, parseSettingsCommand } from "../src/command.js";
import { planRequestInjection } from "../src/review.js";
import { createScreenshotView } from "../src/render.js";
import { chooseEgoSetting } from "../src/settings-ui.js";
import { pickFolder } from "../src/folder-picker.js";
import { acquireLock } from "../src/store.js";
import { BrowserService } from "../src/tools.js";

const SESSION_FALLBACK = "default";

function sessionKeyOf(ctx) {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (id) return String(id);
  } catch {
    // fall through to the environment/default key
  }
  return SESSION_FALLBACK;
}

/**
 * The current Pi session's own entries, for looking up a screenshot ID that has
 * already fallen out of the short reference list. `getBranch()` is the branch the
 * model actually saw; `getEntries()` is the fallback for hosts without it, and
 * `null` (no session API, e.g. an injected fake context) falls back to the store.
 */
function sessionEntriesOf(ctx) {
  try {
    const manager = ctx?.sessionManager;
    if (typeof manager?.getBranch === "function") return manager.getBranch();
    if (typeof manager?.getEntries === "function") return manager.getEntries();
  } catch {
    // A lookup helper must never break a tool call.
  }
  return null;
}

/**
 * Tool results carry text and small metadata only. An `image` content block here
 * would be persisted into the session JSONL as base64, which this version never
 * does: images travel through `renderResult` and the `context` hook instead.
 */
function toToolResult(outcome) {
  const content = [{ type: "text", text: outcome.text || outcome.message || (outcome.ok ? "ok" : "failed") }];
  const details = outcome.details && typeof outcome.details === "object" ? { ...outcome.details } : {};
  if (outcome.code && details.code === undefined) details.code = outcome.code;
  const result = { content, details };
  if (outcome.ok === false) result.isError = true;
  return result;
}

function textOf(result) {
  return (result?.content || [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * TUI row for a result that carries `details.attachment`: ID, size, page and the
 * absolute file path always; the picture only when the row is expanded and Pi has
 * images enabled, read from the attachment library at that moment.
 */
function makeAttachmentRenderer(tui, libraryFor) {
  if (!tui?.Text) return null;
  return (result, options = {}, theme, context = {}) => {
    const details = result?.details || {};
    const attachment = details.attachment;
    const raw = textOf(result);
    if (options.isPartial || !attachment?.id) return new tui.Text(raw, 0, 0);
    const page = [attachment.pageLabel, attachment.url].filter(Boolean).join(" · ");
    const lines = [
      `${theme.fg("success", `附件 ${shortId(attachment.id)}…`)} ${theme.fg("dim", `${
        formatBytes(attachment.bytes)
      }${page ? ` · ${page}` : ""}`)}`,
      theme.fg("dim", `文件：${details.path || "（解析附件库路径）"}`),
    ];
    if (!options.expanded) {
      lines.push(theme.fg("dim", context.showImages ? "展开这一行查看图片" : "图片显示已关闭：可以用上面的文件路径打开"));
      return new tui.Text(lines.join("\n"), 0, 0);
    }
    return createScreenshotView(tui, {
      text: [...lines, "", raw].join("\n"),
      loadImage: () => {
        const library = libraryFor();
        // The TUI row is an inline surface: a larger picture stays a path, so the
        // row never reads a huge PNG into memory just to show it.
        const loaded = library.load(attachment, { maxBytes: MAX_INLINE_ATTACHMENT_BYTES });
        if (!loaded.ok) return { error: loaded.message };
        return { data: loaded.data.toString("base64"), mimeType: loaded.mime || "image/png", filename: loaded.path };
      },
      theme,
      showImages: context.showImages !== false,
      maxWidthCells: 60,
    });
  };
}

export default async function piEgoBrowser(pi) {
  // Pi maps this import to its own copy of the TUI package. Outside Pi (the load
  // check, unit tests) it may be missing; the tools then render text only.
  let tui = null;
  try {
    tui = await import("@earendil-works/pi-tui");
  } catch {
    tui = null;
  }

  const progress = new AsyncLocalStorage();
  const service = new BrowserService({
    notify: (message) => progress.getStore()?.(toToolResult({ ok: true, text: message })),
  });
  const libraryFor = () => new AttachmentLibrary(service.paths);
  const attachmentRenderer = makeAttachmentRenderer(tui, libraryFor);

  const withBrowserLock = async (operation) => {
    const release = await acquireLock(service.paths.lockFile);
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const run = async (ctx, onUpdate, fn, params) => {
    try {
      const outcome = await withBrowserLock(() =>
        progress.run(onUpdate, () => fn({ sessionKey: sessionKeyOf(ctx), ...params })),
      );
      return toToolResult(outcome);
    } catch (error) {
      return toToolResult({
        ok: false,
        message: `pi-ego-browser failed: ${error?.stack || error?.message || error}`,
        details: { error: String(error?.message || error) },
      });
    }
  };

  pi.registerTool({
    name: "browser_open",
    label: "Browser Open",
    description:
      "Open a URL in the browser task space owned by this Pi session and make it the current tab. Returns the page title, the final URL and the tab label. Follow it with browser_read to get element numbers.",
    promptSnippet: "Open or navigate a URL in this session's browser task space",
    promptGuidelines: [
      "Use browser_open to start browser work; it creates this session's own Ego task space on first use and reuses it afterwards.",
      "After browser_open, call browser_read before clicking or filling: element numbers come from a read.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Absolute http(s), file:// or data: URL to open" }),
    }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return run(ctx, onUpdate, service.open.bind(service), { url: params.url });
    },
  });

  pi.registerTool({
    name: "browser_read",
    label: "Browser Read",
    description:
      "Read the current page of this session's browser task space as a numbered element tree (role, accessible name, `[#n]` action number). Element numbers are valid only for the page state that printed them: after a navigation, a tab switch or another action that changes the page, read again.",
    promptSnippet: "Read the page as a numbered element tree (#n) for the next click or fill",
    promptGuidelines: [
      "Use browser_read before acting, and again after any action that changes the page; element numbers from an old read are rejected.",
      "Pass scope \"full_page\" when the content you need may be below the fold.",
    ],
    parameters: Type.Object({
      pageLabel: Type.Optional(Type.String({ description: "Tab label such as p2; defaults to the active tab" })),
      scope: Type.Optional(StringEnum(["viewport", "full_page"])),
    }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return run(ctx, onUpdate, service.read.bind(service), { pageLabel: params.pageLabel ?? null, scope: params.scope ?? "viewport" });
    },
  });

  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description:
      "Click one element in the current page: pass an element number from the latest browser_read (`#4` or `4`), or an Ego selector (`@12`, `text=Save`, `loc=role:button[name='Save']`, CSS). Reports the page state afterwards. If the action times out or the result is uncertain, read the page before retrying.",
    promptSnippet: "Click an element by read number (#n) or selector",
    promptGuidelines: [
      "Use browser_click with an element number from the latest browser_read, not with a number from an older read.",
      "If browser_click reports a timeout or an uncertain result, call browser_read and decide again instead of repeating the click.",
    ],
    parameters: Type.Object({
      target: Type.String({ description: "Element number from browser_read (#4 / 4) or an Ego selector" }),
    }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return run(ctx, onUpdate, service.click.bind(service), { target: params.target });
    },
  });

  pi.registerTool({
    name: "browser_fill",
    label: "Browser Fill",
    description:
      "Fill one text field, textarea or contenteditable on the current page with `text`, replacing its content and firing input/change events. Pass an element number from the latest browser_read or an Ego selector.",
    promptSnippet: "Fill a form field by read number (#n) or selector",
    promptGuidelines: [
      "Use browser_fill for form fields; check the page state with browser_read when a fill must be confirmed.",
    ],
    parameters: Type.Object({
      target: Type.String({ description: "Element number from browser_read (#4 / 4) or an Ego selector" }),
      text: Type.String({ description: "Text to put in the field" }),
    }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return run(ctx, onUpdate, service.fill.bind(service), { target: params.target, text: params.text });
    },
  });

  pi.registerTool({
    name: "browser_tabs",
    label: "Browser Tabs",
    description:
      "Manage the tabs of this session's browser task space: list them, open a new one, switch the active tab, or close one. Tabs are owned by this session; another Pi session has its own task space and its own tabs. Switching or opening a tab invalidates element numbers.",
    promptSnippet: "List, open, switch or close tabs in this session's task space",
    promptGuidelines: [
      "Use browser_tabs action \"list\" to see this session's tabs before switching by label or index.",
      "After browser_tabs opens or switches a tab, call browser_read before acting on the new page.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "new", "switch", "close"]),
      url: Type.Optional(Type.String({ description: "URL to open for action \"new\"" })),
      pageLabel: Type.Optional(Type.String({ description: "Tab label such as p2 for switch/close" })),
      index: Type.Optional(Type.Number({ description: "Tab position from action \"list\" for switch/close" })),
    }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return run(ctx, onUpdate, service.tabs.bind(service), {
        action: params.action,
        url: params.url ?? null,
        pageLabel: params.pageLabel ?? null,
        index: Number.isInteger(params.index) ? params.index : null,
      });
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description:
      "Take a screenshot of the current page (or `pageLabel` tab). The raw PNG is stored once in the attachment library and the result returns a stable attachment ID with its size, MIME type and storage root: no image bytes go into the conversation. A vision model sees the picture with the next request of this user turn; on a text-only model, in a non-image TUI and over RPC the ID and the absolute file path are the way to open it.",
    promptSnippet: "Capture the current page into the attachment library and get its ID",
    promptGuidelines: [
      "Take a screenshot when the user requests one or when the task needs visual details the page read cannot provide. Use browser_read for ordinary page lookups.",
      "Screenshots are already saved permanently in the attachment library: keep the returned attachment ID and absolute file path when the user may ask about that picture later, and never expect image bytes in the result.",
      "When the user says to save the screenshot or keep it, browser_screenshot alone has already saved the only copy: answer with its path/ID. Do not copy it anywhere, and do not call browser_save_screenshot for a normal save.",
      "To look at a picture taken earlier in this session, call browser_show_screenshot with its ID instead of taking the same screenshot again.",
    ],
    parameters: Type.Object({
      pageLabel: Type.Optional(Type.String({ description: "Tab label such as p2; defaults to the active tab" })),
      fullPage: Type.Optional(Type.Boolean({ description: "Capture the whole scrollable page" })),
    }),
    executionMode: "sequential",
    ...(attachmentRenderer ? { renderResult: attachmentRenderer } : {}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return run(ctx, onUpdate, service.screenshot.bind(service), { pageLabel: params.pageLabel ?? null, fullPage: Boolean(params.fullPage) });
    },
  });

  pi.registerTool({
    name: "browser_show_screenshot",
    label: "Show Browser Screenshot",
    description:
      "Load one screenshot taken earlier in this Pi session by its attachment ID (the full 64-character ID from browser_screenshot, or a unique prefix of it). The image is attached to the next model request of this user turn only; the conversation keeps just the ID and path. Use it when the user asks to look at an earlier screenshot again.",
    promptSnippet: "Bring one earlier screenshot of this session back into view by attachment ID",
    promptGuidelines: [
      "Use browser_show_screenshot with an ID this session returned; IDs from another session or a made-up ID are refused.",
      "Only the current user turn carries the image, so ask once per turn; there is no need to repeat the call within the same turn.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Attachment ID (64 lowercase hex characters) or its unique prefix" }),
    }),
    executionMode: "sequential",
    ...(attachmentRenderer ? { renderResult: attachmentRenderer } : {}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return run(ctx, onUpdate, service.reviewScreenshot.bind(service), {
        id: params.id,
        entries: sessionEntriesOf(ctx),
      });
    },
  });

  pi.registerTool({
    name: "browser_save_screenshot",
    label: "Save Browser Screenshot",
    description:
      "Return the screenshot's saved original from the attachment library: a capture is already stored permanently on disk, so a normal \"save this\" needs no copy. Without a `path` this verifies and returns the existing absolute file path and attachment ID. Pass `path` only when the user explicitly asked for a separate copy in another place: a full absolute Windows path ending in .png. That copy never overwrites an existing file, never falls back to a default directory and never creates the directory.",
    promptSnippet: "Return the already-saved screenshot original, or copy it to the one absolute .png path the user named",
    promptGuidelines: [
      "Screenshots are already permanently saved by browser_screenshot. When the user says to save or keep a picture, call browser_screenshot (or this tool without `path`) and report the existing absolute path and ID; do not produce a second copy.",
      "Use `path` only when the user explicitly names another destination as a full absolute .png path. Never invent one, never pass a directory, and expect a refusal instead of an overwrite when the file exists.",
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description:
            "Only for an explicit separate copy: the full absolute destination path ending in .png. Omit to get the already-saved original.",
        }),
      ),
    }),
    executionMode: "sequential",
    ...(attachmentRenderer ? { renderResult: attachmentRenderer } : {}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return run(ctx, onUpdate, service.saveScreenshot.bind(service), { path: params.path ?? null });
    },
  });

  pi.registerTool({
    name: "browser_handoff",
    label: "Browser Hand Off",
    description:
      "Hand the current tab to the user for something only a human can do (login, CAPTCHA, 2FA, a manual confirmation), then stop. While the user has control, this session's browser tools refuse to run until the user takes control back from /ego-settings (恢复浏览器控制).",
    promptSnippet: "Hand the browser tab to the user and pause browser tools",
    promptGuidelines: [
      "Use browser_handoff as soon as a step needs the user (login without credentials, CAPTCHA, 2FA); then stop and tell the user to take control back from /ego-settings (恢复浏览器控制).",
      "Do not retry browser tools while browser_handoff is in effect.",
    ],
    parameters: Type.Object({
      instruction: Type.Optional(Type.String({ description: "What the user should do in the browser window" })),
    }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return run(ctx, onUpdate, service.handoff.bind(service), { instruction: params.instruction ?? null });
    },
  });

  /**
   * Attach this turn's screenshot observations to the model request.
   *
   * Pi hands over a deep copy of the transcript for one request, and the copy is
   * thrown away afterwards, which is exactly the lifetime an image should have.
   * The picture is attached to the screenshot tool result that reports it — a
   * capture or a lookback of this turn, selected by message order. Text-only
   * models, an unreadable library file and an oversized image all fall back to
   * the text the tool result already carries.
   */
  pi.on?.("context", async (event, ctx) => {
    try {
      const plan = planRequestInjection({
        messages: event.messages,
        model: ctx?.model,
        library: libraryFor(),
      });
      if (!plan?.injected) return;
      return { messages: plan.messages };
    } catch {
      // A screenshot must never break a model request.
      return;
    }
  });

  const uiNotify = (ctx, message, level = "info") => {
    try {
      ctx?.ui?.notify?.(message, level);
    } catch {
      // notifications are best effort
    }
  };

const SETTINGS_USAGE = [
    "/ego-settings                     打开 Ego 浏览器设置（菜单：info / 截图附件目录 / 恢复默认目录 / 本会话截图 / 恢复浏览器控制）",
    "/ego-settings info                浏览器状态（菜单 info 一栏；与 status 完全相同）",
    "/ego-settings status              浏览器状态",
    "/ego-settings resume              用户手动接手后恢复 Pi 控制并重新读取页面（只在用户主动输入时恢复）",
    "/ego-settings attachments         看首选目录、默认目录、登记的存储根和本会话截图",
    "/ego-settings attachments set <绝对路径>   设置首选附件目录（可带引号；空格原样保留）",
    "/ego-settings attachments reset   清除首选目录，新截图回到默认库",
    "/ego-settings attachments open <ID>  用系统看图程序打开本会话的一张截图",
    "/ego-settings help                这份说明",
    "截图默认落盘：PI_EGO_HOME/attachments，或在设置里选的首选目录",
  ].join("\n");

  const ATTACHMENTS_USAGE = [
    "/ego-settings                   打开 Ego 浏览器设置（info 显示浏览器状态；截图附件目录用 Windows 文件夹选择器；本会话截图可查看 / 按 ID 打开）",
    "/ego-settings attachments       看首选目录、默认目录、登记的存储根和本会话截图",
    "/ego-settings attachments set <绝对路径> 设置首选附件目录（可带引号；空格原样保留）",
    "/ego-settings attachments reset 清除首选目录，新截图回到默认库",
    "/ego-settings attachments open <ID> 用系统看图程序打开本会话的一张截图",
    "默认库：PI_EGO_HOME/attachments",
  ].join("\n");

  const updateAttachmentsDir = async (ctx, dir) => {
    const result = dir === null
      ? await run(ctx, undefined, service.resetAttachmentsDir.bind(service), {})
      : await run(ctx, undefined, service.setAttachmentsDir.bind(service), { dir });
    const text = result.content[0].text;
    uiNotify(ctx, text, result.isError ? "error" : "info");
    return text;
  };

  /** The browser status text, and whether the user holds the browser now. */
  const browserStatusForInfo = async (ctx) => {
    try {
      const outcome = await service.status({ sessionKey: sessionKeyOf(ctx) });
      const text = outcome.ok ? outcome.text : `状态读取失败：${outcome.message}`;
      const first = text.split("\n")[0] || "";
      return {
        text,
        failed: !outcome.ok,
        summary: first.replace(/^浏览器：/, "").trim(),
        handedOff: Boolean(outcome.details?.session?.handedOff),
      };
    } catch (error) {
      const text = `状态读取失败：${error?.message || error}`;
      return { text, failed: true, summary: "状态读取失败", handedOff: false };
    }
  };

  /**
   * One attachment directory choice: Windows' own folder picker, and the typed
   * path prompt this command has always had as the fallback when the dialog is
   * unusable here (no Windows, no WinForms, no exec). The dialog runs to its own
   * end and nothing holds the run lock while the user decides; a cancel, a
   * non-zero exit or a timeout all leave the stored choice untouched.
   */
  const pickAttachmentDir = async (ctx, library) => {
    const preferred = library.preferredDir();
    const defaultDir = library.defaultDir();
    // Start where the user can actually see something: the current choice if it
    // is still there, otherwise the library that is in use right now.
    const initial = preferred && existsSync(preferred) ? preferred : defaultDir;
    const picked = await pickFolder({
      // Without a host exec there is nothing to start; the picker reports that as
      // "unavailable" and the typed path below is used instead.
      exec: typeof pi.exec === "function" ? (command, args, options) => pi.exec(command, args, options) : undefined,
      initialDir: existsSync(initial) ? initial : "",
    });
    if (picked.ok) return picked.path;
    if (picked.cancelled) {
      uiNotify(ctx, picked.message, "info");
      return "";
    }
    uiNotify(ctx, picked.message, picked.available === false ? "info" : "error");

    // Same fallback as before: type the path (quotes and spaces are fine).
    const input = await ctx.ui.input("截图附件目录（绝对路径）", preferred || defaultDir);
    if (input === undefined) {
      uiNotify(ctx, "已取消，截图附件目录保持不变。", "info");
      return "";
    }
    const dir = parsePathArgument(input);
    if (!dir) {
      uiNotify(ctx, "请输入目录路径。", "error");
      return "";
    }
    return dir;
  };

  /** Hand one verified file to Windows' default image viewer. */
  const openFileWithViewer = async (ctx, file) => {
    if (typeof pi.exec !== "function") {
      const text = `这个运行环境不能打开程序；文件在：${file}`;
      uiNotify(ctx, text, "info");
      return text;
    }
    try {
      // `explorer.exe <file>` hands the file to the default image viewer.
      await pi.exec("explorer.exe", [file], { timeout: 10000 });
      const text = `已用系统默认程序打开：${file}`;
      uiNotify(ctx, text, "info");
      return text;
    } catch (error) {
      const text = `打开失败（${error?.message || error}）；文件在：${file}`;
      uiNotify(ctx, text, "error");
      return text;
    }
  };

  /**
   * Open one screenshot of this session by ID: the same lookup
   * `browser_show_screenshot` uses (full ID or unique prefix, this session's own
   * references only, registered root, realpath containment, digest), then the
   * OS viewer.
   */
  const openSessionAttachment = async (ctx, sessionKey, id) => {
    const wanted = String(id ?? "").trim();
    if (!wanted) {
      const text = "用法：/ego-settings attachments open <附件 ID>（/ego-settings 的「本会话截图」里能看到 ID）";
      uiNotify(ctx, text, "error");
      return text;
    }
    const outcome = await withBrowserLock(() =>
      service.attachmentFile({ sessionKey, id: wanted, entries: sessionEntriesOf(ctx) }),
    );
    if (!outcome.ok) {
      uiNotify(ctx, outcome.message, "error");
      return outcome.message;
    }
    return openFileWithViewer(ctx, outcome.details.path);
  };

  /**
   * Take control back after the user worked in the window by hand. Only a user
   * action reaches this: the settings row (Enter) or the non-TUI
   * `/ego-settings resume` argument. Success re-reads the page and continues the
   * task through the same follow-up message path as before.
   */
  const resumeBrowser = async (ctx, sessionKey) => {
    const outcome = await withBrowserLock(() => service.resume({ sessionKey }));
    if (!outcome.ok) {
      const text = `恢复失败：${outcome.message}`;
      uiNotify(ctx, text, "error");
      return text;
    }
    uiNotify(ctx, "浏览器控制权已恢复，请继续当前任务。", "info");
    pi.sendMessage(
      { customType: "pi-ego-browser-resume", content: outcome.text, display: false },
      { deliverAs: "followUp", triggerTurn: true },
    );
    return outcome.text;
  };

  /**
   * The settings menu: the one interactive entry point. Resetting the directory,
   * the native picker, the session's screenshots and taking control back are all
   * rows here. Nothing is registered as another slash command.
   */
  const runSettingsMenu = async (ctx, sessionKey) => {
    const library = libraryFor();
    while (true) {
      const status = await browserStatusForInfo(ctx);
      // Read-only: the row list must not probe or create a directory.
      const shots = service.sessionScreenshots({ sessionKey });
      const action = await chooseEgoSetting(ctx, tui, {
        preferred: library.preferredDir(),
        defaultDir: library.defaultDir(),
        statusText: status.text,
        statusSummary: status.summary,
        statusFailed: status.failed,
        handedOff: status.handedOff,
        shots,
      });
      if (!action) return undefined;
      if (action === "reset") {
        await updateAttachmentsDir(ctx, null);
        continue;
      }
      if (action === "directory") {
        const dir = await pickAttachmentDir(ctx, library);
        if (dir) await updateAttachmentsDir(ctx, dir);
        continue;
      }
      if (action === "resume") return resumeBrowser(ctx, sessionKey);
      if (action === "open-id") {
        const input = await ctx.ui.input("截图附件 ID（完整 64 位或唯一前缀）", "");
        if (input === undefined) {
          uiNotify(ctx, "已取消。", "info");
          continue;
        }
        await openSessionAttachment(ctx, sessionKey, input);
        continue;
      }
      if (typeof action === "string" && action.startsWith("open:")) {
        await openSessionAttachment(ctx, sessionKey, action.slice("open:".length));
        continue;
      }
    }
  };

  /** Attachments listing and its three actions, shared by both entry surfaces. */
  const runAttachments = async (ctx, arg) => {
    const sessionKey = sessionKeyOf(ctx);
    const sub = parseAttachmentsCommand(arg);
    const notify = (text, level = "info") => uiNotify(ctx, text, level);

    if (sub.action === "help" || sub.action === "-h" || sub.action === "--help") {
      notify(ATTACHMENTS_USAGE, "info");
      return ATTACHMENTS_USAGE;
    }
    if (sub.action === "set") {
      const dir = parsePathArgument(sub.arg);
      if (!dir) {
        const text = "用法：/ego-settings attachments set <绝对路径>（目录名里有空格就原样写，或加引号）";
        notify(text, "error");
        return text;
      }
      return updateAttachmentsDir(ctx, dir);
    }
    if (sub.action === "reset") {
      return updateAttachmentsDir(ctx, null);
    }
    if (sub.action === "open") {
      return openSessionAttachment(ctx, sessionKey, sub.arg);
    }
    if (sub.action === "list" || sub.action === "show" || sub.action === "status") {
      const outcome = await withBrowserLock(() => service.attachments({ sessionKey }));
      uiNotify(ctx, outcome.text, outcome.ok ? "info" : "error");
      return outcome.text;
    }
    const text = `不认识的子命令“${sub.action}”。\n${ATTACHMENTS_USAGE}`;
    notify(text, "error");
    return text;
  };

  /**
   * Everything the settings command can do without a TUI. A headless host (RPC,
   * CI) still needs the four real actions — read the status, take control back
   * after a hand-off, see/open this session's screenshots, and set the directory
   * — so the same slash command takes them as arguments. There is no second
   * command and no re-registered `/ego`.
   */
  const runSettingsWithoutTui = async (ctx, parsed, sessionKey, { bare = false, interactive = false } = {}) => {
    if (parsed.action === "status" || parsed.action === "info") {
      const outcome = await service.status({ sessionKey });
      const text = outcome.ok ? outcome.text : `状态读取失败：${outcome.message}`;
      // The hint belongs to a host with no interactive terminal. Inside the TUI
      // the menu (and this same action) is one key away, so it would be wrong.
      const hint = interactive
        ? ""
        : "（这个环境没有可用的交互终端：菜单在 Pi 的 TUI 里；这里用 /ego-settings status | resume | attachments。）";
      const shown = hint ? `${hint}\n${text}` : text;
      uiNotify(ctx, shown, outcome.ok ? "info" : "error");
      return bare ? shown : text;
    }
    if (parsed.action === "resume") {
      return resumeBrowser(ctx, sessionKey);
    }
    if (parsed.action === "attachments" || parsed.action === "attachment") {
      return runAttachments(ctx, parsed.arg);
    }
    if (parsed.action === "help" || parsed.action === "-h" || parsed.action === "--help") {
      uiNotify(ctx, SETTINGS_USAGE, "info");
      return SETTINGS_USAGE;
    }
    const text = `不认识的动作“${parsed.action}”。\n${SETTINGS_USAGE}`;
    uiNotify(ctx, text, "error");
    return text;
  };

  pi.registerCommand("ego-settings", {
    description:
      "Ego 浏览器设置：info 浏览器状态 · 本会话截图（查看 / 按 ID 打开）· 恢复浏览器控制 · 截图附件目录（Windows 选择器）；非交互环境用 /ego-settings status|resume|attachments",
    handler: async (args, ctx) => {
      const raw = String(args ?? "").trim();
      const parsed = parseSettingsCommand(raw);
      const sessionKey = sessionKeyOf(ctx);
      const canMenu = ctx.mode === "tui" && tui?.SettingsList && tui?.Text && tui?.Container;
      // No arguments in the TUI opens the menu. An explicit action (and every
      // non-TUI call) goes through the same actions the menu rows perform.
      if (canMenu && !raw) return runSettingsMenu(ctx, sessionKey);
      return runSettingsWithoutTui(ctx, parsed, sessionKey, { bare: !raw, interactive: canMenu });
    },
  });

  pi.on?.("session_shutdown", async () => {
    // The browser is intentionally left running: it holds the profile, the
    // tabs and any login the user completed. `/ego-settings status` reports it
    // later.
  });
}
