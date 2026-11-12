// WebM/Opus (what the browser recorder and the pendant app produce): parse the packets, cut and
// join them, and write a fresh seekable file. Lossless -- Opus packets are copied, never re-encoded.
// Supports one Opus track, no lacing (every MediaRecorder / pendant file is like that).

const ID = {
  EBML: 0x1A45DFA3, SEGMENT: 0x18538067, INFO: 0x1549A966, TRACKS: 0x1654AE6B, CLUSTER: 0x1F43B675,
  CUES: 0x1C53BB6B, SEEKHEAD: 0x114D9B74, TAGS: 0x1254C367, CHAPTERS: 0x1043A770, ATTACH: 0x1941A469,
  TIMECODE_SCALE: 0x2AD7B1, DURATION: 0x4489, TRACK_ENTRY: 0xAE, TRACK_NUMBER: 0xD7, CODEC_ID: 0x86,
  CODEC_PRIVATE: 0x63A2, CODEC_DELAY: 0x56AA, SEEK_PRE_ROLL: 0x56BB, AUDIO: 0xE1, SAMPLE_RATE: 0xB5,
  CHANNELS: 0x9F, CLUSTER_TIME: 0xE7, SIMPLE_BLOCK: 0xA3, BLOCK_GROUP: 0xA0, BLOCK: 0xA1,
};
const TOP_LEVEL = new Set([ID.CLUSTER, ID.CUES, ID.SEEKHEAD, ID.TAGS, ID.CHAPTERS, ID.ATTACH, ID.INFO, ID.TRACKS]);

export const isWebm = (b) => b.length > 4 && b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3;

// Element id (marker bits kept) and size (marker removed; -1 = unknown) at offset o.
function readId(b, o) {
  const first = b[o];
  if (first === undefined || first === 0) return null;
  const n = Math.clz32(first) - 24 + 1;
  if (n > 4 || o + n > b.length) return null;
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[o + i];
  return { id: v, len: n };
}
function readSize(b, o) {
  const first = b[o];
  if (first === undefined || first === 0) return null;
  const n = Math.clz32(first) - 24 + 1;
  if (o + n > b.length) return null;
  let v = first & (0xFF >> n), allOnes = v === (0xFF >> n);
  for (let i = 1; i < n; i++) { v = v * 256 + b[o + i]; if (b[o + i] !== 0xFF) allOnes = false; }
  return { size: allOnes ? -1 : v, len: n };
}
const uintOf = (b, s, e) => { let v = 0; for (let i = s; i < e; i++) v = v * 256 + b[i]; return v; };
const floatOf = (b, s, e) => {
  const dv = new DataView(b.buffer, b.byteOffset + s, e - s);
  return e - s === 4 ? dv.getFloat32(0) : e - s === 8 ? dv.getFloat64(0) : 0;
};

// One child element at o inside [.., end): {id, dataStart, dataEnd, next}; dataEnd = end for an unknown size.
function child(b, o, end) {
  const id = readId(b, o); if (!id) return null;
  const sz = readSize(b, o + id.len); if (!sz) return null;
  const dataStart = o + id.len + sz.len;
  const dataEnd = sz.size < 0 ? end : Math.min(end, dataStart + sz.size);
  return { id: id.id, dataStart, dataEnd, unknown: sz.size < 0, next: dataEnd };
}

// Opus packet duration in ms from its TOC byte (RFC 6716 section 3.1).
export function opusPacketMs(p) {
  if (!p.length) return 0;
  const toc = p[0], cfg = toc >> 3, c = toc & 3;
  const size = cfg < 12 ? [10, 20, 40, 60][cfg & 3] : cfg < 16 ? [10, 20][cfg & 1] : [2.5, 5, 10, 20][cfg & 3];
  const frames = c === 0 ? 1 : c === 3 ? (p[1] ?? 1) & 0x3F : 2;
  return size * frames;
}

