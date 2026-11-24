// Which screenshots ride along with one model request.
//
// Screenshots are never written into the conversation: the tool result holds the
// attachment ID, the root ID and the byte count only. The picture itself is
// attached to a deep copy of the request messages right before the model call,
// so a vision model can see it and the transcript stays small.
//
// Selection is by message order, not by clock: the screenshot tool results that
// actually appear after the last user message in this request are the ones that
// belong to the active turn. A capture and a lookback in the same millisecond are
// ordered exactly as the model saw them, and a lookback asked in this turn counts
// in this turn only. Each image is attached back onto the tool result that
// reports it: a screenshot is observation data of that tool call.
import { matchesReferenceId, MAX_INLINE_ATTACHMENT_BYTES, OBJECT_ID, ROOT_ID, shortId } from "./attachments.js";

export const ATTACHMENT_INJECTION_LIMITS = Object.freeze({
  /** At most two recent, distinct screenshots from this turn. */
  maxImages: 2,
  maxImageBytes: MAX_INLINE_ATTACHMENT_BYTES,
  maxTotalBytes: 8 * 1024 * 1024,
});

/** Tool results that are a screenshot observation and may carry an image. */
export const SCREENSHOT_TOOLS = Object.freeze(["browser_screenshot", "browser_show_screenshot"]);

/** Index of the user message that opened the active turn, or -1. */
export function lastUserMessageIndex(messages) {
  if (!Array.isArray(messages)) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

/**
 * The attachment reference a screenshot observation carries, or null.
 *
 * A successful result from a screenshot tool can supply a well-formed
 * reference. The reference itself is
 * only a lookup key: the library checks the registered storage root, realpath
 * containment and the digest before one byte is read.
 */
export function referenceOfToolResult(message) {
  if (!message || message.role !== "toolResult" || message.isError) return null;
  if (!SCREENSHOT_TOOLS.includes(message.toolName)) return null;
  const attachment = message.details && typeof message.details === "object" ? message.details.attachment : null;
  if (!attachment || typeof attachment !== "object") return null;
  const id = String(attachment.id ?? "").trim().toLowerCase();
  const rootId = String(attachment.rootId ?? "").trim().toLowerCase();
  if (!OBJECT_ID.test(id) || !ROOT_ID.test(rootId)) return null;
  return { ...attachment, id, rootId };
}

/**
 * Screenshot observations produced after the last user message, in message
 * order and at most once per attachment. Indices point into the request's own
 * message list, so the image can be attached to the exact message it belongs to.
 */
export function turnAttachmentMessages(messages, lastUserIndex = lastUserMessageIndex(messages)) {
  const out = [];
  if (!Array.isArray(messages) || lastUserIndex < 0) return out;
  const seen = new Set();
  for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
    const ref = referenceOfToolResult(messages[index]);
    if (!ref || seen.has(ref.id)) continue;
    seen.add(ref.id);
    out.push({ index, ref });
  }
  return out.reverse();
}

/**
 * Screenshot references recorded in a session entry list, newest first.
 *
 * `entries` is what the Pi session manager returns (`getBranch()` for the
 * current branch, `getEntries()` for everything). Each entry is a
 * `{ type: "message", message }` record, so the compact reference a tool result
 * already stores is enough to look a picture up long after the session's short
 * reference list has moved on. Every row keeps its own root ID: the same digest
 * published under two roots stays two rows, and the original file of the row
 * that is used stays the one that is read.
 */
export function sessionReferences(entries) {
  const out = [];
  if (!Array.isArray(entries)) return out;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "message") continue;
    const ref = referenceOfToolResult(entry.message);
    if (ref) out.push(ref);
  }
  return out;
}

/**
 * Pick the one session reference a tool argument names.
 *
 * A full ID always identifies one object; a prefix must identify exactly one
 * digest. Two different screenshots that happen to share a prefix are refused
 * instead of opening whichever was recorded first, and a prefix shorter than the
 * minimum is not a guess at all.
 */
