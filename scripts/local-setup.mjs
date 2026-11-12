// `npm run setup:local` (also offered by `npm run setup`): configure Attest to run entirely on
// this machine against a local OpenAI-compatible server (oMLX on a Mac; LM Studio or Ollama on
// Windows and Linux). Detects the server, lists its models, proposes roles, tests each
// capability, and writes .dev.vars.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ask, confirm, secret } from './lib/prompt.mjs';
import {
  detectBase, normalizeBase, listModels, guessRole, probeChat, probeEmbeddings, probeStt, mergeDevVars, buildLocalVars,
  recommendedFor, suggestedModels, recommendationsText, recommendedIndex, missingRecommended, explainSttError,
} from './lib/omlx.mjs';
import { isMain, machineLabel, defaultPorts } from './lib/platform.mjs';

const PLATFORM = process.platform;
const MAC = PLATFORM === 'darwin';
const RECOMMENDED = recommendedFor(PLATFORM);
const SUGGESTED_MODELS = suggestedModels(PLATFORM);

// `role` marks the recommended model in the list and makes it the default when it is installed.
const pickFrom = async (title, ids, { role, optional, guessed = true } = {}) => {
  const rec = role ? recommendedIndex(ids, role, PLATFORM) : 0;
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
Local setup: run Attest entirely on ${machineLabel(PLATFORM)}, nothing leaving it.
${MAC
    ? 'You need a local server with an OpenAI-compatible API running, such as oMLX\n(https://github.com/jundot/omlx).'
    : 'You need a local server with an OpenAI-compatible API running for chat, such as LM Studio\n(https://lmstudio.ai, start its server) or Ollama (https://ollama.com). To transcribe audio\nyou also need a Whisper server, such as Speaches (https://speaches.ai) or whisper.cpp\'s\nwhisper-server. The README section "Run it locally on Windows or Linux" has the commands.'}

${recommendationsText(PLATFORM)}
`);
  if (!(await confirm('Have the models you want downloaded, and the server running?', true))) {
    console.log('\nNo problem. Download them, then run `npm run setup:local` again.');
    return false;
  }
  const detected = await detectBase();
  if (detected) console.log(`Found a server answering at ${detected}`);
  let base = '', key = '', models;
  for (;;) {
    base = normalizeBase(await ask('Server address', { def: detected || `http://localhost:${defaultPorts(PLATFORM)[0]}/v1` }));
    key = await secret('API key for that server');
    models = await listModels(base, key);
    if (models.ok) break;
    console.log(`\nCould not use that: ${models.error}\n`);
    if (!(await confirm('Try again?', true))) return false;
  }
  console.log(`\nConnected. ${models.ids.length} model(s) available.`);
  const ids = models.ids;
  const by = (role) => ids.filter((m) => guessRole(m) === role);
  // Off the Mac, transcription lives on a separate Whisper server, so its absence here is expected.
  const missing = missingRecommended(ids, PLATFORM).filter((role) => MAC || role !== 'stt');
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
    console.log(MAC
      ? `Without one you cannot transcribe audio. Download ${SUGGESTED_MODELS.stt} in oMLX, or point Attest at another server that has /v1/audio/transcriptions.`
      : 'That is normal for LM Studio and Ollama. To transcribe audio, point Attest at a Whisper server with /v1/audio/transcriptions\n(Speaches listens on port 8000 by default; whisper.cpp\'s whisper-server on 8080).');
    if (await confirm('Use a different server for transcription?', !MAC)) {
      sttBase = normalizeBase(await ask('Transcription server address', { def: MAC ? base : 'http://localhost:8000/v1' }));
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

if (isMain(import.meta.url)) setupLocal().then((ok) => process.exit(ok ? 0 : 1));
