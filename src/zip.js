// Dependency-free ZIP writer (STORED, no compression) for Cloudflare Workers.
// No Node builtins, no Buffer — everything below is Uint8Array/DataView/TextEncoder.
// Used by #8 (DOCX / bulk ZIP export): DOCX itself is just this zip() plus 3 XML files.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

// IEEE 802.3 CRC-32, table-driven. Returns an unsigned 32-bit number.
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Fixed deterministic DOS date/time: 1980-01-01 00:00:00 — keeps output byte-stable
// across runs instead of baking Date.now() into every export.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // year offset 0 (=1980), month=1, day=1

const ILLEGAL_WINDOWS_CHARS = /[<>:"|?*\x00-\x1f]/g;

const enc = new TextEncoder();
const byteLen = (str) => enc.encode(str).length;

// Cut `str` to at most `max` UTF-8 bytes on a code-point boundary (never mid-surrogate).
function truncateBytes(str, max) {
  let bytes = 0;
  let out = '';
  for (const ch of str) {
    const n = byteLen(ch);
    if (bytes + n > max) break;
    bytes += n;
    out += ch;
  }
  return out;
}

// base + ext fitted into the 255-byte ZIP name limit: the base shrinks, the extension stays.
function fit(base, ext, max = 255) {
  return truncateBytes(base, max - byteLen(ext)) + ext;
}

// Strip a leading '/', collapse '..' segments, swap characters illegal on Windows
// for '_'. Length is NOT limited here; fit() does that after collisions are resolved.
function sanitizeName(name) {
  let n = String(name ?? '').replace(/\\/g, '/');
  n = n.replace(/^\/+/, '');
  n = n
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.' && seg !== '..')
    .join('/');
  n = n.replace(ILLEGAL_WINDOWS_CHARS, '_');
  return n === '' ? '_' : n;
}

function splitExt(name) {
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && dot < name.length - 1 && name.length - dot <= 16;
  return hasExt ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

// Final entry name: fitted to 255 bytes, and unique ignoring case (macOS/Windows extract
// onto case-insensitive disks, where "Standup.docx" and "standup.docx" would overwrite each
// other). Collisions get " (2)", " (3)", ... before the extension, re-fitted each time.
function uniqueName(raw, used) {
  const [base, ext] = splitExt(sanitizeName(raw));
  let candidate = fit(base, ext);
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    // The " (n)" suffix is what makes the name unique, so it must survive the fit: shrink
    // the base, never the suffix (fitting `${base} (n)` as one string would cut the suffix
    // off a long name and loop forever).
    const suffix = ` (${n})`;
    candidate = fit(base, `${suffix}${ext}`);
  }
  return candidate;
}

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const VERSION_NEEDED = 20;
const GP_FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;

const MAX_ENTRIES = 65535;
const MAX_TOTAL_SIZE = 4 * 1024 * 1024 * 1024; // 4GB

// Build a STORED (uncompressed) zip from [{ name, data }]. `data` may be a
// Uint8Array or a string (UTF-8 encoded). Returns the zip file as a Uint8Array.
export function zip(entries) {
  if (!Array.isArray(entries)) throw new Error('zip() expects an array of entries');
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`zip() supports at most ${MAX_ENTRIES} entries, got ${entries.length}`);
  }

  const encoder = new TextEncoder();
  const used = new Set();
  const records = [];
  let totalSize = 0;

  for (const entry of entries) {
    const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    if (!(data instanceof Uint8Array)) {
      throw new Error(`zip() entry "${entry.name}" must have string or Uint8Array data`);
    }

    const name = uniqueName(entry.name, used);
    used.add(name.toLowerCase());

    totalSize += data.length;
    if (totalSize > MAX_TOTAL_SIZE) {
      throw new Error('zip() total uncompressed size exceeds the 4GB limit');
    }

    records.push({ name, nameBytes: encoder.encode(name), data, crc: crc32(data) });
  }

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const rec of records) {
    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, LOCAL_FILE_HEADER_SIG, true);
    localHeader.setUint16(4, VERSION_NEEDED, true);
    localHeader.setUint16(6, GP_FLAG_UTF8, true);
    localHeader.setUint16(8, METHOD_STORED, true);
    localHeader.setUint16(10, DOS_TIME, true);
    localHeader.setUint16(12, DOS_DATE, true);
    localHeader.setUint32(14, rec.crc, true);
    localHeader.setUint32(18, rec.data.length, true); // compressed size
    localHeader.setUint32(22, rec.data.length, true); // uncompressed size
    localHeader.setUint16(26, rec.nameBytes.length, true);
    localHeader.setUint16(28, 0, true); // extra field length

    const localHeaderBytes = new Uint8Array(localHeader.buffer);
    localParts.push(localHeaderBytes, rec.nameBytes, rec.data);

    const localOffset = offset;
    offset += localHeaderBytes.length + rec.nameBytes.length + rec.data.length;

    const centralHeader = new DataView(new ArrayBuffer(46));
    centralHeader.setUint32(0, CENTRAL_DIR_SIG, true);
    centralHeader.setUint16(4, VERSION_NEEDED, true); // version made by
    centralHeader.setUint16(6, VERSION_NEEDED, true); // version needed to extract
    centralHeader.setUint16(8, GP_FLAG_UTF8, true);
    centralHeader.setUint16(10, METHOD_STORED, true);
    centralHeader.setUint16(12, DOS_TIME, true);
    centralHeader.setUint16(14, DOS_DATE, true);
    centralHeader.setUint32(16, rec.crc, true);
    centralHeader.setUint32(20, rec.data.length, true); // compressed size
    centralHeader.setUint32(24, rec.data.length, true); // uncompressed size
    centralHeader.setUint16(28, rec.nameBytes.length, true);
    centralHeader.setUint16(30, 0, true); // extra field length
    centralHeader.setUint16(32, 0, true); // comment length
    centralHeader.setUint16(34, 0, true); // disk number start
    centralHeader.setUint16(36, 0, true); // internal file attributes
    centralHeader.setUint32(38, 0, true); // external file attributes
    centralHeader.setUint32(42, localOffset, true); // offset of local header

    centralParts.push(new Uint8Array(centralHeader.buffer), rec.nameBytes);
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const part of centralParts) centralDirSize += part.length;

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, EOCD_SIG, true);
  eocd.setUint16(4, 0, true); // disk number
  eocd.setUint16(6, 0, true); // disk with central dir
  eocd.setUint16(8, records.length, true); // entries on this disk
  eocd.setUint16(10, records.length, true); // total entries
  eocd.setUint32(12, centralDirSize, true);
  eocd.setUint32(16, centralDirOffset, true);
  eocd.setUint16(20, 0, true); // comment length

  const allParts = [...localParts, ...centralParts, new Uint8Array(eocd.buffer)];
  let total = 0;
  for (const part of allParts) total += part.length;

  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of allParts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}
