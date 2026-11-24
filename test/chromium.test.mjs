import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  candidateSystemBrowsers,
  downloadArchive,
  findSystemBrowser,
  installManagedBrowser,
  managedBrowserExe,
  managedBrowserReady,
  readBrowserState,
  resolveBrowser,
} from "../src/chromium.js";
import { extractZip } from "../src/unzip.js";
import { buildZip, tempDir } from "./helpers.mjs";

const EXE = "fake chrome binary";
const ZIPE = buildZip([
  { name: "chrome-win64/", data: "" },
  { name: "chrome-win64/chrome.exe", data: EXE },
  { name: "chrome-win64/version.txt", data: "158.0.8127.88 fake", deflate: true },
]);
const ZIP_SHA = createHash("sha256").update(ZIPE).digest("hex");

function startArchiveServer(archive, { interruptAt = null } = {}) {
  const state = { requests: [], interrupted: false };
  const server = createServer((request, response) => {
    const range = request.headers.range;
    state.requests.push({ range: range || null, at: Date.now() });
    const match = range ? /bytes=(\d+)-/.exec(range) : null;
    const start = match ? Number(match[1]) : 0;
    const body = archive.subarray(start);
    if (match) {
      response.writeHead(206, {
        "content-type": "application/zip",
        "content-length": String(body.length),
        "content-range": `bytes ${start}-${archive.length - 1}/${archive.length}`,
      });
    } else {
      response.writeHead(200, { "content-type": "application/zip", "content-length": String(body.length) });
    }
    if (interruptAt && !state.interrupted && start === 0) {
      state.interrupted = true;
      response.write(body.subarray(0, interruptAt));
      // Drop the connection mid-body: the downloader must resume or restart.
      setTimeout(() => response.destroy(), 10);
      return;
    }
    response.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        state,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test("system browser discovery prefers Edge then Chrome then Chromium", () => {
  const env = { PROGRAMFILES: "C:\\Program Files", "PROGRAMFILES(X86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" };
  const candidates = candidateSystemBrowsers(env);
  assert.equal(candidates.length, 9);
  assert.match(candidates[0], /Microsoft\\Edge\\Application\\msedge\.exe$/);
  const edge = findSystemBrowser(env, (path) => path === candidates[0]);
  assert.equal(edge, candidates[0]);
  const chrome = findSystemBrowser(env, (path) => path === candidates[3]);
  assert.equal(chrome, candidates[3]);
  assert.equal(findSystemBrowser(env, () => false), null);
});

test("extractZip unpacks stored and deflated entries", () => {
  const temp = tempDir("unzip");
  try {
    const zip = temp.write("chrome.zip", ZIPE);
    const written = extractZip(zip, join(temp.dir, "out"));
    assert.deepEqual(written, ["chrome-win64/chrome.exe", "chrome-win64/version.txt"]);
    assert.equal(readFileSync(join(temp.dir, "out", "chrome-win64", "chrome.exe"), "utf8"), EXE);
    assert.match(readFileSync(join(temp.dir, "out", "chrome-win64", "version.txt"), "utf8"), /158\.0\.8127/);
  } finally {
    temp.cleanup();
  }
});

test("an empty cache downloads, verifies, unpacks, then reuses the cache", async () => {
  const temp = tempDir("managed-first-run");
  const server = await startArchiveServer(ZIPE);
  try {
    const paths = {
      stateRoot: temp.dir,
      browsersDir: join(temp.dir, "browsers"),
      downloadDir: join(temp.dir, "downloads"),
      browserStateFile: join(temp.dir, "browser-state.json"),
      chromiumLock: join(temp.dir, "lock.json"),
      browserPathEnv: "",
      noSystemBrowser: true,
      chromiumUrl: "",
      chromiumSha256: "",
      chromiumVersion: "",
      profileDir: join(temp.dir, "profile"),
      port: 9,
    };
    const overrides = { url: `${server.origin}/chrome-win64.zip`, sha256: ZIP_SHA, version: "158.0.8127.88" };
    const progress = [];
    const first = await resolveBrowser({
      paths,
      env: { ...process.env, PI_EGO_NO_SYSTEM_BROWSER: "1" },
      overrides,
      onProgress: (message) => progress.push(message),
      exists: existsSync,
    });
    assert.equal(first.ok, true, first.message);
    assert.equal(first.source, "managed");
    assert.equal(existsSync(first.path), true);
    assert.ok(progress.some((line) => /preparing Chrome for Testing/.test(line)), "reports the prepare stage");
    assert.ok(progress.some((line) => /download verified/.test(line)), "reports verification");

    const state = readBrowserState(paths);
    assert.equal(state.ok, true);
    assert.equal(state.source, "managed");
    assert.equal(server.state.requests.length, 1);

    const second = await resolveBrowser({
      paths,
      env: { ...process.env, PI_EGO_NO_SYSTEM_BROWSER: "1" },
      overrides,
      exists: existsSync,
    });
    assert.equal(second.ok, true);
    assert.equal(second.path, first.path);
    assert.equal(server.state.requests.length, 1, "the cached browser is reused without a download");
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test("an interrupted download resumes and still verifies", async () => {
  const temp = tempDir("managed-interrupted");
  const server = await startArchiveServer(ZIPE, { interruptAt: 120 });
  try {
    const lock = {
      version: "158.0.8127.88",
      url: `${server.origin}/chrome-win64.zip`,
      sha256: ZIP_SHA,
      executableRelativePath: "chrome-win64/chrome.exe",
    };
    const paths = { downloadDir: join(temp.dir, "downloads"), browsersDir: join(temp.dir, "browsers") };
    const downloaded = await downloadArchive({ lock, paths, attempts: 3 });
    assert.equal(downloaded.resumed, true, "the second attempt used the partial file");
    assert.ok(server.state.requests.length >= 2);
    assert.ok(server.state.requests.some((entry) => entry.range), "a range request was made");
    const exe = await installManagedBrowser({ lock, paths });
    assert.equal(existsSync(exe), true);
    assert.equal(managedBrowserReady(paths, lock), true);
    assert.equal(managedBrowserExe(paths, lock), exe);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test("a checksum mismatch is refused, kept out of the cache, and reported", async () => {
  const temp = tempDir("managed-bad-hash");
  const server = await startArchiveServer(ZIPE);
  try {
    const paths = {
      stateRoot: temp.dir,
      browsersDir: join(temp.dir, "browsers"),
      downloadDir: join(temp.dir, "downloads"),
      browserStateFile: join(temp.dir, "browser-state.json"),
      chromiumLock: join(temp.dir, "lock.json"),
      browserPathEnv: "",
      noSystemBrowser: true,
      chromiumUrl: "",
      chromiumSha256: "",
      chromiumVersion: "",
      profileDir: join(temp.dir, "profile"),
      port: 9,
    };
    const result = await resolveBrowser({
      paths,
      env: { ...process.env, PI_EGO_NO_SYSTEM_BROWSER: "1" },
      overrides: { url: `${server.origin}/chrome-win64.zip`, sha256: "0".repeat(64), version: "158.0.8127.88" },
      exists: existsSync,
    });
    assert.equal(result.ok, false);
    assert.equal(result.stage, "browser-download");
    assert.match(result.message, /SHA-256/);
    assert.equal(existsSync(join(paths.downloadDir, "chrome-win64-158.0.8127.88.zip")), false);
    assert.equal(existsSync(join(paths.browsersDir, "chrome-win64-158.0.8127.88", ".complete")), false);
    const state = readBrowserState(paths);
    assert.equal(state.ok, false);
    assert.match(state.message, /SHA-256/);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test("a missing PI_EGO_BROWSER_PATH fails at the detect stage", async () => {
  const temp = tempDir("managed-env-missing");
  try {
    const paths = {
      stateRoot: temp.dir,
      browserStateFile: join(temp.dir, "browser-state.json"),
      chromiumLock: join(temp.dir, "lock.json"),
      browserPathEnv: "C:\\definitely\\not\\here\\msedge.exe",
      noSystemBrowser: false,
      profileDir: join(temp.dir, "profile"),
      port: 9,
    };
    const result = await resolveBrowser({ paths, exists: () => false });
    assert.equal(result.ok, false);
    assert.equal(result.stage, "browser-detect");
    assert.equal(result.source, "env");
  } finally {
    temp.cleanup();
  }
});