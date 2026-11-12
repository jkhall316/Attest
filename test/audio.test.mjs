import test from 'node:test';
import assert from 'node:assert/strict';
import { probeAudio, cutAudio, joinAudio, detect } from '../src/audio/index.js';
import { writeWebm, parseWebm, opusPacketMs } from '../src/audio/webm.js';

/* ---------- fixtures ---------- */
function wav(seconds, rate = 8000) {
  const n = seconds * rate, pcm = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) { const v = Math.round(Math.sin(i / 20) * 8000); pcm[i * 2] = v & 255; pcm[i * 2 + 1] = (v >> 8) & 255; }
  const out = new Uint8Array(44 + pcm.length), dv = new DataView(out.buffer);
  out.set([82, 73, 70, 70], 0); dv.setUint32(4, 36 + pcm.length, true); out.set([87, 65, 86, 69, 102, 109, 116, 32], 8);
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  out.set([100, 97, 116, 97], 36); dv.setUint32(40, pcm.length, true); out.set(pcm, 44);
  return out;
}
// MPEG1 Layer III, 128 kbps, 44.1 kHz, stereo: 417-byte frames of 26.122 ms. Each frame is stamped with its index.
function mp3(frames, { id3 = false } = {}) {
  const parts = [];
  if (id3) parts.push(Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 20, ...new Array(20).fill(0)]));
  for (let i = 0; i < frames; i++) { const f = new Uint8Array(417); f.set([0xFF, 0xFB, 0x90, 0x00]); f[10] = i & 255; f[11] = i >> 8; parts.push(f); }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const TRACK = { number: 1, codec: 'A_OPUS', codecPrivate: Uint8Array.from([79, 112, 117, 115, 72, 101, 97, 100, 1, 1, 56, 1, 128, 62, 0, 0, 0, 0, 0]), codecDelay: 6500000, seekPreRoll: 80000000, rate: 48000, channels: 1 };
// 20 ms CELT packets (TOC 0x98), each stamped with its index
const packets = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ t: i * 20, dur: 20, data: Uint8Array.from([0x98, (from + i) & 255, (from + i) >> 8, 7, 7]) }));

/* ---------- WAV ---------- */
test('wav: probe, cut by time and join are exact', () => {
  const p = probeAudio(wav(10));
  assert.equal(p.format, 'wav');
  assert.equal(p.durationMs, 10000);
  const [a, b] = cutAudio(p, [{ startMs: 1000, endMs: 3500 }, { startMs: 9000, endMs: 20000 }]);
  assert.equal(a.durationMs, 2500);
  assert.equal(b.durationMs, 1000); // clamped to the end of the file
  assert.equal(a.contentType, 'audio/wav');
  assert.equal(probeAudio(a.data).durationMs, 2500);
  const j = joinAudio([probeAudio(a.data), probeAudio(b.data)]);
  assert.equal(j.durationMs, 3500);
  assert.equal(probeAudio(j.data).durationMs, 3500);
  assert.equal(joinAudio([probeAudio(wav(1, 8000)), probeAudio(wav(1, 16000))]), null); // different formats do not join
});

/* ---------- MP3 ---------- */
test('mp3: frames are found past an ID3 tag, cut on frame boundaries and joined byte for byte', () => {
  const p = probeAudio(mp3(200, { id3: true }));
  assert.equal(p.format, 'mp3');
  assert.ok(Math.abs(p.durationMs - 200 * 26.122) < 2);
  const [c] = cutAudio(p, [{ startMs: 1000, endMs: 2000 }]);
  assert.equal(c.data.length % 417, 0);
  assert.equal(c.contentType, 'audio/mpeg');
  assert.ok(Math.abs(c.durationMs - 1000) < 30);
  assert.equal(c.data[10], Math.ceil(1000 / 26.122) & 255); // first kept frame is the first starting at/after 1000 ms
  const q = probeAudio(c.data);
  const j = joinAudio([q, q]);
  assert.equal(j.data.length, c.data.length * 2);
});

test('mp3: a Xing/Info frame is metadata and is dropped', () => {
  const info = new Uint8Array(417); info.set([0xFF, 0xFB, 0x90, 0x00]); info.set([0x49, 0x6e, 0x66, 0x6f], 36);
  const body = mp3(50);
  const file = new Uint8Array(info.length + body.length); file.set(info); file.set(body, info.length);
  const p = probeAudio(file);
  assert.equal(p.parsed.frames.length, 50);
});

/* ---------- WebM / Opus ---------- */
test('opus packet duration comes from the TOC byte', () => {
  assert.equal(opusPacketMs(Uint8Array.from([0x98])), 20);   // CELT 20 ms, 1 frame
  assert.equal(opusPacketMs(Uint8Array.from([0x99])), 40);   // 2 frames
  assert.equal(opusPacketMs(Uint8Array.from([0x78])), 20);   // SILK/hybrid
  assert.equal(opusPacketMs(Uint8Array.from([0x9B, 3])), 60); // code 3, 3 frames
});

