// Builds the JavaScript that the Ego runtime executes for each tool call.
//
// The runtime compiles this source as an `AsyncFunction` whose parameters are
// its helper names (`snapshot`, `click`, `fillInput`, `tabSpace`, … — 59 of
// them), so every identifier this file declares is prefixed with `pi` to stay
// out of that namespace. A collision is a SyntaxError before the script runs,
// which is exactly the trap a probe run hit with `const snapshot`.
//
// One call = one short-lived Node process. The script re-enters this session's
// task space first, so tabs and page labels survive between calls while
// JavaScript variables do not. Everything the extension needs back is printed
// as one sentinel-prefixed JSON line, so a script must emit exactly one result:
// the helpers below are strict if/else chains for that reason.
//
// A task space that is not owned by the agent (`agentDelegatedToUser`, `user`)
// is never taken over here. The `/ego-settings` resume action (the menu's
// Resume Browser Control row, or `/ego-settings resume` without a TUI) is the only
// path that does that.
import { RESULT_SENTINEL } from "./runtime.js";

const PRELUDE = `
const PI_CMD = __CMD__;
const PI_OUT = (payload) => console.log(${JSON.stringify(RESULT_SENTINEL)} + JSON.stringify(payload));
const PI_ERR = (code, message, extra) => PI_OUT({ ok: false, code, message, ...(extra || {}) });

function piDescribeTab(tab) {
  return {
    label: tab.label || null,
    title: tab.title || "",
    url: tab.url || "",
    active: Boolean(tab.active),
    openedBy: tab.openedBy || null,
  };
}

async function piTabsOf(task) {
  try {
    return await task.tabs();
  } catch (error) {
    return [];
  }
}

async function piEnterSpace() {
  const piSpaces = await listTaskSpaces();
  const piWanted = piSpaces.find((entry) => entry.id === PI_CMD.space.id)
    || piSpaces.find((entry) => entry.name === PI_CMD.space.name);
  if (!piWanted) return { task: await taskSpace(PI_CMD.space.name), created: true };
  if (piWanted.ownership === "agent") return { task: await taskSpace(piWanted.id) };
  return { blocked: piWanted };
}

async function piPageForTab(task, tab) {
  if (!tab) return null;
  const piPage = tab.label ? task.page(tab.label) : await task.adopt(tab.page);
  return piPage;
}

async function piActiveTab(task) {
  const piTabs = await piTabsOf(task);
  if (!piTabs.length) return null;
  return piTabs.find((tab) => tab.active) || piTabs[piTabs.length - 1];
}

async function piTabByLabel(task, label) {
  const piTabs = await piTabsOf(task);
  const piTab = piTabs.find((entry) => entry.label === label) || null;
  return { tab: piTab, tabs: piTabs };
}

async function piTabByIndex(task, index) {
  const piTabs = await piTabsOf(task);
  const piWanted = index === null ? piTabs.length - 1 : index;
  const piTab = piTabs[piWanted] || null;
  return { tab: piTab, tabs: piTabs };
}

async function piInfoOf(page) {
  const piUrl = await page.url().catch(() => null);
  const piTitle = await page.title().catch(() => "");
  return { pageLabel: page.label, url: piUrl, title: piTitle };
}

async function piSpaceReport(task) {
  const piTabs = await piTabsOf(task);
  return {
    spaceId: task.spaceId,
    spaceName: task.name,
    ownership: task.ownership,
    tabs: piTabs.map(piDescribeTab),
  };
}

function piReceiptSummary(receipt) {
  if (!receipt || typeof receipt !== "object") return null;
  const piOut = {};
  if (receipt.popups) piOut.popups = receipt.popups;
  if (receipt.dialog) piOut.dialog = receipt.dialog;
  if (receipt.download) piOut.download = receipt.download;
  return Object.keys(piOut).length ? piOut : null;
}

function piErrorPayload(error) {
  return {
    code: (error && (error.error_code || error.code)) || "EGO_ERROR",
    message: String((error && error.message) || error),
    mayHaveLateEffects: Boolean(error && error.mayHaveLateEffects),
  };
}

function piBlocked(payload) {
  PI_ERR(
    "HANDED_TO_USER",
    "The user is controlling this browser task space (ownership=" + payload.ownership + "); wait until the user resumes from /ego-settings (Resume Browser Control) in Pi, then continue.",
    { spaceId: payload.id, spaceName: payload.name, ownership: payload.ownership },
  );
}
`;

