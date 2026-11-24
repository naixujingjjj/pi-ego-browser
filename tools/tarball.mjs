// Reads an npm tarball (gzip + tar) in-process, so packaging can be checked
// without spawning `tar` — the sandbox this extension is developed in refuses
// child processes, and the check itself should not need one.
import { gunzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function parsePax(body) {
  const out = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(body.subarray(offset, space).toString("utf8"));
    if (!Number.isFinite(length) || length <= 0) break;
    const record = body.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) out[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return out;
}

function nullTerminated(buffer, length) {
  const end = buffer.subarray(0, length).indexOf(0);
  return buffer.subarray(0, end === -1 ? length : end).toString("utf8");
}

/** Every entry of the tarball: `{ name, size, mode, type }`. */
export function readTarball(filePath) {
  const raw = gunzipSync(readFileSync(filePath));
  const entries = [];
  let offset = 0;
  let pax = null;
  let longName = null;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const storedName = nullTerminated(header, 100);
    const sizeField = nullTerminated(header.subarray(124, 136), 12).trim();
    const size = Number.parseInt(sizeField || "0", 8) || 0;
    const mode = Number.parseInt(nullTerminated(header.subarray(100, 108), 8).trim() || "0", 8) || 0;
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = nullTerminated(header.subarray(345, 500), 155);
    const body = raw.subarray(offset + 512, offset + 512 + size);
    let name = storedName;
    if (type === "L") {
      longName = nullTerminated(body, size);
    } else if (type === "x") {
      pax = parsePax(body);
    } else if (type === "g") {
      parsePax(body);
    } else {
      if (pax?.path) name = pax.path;
      else if (longName) name = longName;
      else if (prefix) name = `${prefix}/${name}`;
      entries.push({ name, size, mode, type, data: type === "0" || type === "" ? body : null });
      pax = null;
      longName = null;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return { entries, bytes: raw.length };
}

/** Unpack a tarball to `destination` (test scaffold, not used at runtime). */
export function extractTarball(filePath, destination) {
  const { entries } = readTarball(filePath);
  const written = [];
  for (const entry of entries) {
    const target = join(destination, entry.name);
    if (entry.type === "5" || entry.name.endsWith("/")) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    if (!entry.data) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
    written.push(entry.name);
  }
  return written;
}

export function summarizeTarball(filePath) {
  const { entries } = readTarball(filePath);
  const files = entries.filter((entry) => entry.type === "0" || entry.type === "7" || entry.type === "");
  const total = files.reduce((sum, entry) => sum + entry.size, 0);
  return { entries, files, totalBytes: total };
}