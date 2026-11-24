import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ATTACHMENT_INJECTION_LIMITS,
  injectAttachmentImages,
  lastUserMessageIndex,
  modelAcceptsImages,
  planRequestInjection,
  referenceOfToolResult,
  selectSessionReference,
  sessionReferences,
  turnAttachmentMessages,
} from "../src/review.js";

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);
const ID_C = "c".repeat(64);
const ROOT_A = "r-0123456789abcdef";
const ROOT_B = "r-fedcba9876543210";

function ref(id, extra = {}) {
  return { schemaVersion: 1, id, rootId: ROOT_A, bytes: 100, mime: "image/png", at: "2026-01-01T00:00:00.000Z", ...extra };
}

function fakeLibrary(images = {}) {
  return {
    loaded: [],
    located: [],
    locate(candidate) {
      this.located.push(candidate.id);
      const bytes = images[candidate.id];
      if (bytes === undefined) return { ok: false, code: "ATTACHMENT_MISSING", message: "missing" };
      if (bytes === "corrupt") return { ok: false, code: "ATTACHMENT_CORRUPT", message: "corrupt" };
      return { ok: true, id: candidate.id, bytes: bytes.length, mime: "image/png", path: `/library/${candidate.id}.png` };
    },
    load(candidate, options = {}) {
      this.loaded.push(candidate.id);
      const bytes = images[candidate.id];
      if (bytes === undefined) return { ok: false, code: "ATTACHMENT_MISSING", message: "missing" };
      if (bytes === "corrupt") return { ok: false, code: "ATTACHMENT_CORRUPT", message: "corrupt" };
      if (options.maxBytes && bytes.length > options.maxBytes) {
        return { ok: false, code: "ATTACHMENT_TOO_LARGE", message: "too large", bytes: bytes.length };
      }
      return { ok: true, id: candidate.id, bytes: bytes.length, mime: "image/png", data: Buffer.from(bytes) };
    },
  };
}

function userMessage(text, timestamp = 1_000) {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function shotMessage(refValue, { toolName = "browser_screenshot", id = "call-1", isError = false } = {}) {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName,
    isError,
    content: [{ type: "text", text: `附件 ID：${refValue.id}` }],
    details: { attachment: refValue, path: `/library/${refValue.id}.png`, temporary: true },
    timestamp: 1_000,
  };
}

test("this turn's screenshot tool results ride along, selected by message order", async () => {
  const messages = [
    userMessage("look"),
    { role: "assistant", content: [{ type: "text", text: "taking a shot" }], timestamp: 1000 },
    shotMessage(ref(ID_B), { id: "call-b" }),
    { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 1000 },
    shotMessage(ref(ID_A), { toolName: "browser_show_screenshot", id: "call-a" }),
  ];
  const entries = turnAttachmentMessages(messages);
  assert.deepEqual(entries.map((entry) => entry.ref.id), [ID_B, ID_A]);
  assert.deepEqual(entries.map((entry) => entry.index), [2, 4]);

  // Same millisecond, same turn: order is still the message order, not a clock.
  const sameMs = [
    userMessage("look", 500),
    shotMessage(ref(ID_A), { id: "c1" }),
    shotMessage(ref(ID_B), { id: "c2" }),
  ];
  assert.deepEqual(turnAttachmentMessages(sameMs).map((entry) => entry.ref.id), [ID_A, ID_B]);

  // A new user message moves the window: nothing from the previous turn counts.
  const nextTurn = [...messages, userMessage("later", 2000)];
  assert.deepEqual(turnAttachmentMessages(nextTurn), []);
  assert.deepEqual(turnAttachmentMessages([]), []);
  assert.deepEqual(turnAttachmentMessages([{ role: "assistant", content: [] }]), []);

  // Only real screenshot observations count, and a failed one contributes nothing.
  assert.equal(referenceOfToolResult({ role: "toolResult", toolName: "browser_read", details: { attachment: ref(ID_A) } }), null);
  assert.equal(referenceOfToolResult(shotMessage(ref(ID_A), { toolName: "other_tool" })), null);
  assert.equal(referenceOfToolResult(shotMessage(ref(ID_A), { isError: true })), null);
  assert.equal(referenceOfToolResult({ role: "toolResult", toolName: "browser_screenshot", details: {} }), null);
  assert.equal(referenceOfToolResult({ role: "toolResult", toolName: "browser_screenshot", details: { attachment: { id: "../../etc/passwd", rootId: ROOT_A } } }), null);

  // A capture and a lookback of the same picture are one observation.
  const duplicate = [userMessage("look"), shotMessage(ref(ID_A), { id: "c1" }), shotMessage(ref(ID_A), { toolName: "browser_show_screenshot", id: "c2" })];
  assert.equal(turnAttachmentMessages(duplicate).length, 1);
  assert.equal(ATTACHMENT_INJECTION_LIMITS.maxImages, 2);
});

