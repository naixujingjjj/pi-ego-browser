// Test helpers: a tiny zip writer, a fake Ego script sandbox, and temp dirs.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateRawSync } from "node:zlib";

/** Build a zip archive in memory. `entries` = [{ name, data, deflate? }]. */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const method = entry.deflate ? 8 : 0;
    const body = entry.deflate ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

/**
 * Run one generated Ego script against stubbed runtime globals.
 *
 * The generated script is plain JavaScript that talks to `taskSpace`,
 * `listTaskSpaces`, `takeOverTaskSpace` and `claimTaskSpace` plus whatever the
 * task/page stubs expose. This executes the real script text, so mistakes like
 * emitting two result lines surface as a test failure instead of a confusing
 * runtime error.
 */
export async function runEgoScript(script, globals = {}) {
  const results = [];
  const logs = [];
  const consoleStub = {
    log: (...args) => logs.push(args.join(" ")),
    error: (...args) => logs.push(args.join(" ")),
  };
  const names = Object.keys(globals);
  const factory = new Function(
    "console",
    ...names,
    `return (async () => {\n${script}\n})();`,
  );
  await factory(consoleStub, ...names.map((name) => globals[name]));
  for (const line of logs) {
    const at = line.indexOf("__PI_EGO_RESULT__");
    if (at !== -1) results.push(JSON.parse(line.slice(at + "__PI_EGO_RESULT__".length)));
  }
  return { results, logs };
}

export function tempDir(prefix = "pi-ego-test") {
  const dir = join(tmpdir(), `${prefix}-${process.pid}-${Math.floor(performance.now() * 1000)}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    write(name, data) {
      writeFileSync(join(dir, name), data);
      return join(dir, name);
    },
  };
}

/**
 * Stub for the Ego runtime globals, hitting nothing. `tabs` is an array of
 * `{ label, title, url, targetId, active, page }` entries; page stubs record
 * calls in `calls`.
 */
export function createRuntimeStub({ spaces = [], tabs = [], snapshot = "", behavior = {} } = {}) {
  const calls = [];
  const state = {
    spaces: spaces.map((space) => ({ ownership: "agent", ...space })),
    tabs: tabs.map((tab) => ({ ...tab })),
  };
  const pageStubs = new Map();
  for (const tab of state.tabs) {
    const page = {
      label: tab.label,
      targetId: tab.targetId,
      async url() {
        return tab.url;
      },
      async title() {
        return tab.title;
      },
      async snapshot(options = {}) {
        calls.push({ op: "snapshot", label: tab.label, options });
        return typeof snapshot === "function" ? snapshot(tab, options) : snapshot;
      },
      async screenshot(options = {}) {
        calls.push({ op: "screenshot", label: tab.label, options });
        return options.path;
      },
      async click(selector, options = {}) {
        calls.push({ op: "click", selector, options, label: tab.label });
        if (behavior.click) return behavior.click({ selector, options, tab, calls });
        return { popups: [] };
      },
      async fill(selector, text, options = {}) {
        calls.push({ op: "fill", selector, text, options, label: tab.label });
        if (behavior.fill) return behavior.fill({ selector, text, options, tab, calls });
        return null;
      },
      async close() {
        calls.push({ op: "close", label: tab.label });
      },
      async goto(url, options = {}) {
        calls.push({ op: "goto", url, options, label: tab.label });
        tab.url = url;
      },
    };
    pageStubs.set(tab.label, page);
    tab.page = page;
  }
  const findSpace = (id) => state.spaces.find((space) => space.id === id);
  const stubTask = (space) => ({
    spaceId: space.id,
    name: space.name,
    ownership: space.ownership,
    page(label) {
      return pageStubs.get(label) || pageStubs.values().next().value;
    },
    async pages() {
      return [...pageStubs.values()];
    },
    async tabs() {
      return state.tabs.map((tab) => ({
        label: tab.label,
        page: tab.page,
        targetId: tab.targetId,
        title: tab.title,
        url: tab.url,
        active: Boolean(tab.active),
        openedBy: "agent",
      }));
    },
    async adopt(page) {
      if (!page.label) page.label = `p${state.tabs.length + 1}`;
      pageStubs.set(page.label, page);
      return page;
    },
    async newPage() {
      const label = `p${state.tabs.length + 1}`;
      const tab = { label, title: "", url: "about:blank", targetId: `target-${label}`, active: true, page: null };
      for (const other of state.tabs) other.active = false;
      const fake = {
        label,
        targetId: tab.targetId,
        async url() {
          return tab.url;
        },
        async title() {
          return tab.title;
        },
        async snapshot() {
          return snapshot;
        },
        async screenshot(options = {}) {
          calls.push({ op: "screenshot", label, options });
          return options.path;
        },
        async click(selector, options = {}) {
          calls.push({ op: "click", selector, options, label });
          return {};
        },
        async fill(selector, text) {
          calls.push({ op: "fill", selector, text, label });
          return null;
        },
        async close() {
          calls.push({ op: "close", label });
        },
        async goto(url) {
          calls.push({ op: "goto", url, label });
          tab.url = url;
        },
      };
      tab.page = fake;
      pageStubs.set(label, fake);
      state.tabs.push(tab);
      return fake;
    },
    async cdp(method, params = {}) {
      calls.push({ op: "cdp", method, params });
      if (method === "Target.activateTarget") {
        for (const tab of state.tabs) tab.active = tab.targetId === params.targetId;
      }
    },
    async handOff() {
      calls.push({ op: "handOff" });
      space.ownership = "agentDelegatedToUser";
      return { visible: true };
    },
  });
  const globals = {
    listTaskSpaces: async () => state.spaces.map((space) => ({ ...space })),
    taskSpace: async (key) => {
      const space =
        typeof key === "number"
          ? findSpace(key)
          : state.spaces.find((entry) => entry.name === key) ||
            (() => {
              const created = { id: state.spaces.length + 1, name: key, ownership: "agent" };
              state.spaces.push(created);
              return created;
            })();
      if (!space) throw new Error(`task space not found: ${key}`);
      return stubTask(space);
    },
    takeOverTaskSpace: async (id) => {
      const space = findSpace(id);
      if (!space) throw new Error(`task space not found: ${id}`);
      space.ownership = "agent";
      return stubTask(space);
    },
    claimTaskSpace: async (id) => {
      const space = findSpace(id);
      if (!space) throw new Error(`task space not found: ${id}`);
      space.ownership = "agent";
      return stubTask(space);
    },
  };
  return { globals, calls, state, pageStubs };
}