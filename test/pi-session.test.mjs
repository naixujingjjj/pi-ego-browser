// What a real Pi session does with screenshots: the transcript stays small, the
// vision request of the active user turn carries the picture, the next turn does
// not, and a lookback resolves only a legal attachment ID of this session.
//
// The capture tool here is a fixture that publishes a PNG through the same
// library and session store the extension uses (`BrowserService.ingestCapture`);
// the browser itself is not spawned. The acceptance suite repeats this with a
// real browser and real captures.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { AttachmentLibrary, attachmentDetails, shortId } from "../src/attachments.js";
import { resolvePaths } from "../src/paths.js";
import { readJsonSync } from "../src/store.js";
import { BrowserService } from "../src/tools.js";
import { freshDir, provideHostPackages, resolvePiPackage, stageSourcePackage } from "../tools/harness.mjs";
import { createFauxSession, loadPiHost, scriptedStep } from "../tools/pi-session.mjs";
import { writeFileSync } from "node:fs";

const ROOT = resolve(import.meta.dirname, "..");
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001",
  "hex",
);
const PORT = "9596";

let stagedEntry = null;
function stagedExtension() {
  if (stagedEntry) return stagedEntry;
  const dir = freshDir(join(ROOT, ".tmp", "unit-pi-package"));
  stageSourcePackage(dir);
  provideHostPackages(dir, resolvePiPackage().packageRoot);
  stagedEntry = join(dir, "extensions", "ego-browser.js");
  return stagedEntry;
}

/** Publishes fixture bytes as this session's capture, through production code. */
function fixtureCaptureFactory() {
  return async function fixtureCapture(pi) {
    // Publishing through the production ingest path gives the tool result the
    // same compact observation shape and `temporary` marker that
    // browser_screenshot reports; only the browser is replaced by fixture bytes.
    const capture = {
      parameters: Type.Object({ variant: Type.Optional(Type.Number()) }),
      executionMode: "sequential",
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const sessionKey = ctx.sessionManager.getSessionId();
        const paths = resolvePaths(process.env);
        const service = new BrowserService({ env: process.env, paths });
        const library = new AttachmentLibrary(paths);
        const staged = library.prepareCapture();
        const variant = Number(params?.variant) || 0;
        const bytes = Buffer.concat([PNG, Buffer.from(`variant-${variant}`)]);
        writeFileSync(staged.stagingFile, bytes);
        const ingested = service.ingestCapture({
          sessionKey,
          staged,
          pageLabel: "p1",
          url: `http://fixture/${variant}`,
          title: "Fixture Home",
        });
        if (!ingested.ok) {
          return { content: [{ type: "text", text: ingested.message }], details: { attachment: null }, isError: true };
        }
        return {
          content: [{ type: "text", text: `Attachment ID: ${ingested.ref.id}\nFile: ${ingested.path}` }],
          details: { attachment: attachmentDetails(ingested.ref), path: ingested.path, temporary: true },
        };
      },
    };
    const { default: install } = await import(pathToFileURL(stagedExtension()).href);
    await install({
      ...pi,
      registerTool(definition) {
        pi.registerTool(definition.name === "browser_screenshot" ? { ...definition, ...capture } : definition);
      },
    });
  };
}

