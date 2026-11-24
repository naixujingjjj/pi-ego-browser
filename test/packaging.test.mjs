import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../src/paths.js";

const read = (name) => readFileSync(join(PACKAGE_ROOT, name), "utf8");

test("the package declares a Pi extension and ships every runtime file", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.deepEqual(manifest.pi.extensions, ["./extensions/ego-browser.js"]);
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.dependencies ?? {}, {}, "no runtime npm dependencies");
  for (const entry of manifest.files) {
    assert.equal(existsSync(join(PACKAGE_ROOT, entry)), true, `${entry} exists`);
  }
  // The settings screen and the native folder picker ship with the entry.
  for (const entry of ["src/settings-ui.js", "src/folder-picker.js"]) {
    assert.equal(existsSync(join(PACKAGE_ROOT, entry)), true, `${entry} exists`);
  }
});

test("every document names the tarball that package.json declares", () => {
  const version = JSON.parse(read("package.json")).version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  for (const file of ["README.md", "docs/ACCEPTANCE.md"]) {
    const text = read(file);
    const named = [...text.matchAll(/pi-ego-browser-(\d+\.\d+\.\d+)\.tgz/g)].map((match) => match[1]);
    assert.ok(named.length > 0, `${file} names a tarball`);
    for (const name of named) assert.equal(name, version, `${file} names ${name}`);
  }
});

test("the vendored Ego runtime is present, fixed, and self-contained", () => {
  const hostPackage = JSON.parse(read("vendor/ego-windows-host/package.json"));
  assert.equal(hostPackage.name, "ego-windows-host");
  assert.equal(hostPackage.version, "2.3.0-linux.1");
  for (const path of [
    "vendor/ego-windows-host/bin/ego-windows-host.mjs",
    "vendor/ego-windows-host/dist/src/cli.js",
    "vendor/ego-windows-host/node_modules/ego-browser-v2/dist/src/run.js",
    "vendor/ego-windows-host/node_modules/ego-v2-ext/src/index.mjs",
    "vendor/ego-windows-host/node_modules/acorn/package.json",
  ]) {
    assert.equal(existsSync(join(PACKAGE_ROOT, path)), true, `${path} ships`);
  }
});

test("licences and third-party notices travel with the runtime", () => {
  const license = read("vendor/LICENSE-agenticbrowser");
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2026 CitroLabs/, "the upstream notice is retained");
  assert.match(read("vendor/LICENSE-acorn"), /MIT/i);
  const notices = read("THIRD_PARTY.md");
  for (const needle of ["agenticbrowser", "ego lite", "acorn", "Chrome for Testing", "MIT"]) {
    assert.match(notices, new RegExp(needle, "i"), `THIRD_PARTY.md mentions ${needle}`);
  }
});

test("the pinned managed browser lock is complete and honest", () => {
  const lock = JSON.parse(read("vendor/chromium-lock.json"));
  assert.match(lock.version, /^\d+\.\d+\.\d+\.\d+$/);
  assert.match(lock.url, /^https:\/\/storage\.googleapis\.com\/chrome-for-testing-public\//);
  assert.match(lock.url, new RegExp(lock.version.replace(/\./g, "\\.")));
  assert.match(lock.sha256, /^[0-9a-f]{64}$/);
  assert.ok(lock.size > 100 * 1024 * 1024, "the pinned archive size looks like a real browser build");
  assert.equal(lock.executableRelativePath, "chrome-win64/chrome.exe");
  assert.match(lock.note, /does not publish per-file checksums/i);
});

test("the README documents install, the one command and what was verified", () => {
  const readme = read("README.md");
  for (const needle of ["pi install", "/ego-settings", "info", "browser_read", "PI_EGO_HOME", "npm test"]) {
    assert.match(readme, new RegExp(needle), `README mentions ${needle}`);
  }
  const { version } = JSON.parse(read("package.json"));
  assert.ok(readme.includes(`pi-ego-browser-${version}.tgz`), "the README names the current installation package");
  // The removed `/ego` command may only appear as history, never as an
  // instruction line: a lone `/ego <action>` line would teach a command Pi no
  // longer registers.
  for (const line of readme.split(/\r?\n/)) {
    assert.equal(/^\s*\/?ego\s+\w/.test(line), false, `README still teaches the removed /ego command: ${line}`);
  }
  const acceptance = read("docs/ACCEPTANCE.md");
  for (const line of acceptance.split(/\r?\n/)) {
    assert.equal(/^\s*\/?ego\s+\w/.test(line), false, `ACCEPTANCE.md still teaches the removed /ego command: ${line}`);
  }
});
