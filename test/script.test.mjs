import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildClickScript,
  buildFillScript,
  buildHandoffScript,
  buildOpenScript,
  buildReadScript,
  buildResumeScript,
  buildScreenshotScript,
  buildTabsScript,
} from "../src/script.js";
import { createRuntimeStub, runEgoScript } from "./helpers.mjs";

const SPACE = { id: 3, name: "pi-ego-browser session1" };
const TABS = [{ label: "p1", title: "Fixture Home", url: "http://127.0.0.1:9/", targetId: "t1", active: true }];

test("a generated script emits exactly one result line", async () => {
  const stub = createRuntimeStub({ spaces: [SPACE], tabs: [], snapshot: "" });
  const { results } = await runEgoScript(buildReadScript({ space: SPACE }), stub.globals);
  assert.equal(results.length, 1, "no double result lines");
  assert.equal(results[0].ok, false);
  assert.equal(results[0].code, "NO_PAGE");
  assert.ok(results[0].tabs, "the failure still reports the space");
});

test("open creates the session space by name on first use and reports the page", async () => {
  const stub = createRuntimeStub({ spaces: [], tabs: [] });
  const script = buildOpenScript({ space: { id: null, name: "pi-ego-browser fresh" }, url: "http://127.0.0.1:9/" });
  const { results } = await runEgoScript(script, stub.globals);
  assert.equal(results.length, 1);
  const [result] = results;
  assert.equal(result.ok, true);
  assert.equal(result.spaceId, 1);
  assert.equal(result.pageLabel, "p1");
  assert.equal(result.url, "http://127.0.0.1:9/");
  const goto = stub.calls.find((call) => call.op === "goto");
  assert.equal(goto.url, "http://127.0.0.1:9/");
});

test("open navigates an existing tab instead of opening a new one", async () => {
  const stub = createRuntimeStub({ spaces: [SPACE], tabs: TABS });
  const { results } = await runEgoScript(buildOpenScript({ space: SPACE, url: "http://127.0.0.1:9/form.html" }), stub.globals);
  assert.equal(results[0].ok, true);
  assert.equal(stub.state.tabs.length, 1, "still one tab");
  assert.equal(stub.state.tabs[0].url, "http://127.0.0.1:9/form.html");
});

test("a first new-tab request uses its task's starter tab and leaves existing blank tabs alone", async () => {
  const starter = { ...TABS[0], url: "about:blank", title: "" };
  const url = "http://127.0.0.1:9/form.html";
  const fresh = createRuntimeStub({ spaces: [], tabs: [{ ...starter }] });
  const created = await runEgoScript(
    buildTabsScript({ space: { id: null, name: "fresh task" }, action: "new", url }),
    fresh.globals,
  );
  assert.equal(created.results[0].ok, true);
  assert.equal(fresh.state.tabs.length, 1);
  assert.equal(fresh.state.tabs[0].url, url);

  const previous = createRuntimeStub({ spaces: [SPACE], tabs: [{ ...starter }] });
  const next = await runEgoScript(
    buildTabsScript({ space: { id: null, name: SPACE.name }, action: "new", url }),
    previous.globals,
  );
  assert.equal(next.results[0].ok, true);
  assert.equal(previous.state.tabs.length, 2);
  assert.equal(previous.state.tabs[0].url, "about:blank");
});

test("read returns the snapshot for the active tab and can target a label", async () => {
  const tabs = [
    { label: "p1", title: "One", url: "http://a/", targetId: "t1", active: false },
    { label: "p2", title: "Two", url: "http://b/", targetId: "t2", active: true },
  ];
  const stub = createRuntimeStub({ spaces: [SPACE], tabs, snapshot: "- button \"Save\" [@11]" });
  const active = await runEgoScript(buildReadScript({ space: SPACE }), stub.globals);
  assert.equal(active.results[0].ok, true);
  assert.equal(active.results[0].pageLabel, "p2");
  assert.match(active.results[0].snapshot, /\[@11\]/);

  const labelled = await runEgoScript(buildReadScript({ space: SPACE, pageLabel: "p1" }), stub.globals);
  assert.equal(labelled.results[0].pageLabel, "p1");

  const missing = await runEgoScript(buildReadScript({ space: SPACE, pageLabel: "p9" }), stub.globals);
  assert.equal(missing.results.length, 1);
  assert.equal(missing.results[0].code, "NO_SUCH_PAGE");
  assert.equal(missing.results[0].tabs.length, 2);
});

test("click refuses to act when the numbering came from another page state", async () => {
  const stub = createRuntimeStub({ spaces: [SPACE], tabs: TABS });
  const { results } = await runEgoScript(
    buildClickScript({
      space: SPACE,
      selector: "@21",
      expect: { pageLabel: "p1", url: "http://127.0.0.1:9/other" },
    }),
    stub.globals,
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].code, "STALE_PAGE");
  assert.equal(stub.calls.some((call) => call.op === "click"), false, "no click was dispatched");
});

test("click dispatches the Ego ref and reports navigation", async () => {
  const tabs = [{ label: "p1", title: "One", url: "http://a/", targetId: "t1", active: true }];
  const stub = createRuntimeStub({
    spaces: [SPACE],
    tabs,
    behavior: {
      click: ({ tab }) => {
        tab.url = "http://a/after";
        tab.title = "After";
        return { popups: [{ label: "p2", targetId: "t9" }] };
      },
    },
  });
  const { results } = await runEgoScript(
    buildClickScript({ space: SPACE, selector: "@21", expect: { pageLabel: "p1", url: "http://a/" } }),
    stub.globals,
  );
  assert.equal(results[0].ok, true);
  assert.equal(results[0].navigated, true);
  assert.equal(results[0].url, "http://a/after");
  assert.deepEqual(results[0].receipt, { popups: [{ label: "p2", targetId: "t9" }] });
  assert.equal(stub.calls.filter((call) => call.op === "click")[0].selector, "@21");
});