export function selectSessionReference(candidates, wanted) {
  const needle = String(wanted ?? "").trim().toLowerCase();
  if (!needle) {
    return { ok: false, code: "ATTACHMENT_ID_REQUIRED", message: "附件 ID 不能为空。" };
  }
  const matches = [];
  for (const ref of Array.isArray(candidates) ? candidates : []) {
    if (!ref || !matchesReferenceId(ref, needle)) continue;
    const id = String(ref.id).toLowerCase();
    const rootId = String(ref.rootId).toLowerCase();
    if (matches.some((entry) => entry.id === id && entry.rootId === rootId)) continue;
    matches.push({ ...ref, id, rootId });
  }
  if (!matches.length) {
    return {
      ok: false,
      code: "ATTACHMENT_NOT_IN_SESSION",
      message: `本会话里没有附件 ${String(wanted ?? "").slice(0, 80)}。只能使用本会话截图结果里的附件 ID；先 browser_screenshot，或在 /ego-settings 的「本会话截图」里看列表。`,
    };
  }
  const ids = [...new Set(matches.map((entry) => entry.id))];
  if (ids.length > 1) {
    return {
      ok: false,
      code: "ATTACHMENT_ID_AMBIGUOUS",
      message: `前缀 ${needle} 同时匹配 ${ids.length} 张不同的截图（${ids.map((id) => `${shortId(id)}…`).join("、")}）；写更长的前缀或完整的 64 位 ID。`,
      ids,
    };
  }
  return { ok: true, id: ids[0], matches };
}

/** A model only gets pixels when its declared input list includes images. */
export function modelAcceptsImages(model) {
  const input = model?.input;
  return Array.isArray(input) && input.includes("image");
}

function blocksOf(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return [];
}

/**
 * Attach images to the messages that reported them and return the message list
 * for this request. Only the targeted messages and their content arrays are
 * replaced; the rest of the list is shared, which is fine because Pi owns the
 * deep copy handed to the hook.
 */
export function injectAttachmentImages(messages, placements) {
  if (!placements.length) return messages;
  const next = messages.slice();
  const byIndex = new Map();
  for (const placement of placements) {
    if (!byIndex.has(placement.index)) byIndex.set(placement.index, []);
    byIndex.get(placement.index).push(placement.block);
  }
  for (const [index, blocks] of byIndex) {
    const target = next[index];
    if (!target) continue;
    next[index] = { ...target, content: [...blocksOf(target.content), ...blocks] };
  }
  return next;
}

/**
 * Load the bytes for the turn's screenshot results, enforcing the per-request
 * budget from the file size first. Anything skipped keeps its text form in the
 * tool result: the caller still has the ID and the path.
 */
export function loadInjectionImages(entries, library, limits = ATTACHMENT_INJECTION_LIMITS) {
  const placements = [];
  const skipped = [];
  let totalBytes = 0;
  const skip = (ref, reason, extra = {}) => skipped.push({ id: ref?.id ?? null, reason, ...extra });
  for (const { index, ref } of entries.slice().reverse()) {
    if (placements.length >= limits.maxImages) {
      skip(ref, "count");
      continue;
    }
    const located = library.locate(ref);
    if (!located.ok) {
      skip(ref, located.code || "unavailable", located.message ? { message: located.message } : {});
      continue;
    }
    if (located.bytes > limits.maxImageBytes || totalBytes + located.bytes > limits.maxTotalBytes) {
      skip(ref, "bytes", { bytes: located.bytes });
      continue;
    }
    const loaded = library.load(ref, { maxBytes: limits.maxImageBytes });
    if (!loaded.ok) {
      skip(ref, loaded.code || "unavailable", loaded.message ? { message: loaded.message } : {});
      continue;
    }
    placements.push({
      index,
      block: { type: "image", data: loaded.data.toString("base64"), mimeType: loaded.mime || "image/png" },
    });
    totalBytes += loaded.bytes;
  }
  return { placements: placements.reverse(), skipped, totalBytes };
}

/**
 * Build the request-time injection for one model call.
 * Returns `null` when nothing should change, so the hook can leave the request
 * untouched (text-only models, no screenshot observation in this turn, nothing
 * readable under the limits).
 */
export function planRequestInjection({ messages, model, library, limits = ATTACHMENT_INJECTION_LIMITS }) {
  if (!modelAcceptsImages(model)) return null;
  const index = lastUserMessageIndex(messages);
  if (index === -1) return null;
  const entries = turnAttachmentMessages(messages, index);
  if (!entries.length) return null;
  const { placements, skipped, totalBytes } = loadInjectionImages(entries, library, limits);
  const images = placements.map((placement) => placement.block);
  if (!images.length) return { messages, images, placements, skipped, totalBytes, injected: false };
  return {
    messages: injectAttachmentImages(messages, placements),
    images,
    placements,
    skipped,
    totalBytes,
    injected: true,
  };
}
