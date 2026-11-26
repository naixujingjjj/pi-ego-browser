// Per-session browser bookkeeping.
//
// A Pi session owns one Ego task space (a named set of tabs plus an ownership
// state) and one snapshot table. Element numbers printed by `browser_read` are
// meaningful only for the page state that produced them: they are bound to the
// space, the page label and the URL, and every later read supersedes them.
import { createHash } from "node:crypto";
import { readJsonSync, writeJsonAtomic } from "./store.js";

export const STALE_NO_SNAPSHOT = "NO_SNAPSHOT";
export const STALE_UNKNOWN_NUMBER = "UNKNOWN_NUMBER";
export const STALE_PAGE_CHANGED = "PAGE_CHANGED";
export const STALE_SUPERSEDED = "SUPERSEDED";

export function resolveSessionKey(explicit, env = process.env) {
  if (explicit) return String(explicit);
  if (env.PI_EGO_SESSION_KEY) return String(env.PI_EGO_SESSION_KEY);
  return "default";
}

export function spaceNameFor(sessionKey) {
  const identity = createHash("sha256").update(String(sessionKey)).digest("hex").slice(0, 32);
  return `pi-ego-browser ${identity}`;
}

export class SessionStore {
  constructor(paths) {
    this.paths = paths;
  }

  #read() {
    const state = readJsonSync(this.paths.sessionsFile, { sessions: {} });
    if (!state || typeof state !== "object" || !state.sessions) return { sessions: {} };
    return state;
  }

  #write(state) {
    writeJsonAtomic(this.paths.sessionsFile, state);
  }

  get(sessionKey) {
    const entry = this.#read().sessions[sessionKey];
    return (
      entry || {
        spaceId: null,
        spaceName: spaceNameFor(sessionKey),
        handedOff: false,
        pageLabel: null,
        url: null,
        title: null,
        snapshot: null,
        latestAttachment: null,
        attachments: [],
        updatedAt: null,
      }
    );
  }

  update(sessionKey, patch) {
    const state = this.#read();
    const current = state.sessions[sessionKey] || this.get(sessionKey);
    state.sessions[sessionKey] = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.#write(state);
    return state.sessions[sessionKey];
  }

  /** Remember the space this session drives, plus the tab it was last on. */
  bind(sessionKey, { spaceId, spaceName, pageLabel = null, url = null, title = null, handedOff = false }) {
    return this.update(sessionKey, {
      spaceId,
      spaceName: spaceName || this.get(sessionKey).spaceName,
      pageLabel,
      url,
      title,
      handedOff,
    });
  }

  /** Store the numbering produced by one read. */
  recordSnapshot(sessionKey, { spaceId, pageLabel, url, title, seq, items }) {
    return this.update(sessionKey, {
      spaceId,
      pageLabel,
      url,
      title,
      snapshot: { spaceId, pageLabel, url, seq, takenAt: new Date().toISOString(), items },
      invalidReason: null,
    });
  }

  /** Drop the numbering without changing the space or hand-off state. */
  invalidateSnapshot(sessionKey, reason) {
    return this.update(sessionKey, { snapshot: null, invalidReason: reason });
  }

  nextSeq(sessionKey) {
    const record = this.get(sessionKey);
    return (record.snapshot?.seq || 0) + 1;
  }

  setHandoff(sessionKey, handedOff) {
    return this.update(sessionKey, { handedOff, ...(handedOff ? {} : {}) });
  }

  /**
   * Remember the attachment a capture published and keep a short recent list.
   * Only the reference is stored: the ID, the root ID, the size and the page it
   * came from. The PNG itself stays in the attachment library.
   *
   * This list is a convenience for the status view, not the lookup index: a
   * screenshot older than `max` is still found through the compact reference of
   * its own tool result in the Pi session branch (`getBranch()`), which is what
   * `browser_show_screenshot` and the `/ego-settings` screenshot row use.
   */
  recordAttachment(sessionKey, ref, { max = 30 } = {}) {
    const record = this.get(sessionKey);
    const attachments = Array.isArray(record.attachments) ? record.attachments.filter((entry) => entry?.id !== ref.id) : [];
    attachments.unshift(ref);
    return this.update(sessionKey, { latestAttachment: ref, attachments: attachments.slice(0, max) });
  }

  /**
   * Resolve a model-supplied target. A bare number (or `#12`) is one of our
   * snapshot numbers and must still match the page state that printed it;
   * anything else is passed through to Ego as a selector or `@ref`.
   */
  resolveTarget(sessionKey, raw) {
    const text = String(raw ?? "").trim();
    const numeric = /^#?(\d+)$/.exec(text);
    if (!numeric) return { kind: "selector", value: text };
    const wanted = Number(numeric[1]);
    const record = this.get(sessionKey);
    const snapshot = record.snapshot;
    if (!snapshot) {
      return {
        kind: "stale",
        code: STALE_NO_SNAPSHOT,
        message: `This session has no usable element numbers yet (${record.invalidReason || "nothing has been read since the last change"}); call browser_read to read the page first.`,
      };
    }
    const item = snapshot.items.find((entry) => entry.n === wanted);
    if (!item) {
      return {
        kind: "stale",
        code: STALE_UNKNOWN_NUMBER,
        message: `Element number #${wanted} is not in the latest read (that read printed only #1..#${snapshot.items.length}); call browser_read first.`,
      };
    }
    if (record.pageLabel !== snapshot.pageLabel || record.url !== snapshot.url) {
      return {
        kind: "stale",
        code: STALE_PAGE_CHANGED,
        message: `Element number #${wanted} was generated for ${snapshot.pageLabel} at ${snapshot.url}, but this session is now on ${record.pageLabel || "no tab"} at ${record.url || "no URL"}; call browser_read first.`,
      };
    }
    return {
      kind: "ref",
      value: `@${item.ref}`,
      number: wanted,
      role: item.role,
      name: item.name,
      expect: { pageLabel: snapshot.pageLabel, url: snapshot.url },
    };
  }
}

/**
 * Turn Ego's snapshot text into our numbered view.
 * Ego prints refs as `[@123]` (backend node id); we print `[#1]`, `[#2]`, … in
 * document order and keep the mapping so an action can resolve a number back
 * to the ref Ego understands.
 */
export function numberSnapshot(text) {
  const items = [];
  const out = String(text ?? "").replace(/\[@(\d+)\]/g, (match, ref, offset, whole) => {
    const lineStart = whole.lastIndexOf("\n", offset) + 1;
    const line = whole.slice(lineStart, whole.indexOf("\n", offset) === -1 ? whole.length : whole.indexOf("\n", offset));
    const parsed = /^\s*-?\s*([A-Za-z][\w-]*)\s*(.*)$/.exec(line);
    const role = parsed?.[1] || "element";
    const rest = (parsed?.[2] || "").replace(/\[@\d+\]/, "").trim();
    const name = /^"(.*)"$/.exec(rest)?.[1] ?? rest;
    const n = items.length + 1;
    items.push({ n, ref: Number(ref), role, name });
    return `[#${n}]`;
  });
  return { text: out, items };
}

export function summarizeTarget(item) {
  if (!item) return "";
  const name = item.name ? ` "${item.name}"` : "";
  return `#${item.n} (${item.role}${name})`;
}
