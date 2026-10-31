import { inflateRawSync } from "node:zlib";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Build-time check: the companion builder emits a small, fixed ZIP. Reject other shapes rather
// than distributing a mismatched or incomplete extension as the current one.
export function validateCompanionZip(bytes, expected) {
  const invalid = () => { throw new Error("The bundled SP extension ZIP is invalid or does not match its metadata."); };
  if (!Buffer.isBuffer(bytes) || bytes.length < 22) invalid();
  const end = bytes.length - 22;
  if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 4) !== 0 ||
      bytes.readUInt16LE(end + 6) !== 0 || bytes.readUInt16LE(end + 8) !== 3 ||
      bytes.readUInt16LE(end + 10) !== 3 || bytes.readUInt16LE(end + 20) !== 0) invalid();
  const directorySize = bytes.readUInt32LE(end + 12), directoryStart = bytes.readUInt32LE(end + 16);
  if (directoryStart + directorySize !== end) invalid();
  const files = new Map();
  let cursor = directoryStart, localCursor = 0, totalSize = 0;
  for (let index = 0; index < 3; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) invalid();
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16), packedSize = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28), extraSize = bytes.readUInt16LE(cursor + 30), commentSize = bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42), next = cursor + 46 + nameSize + extraSize + commentSize;
    if (next > end || flags !== 0 && flags !== 0x800 || ![0, 8].includes(method) || bytes.readUInt16LE(cursor + 34) !== 0 ||
        offset !== localCursor || offset + 30 > directoryStart || size > 1024 * 1024) invalid();
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameSize).toString("utf8");
    if (!["manifest.json", "plugin.js", "README.md"].includes(name) || files.has(name)) invalid();
    if (bytes.readUInt32LE(offset) !== 0x04034b50 || bytes.readUInt16LE(offset + 6) !== flags ||
        bytes.readUInt16LE(offset + 8) !== method || bytes.readUInt32LE(offset + 14) !== crc ||
        bytes.readUInt32LE(offset + 18) !== packedSize || bytes.readUInt32LE(offset + 22) !== size ||
        bytes.readUInt16LE(offset + 26) !== nameSize) invalid();
    const localExtra = bytes.readUInt16LE(offset + 28), dataStart = offset + 30 + nameSize + localExtra;
    if (dataStart + packedSize > directoryStart ||
        !bytes.subarray(offset + 30, offset + 30 + nameSize).equals(bytes.subarray(cursor + 46, cursor + 46 + nameSize))) invalid();
    const packed = bytes.subarray(dataStart, dataStart + packedSize);
    const content = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, size) });
    totalSize += content.length;
    if (content.length !== size || crc32(content) !== crc || totalSize > 2 * 1024 * 1024) invalid();
    files.set(name, content);
    localCursor = dataStart + packedSize;
    cursor = next;
  }
  if (cursor !== end || localCursor !== directoryStart || !files.get("plugin.js")?.length) invalid();
  const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  if (manifest.id !== expected.id || manifest.version !== expected.version || manifest.minSupVersion !== expected.minSpVersion || manifest.manifestVersion !== 1) invalid();
  return manifest;
}
