// `npm run local:check [-- --audio path/to/speech.wav]`: reads .dev.vars and tests every
// capability Attest's local mode uses against your local server, so you know what works before
// you record anything.
import { existsSync, readFileSync } from 'node:fs';
import { parseDevVars, listModels, probeChat, probeEmbeddings, probeStt, explainSttError } from './lib/omlx.mjs';
import { isMain } from './lib/platform.mjs';

const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);
const note = (m) => console.log(`    ${m}`);

export async function check({ file = '.dev.vars', audio = '', f = fetch, log = true } = {}) {
  const results = { ok: true, items: [] };
  const rec = (name, pass, detail = '') => { results.items.push({ name, pass, detail }); if (!pass) results.ok = false; if (log) (pass ? ok : bad)(`${name}${detail ? `: ${detail}` : ''}`); };
  if (!existsSync(file)) { rec('.dev.vars', false, 'not found. Run: npm run setup:local'); return results; }
  const v = parseDevVars(readFileSync(file, 'utf8'));
  if (v.LOCAL_MODE !== 'true') { rec('LOCAL_MODE', false, 'not set to true in .dev.vars. Run: npm run setup:local'); return results; }

  const base = v.LLM_BASE_URL, key = v.LLM_API_KEY;
  const models = await listModels(base, key, f);
  if (!models.ok) { rec(`server ${base}`, false, models.error); return results; }
  rec(`server ${base}`, true, `${models.ids.length} model${models.ids.length === 1 ? '' : 's'} available`);

  const chat = v.DEFAULT_MODEL;
  rec(`chat model "${chat}" is installed`, models.ids.includes(chat), models.ids.includes(chat) ? '' : 'not in the server\'s model list');
  const c = await probeChat(base, key, chat, f);
  rec('chat model answers in JSON', c.ok, c.ok ? (c.jsonMode ? 'and accepts response_format' : 'but ignores response_format (fine: Attest\'s parser copes)') : c.error);
  if (v.LLM_CONTEXT_CHARS && log) note(`transcripts are cut to ${Number(v.LLM_CONTEXT_CHARS).toLocaleString()} characters; set LLM_CONTEXT_CHARS to match your model's context`);

  if (v.EMBED_MODEL) {
    const e = await probeEmbeddings(v.EMBED_BASE_URL || base, v.EMBED_API_KEY || key, v.EMBED_MODEL, f);
    rec(`embedding model "${v.EMBED_MODEL}"`, e.ok, e.ok ? `${e.dim}-dimensional vectors: semantic search will work` : e.error);
  } else if (log) note('no EMBED_MODEL: Ask will use keyword search. Add one for semantic search.');

  if (v.STT_MODELS) {
    const stt = v.STT_MODELS.split(',')[0];
    const bytes = audio && existsSync(audio) ? readFileSync(audio) : null;
    const s = await probeStt(v.STT_BASE_URL || base, v.STT_API_KEY || key, stt, bytes, f);
    rec(`transcription model "${stt}"`, s.ok, s.ok ? 'accepted an upload' : s.error);
    const fix = !s.ok && explainSttError(s.error);
    if (fix) { results.fix = fix; if (log) console.log(`\n${fix.split('\n').map((l) => `    ${l}`).join('\n')}\n`); }
    if (s.ok) {
      if (!s.timestampsChecked && log) note('timestamps not checked (a test tone has no words). Re-run with --audio your-speech.wav');
      else if (s.hasTimestamps) { ok(`returns ${s.segments} timestamped segment(s): speaker detection by voice will work`); }
      else bad('no timestamped segments in the answer: Attest cannot split speakers by voice without them');
      if (s.timestampsChecked && !s.hasTimestamps) results.ok = false;
    }
    if (v.LOCAL_DIARIZE === 'true' && log) note('LOCAL_DIARIZE=true: speakers are detected in your browser by clustering voices');
  } else if (log) note('no STT_MODELS: you can paste or import transcripts, but not transcribe audio.');
  return results;
}

if (isMain(import.meta.url)) {
  const i = process.argv.indexOf('--audio');
  console.log('\nChecking your local setup\n');
  const r = await check({ audio: i > 0 ? process.argv[i + 1] : '' });
  console.log(r.ok ? '\nAll checks passed. Start Attest with: npm run local\n' : '\nSome checks failed. Fix those, or re-run: npm run setup:local\n');
  process.exit(r.ok ? 0 : 1);
}
