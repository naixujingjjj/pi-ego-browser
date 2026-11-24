// Minimal ZIP reader for unpacking the pinned Chrome for Testing archive.
// Written in-tree on purpose: the extension must unpack a browser without
// spawning `Expand-Archive` or `tar`, so a plain zlib inflate over the archive's
// central directory is the smallest dependency-free path.
import { closeSync, mkdirSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const MAX_COMMENT = 0xffff;

function readAt(fd, position, length) {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const chunk = readSync(fd, buffer, read, length - read, position + read);
    if (chunk <= 0) break;
    read += chunk;
  }
  return buffer.subarray(0, read);
}

function findEndOfCentralDirectory(fd, fileSize) {
  const tailLength = Math.min(fileSize, MAX_COMMENT + 22);
  const tailStart = fileSize - tailLength;
  const tail = readAt(fd, tailStart, tailLength);
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD_SIGNATURE) {
      return { record: tail.subarray(index, index + 22), position: tailStart + index };
    }
  }
  throw new Error("not a zip archive: end of central directory not found");
}

/** Apply the 0x0001 zip64 extra field to fields saturated in the fixed header. */
function applyZip64(extra, entry) {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    const body = extra.subarray(offset + 4, offset + 4 + size);
    if (id === 0x0001) {
      let cursor = 0;
      if (entry.uncompressedSize === 0xffffffff && body.length >= cursor + 8) {
        entry.uncompressedSize = Number(body.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (entry.compressedSize === 0xffffffff && body.length >= cursor + 8) {
        entry.compressedSize = Number(body.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (entry.localHeaderOffset === 0xffffffff && body.length >= cursor + 8) {
        entry.localHeaderOffset = Number(body.readBigUInt64LE(cursor));
      }
      return;
    }
    offset += 4 + size;
  }
}

/** Every entry of the archive: `{ name, method, compressedSize, ... }`. */
export function readZipEntries(filePath) {
  const fileSize = statSync(filePath).size;
  const fd = openSync(filePath, "r");
  try {
    const { record: eocd, position: eocdPosition } = findEndOfCentralDirectory(fd, fileSize);
    let entryCount = eocd.readUInt16LE(10);
    let centralOffset = eocd.readUInt32LE(16);
    if (entryCount === 0xffff || centralOffset === 0xffffffff) {
      const locator = readAt(fd, eocdPosition - 20, 20);
      if (locator.length === 20 && locator.readUInt32LE(0) === ZIP64_LOCATOR_SIGNATURE) {
        const zip64Offset = Number(locator.readBigUInt64LE(8));
        const zip64 = readAt(fd, zip64Offset, 56);
        if (zip64.length >= 56 && zip64.readUInt32LE(0) === ZIP64_EOCD_SIGNATURE) {
          entryCount = Number(zip64.readBigUInt64LE(32));
          centralOffset = Number(zip64.readBigUInt64LE(48));
        }
      }
    }
    if (!Number.isFinite(centralOffset) || centralOffset <= 0) {
      throw new Error("corrupt zip: central directory offset missing");
    }
    const entries = [];
    let cursor = centralOffset;
    for (let index = 0; index < entryCount; index += 1) {
      const header = readAt(fd, cursor, 46);
      if (header.length < 46 || header.readUInt32LE(0) !== CENTRAL_SIGNATURE) {
        throw new Error(`corrupt zip central directory at entry ${index}`);
      }
      const nameLength = header.readUInt16LE(28);
      const extraLength = header.readUInt16LE(30);
      const commentLength = header.readUInt16LE(32);
      const name = readAt(fd, cursor + 46, nameLength).toString("utf8");
      const extra = readAt(fd, cursor + 46 + nameLength, extraLength);
      const entry = {
        name,
        method: header.readUInt16LE(10),
        compressedSize: header.readUInt32LE(20),
        uncompressedSize: header.readUInt32LE(24),
        localHeaderOffset: header.readUInt32LE(42),
      };
      applyZip64(extra, entry);
      entries.push(entry);
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

function localDataOffset(fd, entry) {
  const header = readAt(fd, entry.localHeaderOffset, 30);
  if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new Error(`corrupt zip local header for ${entry.name}`);
  }
  return entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
}

/** Extract every entry under `destination`; returns the written file names. */
export function extractZip(filePath, destination) {
  const entries = readZipEntries(filePath);
  mkdirSync(destination, { recursive: true });
  const fd = openSync(filePath, "r");
  const written = [];
  try {
    for (const entry of entries) {
      const target = join(destination, entry.name);
      if (entry.name.endsWith("/") || entry.name.endsWith("\\")) {
        mkdirSync(target, { recursive: true });
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      const compressed = readAt(fd, localDataOffset(fd, entry), entry.compressedSize);
      let data;
      if (entry.method === 0) {
        data = compressed;
      } else if (entry.method === 8) {
        data = inflateRawSync(compressed);
      } else {
        throw new Error(`unsupported zip compression method ${entry.method} for ${entry.name}`);
      }
      if (entry.uncompressedSize && data.length !== entry.uncompressedSize) {
        throw new Error(
          `zip entry ${entry.name} inflated to ${data.length} bytes, expected ${entry.uncompressedSize}`,
        );
      }
      const out = openSync(target, "w");
      try {
        let offset = 0;
        while (offset < data.length) {
          offset += writeSync(out, data, offset, data.length - offset);
        }
      } finally {
        closeSync(out);
      }
      written.push(entry.name);
    }
  } finally {
    closeSync(fd);
  }
  return written;
}