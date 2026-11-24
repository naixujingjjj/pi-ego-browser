import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAttachmentsCommand, parsePathArgument, parseSettingsCommand } from "../src/command.js";

test("the settings action word is split off and the rest stays as typed", async () => {
  assert.deepEqual(parseSettingsCommand(""), { action: "status", arg: "" });
  assert.deepEqual(parseSettingsCommand("   "), { action: "status", arg: "" });
  assert.deepEqual(parseSettingsCommand("RESUME"), { action: "resume", arg: "" });
  assert.deepEqual(parseSettingsCommand("  attachments   set  F:\\a b  "), { action: "attachments", arg: "set  F:\\a b" });
  assert.deepEqual(parseSettingsCommand("attachments"), { action: "attachments", arg: "" });
});

test("a quoted path is unwrapped and an unquoted path keeps its spaces", async () => {
  assert.equal(parsePathArgument('"F:\\截图 与 素材\\shots"'), "F:\\截图 与 素材\\shots");
  assert.equal(parsePathArgument("'E:\\with spaces\\ego'"), "E:\\with spaces\\ego");
  assert.equal(parsePathArgument("F:\\with spaces\\ego"), "F:\\with spaces\\ego");
  assert.equal(parsePathArgument('  "E:\\trailing"  '), "E:\\trailing");
  assert.equal(parsePathArgument('"unbalanced'), '"unbalanced');
  assert.equal(parsePathArgument(""), "");
  assert.equal(parsePathArgument('""'), "");
});

test("attachment sub-commands parse with their argument", async () => {
  assert.deepEqual(parseAttachmentsCommand(""), { action: "list", arg: "" });
  assert.deepEqual(parseAttachmentsCommand("set \"E:\\a b\""), { action: "set", arg: "\"E:\\a b\"" });
  assert.deepEqual(parseAttachmentsCommand("open  abc123"), { action: "open", arg: "abc123" });
  assert.equal(parsePathArgument(parseAttachmentsCommand("set E:\\no  quotes").arg), "E:\\no  quotes");
});