// -> {track, packets: [{t, dur, data}], durationMs} or null when it is not a single-track Opus WebM
export function parseWebm(b) {
  if (!isWebm(b)) return null;
  let o = 0;
  const head = child(b, 0, b.length); if (!head) return null;
  o = head.next;
  const seg = child(b, o, b.length);
  if (!seg || seg.id !== ID.SEGMENT) return null;

  let scale = 1_000_000, track = null;
  const packets = [];
  let p = seg.dataStart;
  while (p < seg.dataEnd) {
    const e = child(b, p, seg.dataEnd); if (!e) break;
    if (e.id === ID.INFO) {
      for (let q = e.dataStart; q < e.dataEnd;) {
        const c = child(b, q, e.dataEnd); if (!c) break;
        if (c.id === ID.TIMECODE_SCALE) scale = uintOf(b, c.dataStart, c.dataEnd) || scale;
        q = c.next;
      }
    } else if (e.id === ID.TRACKS) {
      for (let q = e.dataStart; q < e.dataEnd;) {
        const te = child(b, q, e.dataEnd); if (!te) break;
        if (te.id === ID.TRACK_ENTRY) {
          const t = { number: 1, codec: '', codecPrivate: null, codecDelay: 0, seekPreRoll: 0, rate: 48000, channels: 1 };
          for (let r = te.dataStart; r < te.dataEnd;) {
            const f = child(b, r, te.dataEnd); if (!f) break;
            if (f.id === ID.TRACK_NUMBER) t.number = uintOf(b, f.dataStart, f.dataEnd);
            else if (f.id === ID.CODEC_ID) t.codec = String.fromCharCode(...b.subarray(f.dataStart, f.dataEnd));
            else if (f.id === ID.CODEC_PRIVATE) t.codecPrivate = b.subarray(f.dataStart, f.dataEnd);
            else if (f.id === ID.CODEC_DELAY) t.codecDelay = uintOf(b, f.dataStart, f.dataEnd);
            else if (f.id === ID.SEEK_PRE_ROLL) t.seekPreRoll = uintOf(b, f.dataStart, f.dataEnd);
            else if (f.id === ID.AUDIO) {
              for (let s = f.dataStart; s < f.dataEnd;) {
                const a = child(b, s, f.dataEnd); if (!a) break;
                if (a.id === ID.SAMPLE_RATE) t.rate = floatOf(b, a.dataStart, a.dataEnd) || t.rate;
                else if (a.id === ID.CHANNELS) t.channels = uintOf(b, a.dataStart, a.dataEnd) || 1;
                s = a.next;
              }
            }
            r = f.next;
          }
          if (t.codec === 'A_OPUS' && !track) track = t;
        }
        q = te.next;
      }
    } else if (e.id === ID.CLUSTER) {
      let clusterT = 0, q = e.dataStart, end = e.dataEnd;
      while (q < end) {
        const c = child(b, q, end);
        if (!c || (e.unknown && TOP_LEVEL.has(c.id))) { end = q; break; }
        if (c.id === ID.CLUSTER_TIME) clusterT = uintOf(b, c.dataStart, c.dataEnd);
        else if (c.id === ID.SIMPLE_BLOCK || c.id === ID.BLOCK_GROUP) {
          let bs = c.dataStart, be = c.dataEnd;
          if (c.id === ID.BLOCK_GROUP) {
            bs = -1;
            for (let r = c.dataStart; r < c.dataEnd;) {
              const f = child(b, r, c.dataEnd); if (!f) break;
              if (f.id === ID.BLOCK) { bs = f.dataStart; be = f.dataEnd; }
              r = f.next;
            }
          }
          if (bs >= 0) {
            const tn = readSize(b, bs); if (!tn) return null;
            const rel = (b[bs + tn.len] << 8 | b[bs + tn.len + 1]) << 16 >> 16; // signed int16
            const flags = b[bs + tn.len + 2];
            if (flags & 0x06) return null; // lacing: not something Opus recorders write
            if (!track || tn.size === track.number) {
              const data = b.subarray(bs + tn.len + 3, be);
              packets.push({ t: ((clusterT + rel) * scale) / 1e6, dur: opusPacketMs(data), data });
            }
          }
        }
        q = c.next;
      }
      p = (e.unknown ? end : e.next);
      continue;
    }
    p = e.next;
  }
  if (!track || !packets.length) return null;
  packets.sort((a, c) => a.t - c.t);
  const last = packets[packets.length - 1];
  return { track, packets, durationMs: Math.round(last.t + (last.dur || 20)) };
}