function sessionEntries(file) {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function toolResults(entries) {
  return entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
}

function assertSmallTranscript(file) {
  const raw = readFileSync(file, "utf8");
  const entries = sessionEntries(file);
  assert.equal(raw.includes('"type":"image"'), false, "no image content block may reach the session file");
  assert.equal(/[A-Za-z0-9+/]{200,}/.test(raw), false, "no base64 blob may reach the session file");
  for (const result of toolResults(entries)) {
    const text = JSON.stringify(result.message);
    assert.ok(text.length < 2500, `a tool result grew to ${text.length} bytes`);
    assert.equal(/"data"\s*:/.test(text), false, "tool result details must not carry image data");
  }
  return { bytes: raw.length, entries };
}

test("a Pi session with a vision model: small transcript, this turn's picture only", async () => {
  const stateRoot = freshDir(join(ROOT, ".tmp", "unit-pi-state", "vision"));
  const workDir = join(stateRoot, "pi-work");
  const received = [];
  const { ai } = await loadPiHost();
  const pi = await createFauxSession({
    workDir,
    extensionFactories: [fixtureCaptureFactory()],
    env: {
      PI_EGO_HOME: stateRoot,
      PI_EGO_BROWSER_PATH: join(stateRoot, "no-such-browser.exe"),
      PI_EGO_DEBUG_PORT: PORT,
      PI_EGO_RUN_TIMEOUT_MS: "5000",
      // The fixture calls the tools directly, so they must be declared: deferred
      // exposure is covered by the extension tests instead of a scripted call.
      PI_EGO_TOOL_EXPOSURE: "direct",
    },
  });

  try {
    // The real extension entry must have produced image-aware rows inside Pi.
    const definitions = pi.toolDefinitions();
    assert.equal(definitions.has("browser_screenshot"), true, "the extension loaded into the session");
    assert.equal(typeof definitions.get("browser_screenshot").renderResult, "function", "the pi-tui import worked inside Pi");

    pi.faux.setResponses([
      scriptedStep(ai, received, { toolCalls: [{ name: "browser_screenshot", arguments: { variant: 1 } }] }),
      scriptedStep(ai, received, { text: "I can see the fixture page." }),
      scriptedStep(ai, received, { text: "Nothing else to add." }),
    ]);
    await pi.session.prompt("take a screenshot and describe it");
    await pi.session.prompt("an ordinary follow-up");

    assert.equal(received.length, 3);
    assert.deepEqual(received[0].images, [], "the first request has no picture yet");
    assert.equal(received[1].images.length, 1, "the same turn's next request carries the capture");
    assert.equal(received[1].images[0].role, "toolResult", "the picture belongs to the screenshot tool result");
    assert.equal(received[1].images[0].mimeType, "image/png");
    assert.deepEqual(received[2].images, [], "the next user turn must not carry the old picture");

    const file = pi.sessionManager.getSessionFile();
    const transcript = assertSmallTranscript(file);
    const record = readJsonSync(join(stateRoot, "sessions.json")).sessions[pi.sessionManager.getSessionId()];
    assert.equal(record.attachments.length, 1);
    assert.equal(record.latestAttachment.at >= new Date(record.latestAttachment.at).toISOString(), true);
    assert.equal(transcript.entries.some((entry) => JSON.stringify(entry).includes(shortId(record.latestAttachment.id))), true, "the ID is in the transcript as text");

    // A lookback asked in a later turn still works, and only for this turn.
    const id = record.latestAttachment.id;
    pi.faux.setResponses([
      scriptedStep(ai, received, { toolCalls: [{ name: "browser_show_screenshot", arguments: { id } }] }),
      scriptedStep(ai, received, { text: "Yes, the same page." }),
    ]);
    await pi.session.prompt("look at that screenshot again");
    const lookback = received.slice(3);
    assert.equal(lookback.length, 2);
    assert.deepEqual(lookback[0].images, [], "asking for a lookback does not attach anything by itself");
    assert.equal(lookback[1].images.length, 1, "the tool's ID brings the picture into this request");
    assert.equal(lookback[1].images[0].mimeType, "image/png");
    assertSmallTranscript(file);

    // An ID that is not part of this session is refused and attaches nothing.
    pi.faux.setResponses([
      scriptedStep(ai, received, { toolCalls: [{ name: "browser_show_screenshot", arguments: { id: "f".repeat(64) } }] }),
      scriptedStep(ai, received, { text: "That ID is unknown." }),
    ]);
    await pi.session.prompt("show me a made-up id");
    const refused = received.slice(5);
    assert.deepEqual(refused[1].images, []);
    const results = toolResults(sessionEntries(file));
    const last = results[results.length - 1];
    assert.equal(last.message.isError, true);
    assert.match(last.message.content[0].text, /No screenshot with ID/);
  } finally {
    pi.dispose();
  }
});

test("two captures in one assistant message share a timestamp and keep their order", async () => {
  const stateRoot = freshDir(join(ROOT, ".tmp", "unit-pi-state", "same-millisecond"));
  const received = [];
  const { ai } = await loadPiHost();
  const pi = await createFauxSession({
    workDir: join(stateRoot, "pi-work"),
    extensionFactories: [fixtureCaptureFactory()],
    env: {
      PI_EGO_HOME: stateRoot,
      PI_EGO_BROWSER_PATH: join(stateRoot, "no-such-browser.exe"),
      PI_EGO_DEBUG_PORT: PORT,
      PI_EGO_RUN_TIMEOUT_MS: "5000",
      // The fixture calls the tools directly, so they must be declared: deferred
      // exposure is covered by the extension tests instead of a scripted call.
      PI_EGO_TOOL_EXPOSURE: "direct",
    },
  });
  try {
    pi.faux.setResponses([
      scriptedStep(ai, received, {
        toolCalls: [
          { name: "browser_screenshot", arguments: { variant: 11 }, id: "capture-11" },
          { name: "browser_screenshot", arguments: { variant: 12 }, id: "capture-12" },
        ],
      }),
      scriptedStep(ai, received, { text: "Both captured." }),
    ]);
    await pi.session.prompt("take two screenshots");

    // Both tool results are in one assistant message. Their timestamps may be
    // identical or a few milliseconds apart; message order decides the image order.
    assert.equal(received[1].images.length, 2, "one request carries both captures");
    assert.deepEqual(received[1].images.map((image) => image.role), ["toolResult", "toolResult"]);
    assert.deepEqual(received[1].images.map((image) => image.toolCallId), ["capture-11", "capture-12"]);
    const digestOf = (variant) =>
      createHash("sha256")
        .update(Buffer.concat([PNG, Buffer.from(`variant-${variant}`)]).toString("base64"))
        .digest("hex")
        .slice(0, 12);
    assert.notEqual(digestOf(11), digestOf(12), "the two pictures differ");
    assert.equal(received[1].images[0].digest, digestOf(11), "the first call's picture comes first");
    assert.equal(received[1].images[1].digest, digestOf(12));

    const entries = sessionEntries(pi.sessionManager.getSessionFile()).filter(
      (entry) => entry.type === "message" && entry.message.role === "toolResult",
    );
    assert.equal(entries.length, 2);
    assertSmallTranscript(pi.sessionManager.getSessionFile());
  } finally {
    pi.dispose();
  }
});

test("a text-only model keeps the text form and never receives image bytes", async () => {
  const stateRoot = freshDir(join(ROOT, ".tmp", "unit-pi-state", "text-only"));
  const workDir = join(stateRoot, "pi-work");
  const received = [];
  const { ai } = await loadPiHost();
  const pi = await createFauxSession({
    workDir,
    extensionFactories: [fixtureCaptureFactory()],
    modelId: "textonly",
    env: {
      PI_EGO_HOME: stateRoot,
      PI_EGO_BROWSER_PATH: join(stateRoot, "no-such-browser.exe"),
      PI_EGO_DEBUG_PORT: PORT,
      PI_EGO_RUN_TIMEOUT_MS: "5000",
      // The fixture calls the tools directly, so they must be declared: deferred
      // exposure is covered by the extension tests instead of a scripted call.
      PI_EGO_TOOL_EXPOSURE: "direct",
    },
  });
  try {
    pi.faux.setResponses([
      scriptedStep(ai, received, { toolCalls: [{ name: "browser_screenshot", arguments: { variant: 1 } }] }),
      scriptedStep(ai, received, { text: "Saved, text only." }),
    ]);
    await pi.session.prompt("take a screenshot");
    assert.equal(received.length, 2);
    assert.deepEqual(received[0].images, []);
    assert.deepEqual(received[1].images, [], "a text-only model is never sent pixels");
    const file = pi.sessionManager.getSessionFile();
    assertSmallTranscript(file);
    const results = toolResults(sessionEntries(file));
    assert.equal(results.length, 1);
    assert.match(results[0].message.content[0].text, /Attachment ID: /);
  } finally {
    pi.dispose();
  }
});

test("two sessions and a fresh process resolve their own references and share one object", async () => {
  const stateRoot = freshDir(join(ROOT, ".tmp", "unit-pi-state", "two-sessions"));
  const receivedA = [];
  const receivedB = [];
  const { ai } = await loadPiHost();
  const env = {
    PI_EGO_HOME: stateRoot,
    PI_EGO_BROWSER_PATH: join(stateRoot, "no-such-browser.exe"),
    PI_EGO_DEBUG_PORT: PORT,
    PI_EGO_RUN_TIMEOUT_MS: "5000",
    // The fixture calls the tools directly, so they must be declared: deferred
    // exposure is covered by the extension tests instead of a scripted call.
    PI_EGO_TOOL_EXPOSURE: "direct",
  };
  const sessionA = await createFauxSession({
    workDir: join(stateRoot, "work-a"),
    extensionFactories: [fixtureCaptureFactory()],
    env,
  });
  const sessionB = await createFauxSession({
    workDir: join(stateRoot, "work-b"),
    extensionFactories: [fixtureCaptureFactory()],
    env,
  });

  try {
    // The same picture in two sessions: one object, two references.
    sessionA.faux.setResponses([
      scriptedStep(ai, receivedA, { toolCalls: [{ name: "browser_screenshot", arguments: { variant: 7 } }] }),
      scriptedStep(ai, receivedA, { text: "A done." }),
    ]);
    sessionB.faux.setResponses([
      scriptedStep(ai, receivedB, { toolCalls: [{ name: "browser_screenshot", arguments: { variant: 7 } }] }),
      scriptedStep(ai, receivedB, { text: "B done." }),
    ]);
    await sessionA.session.prompt("capture");
    await sessionB.session.prompt("capture");

    const store = readJsonSync(join(stateRoot, "sessions.json")).sessions;
    const recordA = store[sessionA.sessionManager.getSessionId()];
    const recordB = store[sessionB.sessionManager.getSessionId()];
    assert.equal(recordA.latestAttachment.id, recordB.latestAttachment.id, "identical bytes keep one ID");
    assert.equal(recordA.latestAttachment.rootId, recordB.latestAttachment.rootId);
    const library = new AttachmentLibrary(resolvePaths({ PI_EGO_HOME: stateRoot }));
    const loaded = library.load(recordA.latestAttachment);
    assert.equal(loaded.ok, true);
    assert.deepEqual(readFileSync(loaded.path).subarray(-9), Buffer.from("variant-7"));

    // Every session carries its own picture into its own requests.
    assert.equal(receivedA[1].images.length, 1);
    assert.equal(receivedB[1].images.length, 1);

    // A new process only has the files: the registry locates both references.
    const restarted = new AttachmentLibrary(resolvePaths({ PI_EGO_HOME: stateRoot }));
    assert.equal(restarted.load(recordA.latestAttachment).ok, true);
    assert.equal(restarted.load(recordB.latestAttachment).ok, true);
    assert.equal(restarted.locate({ ...recordA.latestAttachment, id: "a".repeat(64) }).code, "ATTACHMENT_MISSING");

    // A foreign session cannot use A's ID for a lookback.
    const service = new BrowserService({ env, paths: resolvePaths({ PI_EGO_HOME: stateRoot }) });
    const foreign = service.reviewScreenshot({ sessionKey: sessionB.sessionManager.getSessionId(), id: "b".repeat(64) });
    assert.equal(foreign.code, "ATTACHMENT_NOT_IN_SESSION");
  } finally {
    sessionA.dispose();
    sessionB.dispose();
  }
});