test("a click failure reports the current page state and whether effects may be late", async () => {
  const stub = createRuntimeStub({
    spaces: [SPACE],
    tabs: TABS,
    behavior: {
      click: () => {
        const error = new Error("element not found");
        error.error_code = "EGO_ELEMENT_NOT_FOUND";
        throw error;
      },
    },
  });
  const { results } = await runEgoScript(buildClickScript({ space: SPACE, selector: "@21" }), stub.globals);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].code, "EGO_ELEMENT_NOT_FOUND");
  assert.equal(results[0].url, "http://127.0.0.1:9/");
  assert.equal(results[0].mayHaveLateEffects, false);
});

test("fill sends the text to the resolved element", async () => {
  const stub = createRuntimeStub({ spaces: [SPACE], tabs: TABS });
  const { results } = await runEgoScript(buildFillScript({ space: SPACE, selector: "@51", text: "张三" }), stub.globals);
  assert.equal(results[0].ok, true);
  const fill = stub.calls.find((call) => call.op === "fill");
  assert.equal(fill.selector, "@51");
  assert.equal(fill.text, "张三");
});

test("tabs list/new/switch/close behave on the session space", async () => {
  const tabs = [{ label: "p1", title: "One", url: "http://a/", targetId: "t1", active: true }];
  const stub = createRuntimeStub({ spaces: [SPACE], tabs });
  const listed = await runEgoScript(buildTabsScript({ space: SPACE, action: "list" }), stub.globals);
  assert.equal(listed.results[0].ok, true);
  assert.deepEqual(listed.results[0].labels, ["p1"]);
  assert.equal(listed.results[0].tabs[0].active, true);

  const created = await runEgoScript(buildTabsScript({ space: SPACE, action: "new", url: "http://b/" }), stub.globals);
  assert.equal(created.results[0].created, true);
  assert.equal(created.results[0].pageLabel, "p2");

  const switched = await runEgoScript(buildTabsScript({ space: SPACE, action: "switch", pageLabel: "p1" }), stub.globals);
  assert.equal(switched.results[0].activated, true);
  assert.equal(switched.results[0].pageLabel, "p1");
  assert.equal(stub.calls.some((call) => call.op === "cdp" && call.method === "Target.activateTarget"), true);

  const missing = await runEgoScript(buildTabsScript({ space: SPACE, action: "switch", pageLabel: "p7" }), stub.globals);
  assert.equal(missing.results[0].code, "NO_SUCH_TAB");

  const closed = await runEgoScript(buildTabsScript({ space: SPACE, action: "close", pageLabel: "p2" }), stub.globals);
  assert.equal(closed.results[0].closed, "p2");
  assert.equal(stub.calls.some((call) => call.op === "close" && call.label === "p2"), true);
});

test("screenshot asks for an absolute path and reports it back", async () => {
  const stub = createRuntimeStub({ spaces: [SPACE], tabs: TABS });
  const path = "F:/tmp/pi-ego-test/shot.png";
  const { results } = await runEgoScript(buildScreenshotScript({ space: SPACE, path }), stub.globals);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].path, path);
  assert.equal(stub.calls.find((call) => call.op === "screenshot").options.path, path);
});

test("handoff hands the space to the user and reports visibility", async () => {
  const stub = createRuntimeStub({ spaces: [SPACE], tabs: TABS });
  const { results } = await runEgoScript(buildHandoffScript({ space: SPACE }), stub.globals);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].handedOff, true);
  assert.equal(results[0].pageLabel, "p1");
  assert.equal(stub.state.spaces[0].ownership, "agentDelegatedToUser");
});

test("resume picks the right entry point for each ownership state", async () => {
  const delegated = createRuntimeStub({ spaces: [{ ...SPACE, ownership: "agentDelegatedToUser" }], tabs: TABS, snapshot: "- button \"Save\" [@5]" });
  const resumed = await runEgoScript(buildResumeScript({ space: SPACE }), delegated.globals);
  assert.equal(resumed.results[0].ok, true);
  assert.equal(resumed.results[0].resumedFrom, "agentDelegatedToUser");
  assert.equal(delegated.state.spaces[0].ownership, "agent");

  const userOwned = createRuntimeStub({ spaces: [{ ...SPACE, ownership: "user" }], tabs: TABS, snapshot: "" });
  const claimed = await runEgoScript(buildResumeScript({ space: SPACE }), userOwned.globals);
  assert.equal(claimed.results[0].ok, true);
  assert.equal(claimed.results[0].resumedFrom, "user");

  const gone = createRuntimeStub({ spaces: [], tabs: [] });
  const missing = await runEgoScript(buildResumeScript({ space: SPACE }), gone.globals);
  assert.equal(missing.results[0].code, "SPACE_GONE");

  const closed = createRuntimeStub({ spaces: [SPACE], tabs: [] });
  const closedResult = await runEgoScript(buildResumeScript({ space: SPACE }), closed.globals);
  assert.equal(closedResult.results[0].code, "PAGES_CLOSED");
});
