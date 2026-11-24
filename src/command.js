// Parsing for the `/ego-settings` command line.
//
// The command has one entry point: `/ego-settings` opens the settings menu in
// Pi's interactive terminal, and the same command takes a small action word
// where no TUI exists (RPC, a headless host):
//
//   /ego-settings [status | info]
//   /ego-settings resume
//   /ego-settings attachments [list | set <path> | reset | open <ID>]
//
// `/ego-settings attachments set <absolute path>` must accept quoted paths and
// unquoted paths with spaces, because a real Windows directory is often
// `E:\截图 与 素材\browser shots`. Only the action word is split off; the rest of
// the line is the argument as typed.
const ACTION = /^(\S+)\s*([\s\S]*)$/;

export function parseSettingsCommand(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { action: "status", arg: "" };
  const match = ACTION.exec(raw);
  return { action: match[1].toLowerCase(), arg: (match[2] || "").trim() };
}

/**
 * A path argument: a matching pair of quotes is stripped, otherwise the whole
 * remainder is the path. An empty value returns "" so the caller can explain.
 */
export function parsePathArgument(text) {
  const value = String(text ?? "").trim();
  if (!value) return "";
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.lastIndexOf(quote) > 0) {
    return value.slice(1, value.lastIndexOf(quote)).trim();
  }
  return value;
}

/** Sub-command of `/ego-settings attachments`: "list" when nothing was given. */
export function parseAttachmentsCommand(arg) {
  const raw = String(arg ?? "").trim();
  if (!raw) return { action: "list", arg: "" };
  const match = ACTION.exec(raw);
  return { action: match[1].toLowerCase(), arg: (match[2] || "").trim() };
}