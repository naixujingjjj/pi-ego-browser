// Resolve attachment references in a separate process.
//
// The acceptance suite uses this to prove that a reference written by one Pi
// process (its ID, root ID and registry entry) still locates the right file in a
// new process, without any in-memory state. It imports the sources of the
// package under test, not the working checkout.
//
// Usage:
//   node tools/attachment-probe.mjs --package <package dir> --root <PI_EGO_HOME> --refs <json array>
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? null : args[at + 1];
};

const packageDir = resolve(option("package") || ".");
const root = option("root");
const refs = JSON.parse(option("refs") || "[]");

if (!root) {
  console.error("usage: attachment-probe.mjs --package <dir> --root <PI_EGO_HOME> --refs <json array>");
  process.exit(2);
}

const { resolvePaths } = await import(pathToFileURL(join(packageDir, "src", "paths.js")).href);
const { AttachmentLibrary } = await import(pathToFileURL(join(packageDir, "src", "attachments.js")).href);

const library = new AttachmentLibrary(resolvePaths({ PI_EGO_HOME: root }));
const results = refs.map((ref) => {
  // Verification reads the digest in chunks, so a large original is never held
  // in memory just to be checked by a new process.
  const verified = library.verify(ref);
  return {
    id: ref?.id ?? null,
    ok: Boolean(verified.ok),
    code: verified.code ?? null,
    path: verified.path ?? null,
    bytes: verified.bytes ?? 0,
    message: verified.ok ? null : verified.message,
  };
});

process.stdout.write(`${JSON.stringify({ pid: process.pid, root, results })}\n`);