function wrap(body, cmd) {
  return `${PRELUDE.replace("__CMD__", () => JSON.stringify(cmd))}
try {
${body}
} catch (error) {
  const piFailure = piErrorPayload(error);
  PI_ERR(piFailure.code, piFailure.message, { mayHaveLateEffects: piFailure.mayHaveLateEffects });
}
`;
}

const spaceArg = (space) => space || { id: null, name: "pi-ego-browser" };

export function buildOpenScript({ space, url, timeoutMs = 30000 }) {
  return wrap(
    `const piEntry = await piEnterSpace();
if (piEntry.blocked) {
  piBlocked(piEntry.blocked);
} else {
  const piTask = piEntry.task;
  const piCurrent = await piActiveTab(piTask);
  const piPage = piCurrent ? await piPageForTab(piTask, piCurrent) : await piTask.newPage();
  await piPage.goto(${JSON.stringify(url)}, { timeout: ${Number(timeoutMs)} });
  const piInfo = await piInfoOf(piPage);
  PI_OUT({ ok: true, ...(await piSpaceReport(piTask)), ...piInfo });
}`,
    { kind: "open", space: spaceArg(space), url, timeoutMs },
  );
}

export function buildReadScript({ space, pageLabel = null, scope = "viewport" }) {
  const snapshotOptions = scope === "full_page" ? '{ scope: "full_page" }' : "{}";
  return wrap(
    `const piEntry = await piEnterSpace();
if (piEntry.blocked) {
  piBlocked(piEntry.blocked);
} else {
  const piTask = piEntry.task;
  let piTab = null;
  let piTabs = [];
  if (${JSON.stringify(pageLabel)}) {
    const piFound = await piTabByLabel(piTask, ${JSON.stringify(pageLabel)});
    piTab = piFound.tab;
    piTabs = piFound.tabs;
  } else {
    piTab = await piActiveTab(piTask);
  }
  if (!piTab) {
    PI_ERR(
      piTabs.length ? "NO_SUCH_PAGE" : "NO_PAGE",
      piTabs.length
        ? "This task space has no tab " + ${JSON.stringify(pageLabel)}
        : "This task space has no tabs yet; call browser_open to open a URL first.",
      { ...(await piSpaceReport(piTask)), tabs: piTabs.map(piDescribeTab) },
    );
  } else {
    const piPage = await piPageForTab(piTask, piTab);
    const piSnapshotText = await piPage.snapshot(${snapshotOptions});
    const piInfo = await piInfoOf(piPage);
    PI_OUT({ ok: true, ...(await piSpaceReport(piTask)), ...piInfo, snapshot: piSnapshotText });
  }
}`,
    { kind: "read", space: spaceArg(space), pageLabel, scope },
  );
}

const ACT_BODY = `
const piEntry = await piEnterSpace();
if (piEntry.blocked) {
  piBlocked(piEntry.blocked);
} else {
  const piTask = piEntry.task;
  const piTab = await piActiveTab(piTask);
  if (!piTab) {
    PI_ERR("NO_PAGE", "This task space has no tabs yet; call browser_open to open a URL first.", await piSpaceReport(piTask));
  } else {
    const piPage = await piPageForTab(piTask, piTab);
    const piBefore = await piInfoOf(piPage);
    const piExpect = PI_CMD.expect;
    const piStale =
      piExpect &&
      ((piExpect.pageLabel && piExpect.pageLabel !== piBefore.pageLabel) ||
        (piExpect.url && piExpect.url !== piBefore.url));
    if (piStale) {
      PI_ERR(
        "STALE_PAGE",
        "These element numbers were generated for " + (piExpect.pageLabel || "another tab") + " at " + (piExpect.url || "another URL") + ", but the current page is " +
          (piBefore.pageLabel || "none") + " at " + (piBefore.url || "none") + "; call browser_read again.",
        { ...(await piSpaceReport(piTask)), ...piBefore },
      );
    } else {
      let piReceipt = null;
      let piFailed = null;
      try {
        __ACTION__
      } catch (error) {
        piFailed = piErrorPayload(error);
      }
      const piAfter = await piInfoOf(piPage);
      const piReport = await piSpaceReport(piTask);
      if (piFailed) {
        PI_ERR(piFailed.code, piFailed.message, {
          ...piReport,
          ...piAfter,
          mayHaveLateEffects: piFailed.mayHaveLateEffects,
        });
      } else {
        PI_OUT({ ok: true, ...piReport, ...piAfter, navigated: piAfter.url !== piBefore.url, receipt: piReceiptSummary(piReceipt) });
      }
    }
  }
}`;