test('webm: write -> parse round-trips every packet', () => {
  const file = writeWebm(TRACK, packets(500)).data; // 10 s
  assert.equal(detect(file), 'webm');
  const p = probeAudio(file);
  assert.equal(p.parsed.packets.length, 500);
  assert.equal(p.durationMs, 10000);
  assert.deepEqual([...p.parsed.packets[123].data], [0x98, 123, 0, 7, 7]);
  assert.equal(p.parsed.track.rate, 48000);
  assert.deepEqual([...p.parsed.track.codecPrivate], [...TRACK.codecPrivate]);
});

test('webm: cut keeps exactly the packets in the range and starts at zero; join is back to back', () => {
  const p = probeAudio(writeWebm(TRACK, packets(500)).data);
  const [a, b] = cutAudio(p, [{ startMs: 2000, endMs: 4000 }, { startMs: 8000, endMs: 10000 }]);
  const pa = probeAudio(a.data), pb = probeAudio(b.data);
  assert.equal(pa.parsed.packets.length, 100);
  assert.equal(pa.parsed.packets[0].t, 0);
  assert.deepEqual([...pa.parsed.packets[0].data], [0x98, 100, 0, 7, 7]); // packet 100 = 2000 ms
  assert.equal(pa.durationMs, 2000);
  const j = joinAudio([pa, pb]);
  const pj = probeAudio(j.data);
  assert.equal(pj.parsed.packets.length, 200);
  assert.equal(pj.durationMs, 4000);
  assert.equal(pj.parsed.packets[100].t, 2000);
  assert.deepEqual([...pj.parsed.packets[100].data], [0x98, 400 & 255, 400 >> 8, 7, 7]);
});

test('webm: a live MediaRecorder file (unknown-size segment and clusters) parses the same', () => {
  const file = writeWebm(TRACK, packets(300)).data;
  const find = (hay, needle, from = 0) => { for (let i = from; i < hay.length - needle.length; i++) if (needle.every((v, k) => hay[i + k] === v)) return i; return -1; };
  const unknown = Uint8Array.from([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
  // replace every cluster's and the segment's size field with "unknown"
  const out = [];
  let o = 0;
  const sizeLen = (b) => Math.clz32(b) - 24 + 1;
  const swap = (id) => {
    for (let at = find(file, id, o); at >= 0; at = find(file, id, o)) {
      out.push(file.subarray(o, at + id.length), unknown);
      o = at + id.length + sizeLen(file[at + id.length]);
    }
  };
  // segment first (only one), then clusters, handled in file order
  const idS = [0x18, 0x53, 0x80, 0x67], idC = [0x1F, 0x43, 0xB6, 0x75];
  const seg = find(file, idS);
  out.push(file.subarray(0, seg + 4), unknown); o = seg + 4 + sizeLen(file[seg + 4]);
  swap(idC);
  out.push(file.subarray(o));
  const live = new Uint8Array(out.reduce((n, p) => n + p.length, 0)); let w = 0;
  for (const p of out) { live.set(p, w); w += p.length; }
  assert.notDeepEqual([...live.subarray(0, 200)], [...file.subarray(0, 200)]);
  const parsed = parseWebm(live);
  assert.equal(parsed.packets.length, 300);
  assert.equal(parsed.durationMs, 6000);
});

test('unknown or unreadable audio is refused, not guessed at', () => {
  assert.equal(probeAudio(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), null);
  assert.equal(probeAudio(Uint8Array.from([0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0])), null); // mp4/m4a
  assert.equal(joinAudio([probeAudio(wav(1)), probeAudio(mp3(50))]), null);              // mixed formats
});

test('mp3: the real Pocket format (MPEG-2, 16 kHz, mono, 32 kbps, 144-byte frames of 36 ms) cuts exactly', () => {
  const frames = 1000; // 36 s
  const f = new Uint8Array(frames * 144);
  for (let i = 0; i < frames; i++) { f.set([0xFF, 0xF3, 0x48, 0xC4], i * 144); f[i * 144 + 20] = i & 255; f[i * 144 + 21] = i >> 8; }
  const p = probeAudio(f);
  assert.equal(p.format, 'mp3');
  assert.equal(p.parsed.rate, 16000);
  assert.equal(p.parsed.mono, true);
  assert.equal(p.durationMs, 36000);
  const [c] = cutAudio(p, [{ startMs: 10_000, endMs: 20_000 }]);
  assert.equal(c.data.length, 278 * 144);                       // frames at 10.008 .. 19.98 s
  assert.equal(c.data[20], 278 & 255);                          // first kept frame is #278 (first starting at/after 10 s)
  assert.ok(Math.abs(c.durationMs - 10000) <= 36);
  assert.equal(probeAudio(c.data).durationMs, c.durationMs);
});