test("planRequestInjection attaches pixels to the tool result that reports them", async () => {
  const messages = [
    userMessage("what does it look like?"),
    { role: "assistant", content: [{ type: "text", text: "taking a shot" }], timestamp: 1000 },
    shotMessage(ref(ID_B), { id: "call-b" }),
  ];
  const library = fakeLibrary({ [ID_B]: "png-bytes" });

  const vision = planRequestInjection({ messages, model: { input: ["text", "image"] }, library });
  assert.equal(vision.injected, true);
  assert.equal(vision.images.length, 1);
  assert.equal(vision.images[0].type, "image");
  assert.equal(vision.images[0].mimeType, "image/png");
  assert.equal(Buffer.from(vision.images[0].data, "base64").toString(), "png-bytes");
  assert.equal(vision.placements[0].index, 2, "the image belongs to the screenshot tool result");
  const injected = vision.messages[2];
  assert.equal(injected.role, "toolResult");
  assert.equal(injected.toolName, "browser_screenshot");
  assert.equal(injected.content.length, 2);
  assert.equal(injected.content[0].text, `附件 ID：${ID_B}`);
  assert.equal(injected.content[1].type, "image");
  assert.equal(injected.toolCallId, "call-b", "the tool result keeps its identity");
  assert.equal(vision.messages[0].content.length, 1, "the user message is untouched");
  assert.equal(vision.messages[1], messages[1], "other messages are shared, not copied");
  assert.equal(messages[2].content.length, 1, "the original message list is not mutated");

  const textOnly = planRequestInjection({ messages, model: { input: ["text"] }, library });
  assert.equal(textOnly, null, "a text-only model gets the tool result's text instead");
  assert.equal(planRequestInjection({ messages, model: {}, library }), null);

  const nextTurn = planRequestInjection({
    messages: [...messages, userMessage("an ordinary follow-up")],
    model: { input: ["text", "image"] },
    library,
  });
  assert.equal(nextTurn, null, "an older capture must not follow the next user turn");

  // A lookback asked in this turn counts in this turn only.
  const lookback = [
    userMessage("show me that again"),
    { role: "assistant", content: [{ type: "text", text: "looking" }], timestamp: 1000 },
    shotMessage(ref(ID_A), { toolName: "browser_show_screenshot", id: "look-a" }),
  ];
  const reviewed = planRequestInjection({ messages: lookback, model: { input: ["text", "image"] }, library: fakeLibrary({ [ID_A]: "x" }) });
  assert.equal(reviewed.injected, true);
  assert.equal(reviewed.messages[2].toolName, "browser_show_screenshot");
  assert.equal(reviewed.messages[2].content.length, 2);
});

test("the injection budget skips oversized or unreadable pictures instead of failing the request", async () => {
  const messages = [userMessage("look"), shotMessage(ref(ID_B), { id: "b" }), shotMessage(ref(ID_A), { toolName: "browser_show_screenshot", id: "a" })];
  const library = fakeLibrary({ [ID_A]: "a".repeat(50), [ID_B]: "b".repeat(500) });

  const tiny = planRequestInjection({
    messages,
    model: { input: ["text", "image"] },
    library,
    limits: { maxImages: 2, maxImageBytes: 100, maxTotalBytes: 200 },
  });
  assert.equal(tiny.injected, true);
  assert.equal(tiny.images.length, 1);
  assert.equal(tiny.skipped.some((entry) => entry.reason === "bytes"), true);
  assert.equal(library.loaded.includes(ID_B), false, "an oversized picture is skipped before it is read");
  assert.equal(library.loaded.includes(ID_A), true);

  const broken = planRequestInjection({
    messages: [userMessage("look"), shotMessage(ref(ID_C))],
    model: { input: ["text", "image"] },
    library,
  });
  assert.equal(broken.injected, false);
  assert.equal(broken.images.length, 0);
  assert.equal(broken.skipped[0].reason, "ATTACHMENT_MISSING");

  const corrupt = planRequestInjection({
    messages: [userMessage("look"), shotMessage(ref(ID_C))],
    model: { input: ["text", "image"] },
    library: fakeLibrary({ [ID_C]: "corrupt" }),
  });
  assert.equal(corrupt.injected, false);
  assert.equal(corrupt.skipped[0].reason, "ATTACHMENT_CORRUPT");

  // Never more than the count limit, even with many captures in one turn.
  const many = [userMessage("look")];
  for (const id of [ID_C, ID_B, ID_A]) many.push(shotMessage(ref(id), { id }));
  const capped = planRequestInjection({ messages: many, model: { input: ["image"] }, library: fakeLibrary({ [ID_A]: "x", [ID_B]: "y", [ID_C]: "z" }) });
  assert.equal(capped.images.length, 2);
  assert.equal(capped.skipped.some((entry) => entry.reason === "count"), true);
});

