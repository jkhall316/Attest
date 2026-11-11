// `npm run setup:local` (also offered by `npm run setup`): configure Attest to run entirely on
// this Mac against a local OpenAI-compatible server such as oMLX. Detects the server, lists
// its models, proposes roles, tests each capability, and writes .dev.vars.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ask, confirm, secret } from './lib/prompt.mjs';
import {
  detectBase, normalizeBase, listModels, guessRole, probeChat, probeEmbeddings, probeStt, mergeDevVars, buildLocalVars, SUGGESTED_MODELS,
  RECOMMENDED, recommendationsText, recommendedIndex, missingRecommended, explainSttError,
} from './lib/omlx.mjs';

// `role` marks the recommended model in the list and makes it the default when it is installed.
const pickFrom = async (title, ids, { role, optional, guessed = true } = {}) => {
  const rec = role ? recommendedIndex(ids, role) : 0;
  console.log(`\n${title}`);
  ids.forEach((id, i) => console.log(`  ${i + 1}. ${id}${guessRole(id) === 'other' ? '  (not for this)' : ''}${i + 1 === rec ? '   <- recommended' : ''}`));
  if (optional) console.log('  0. none');
  if (role && !rec) console.log(`  (The recommended one, ${RECOMMENDED[role].id}, is not installed. You can download it and run this again, or pick another.)`);
  // the recommended model if installed; else the first of that role; "none" only when nothing of that type was found
  const def = rec || (guessed ? 1 : (optional ? 0 : 1));
  for (;;) {
    const a = (await ask('Number or model id', { def: String(def) })).trim();
    if (optional && (a === '0' || a.toLowerCase() === 'none')) return '';
    if (/^\d+$/.test(a) && ids[Number(a) - 1]) return ids[Number(a) - 1];
    if (a && !/^\d+$/.test(a)) return a;
  }
};

export async function setupLocal() {
  console.log(`
Local setup: run Attest entirely on this Mac, nothing leaving it.
You need a local server with an OpenAI-compatible API running, such as oMLX
(https://github.com/jundot/omlx).

${recommendationsText()}
`);
  if (!(await confirm('Have the models you want downloaded, and the server running?', true))) {
    console.log('\nNo problem. Download them, then run `npm run setup:local` again.');
    return false;
  }
  const detected = await detectBase();
  if (detected) console.log(`Found a server answering at ${detected}`);
  let base = '', key = '', models;
  for (;;) {
    base = normalizeBase(await ask('Server address', { def: detected || 'http://localhost:8000/v1' }));
    key = await secret('API key for that server');
    models = await listModels(base, key);
    if (models.ok) break;
    console.log(`\nCould not use that: ${models.error}\n`);
    if (!(await confirm('Try again?', true))) return false;
  }
  console.log(`\nConnected. ${models.ids.length} model(s) available.`);
  const ids = models.ids;
  const by = (role) => ids.filter((m) => guessRole(m) === role);
  const missing = missingRecommended(ids);
  if (missing.length) {
    console.log('\nNot installed on that server yet:');
    for (const role of missing) console.log(`  ${role === 'stt' ? 'transcription' : role}: ${RECOMMENDED[role].id}`);
    console.log('You can continue with what is there, or quit, download them, and run this again.');
    if (!(await confirm('Continue now?', true))) return false;
  }

  const chat = await pickFrom('Chat model (summaries, mind maps, Ask, Today). Larger is better; it needs a long context window.', by('chat').length ? by('chat') : ids, { role: 'chat', guessed: by('chat').length > 0 });
  const embed = await pickFrom('Embedding model (semantic search). Optional; without one, Ask uses keyword search.', by('embedding').length ? by('embedding') : ids, { role: 'embedding', optional: true, guessed: by('embedding').length > 0 });
  let stt = '', sttBase = '', sttKey = '';
  const sttIds = by('stt');
  if (sttIds.length) stt = await pickFrom('Transcription model (Whisper-style). Optional, but needed to transcribe audio.', sttIds, { role: 'stt', optional: true });
  else {
    console.log('\nNo transcription model found on that server.');
    console.log(`Without one you cannot transcribe audio. Download ${SUGGESTED_MODELS.stt} in oMLX, or point Attest at another server that has /v1/audio/transcriptions.`);
    if (await confirm('Use a different server for transcription?', false)) {
      sttBase = normalizeBase(await ask('Transcription server address', { def: base }));
      sttKey = await secret('API key for it');
      stt = await ask('Transcription model id', { def: SUGGESTED_MODELS.stt });
    }
  }
  const tokens = Number(await ask('Context window your chat model runs with, in tokens (Attest trims transcripts to fit)', { def: '32768' })) || 32768;

  console.log('\nTesting…');
  const c = await probeChat(base, key, chat);
  console.log(`  chat: ${c.ok ? `✓ answers in JSON${c.jsonMode ? '' : ' (ignores response_format; fine)'}` : `✗ ${c.error}`}`);
  if (embed) { const e = await probeEmbeddings(base, key, embed); console.log(`  embeddings: ${e.ok ? `✓ ${e.dim}-dimensional` : `✗ ${e.error}`}`); }
  let timestamps = true;
  if (stt) { const s = await probeStt(sttBase || base, sttKey || key, stt); console.log(`  transcription: ${s.ok ? '✓ accepted an upload' : `✗ ${s.error}`}`); timestamps = s.ok; }
  if (!c.ok && !(await confirm('The chat test failed. Write the settings anyway?', false))) return false;

  const vars = buildLocalVars({ base, key, chat, embed, stt, sttBase, sttKey, diarize: Boolean(stt), contextTokens: tokens });
  const file = '.dev.vars';
  writeFileSync(file, mergeDevVars(existsSync(file) ? readFileSync(file, 'utf8') : '', vars));
  console.log(`\nWrote ${file} (gitignored).`);
  console.log(`
Next:
  npm run local:check                       test everything again, any time
  npm run local:check -- --audio speech.wav also confirms timestamps from your Whisper model
  npm run local                             start Attest at http://localhost:8787
${stt && timestamps ? '\nSpeaker labels: your transcriber does not label speakers, so Attest detects them in your browser by\nclustering voices (Today > a recording > "Detect speakers" for long ones).\n' : ''}`);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) setupLocal().then((ok) => process.exit(ok ? 0 : 1));