export function buildClickScript({ space, selector, expect = null, timeoutMs = 8000 }) {
  const body = ACT_BODY.replace(
    "__ACTION__",
    () => `piReceipt = await piPage.click(${JSON.stringify(selector)}, { timeout: ${Number(timeoutMs)} });`,
  );
  return wrap(body, { kind: "click", space: spaceArg(space), selector, expect, timeoutMs });
}

export function buildFillScript({ space, selector, text, expect = null, timeoutMs = 8000 }) {
  const body = ACT_BODY.replace(
    "__ACTION__",
    () => `piReceipt = await piPage.fill(${JSON.stringify(selector)}, ${JSON.stringify(text)}, { timeout: ${Number(timeoutMs)} });`,
  );
  return wrap(body, { kind: "fill", space: spaceArg(space), selector, text, expect, timeoutMs });
}

export function buildTabsScript({ space, action, url = null, pageLabel = null, index = null, timeoutMs = 30000 }) {
  const select = `const piWantedLabel = ${JSON.stringify(pageLabel)};
const piWantedIndex = ${index === null ? "null" : Number(index)};
const piFound = piWantedLabel ? await piTabByLabel(piTask, piWantedLabel) : await piTabByIndex(piTask, piWantedIndex);`;
  const bodies = {
    list: `const piEntry = await piEnterSpace();
if (piEntry.blocked) {
  piBlocked(piEntry.blocked);
} else {
  const piReport = await piSpaceReport(piEntry.task);
  PI_OUT({ ok: true, ...piReport, labels: piReport.tabs.map((tab) => tab.label).filter(Boolean) });
}`,
    new: `const piEntry = await piEnterSpace();
if (piEntry.blocked) {
  piBlocked(piEntry.blocked);
} else {
  const piTask = piEntry.task;
  const piStarter = piEntry.created ? await piActiveTab(piTask) : null;
  const piPage = piStarter?.url === "about:blank"
    ? await piPageForTab(piTask, piStarter)
    : await piTask.newPage();
  ${
    url
      ? `await piPage.goto(${JSON.stringify(url)}, { timeout: ${Number(timeoutMs)} });`
      : ""
  }
  const piInfo = await piInfoOf(piPage);
  PI_OUT({ ok: true, ...(await piSpaceReport(piTask)), ...piInfo, created: true });
}`,
    switch: `const piEntry = await piEnterSpace();
if (piEntry.blocked) {
  piBlocked(piEntry.blocked);
} else {
  const piTask = piEntry.task;
  ${select}
  if (!piFound.tab) {
    PI_ERR("NO_SUCH_TAB", "No such tab to switch to", { tabs: piFound.tabs.map(piDescribeTab) });
  } else {
    await piTask.cdp("Target.activateTarget", { targetId: piFound.tab.targetId });
    const piPage = await piPageForTab(piTask, piFound.tab);
    const piInfo = await piInfoOf(piPage);
    PI_OUT({ ok: true, ...(await piSpaceReport(piTask)), ...piInfo, activated: true });
  }
}`,
    close: `const piEntry = await piEnterSpace();
if (piEntry.blocked) {
  piBlocked(piEntry.blocked);
} else {
  const piTask = piEntry.task;
  ${select}
  if (!piFound.tab) {
    PI_ERR("NO_SUCH_TAB", "No such tab to close", { tabs: piFound.tabs.map(piDescribeTab) });
  } else {
    const piPage = await piPageForTab(piTask, piFound.tab);
    const piClosed = piFound.tab.label || null;
    await piPage.close();
    PI_OUT({ ok: true, closed: piClosed, ...(await piSpaceReport(piTask)) });
  }
}`,
  };
  const body = bodies[action];
  if (!body) throw new Error(`unknown tabs action: ${action}`);
  return wrap(body, { kind: "tabs", action, space: spaceArg(space), url, pageLabel, index });
}

