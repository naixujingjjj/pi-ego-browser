// Probes the vendored ego-windows-host release against the local fixture and
// prints the raw shapes the extension depends on: task space entry, tab
// inventory, snapshot text, refs, screenshot paths, hand-off/resume, doctor.
// Run: node src/probe-runtime.mjs
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startFixtureServer } from "../test/fixtures/server.mjs";

const root = resolve(import.meta.dirname, "..");
const hostEntry = join(root, "vendor", "ego-windows-host", "bin", "ego-windows-host.mjs");
const stateDir = join(root, ".tmp", "probe-state");
const shotDir = join(root, ".tmp", "probe-shots");
await mkdir(stateDir, { recursive: true });
await mkdir(shotDir, { recursive: true });

const fixture = await startFixtureServer();
const log = (...args) => console.log(...args);
log("fixture:", fixture.origin);

function runHost(args, { timeoutMs = 180000 } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [hostEntry, ...args], {
      env: { ...process.env, EGO_HOST_STATE_DIR: stateDir, EGO_HOST_DEBUG_PORT: "9531", EGO_HOST_HEADLESS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
    child.stdin.end("", "utf8");
  });
}

async function runScript(name, script) {
  const file = join(stateDir, `${name}.js`);
  await writeFile(file, script, "utf8");
  const { code, stdout, stderr } = await runHost([file]);
  log(`\n===== ${name} (exit ${code}) =====`);
  if (stderr.trim()) log("--- stderr ---\n" + stderr.trim());
  log(stdout.trim());
  return { code, stdout, stderr };
}

await runHost(["--doctor"]).then(({ stdout, stderr }) => {
  log("\n===== doctor (before launch) =====");
  log(stdout.trim());
  if (stderr.trim()) log(stderr.trim());
});

const shot = join(shotDir, "home.png").replace(/\\/g, "/");

await runScript(
  "01-open-and-read",
  `const task = await taskSpace("probe");
const page = (await task.pages())[0] ?? await task.adopt((await task.tabs())[0].page);
console.log("spaceId=" + task.spaceId + " name=" + task.name + " ownership=" + task.ownership);
console.log("pageLabel=" + page.label + " targetId=" + page.targetId);
await page.goto(${JSON.stringify(fixture.origin + "/")}, { timeout: 20000 });
console.log("url=" + (await page.url()) + " title=" + (await page.title()));
const snapshot = await page.snapshot();
console.log("--- snapshot ---");
console.log(snapshot);
console.log("--- snapshot end (length " + snapshot.length + ") ---");
const tabs = await task.tabs();
console.log("tabs=" + JSON.stringify(tabs.map((t) => ({ label: t.label, targetId: t.targetId, active: t.active, openedBy: t.openedBy, title: t.title, url: t.url }))));
const saved = await page.screenshot({ path: ${JSON.stringify(shot)} });
console.log("screenshot=" + saved);
`,
);

await runScript(
  "02-click-and-fill",
  `const task = await taskSpace("probe");
const page = (await task.pages())[0];
await page.goto(${JSON.stringify(fixture.origin + "/form.html")}, { timeout: 20000 });
const before = await page.snapshot();
const mark = /\\[(?:@|ref=)(\\d+)\\][^\\n]*/.exec("");
const refs = [...before.matchAll(/\\[@(\\d+)\\]/g)].map((m) => Number(m[1]));
console.log("refCount=" + refs.length + " first3=" + JSON.stringify(refs.slice(0, 6)));
const lines = before.split("\\n").filter((line) => /textbox|combobox|button|checkbox|heading/.test(line));
console.log(lines.join("\\n"));
// Fill the first textbox by role locator and click the submit button.
const fillReceipt = await page.fill("loc=role:textbox[name='Full name']", "张三", { timeout: 8000 });
console.log("fillReceipt=" + JSON.stringify(fillReceipt));
const clickReceipt = await page.click("loc=role:button[name='Sign up']", { timeout: 8000 });
console.log("clickReceipt=" + JSON.stringify(clickReceipt));
const after = await page.snapshot();
console.log("--- after ---");
console.log(after.split("\\n").filter((line) => /Outcome|submitted|fieldstate|textbox/.test(line)).join("\\n"));
console.log("url=" + (await page.url()));
`,
);

await runScript(
  "03-tabs",
  `const task = await taskSpace("probe");
const second = await task.newPage();
await second.goto(${JSON.stringify(fixture.origin + "/second.html")}, { timeout: 20000 });
console.log("newPage label=" + second.label + " targetId=" + second.targetId);
let tabs = await task.tabs();
console.log("tabs after new=" + JSON.stringify(tabs.map((t) => ({ label: t.label, active: t.active, url: t.url }))));
const first = task.page("p1");
await task.cdp("Target.activateTarget", { targetId: first.targetId });
tabs = await task.tabs();
console.log("tabs after activate p1=" + JSON.stringify(tabs.map((t) => ({ label: t.label, active: t.active, url: t.url }))));
const snap = await page.snapshot().catch((error) => "ERR " + error.error_code + " " + error.message).then(() => null);
const activeSnapshot = await (async () => {
  const pages = await task.pages();
  for (const candidate of pages) {
    if (candidate.label === "p1") return await candidate.snapshot();
  }
  return "";
})();
console.log("p1 snapshot head=" + JSON.stringify(activeSnapshot.split("\\n").slice(0, 3)));
await task.page("p2").close();
tabs = await task.tabs();
console.log("tabs after close p2=" + JSON.stringify(tabs.map((t) => ({ label: t.label, active: t.active }))));
`,
);

await runScript(
  "04-handoff-resume",
  `const task = await taskSpace("probe");
const page = (await task.pages())[0];
await page.goto(${JSON.stringify(fixture.origin + "/form.html")}, { timeout: 20000 });
const handed = await task.handOff();
console.log("handOff=" + JSON.stringify(handed));
const blocked = await page.snapshot().then(() => "NO-ERROR").catch((error) => (error.error_code || error.code) + ": " + error.message);
console.log("snapshot while handed off=" + blocked);
const entry = (await listTaskSpaces()).find((space) => space.id === task.spaceId);
console.log("space entry=" + JSON.stringify(entry));
`,
);

await runScript(
  "05-resume-script",
  `const spaces = await listTaskSpaces();
const entry = spaces.find((space) => space.name === "probe");
console.log("entry=" + JSON.stringify(entry));
const task = entry.ownership === "agentDelegatedToUser" ? await takeOverTaskSpace(entry.id) : await taskSpace(entry.id);
const page = (await task.pages())[0];
console.log("resumed ownership=" + task.ownership + " page=" + page.label + " url=" + (await page.url()));
const snapshot = await page.snapshot();
console.log("snapshot head=" + JSON.stringify(snapshot.split("\\n").slice(0, 4)));
await page.fill("loc=role:textbox[name='Full name']", "李四", { timeout: 8000 });
console.log("refilled");
`,
);

const after = await runHost(["--doctor"]);
log("\n===== doctor (after) =====");
log(after.stdout.trim());

const spaces = await import("node:fs/promises").then((fs) => fs.readFile(join(stateDir, "spaces.json"), "utf8").catch(() => "(none)"));
log("\n===== spaces.json =====");
log(spaces);

await fixture.close();