// Build-time helper: download the pinned Chrome for Testing build once and
// print the SHA-256/size so it can be recorded in vendor/chromium-lock.json.
// Usage: node src/fetch-chromium.mjs <version> <destDir>
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const version = process.argv[2];
const destDir = process.argv[3];
if (!version || !destDir) {
  console.error("usage: node src/fetch-chromium.mjs <version> <destDir>");
  process.exit(2);
}
const url = `https://storage.googleapis.com/chrome-for-testing-public/${version}/win64/chrome-win64.zip`;
await mkdir(destDir, { recursive: true });
const dest = join(destDir, `chrome-win64-${version}.zip`);

const started = Date.now();
const response = await fetch(url, { redirect: "follow" });
if (!response.ok) {
  throw new Error(`download failed: HTTP ${response.status} for ${url}`);
}
const hash = createHash("sha256");
let bytes = 0;
const source = Readable.fromWeb(response.body);
source.on("data", (chunk) => {
  hash.update(chunk);
  bytes += chunk.length;
  if (bytes % (20 * 1024 * 1024) < chunk.length) {
    process.stderr.write(`  ${(bytes / 1048576).toFixed(0)} MiB\n`);
  }
});
await pipeline(source, createWriteStream(dest));
const info = await stat(dest);
console.log(
  JSON.stringify(
    {
      url,
      version,
      path: dest,
      size: info.size,
      sha256: hash.digest("hex"),
      seconds: Math.round((Date.now() - started) / 1000),
    },
    null,
    2,
  ),
);