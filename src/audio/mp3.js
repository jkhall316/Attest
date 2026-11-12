// MP3 (Layer III): cut and join on whole frames. Lossless -- frames are copied byte for byte.
// A frame is ~26 ms, so a cut lands within that of the requested time. The bit reservoir can make
// the first decoded frame after a cut slightly off; cuts are made in silence, where it is inaudible.

const BITRATE_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATE_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATE = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

export const isMp3 = (b) => b.length > 3 && ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0));

function header(b, o) {
  if (o + 4 > b.length || b[o] !== 0xFF || (b[o + 1] & 0xE0) !== 0xE0) return null;
  const version = (b[o + 1] >> 3) & 3, layer = (b[o + 1] >> 1) & 3;
  if (version === 1 || layer !== 1) return null; // reserved version, or not Layer III
  const bi = b[o + 2] >> 4, si = (b[o + 2] >> 2) & 3;
  if (bi === 0 || bi === 15 || si === 3) return null;
  const v1 = version === 3;
  const bitrate = (v1 ? BITRATE_V1 : BITRATE_V2)[bi] * 1000, rate = RATE[version][si];
  const pad = (b[o + 2] >> 1) & 1;
  const len = Math.floor(((v1 ? 144 : 72) * bitrate) / rate) + pad;
  const mono = (b[o + 3] >> 6) === 3;
  return { len, rate, samples: v1 ? 1152 : 576, version, mono, v1 };
}

// Where a Xing/Info/VBRI tag would sit inside the first frame; such a frame is metadata, not audio.
function isInfoFrame(b, o, h) {
  const side = h.v1 ? (h.mono ? 17 : 32) : (h.mono ? 9 : 17);
  const t = String.fromCharCode(b[o + 4 + side], b[o + 5 + side], b[o + 6 + side], b[o + 7 + side]);
  const v = String.fromCharCode(b[o + 36], b[o + 37], b[o + 38], b[o + 39]);
  return t === 'Xing' || t === 'Info' || v === 'VBRI';
}

// -> {frames: [{off, len, ms}], rate, version, mono, durationMs} or null
export function parseMp3(b) {
  let o = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    o = 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f));
    if (b[5] & 0x10) o += 10;
  }
  const frames = [];
  let rate = 0, version = -1, mono = false, ms = 0, ok = 0;
  while (o + 4 <= b.length) {
    const h = header(b, o);
    if (!h || o + h.len > b.length) {
      // resync byte by byte (padding, an APE/ID3v1 tail); stop for good if nothing valid follows
      o += 1; if (!frames.length && o > 65536) return null; continue;
    }
    if (!frames.length && isInfoFrame(b, o, h)) { o += h.len; continue; }
    if (!rate) { rate = h.rate; version = h.version; mono = h.mono; }
    if (h.rate !== rate || h.version !== version) { o += 1; continue; } // stray bytes that looked like a header
    frames.push({ off: o, len: h.len, ms });
    ms += (h.samples / rate) * 1000;
    o += h.len; ok++;
  }
  if (ok < 3) return null;
  return { frames, rate, version, mono, durationMs: Math.round(ms), buf: b };
}

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

export function cutMp3(p, startMs, endMs) {
  const sel = p.frames.filter((f) => f.ms >= startMs && f.ms < endMs);
  if (!sel.length) return { data: new Uint8Array(0), durationMs: 0 };
  const per = (p.version === 3 ? 1152 : 576) / p.rate * 1000;
  return { data: concat(sel.map((f) => p.buf.subarray(f.off, f.off + f.len))), durationMs: Math.round(sel.length * per) };
}

export function joinMp3(parsed) {
  const a = parsed[0];
  if (parsed.some((p) => p.rate !== a.rate || p.version !== a.version)) return null;
  const all = parsed.flatMap((p) => p.frames.map((f) => p.buf.subarray(f.off, f.off + f.len)));
  return { data: concat(all), durationMs: parsed.reduce((n, p) => n + p.durationMs, 0) };
}
