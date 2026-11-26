import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePiPackage } from "../tools/harness.mjs";
import { createScreenshotView } from "../src/render.js";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001",
  "hex",
);
const B64 = PNG.toString("base64");

const theme = { fg: (_token, text) => text };

const piRoot = resolvePiPackage().packageRoot;
const tui = await import(pathToFileURL(join(piRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js")).href);

test("a screenshot row shows text only when images are off", async () => {
  const view = createScreenshotView(tui, {
    text: "Attachment abc123… 12 B\nFile: C:/library/abc.png",
    loadImage: () => {
      throw new Error("must not read with images off");
    },
    theme,
    showImages: false,
  });
  const lines = view.render(80);
  assert.equal(lines.some((line) => line.includes("[Image:")), false);
  assert.ok(lines.join("\n").includes("C:/library/abc.png"));
});

test("an expanded row reads the picture once and then reuses it", async () => {
  let reads = 0;
  const view = createScreenshotView(tui, {
    text: "Attachment abc123…",
    loadImage: () => {
      reads += 1;
      return { data: B64, mimeType: "image/png", filename: "C:/library/abc.png" };
    },
    theme,
    showImages: true,
  });
  const first = view.render(100);
  const second = view.render(100);
  assert.equal(reads, 1, "the image file is read on the first render only");
  assert.deepEqual(first, second);
  const flat = first.join("\n");
  assert.ok(flat.includes("Attachment abc123…"));
  // This test terminal has no image protocol, so the fallback carries the path.
  assert.ok(/\[Image:.*abc\.png/.test(flat) || flat.includes("abc.png"), `no image fallback in:\n${flat}`);
  view.invalidate();
  assert.equal(view.render(100).length, first.length);
});

test("an unreadable picture degrades to a warning, not a crash", async () => {
  const view = createScreenshotView(tui, {
    text: "Attachment abc123…",
    loadImage: () => ({ error: "storage root unavailable" }),
    theme,
    showImages: true,
  });
  const flat = view.render(60).join("\n");
  assert.ok(flat.includes("Image unavailable"));
  assert.ok(flat.includes("storage root unavailable"));
});