export function buildScreenshotScript({ space, path, fullPage = false, pageLabel = null }) {
  return wrap(
    `const piEntry = await piEnterSpace();
if (piEntry.blocked) {
  piBlocked(piEntry.blocked);
} else {
  const piTask = piEntry.task;
  let piTab = null;
  let piTabs = [];
  if (${JSON.stringify(pageLabel)}) {
    const piFound = await piTabByLabel(piTask, ${JSON.stringify(pageLabel)});
    piTab = piFound.tab;
    piTabs = piFound.tabs;
  } else {
    piTab = await piActiveTab(piTask);
  }
  if (!piTab) {
    PI_ERR(
      piTabs.length ? "NO_SUCH_PAGE" : "NO_PAGE",
      piTabs.length
        ? "This task space has no tab " + ${JSON.stringify(pageLabel)}
        : "This task space has no tabs yet; call browser_open to open a URL first.",
      { ...(await piSpaceReport(piTask)), tabs: piTabs.map(piDescribeTab) },
    );
  } else {
    const piPage = await piPageForTab(piTask, piTab);
    const piSaved = await piPage.screenshot({ path: ${JSON.stringify(path)}, ${fullPage ? "fullPage: true," : ""} });
    const piInfo = await piInfoOf(piPage);
    PI_OUT({ ok: true, ...(await piSpaceReport(piTask)), ...piInfo, path: piSaved });
  }
}`,
    { kind: "screenshot", space: spaceArg(space), path, fullPage, pageLabel },
  );
}

export function buildHandoffScript({ space }) {
  return wrap(
    `const piEntry = await piEnterSpace();
if (piEntry.blocked) {
  PI_OUT({
    ok: true,
    handedOff: true,
    alreadyHandedOff: true,
    spaceId: piEntry.blocked.id,
    spaceName: piEntry.blocked.name,
    ownership: piEntry.blocked.ownership,
    tabs: [],
    pageLabel: null,
    url: null,
    title: "",
  });
} else {
  const piTask = piEntry.task;
  const piTab = await piActiveTab(piTask);
  const piInfo = piTab ? await piInfoOf(await piPageForTab(piTask, piTab)) : { pageLabel: null, url: null, title: "" };
  const piReport = await piSpaceReport(piTask);
  await piTask.handOff();
  PI_OUT({ ok: true, handedOff: true, ...piReport, ownership: "agentDelegatedToUser", ...piInfo });
}`,
    { kind: "handoff", space: spaceArg(space) },
  );
}

export function buildResumeScript({ space }) {
  return wrap(
    `const piSpaces = await listTaskSpaces();
const piWanted = PI_CMD.space && PI_CMD.space.id != null ? piSpaces.find((entry) => entry.id === PI_CMD.space.id) : undefined;
if (!piWanted) {
  PI_ERR("SPACE_GONE", "This Pi session's Ego task space is gone (the browser or the state folder was cleaned up). Call browser_open to open a page and create a new task space.");
} else {
  const piTask =
    piWanted.ownership === "agent"
      ? await taskSpace(piWanted.id)
      : piWanted.ownership === "user"
        ? await claimTaskSpace(piWanted.id)
        : await takeOverTaskSpace(piWanted.id);
  const piTab = await piActiveTab(piTask);
  if (!piTab) {
    PI_ERR("PAGES_CLOSED", "The user closed every tab of this task space. Call browser_open to reopen the pages you need.", await piSpaceReport(piTask));
  } else {
    const piPage = await piPageForTab(piTask, piTab);
    const piSnapshotText = await piPage.snapshot({});
    const piInfo = await piInfoOf(piPage);
    PI_OUT({ ok: true, resumedFrom: piWanted.ownership, ...(await piSpaceReport(piTask)), ...piInfo, snapshot: piSnapshotText });
  }
}`,
    { kind: "resume", space: spaceArg(space) },
  );
}