test("messages without a user turn or with string content behave", async () => {
  assert.equal(lastUserMessageIndex([]), -1);
  assert.equal(lastUserMessageIndex([{ role: "assistant", content: [] }]), -1);

  const messages = [{ role: "user", content: "plain string", timestamp: 10 }];
  const next = injectAttachmentImages(messages, [{ index: 0, block: { type: "image", data: "x", mimeType: "image/png" } }]);
  assert.equal(next[0].content.length, 2);
  assert.equal(next[0].content[0].text, "plain string");

  const plan = planRequestInjection({
    messages: [...messages, shotMessage(ref(ID_A))],
    model: { input: ["image"] },
    library: fakeLibrary({ [ID_A]: "x" }),
  });
  assert.equal(plan.injected, true);
  assert.equal(modelAcceptsImages({ input: ["text", "image"] }), true);
  assert.equal(modelAcceptsImages({ input: ["text"] }), false);
  assert.equal(modelAcceptsImages(undefined), false);
});

test("a session reference is found by full ID or by a unique-enough prefix", async () => {
  const candidates = [ref(ID_B), ref(ID_A), ref(ID_B)];
  assert.equal(selectSessionReference(candidates, ID_A).matches.length, 1);
  assert.equal(selectSessionReference(candidates, ID_A.slice(0, 12)).id, ID_A);
  assert.equal(selectSessionReference(candidates, ID_A.toUpperCase()).id, ID_A);
  assert.equal(selectSessionReference(candidates, ID_A.slice(0, 4)).code, "ATTACHMENT_NOT_IN_SESSION", "a short prefix is not a guess");
  assert.equal(selectSessionReference(candidates, "f".repeat(64)).code, "ATTACHMENT_NOT_IN_SESSION");
  assert.equal(selectSessionReference([], ID_A).code, "ATTACHMENT_NOT_IN_SESSION");
  assert.equal(selectSessionReference(null, ID_A).code, "ATTACHMENT_NOT_IN_SESSION");
  assert.equal(selectSessionReference(candidates, "  ").code, "ATTACHMENT_ID_REQUIRED");

  // The same digest under two roots: one row per root, and both pick that root.
  const bothRoots = [
    { ...ref(ID_A), rootId: ROOT_B },
    { ...ref(ID_A), rootId: ROOT_A },
  ];
  const selected = selectSessionReference(bothRoots, ID_A);
  assert.equal(selected.ok, true);
  assert.deepEqual(selected.matches.map((entry) => entry.rootId), [ROOT_B, ROOT_A]);
});

test("two different digests sharing a prefix are refused instead of opening the first", async () => {
  const first = { ...ref(`deadbeef${"1".repeat(56)}`), rootId: ROOT_A };
  const second = { ...ref(`deadbeef${"2".repeat(56)}`), rootId: ROOT_B };
  const ambiguous = selectSessionReference([first, second], "deadbeef");
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.code, "ATTACHMENT_ID_AMBIGUOUS");
  assert.equal(ambiguous.ids.length, 2);
  assert.match(ambiguous.message, /同时匹配/);

  // One more character makes it unique again.
  assert.equal(selectSessionReference([first, second], "deadbeef1").id, first.id);
});

test("the session entry list supplies references beyond the short record list", async () => {
  const entries = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "first" }] } },
    { type: "message", message: shotMessage(ref(ID_A), { id: "old" }) },
    { type: "message", message: shotMessage(ref(ID_B), { toolName: "browser_show_screenshot", id: "mid" }) },
    { type: "custom", customType: "anything", data: {} },
    { type: "message", message: shotMessage(ref(ID_C), { id: "new" }) },
  ];
  const references = sessionReferences(entries);
  assert.deepEqual(references.map((entry) => entry.id), [ID_C, ID_B, ID_A], "newest first");
  assert.equal(selectSessionReference(references, ID_A.slice(0, 10)).id, ID_A);
  assert.deepEqual(sessionReferences(null), []);
  assert.deepEqual(sessionReferences([{ type: "message", message: { role: "assistant", content: [] } }]), []);

  // Each historical row keeps the root it was recorded with.
  const twoRoots = [
    { type: "message", message: shotMessage({ ...ref(ID_A), rootId: ROOT_A }, { id: "one" }) },
    { type: "message", message: shotMessage({ ...ref(ID_A), rootId: ROOT_B }, { id: "two" }) },
  ];
  assert.deepEqual(sessionReferences(twoRoots).map((entry) => entry.rootId), [ROOT_B, ROOT_A]);
});