/* ---------- writer ---------- */
const bytesOfId = (id) => { const out = []; for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xFF); return out; };
function vsize(n) {
  let len = 1;
  while (len < 8 && n >= 2 ** (7 * len) - 1) len++;
  const out = new Array(len);
  for (let i = len - 1, v = n; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
  out[0] |= 0x80 >> (len - 1);
  return out;
}
const cat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const el = (id, ...body) => { const data = cat(body); return cat([Uint8Array.from(bytesOfId(id)), Uint8Array.from(vsize(data.length)), data]); };
const uintEl = (id, v) => { const out = []; let x = v; do { out.unshift(x % 256); x = Math.floor(x / 256); } while (x > 0); return el(id, Uint8Array.from(out)); };
const strEl = (id, s) => el(id, new TextEncoder().encode(s));
const f64El = (id, v) => { const a = new Uint8Array(8); new DataView(a.buffer).setFloat64(0, v); return el(id, a); };

const CLUSTER_MS = 5000;

// packets [{t,dur,data}] (t in ms, from 0) + the track -> a complete, seekable WebM file.
export function writeWebm(track, packets) {
  const durationMs = packets.length ? packets[packets.length - 1].t + (packets[packets.length - 1].dur || 20) : 0;
  const header = el(ID.EBML, uintEl(0x4286, 1), uintEl(0x42F7, 1), uintEl(0x42F2, 4), uintEl(0x42F3, 8),
    strEl(0x4282, 'webm'), uintEl(0x4287, 4), uintEl(0x4285, 2));
  const info = el(ID.INFO, uintEl(ID.TIMECODE_SCALE, 1_000_000), f64El(ID.DURATION, durationMs), strEl(0x4D80, 'Attest'), strEl(0x5741, 'Attest'));
  const entry = [uintEl(ID.TRACK_NUMBER, 1), uintEl(0x73C5, 1), uintEl(0x83, 2), strEl(ID.CODEC_ID, 'A_OPUS')];
  if (track.codecPrivate) entry.push(el(ID.CODEC_PRIVATE, track.codecPrivate));
  if (track.codecDelay) entry.push(uintEl(ID.CODEC_DELAY, track.codecDelay));
  if (track.seekPreRoll) entry.push(uintEl(ID.SEEK_PRE_ROLL, track.seekPreRoll));
  const sr = new Uint8Array(8); new DataView(sr.buffer).setFloat64(0, track.rate);
  entry.push(el(ID.AUDIO, el(ID.SAMPLE_RATE, sr), uintEl(ID.CHANNELS, track.channels)));
  const tracks = el(ID.TRACKS, el(ID.TRACK_ENTRY, ...entry));

  const clusters = [], cues = [];
  let offset = info.length + tracks.length, i = 0;
  while (i < packets.length) {
    const startT = Math.round(packets[i].t);
    const blocks = [];
    for (; i < packets.length && packets[i].t - startT < CLUSTER_MS; i++) {
      const rel = Math.round(packets[i].t) - startT;
      blocks.push(el(ID.SIMPLE_BLOCK, Uint8Array.from([0x81, (rel >> 8) & 0xFF, rel & 0xFF, 0x80]), packets[i].data));
    }
    const cl = el(ID.CLUSTER, uintEl(ID.CLUSTER_TIME, startT), ...blocks);
    cues.push(el(0xBB, uintEl(0xB3, startT), el(0xB7, uintEl(0xF7, 1), uintEl(0xF1, offset))));
    clusters.push(cl);
    offset += cl.length;
  }
  const segment = el(ID.SEGMENT, info, tracks, ...clusters, el(ID.CUES, ...cues));
  return { data: cat([header, segment]), durationMs: Math.round(durationMs) };
}

// Packets with start time in [startMs, endMs), moved so the first one is at 0.
export function cutWebm(p, startMs, endMs) {
  const sel = p.packets.filter((k) => k.t >= startMs && k.t < endMs);
  if (!sel.length) return { data: new Uint8Array(0), durationMs: 0 };
  const base = sel[0].t;
  return writeWebm(p.track, sel.map((k) => ({ t: k.t - base, dur: k.dur, data: k.data })));
}

// Back to back: each file's packets start where the previous file's audio ended.
export function joinWebm(parsed) {
  const a = parsed[0].track;
  if (parsed.some((p) => p.track.rate !== a.rate || p.track.channels !== a.channels)) return null;
  const all = [];
  let at = 0;
  for (const p of parsed) {
    const base = p.packets[0].t;
    for (const k of p.packets) all.push({ t: at + (k.t - base), dur: k.dur, data: k.data });
    at += p.durationMs - base;
  }
  return writeWebm(a, all);
}
