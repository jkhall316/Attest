// WAV (PCM): cut by time, join. Lossless -- the samples are copied, never re-encoded.

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

export const isWav = (b) => b.length > 12 && tag(b, 0) === 'RIFF' && tag(b, 8) === 'WAVE';

// -> {fmt: Uint8Array (the fmt chunk body), blockAlign, byteRate, data: Uint8Array} or null
export function parseWav(b) {
  if (!isWav(b)) return null;
  let o = 12, fmt = null, data = null;
  while (o + 8 <= b.length) {
    const id = tag(b, o);
    let size = u32(b, o + 4);
    const body = o + 8;
    if (id === 'data') {
      // A streamed WAV leaves the size at 0 or 0xFFFFFFFF: the data runs to the end of the file.
      if (size === 0 || size === 0xFFFFFFFF || body + size > b.length) size = b.length - body;
      data = b.subarray(body, body + size);
      break;
    }
    if (id === 'fmt ') fmt = b.subarray(body, body + size);
    o = body + size + (size & 1);
  }
  if (!fmt || !data || fmt.length < 16) return null;
  const tagFmt = fmt[0] | (fmt[1] << 8);
  if (tagFmt !== 1 && tagFmt !== 0xFFFE) return null; // PCM only
  const blockAlign = fmt[12] | (fmt[13] << 8);
  const byteRate = u32(fmt, 8);
  if (!blockAlign || !byteRate) return null;
  return { fmt, blockAlign, byteRate, data, durationMs: Math.round((data.length / byteRate) * 1000) };
}

function build(fmt, pcm) {
  const pad = pcm.length & 1;
  const out = new Uint8Array(12 + 8 + fmt.length + 8 + pcm.length + pad);
  const dv = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0); dv.setUint32(4, out.length - 8, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8);
  out.set([0x66, 0x6d, 0x74, 0x20], 12); dv.setUint32(16, fmt.length, true); out.set(fmt, 20);
  const d = 20 + fmt.length;
  out.set([0x64, 0x61, 0x74, 0x61], d); dv.setUint32(d + 4, pcm.length, true); out.set(pcm, d + 8);
  return out;
}

export function cutWav(p, startMs, endMs) {
  const at = (ms) => Math.min(p.data.length, Math.max(0, Math.round((ms / 1000) * p.byteRate / p.blockAlign) * p.blockAlign));
  const pcm = p.data.subarray(at(startMs), at(endMs));
  return { data: build(p.fmt, pcm), durationMs: Math.round((pcm.length / p.byteRate) * 1000) };
}

export function joinWav(parsed) {
  const first = parsed[0];
  for (const p of parsed) {
    if (p.fmt.length !== first.fmt.length || p.fmt.some((v, i) => v !== first.fmt[i])) return null; // different formats cannot be joined
  }
  const pcm = new Uint8Array(parsed.reduce((n, p) => n + p.data.length, 0));
  let o = 0;
  for (const p of parsed) { pcm.set(p.data, o); o += p.data.length; }
  return { data: build(first.fmt, pcm), durationMs: Math.round((pcm.length / first.byteRate) * 1000) };
}
