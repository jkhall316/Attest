// Lossless audio cutting and joining without ffmpeg (a Worker cannot run it): WAV, MP3 and
// WebM/Opus are handled by copying frames or packets. Anything else (M4A, ...) returns null and
// the caller keeps the audio untouched. The whole file is held in memory, so large files are
// refused rather than risking the Worker's memory limit.

import { isWav, parseWav, cutWav, joinWav } from './wav.js';
import { isMp3, parseMp3, cutMp3, joinMp3 } from './mp3.js';
import { isWebm, parseWebm, cutWebm, joinWebm } from './webm.js';

export const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const TYPE = { wav: 'audio/wav', mp3: 'audio/mpeg', webm: 'audio/webm' };

const FORMATS = {
  wav: { is: isWav, parse: parseWav, cut: cutWav, join: joinWav },
  mp3: { is: isMp3, parse: parseMp3, cut: cutMp3, join: joinMp3 },
  webm: { is: isWebm, parse: parseWebm, cut: cutWebm, join: joinWebm },
};

export function detect(bytes) {
  for (const [name, f] of Object.entries(FORMATS)) if (f.is(bytes)) return name;
  return null;
}

// -> {format, parsed, durationMs, contentType} or null (unknown format, unreadable, or too big)
export function probeAudio(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length > MAX_AUDIO_BYTES) return null;
  const format = detect(bytes);
  if (!format) return null;
  try {
    const parsed = FORMATS[format].parse(bytes);
    return parsed ? { format, parsed, durationMs: parsed.durationMs, contentType: TYPE[format] } : null;
  } catch { return null; }
}

// One output per [startMs, endMs] range: {data, durationMs, contentType}. null if it cannot be done.
export function cutAudio(probe, ranges) {
  try {
    const out = ranges.map((r) => ({ ...FORMATS[probe.format].cut(probe.parsed, r.startMs, r.endMs), contentType: probe.contentType }));
    return out.every((o) => o.data.length > 0) ? out : null;
  } catch { return null; }
}

// Several files of the same format, back to back -> {data, durationMs, contentType} or null.
export function joinAudio(probes) {
  if (probes.length < 2 || probes.some((p) => !p || p.format !== probes[0].format)) return null;
  try {
    const out = FORMATS[probes[0].format].join(probes.map((p) => p.parsed));
    return out && out.data.length ? { ...out, contentType: probes[0].contentType } : null;
  } catch { return null; }
}
