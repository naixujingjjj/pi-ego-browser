// Verifies an npm tarball of this package without unpacking it to disk.
// Usage: node tools/check-pack.mjs [path/to/pi-ego-browser-x.y.z.tgz]
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { summarizeTarball } from "./tarball.mjs";

const root = resolve(import.meta.dirname, "..");

function newestTarball() {
  const dir = join(root, "dist");
  if (!existsSync(dir)) return null;
  const tgz = readdirSync(dir)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return tgz[0] || null;
}

const target = process.argv[2] ? resolve(process.argv[2]) : newestTarball();
if (!target || !existsSync(target)) {
  console.error("no tarball found; run: npm pack --ignore-scripts --pack-destination dist");
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const summary = summarizeTarball(target);
const names = summary.files.map((entry) => entry.name);
const has = (suffix) => names.some((name) => name === suffix || name.endsWith(`/${suffix}`));

const required = [
  "package/package.json",
  "package/extensions/ego-browser.js",
  "package/src/tools.js",
  "package/src/script.js",
  "package/src/runtime.js",
  "package/src/chromium.js",
  "package/src/session.js",
  "package/src/attachments.js",
  "package/src/review.js",
  "package/src/command.js",
  "package/src/render.js",
  "package/src/settings-ui.js",
  "package/src/folder-picker.js",
  "package/src/paths.js",
  "package/src/store.js",
  "package/vendor/ego-windows-host/bin/ego-windows-host.mjs",
  "package/vendor/ego-windows-host/dist/src/cli.js",
  "package/vendor/ego-windows-host/node_modules/ego-browser-v2/dist/src/run.js",
  "package/vendor/ego-windows-host/node_modules/ego-v2-ext/src/index.mjs",
  "package/vendor/chromium-lock.json",
  "package/vendor/LICENSE-agenticbrowser",
  "package/vendor/LICENSE-acorn",
  "package/THIRD_PARTY.md",
  "package/README.md",
];
const forbidden = [
  "package/node_modules/",
  "package/test/",
  "package/tools/",
  "package/.tmp/",
  "package/dist/",
  "package/src/probe-runtime.mjs",
  "package/src/smoke.mjs",
  "package/settings.json",
];

const problems = [];
for (const name of required) {
  if (!names.includes(name)) problems.push(`missing required file: ${name}`);
}
for (const name of names) {
  for (const prefix of forbidden) {
    if (name.startsWith(prefix) || name === prefix.replace(/\/$/, "")) {
      problems.push(`should not ship: ${name}`);
    }
  }
}
const packedManifest = names.includes("package/package.json");
const unpacked = summary.files.filter((entry) => entry.name === "package/package.json");
if (packedManifest && unpacked.length === 1) {
  const text = readFileSync(join(root, "package.json"), "utf8");
  if (!text.includes(`"version": "${manifest.version}"`)) problems.push("package.json version is stale");
}
if (!has("package/vendor/ego-windows-host/package.json")) problems.push("missing vendored runtime manifest");

const sha256 = createHash("sha256").update(readFileSync(target)).digest("hex");
console.log(
  JSON.stringify(
    {
      tarball: target,
      version: manifest.version,
      sizeBytes: statSync(target).size,
      unpackedBytes: summary.totalBytes,
      fileCount: summary.files.length,
      sha256,
      topLevel: [...new Set(names.map((name) => name.split("/")[1]))].sort(),
      problems,
      ok: problems.length === 0,
    },
    null,
    2,
  ),
);
process.exit(problems.length === 0 ? 0 : 1);