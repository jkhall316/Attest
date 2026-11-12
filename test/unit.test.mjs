import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diarizeToText, ftsQuery, buildSystemPrompt, recordingToMarkdown, modelById, transcriberById,
  TEMPLATES, chatTitleFrom, historyToMessages, recordingToHtml, safeFilename,
  deprecationState, deprecations, applySpeakerNames, filterSpeakerGuess, rebuildTranscript,
  effectiveStatus, STALE_RECORDING_MS, STALE_PROCESSING_MS,
  nameSpeakers, anonymousSpeakers, excerpt, deepResearch,
  mergeHits, MAX_SUB_QUESTIONS, MAX_HITS, MAX_MODEL_CALLS,
  appendLive,
  encodeWav, pickClipWindow, wavDurationMs, matchedSpeakerRefs,
  normalizeEmbedding, matchVoices, applyVoiceMatches,
  validDate, weekStart, openItems, talkStats, involves, buildContext,
  normalizeFacts, chunkText, buildChunks, chunksToHits, vectorsEnabled,
  suggestMerges, renameSpeaker, mergeAliases, reassignSegments,
} from '../src/testing.js';
import { selectVoiceprints, speakerRefsForm } from '../src/voiceprints.js';

test('diarizeToText merges consecutive turns by the same speaker', () => {
  const out = diarizeToText([
    { speaker: 'A', text: 'Hello there' },
    { speaker: 'A', text: 'how are you' },
    { speaker: 'B', text: 'Good, thanks' },
    { speaker: 'A', text: 'Great' },
    { speaker: 'B', text: '   ' },
  ]);
  assert.equal(out, 'A: Hello there how are you\n\nB: Good, thanks\n\nA: Great');
});

test('diarizeToText survives missing segments', () => {
  assert.equal(diarizeToText(undefined), '');
  assert.equal(diarizeToText([]), '');
  assert.equal(diarizeToText([{ text: 'no speaker label' }]), 'Speaker: no speaker label');
});

test('ftsQuery strips FTS5 syntax instead of letting it reach MATCH', () => {
  // parens, quotes and apostrophes are all dropped, so nothing reaches MATCH raw
  assert.equal(ftsQuery('pricing (terms*) "quo\'ted"'), '"pricing" OR "terms" OR "quo" OR "ted"');
  assert.equal(ftsQuery('a'), '');            // too short to be useful
  assert.equal(ftsQuery('!!!'), '');
});

test('ftsQuery keeps non-ASCII words instead of falling back to nothing', () => {
  assert.equal(ftsQuery('café résumé'), '"café" OR "résumé"');
  assert.equal(ftsQuery('会議 決定'), '"会議" OR "決定"');
});

test('buildSystemPrompt falls back to meeting and never asks a scribe to diagnose', () => {
  assert.match(buildSystemPrompt(), /decisions made/);
  assert.match(buildSystemPrompt(TEMPLATES.meeting), /decisions made/);
  assert.match(buildSystemPrompt(TEMPLATES.medical_visit), /Never diagnose/);
  assert.match(buildSystemPrompt(TEMPLATES.medical_visit), /"action_items"/);
});

test('buildSystemPrompt asks for all three mind map orientations', () => {
  const prompt = buildSystemPrompt(TEMPLATES.meeting);
  assert.match(prompt, /"mindmaps"/);
  assert.match(prompt, /"topic"/);
  assert.match(prompt, /"driver"/);
  assert.match(prompt, /"people"/);
});

test('recordingToMarkdown renders summary, action items and transcript', () => {
  const out = recordingToMarkdown({
    title: 'Kickoff', created_at: Date.UTC(2026, 0, 2, 15, 30), template: 'meeting',
    summary: 'We agreed on scope.',
    action_items: JSON.stringify([{ task: 'Draft spec', owner: 'Sam', due: 'Fri' }, { task: 'Book room' }]),
    transcript: 'A: hello',
  });
  assert.match(out, /^# Kickoff/);
  assert.match(out, /- \[ \] Draft spec _\(Sam, Fri\)_/);
  assert.match(out, /- \[ \] Book room$/m);
  assert.match(out, /## Transcript/);
});

test('recordingToMarkdown renders all three mind map orientations', () => {
  const out = recordingToMarkdown({
    title: 'Kickoff', created_at: Date.UTC(2026, 0, 2, 15, 30), template: 'meeting',
    mindmaps: { topic: '# Topic tree', driver: '# Driver tree', people: '# People tree' },
  });
  assert.match(out, /## Mind map — Topic/);
  assert.match(out, /## Mind map — Driver/);
  assert.match(out, /## Mind map — People/);
});

test('recordingToMarkdown falls back to the legacy mindmap column as the topic tree', () => {
  const out = recordingToMarkdown({
    title: 'Old', created_at: Date.UTC(2026, 0, 2, 15, 30), template: 'meeting',
    mindmap: '# Legacy tree',
  });
  assert.match(out, /## Mind map — Topic/);
  assert.match(out, /# Legacy tree/);
  assert.doesNotMatch(out, /## Mind map — Driver/);
});

test('recordingToHtml escapes user content and carries the print stylesheet', () => {
  const out = recordingToHtml({
    title: 'A & B <script>', created_at: Date.UTC(2026, 0, 2), template: 'meeting',
    summary: 'x < y', action_items: [{ task: 'Ship <it>', owner: 'Sam' }],
    mindmaps: { topic: '# Root\n- leaf' }, transcript: 'A: hi',
  });
  assert.match(out, /A &amp; B &lt;script&gt;/);
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /@media print/);
  assert.match(out, /Mind map — Topic/);
  assert.match(out, /☐ Ship &lt;it&gt;/);
});

test('safeFilename keeps names header- and zip-safe', () => {
  assert.equal(safeFilename('Q3 / Pricing: "final"?'), 'Q3  Pricing final');
  assert.equal(safeFilename(''), 'recording');
  assert.equal(safeFilename(undefined), 'recording');
  assert.ok(safeFilename('x'.repeat(200)).length <= 80);
});

test('export renders a custom template label instead of its slug key', () => {
  const labels = { ...TEMPLATES, court_hearing: { label: 'Court hearing', style: 'x', group: 'custom' } };
  const r = { title: 'T', created_at: Date.UTC(2026, 0, 2), template: 'court_hearing' };
  assert.match(recordingToMarkdown(r, labels), /_2026-01-02 00:00 · Court hearing_/);
  assert.match(recordingToHtml(r, labels), /Court hearing/);
  // Falls back to the raw key when no label map is supplied at all.
  assert.match(recordingToMarkdown({ ...r, template: 'meeting' }), /· Meeting_/);
  assert.match(recordingToMarkdown(r), /· court_hearing_/);
});

test('deprecationState levels a known cut-off by days remaining', () => {
  const dep = { cutoff: '2027-02-26' };
  assert.deepEqual(deprecationState(dep, Date.parse('2026-01-01T00:00:00Z')), { days: 421, level: 'watch' });
  assert.equal(deprecationState(dep, Date.parse('2026-12-01T00:00:00Z')).level, 'soon');
  assert.equal(deprecationState(dep, Date.parse('2027-02-26T00:00:00Z')).level, 'retired');
  assert.equal(deprecationState(dep, Date.parse('2027-06-01T00:00:00Z')).level, 'retired');
});

test('deprecations() ships cutoff, note and level for every known model', () => {
  const d = deprecations(Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(d['gpt-4o-transcribe-diarize'].cutoff, '2027-02-26');
  assert.equal(d['gpt-4o-transcribe-diarize'].level, 'watch');
  assert.match(d['gpt-4o-transcribe-diarize'].note, /no diarizing successor/);
});

test('liveTranscriberId falls back to gpt-transcribe only after the diarize cut-off', async () => {
  const { liveTranscriberId } = await import('../src/config.js');
  assert.equal(liveTranscriberId('gpt-4o-transcribe-diarize', Date.parse('2027-02-25T00:00:00Z')), 'gpt-4o-transcribe-diarize');
  assert.equal(liveTranscriberId('gpt-4o-transcribe-diarize', Date.parse('2027-02-27T00:00:00Z')), 'gpt-transcribe');
  assert.equal(liveTranscriberId('gpt-transcribe', Date.parse('2030-01-01T00:00:00Z')), 'gpt-transcribe');
});

test('modelById rejects unknown ids instead of forwarding them to the API', () => {
  assert.equal(modelById('gpt-6-luna').id, 'gpt-6-luna');
  assert.equal(modelById('made-up-model'), null);
  assert.equal(modelById(undefined), null);
  assert.equal(transcriberById('nope').id, 'gpt-4o-transcribe-diarize');
  assert.equal(transcriberById('gpt-transcribe').id, 'gpt-transcribe');
});

test('chatTitleFrom trims to 60 chars and falls back to New chat', () => {
  assert.equal(chatTitleFrom('What did we decide about pricing?'), 'What did we decide about pricing?');
  assert.equal(chatTitleFrom('  padded question  '), 'padded question');
  assert.equal(chatTitleFrom('x'.repeat(80)).length, 60);
  assert.equal(chatTitleFrom(''), 'New chat');
  assert.equal(chatTitleFrom('   '), 'New chat');
  assert.equal(chatTitleFrom(undefined), 'New chat');
});

test('historyToMessages maps rows, drops empties, keeps the last 10', () => {
  const rows = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: '  ' },
    { role: 'assistant', content: 'first answer' },
  ];
  assert.deepEqual(historyToMessages(rows), [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
  ]);

  const long = Array.from({ length: 14 }, (_, i) => ({ role: 'user', content: `q${i}` }));
  const out = historyToMessages(long);
  assert.equal(out.length, 10);
  assert.equal(out[0].content, 'q4');
  assert.equal(out[9].content, 'q13');

  assert.deepEqual(historyToMessages(undefined), []);
});

test('applySpeakerNames names confirmed speakers and numbers the rest stably', () => {
  const segments = [
    { speaker: 'A', text: 'hi' },
    { speaker: 'B', text: 'hey' },
    { speaker: 'C', text: 'yo' },
    { speaker: 'B', text: 'again' },
    { speaker: 'A', text: 'bye' },
  ];
  const speakers = [
    { label: 'A', name: 'Sam' },
    { label: 'B', name: null },
    { label: 'C', name: null },
  ];
  const out = applySpeakerNames(segments, speakers);
  assert.deepEqual(out.map((s) => s.speaker), ['Sam', 'Unknown 1', 'Unknown 2', 'Unknown 1', 'Sam']);
  // pure: original segments are untouched, new objects are returned
  assert.equal(segments[0].speaker, 'A');
  assert.notEqual(out[0], segments[0]);
});

test('effectiveStatus reports an interrupted live recording as recoverable, by last activity', () => {
  const now = Date.UTC(2026, 0, 2, 12);
  const fresh = { status: 'recording', created_at: now - 60_000 };
  assert.deepEqual(effectiveStatus(fresh, now), { status: 'recording', error: undefined, recoverable: false });

  const stale = { status: 'recording', created_at: now - STALE_RECORDING_MS - 1 };
  const out = effectiveStatus(stale, now);
  assert.equal(out.status, 'error');
  assert.equal(out.recoverable, true);
  assert.match(out.error, /interrupted/);
  assert.equal(STALE_RECORDING_MS, 15 * 60 * 1000);

  // A long recording that is still sending parts stays 'recording': status_at wins over created_at.
  const longButActive = { status: 'recording', created_at: now - 3 * 3600_000, status_at: now - 5_000 };
  assert.equal(effectiveStatus(longButActive, now).status, 'recording');

  // A row stuck at 'processing' (request killed mid-flight) is reaped, but not recoverable audio.
  const stuck = { status: 'processing', created_at: 0, status_at: now - STALE_PROCESSING_MS - 1 };
  assert.equal(effectiveStatus(stuck, now).status, 'error');
  assert.equal(effectiveStatus(stuck, now).recoverable, false);
  assert.equal(STALE_PROCESSING_MS, 20 * 60 * 1000);
  assert.equal(effectiveStatus({ status: 'processing', created_at: 0, status_at: now - 1000 }, now).status, 'processing');

  // A ready row is never rewritten; an existing error message is preserved.
  assert.equal(effectiveStatus({ status: 'ready', created_at: 0 }, now).status, 'ready');
  assert.equal(effectiveStatus({ status: 'recording', created_at: 0, error: 'boom' }, now).error, 'boom');
});

test('rebuildTranscript never blanks a transcript that has no segments', () => {
  // Non-diarized transcribers store segments = []. Rebuilding from them used to
  // return '' and wipe both the transcript and the FTS row on a speaker confirm.
  assert.equal(rebuildTranscript([], [], 'the original text'), 'the original text');
  assert.equal(rebuildTranscript(undefined, [], 'kept'), 'kept');
  assert.equal(
    rebuildTranscript([{ speaker: 'A', text: 'hi' }], [{ label: 'A', name: 'Sam' }], 'ignored'),
    'Sam: hi',
  );
});

test('filterSpeakerGuess rejects a fabricated quote', () => {
  const transcript = 'A: Hi, I\'m Sam, thanks for joining.\n\nB: Happy to be here.';
  // real, verbatim evidence is kept
  assert.deepEqual(
    filterSpeakerGuess({ name: 'Sam', evidence: "I'm Sam" }, transcript),
    { name: 'Sam', evidence: "I'm Sam" },
  );
  // evidence that never appears in the transcript is a fabrication -- drop the name
  assert.deepEqual(
    filterSpeakerGuess({ name: 'Taylor', evidence: "I'm definitely Taylor" }, transcript),
    { name: null, evidence: '' },
  );
  // no evidence at all is also a drop, never a free pass
  assert.deepEqual(filterSpeakerGuess({ name: 'Sam', evidence: '' }, transcript), { name: null, evidence: '' });
});

test('filterSpeakerGuess requires the name to appear in the evidence', () => {
  const transcript = "A: Let's get started.\n\nB: I'm Sam.";
  assert.deepEqual(
    filterSpeakerGuess({ name: 'Bob', evidence: "Let's get started" }, transcript),
    { name: null, evidence: '' },
  );
});

test('filterSpeakerGuess binds the evidence to the label\'s own turn or an adjacent one', () => {
  const segments = [
    { speaker: 'A', text: "Hi, I'm Sam, thanks for joining." },
    { speaker: 'B', text: 'Happy to be here.' },
    { speaker: 'A', text: 'Great.' },
    { speaker: 'C', text: 'Unrelated chatter.' },
    { speaker: 'C', text: 'More chatter.' },
  ];
  const transcript = diarizeToText(segments);
  const guess = { name: 'Sam', evidence: "I'm Sam" };
  assert.deepEqual(filterSpeakerGuess(guess, transcript, 'A', segments), { name: 'Sam', evidence: "I'm Sam" });
  // B is addressed right after A's turn, so adjacency allows it (being addressed by name)
  assert.equal(filterSpeakerGuess(guess, transcript, 'B', segments).name, 'Sam');
  // C sits far from the quote: a real quote from someone else's turn does not vouch for C
  assert.deepEqual(filterSpeakerGuess(guess, transcript, 'C', segments), { name: null, evidence: '' });
});

test('filterSpeakerGuess rejects placeholder names like "Unknown 2"', () => {
  const transcript = 'A: Unknown 2 said hello';
  for (const name of ['Unknown 2', 'unknown', 'Speaker 1', 'null', 'N/A']) {
    assert.equal(filterSpeakerGuess({ name, evidence: 'said hello' }, transcript).name, null, name);
  }
});

test('anonymousSpeakers gives one unconfirmed nameless entry per distinct label', () => {
  assert.deepEqual(
    anonymousSpeakers([{ speaker: 'A' }, { speaker: 'B' }, { speaker: 'A' }]),
    [{ label: 'A', name: null, evidence: '', confirmed: false }, { label: 'B', name: null, evidence: '', confirmed: false }],
  );
  assert.deepEqual(anonymousSpeakers(undefined), []);
});

test('nameSpeakers with refsSent skips inference entirely, even when nothing matched', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('inference must not run'); };
  try {
    const env = { DB: { prepare() { throw new Error('people lookup must not run'); } } };
    const segments = [{ speaker: 'A', text: "I'm Sam" }, { speaker: 'B', text: 'hi' }];
    const out = await nameSpeakers(env, 'o', segments, "A: I'm Sam\n\nB: hi", [], true);
    assert.deepEqual(out.map((s) => s.name), [null, null]);
    assert.ok(out.every((s) => s.confirmed === false));
  } finally { globalThis.fetch = origFetch; }
});

test('nameSpeakers refs branch names only matched labels and never marks them confirmed', async () => {
  const segments = [{ speaker: 'Sam', text: 'hi' }, { speaker: 'B', text: 'hey' }];
  const out = await nameSpeakers({}, 'o', segments, 'x', [{ label: 'Sam', name: 'Sam' }], true);
  assert.deepEqual(out, [
    { label: 'Sam', name: 'Sam', evidence: 'voiceprint match', confirmed: false },
    { label: 'B', name: null, evidence: '', confirmed: false },
  ]);
});

test('nameSpeakers nulls a name the model gave to two different labels', async () => {
  const origFetch = globalThis.fetch;
  const segments = [
    { speaker: 'A', text: "I'm Sam here." },
    { speaker: 'B', text: "No, I'm Sam too." },
    { speaker: 'C', text: "I'm Pat." },
  ];
  const transcript = diarizeToText(segments);
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ speakers: [
    { label: 'A', name: 'Sam', evidence: "I'm Sam" },
    { label: 'B', name: 'Sam', evidence: "I'm Sam" },
    { label: 'C', name: 'Pat', evidence: "I'm Pat" },
  ] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const env = { OPENAI_API_KEY: 'k', DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) } };
    const out = await nameSpeakers(env, 'o', segments, transcript);
    assert.deepEqual(out.map((s) => s.name), [null, null, 'Pat']);
  } finally { globalThis.fetch = origFetch; }
});

test('excerpt returns short transcripts whole and centres long ones on the question terms', () => {
  assert.equal(excerpt('short text', 'anything'), 'short text');
  const long = 'filler '.repeat(2000) + 'the pricing decision was made here ' + 'filler '.repeat(2000);
  const out = excerpt(long, 'what about pricing?', 3000);
  assert.ok(out.includes('pricing decision'), 'window should include the matched term');
  assert.ok(out.length <= 3100);
  // no match: just the head
  assert.ok(excerpt(long, 'zzzzqq', 3000).startsWith('filler'));
});

/* --- #3 deep research --- */
test('mergeHits dedupes by id across sub-question hit lists, first-seen order wins', () => {
  const a = { id: 'r1', title: 'Standup' };
  const b = { id: 'r2', title: 'Planning' };
  const bAgain = { id: 'r2', title: 'Planning (stale copy)' };
  const c = { id: 'r3', title: 'Retro' };
  const out = mergeHits([[a, b], [bAgain, c]], 10);
  assert.deepEqual(out, [a, b, c]);
});

test('mergeHits truncates to the cap without reordering', () => {
  const hits = [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }];
  assert.deepEqual(mergeHits([hits], 2), [{ id: 'r1' }, { id: 'r2' }]);
  assert.deepEqual(mergeHits([[]], 2), []);
});

test('deep research hard bounds are capped as designed', () => {
  assert.equal(MAX_SUB_QUESTIONS, 4);
  assert.equal(MAX_HITS, 12);
  assert.equal(MAX_MODEL_CALLS, 2);
});

test('deepResearch makes exactly the bounded model calls and reports them', async () => {
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    const content = calls === 1 ? JSON.stringify({ sub_questions: ['q1', 'q2'] }) : 'synthesized answer';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const hit = { id: 'r1', title: 'Standup', transcript: 'we talked', summary: 's' };
    const env = {
      OPENAI_API_KEY: 'k',
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [hit] }) }) }) },
    };
    const out = await deepResearch(env, 'o', 'what happened?');
    assert.equal(calls, MAX_MODEL_CALLS);
    assert.equal(out.model_calls, MAX_MODEL_CALLS);
    assert.deepEqual(out.sub_questions, ['q1', 'q2']);
    assert.equal(out.answer, 'synthesized answer');
  } finally { globalThis.fetch = origFetch; }
});
/* --- /#3 deep research --- */

/* --- #7 live transcription --- */
test('appendLive trims each side and joins with one space', () => {
  assert.equal(appendLive('Hello', 'world'), 'Hello world');
  assert.equal(appendLive('  Hello  ', '  world  '), 'Hello world');
  assert.equal(appendLive('', 'world'), 'world');
  assert.equal(appendLive('Hello', ''), 'Hello');
  assert.equal(appendLive('', ''), '');
  assert.equal(appendLive(null, 'world'), 'world');
});

test('appendLive caps at ~20000 chars, keeping the tail', () => {
  const prev = 'a'.repeat(19995);
  const out = appendLive(prev, 'bbbbbbbbbb'); // pushes well past the cap
  assert.equal(out.length, 20000);
  assert.ok(out.endsWith('bbbbbbbbbb'));
  assert.ok(!out.includes('c')); // sanity: nothing but a's and b's went in
});
/* --- /#7 live transcription --- */

/* --- #14 voiceprint enrollment --- */
test('encodeWav writes a canonical 16-bit mono RIFF/WAVE header', () => {
  const samples = new Float32Array([0, 0.5, -1, 1, -0.5]);
  const wav = encodeWav(samples, 16000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const str4 = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));

  assert.equal(wav.length, 44 + samples.length * 2); // header + 16-bit mono data
  assert.equal(str4(0), 'RIFF');
  assert.equal(str4(8), 'WAVE');
  assert.equal(str4(12), 'fmt ');
  assert.equal(str4(36), 'data');
  assert.equal(view.getUint16(20, true), 1);  // PCM
  assert.equal(view.getUint16(22, true), 1);  // mono
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16); // bits per sample
  assert.equal(view.getUint32(40, true), samples.length * 2);
  // round-trips through 16-bit quantization within one LSB
  assert.equal(view.getInt16(44, true), 0);
  assert.ok(Math.abs(view.getInt16(44 + 2 * 2, true) - (-32768)) <= 1);
  assert.ok(Math.abs(view.getInt16(44 + 3 * 2, true) - 32767) <= 1);
});

test('wavDurationMs reads duration back from encodeWav output', () => {
  const samples = new Float32Array(32000); // 2s at 16kHz
  assert.equal(wavDurationMs(encodeWav(samples, 16000)), 2000);
  assert.equal(wavDurationMs(new Uint8Array([1, 2, 3, 4])), null); // not a WAV at all
});

// Segment times are SECONDS (diarized_json), and so is the returned window.
test('pickClipWindow picks the speaker\'s longest turn, capped at maxMs (seconds in, seconds out)', () => {
  const segments = [
    { speaker: 'A', text: 'short', start: 0, end: 1 },
    { speaker: 'B', text: 'long one', start: 2, end: 17 }, // 15s turn
    { speaker: 'A', text: 'another', start: 18, end: 19.5 },
  ];
  assert.deepEqual(pickClipWindow(segments, 'B', 2000, 10000), { start: 2, end: 12 });
  assert.deepEqual(pickClipWindow(segments, 'A', 1000, 10000), { start: 18, end: 19.5 });
});

test('pickClipWindow returns null for a turn shorter than minMs instead of a clip the server rejects', () => {
  const segments = [{ speaker: 'A', text: 'hi', start: 1, end: 1.8 }]; // 0.8s, under the 2s floor
  assert.equal(pickClipWindow(segments, 'A', 2000, 10000), null);
});

test('pickClipWindow returns null when the label has no segments', () => {
  assert.equal(pickClipWindow([{ speaker: 'A', start: 0, end: 5 }], 'B', 2000, 10000), null);
  assert.equal(pickClipWindow(undefined, 'A', 2000, 10000), null);
});

test('selectVoiceprints returns the newest clip per person, capped at the limit', async () => {
  const rows = [
    { id: 'v5', person_id: 'p1', name: 'Sam' }, { id: 'v4', person_id: 'p1', name: 'Sam' },
    { id: 'v3', person_id: 'p2', name: 'Pat' }, { id: 'v2', person_id: 'p3', name: 'Lee' },
    { id: 'v1', person_id: 'p4', name: 'Kim' },
  ];
  const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } };
  assert.deepEqual((await selectVoiceprints(env, 'o', 4)).map((r) => r.id), ['v5', 'v3', 'v2', 'v1']);
  assert.deepEqual((await selectVoiceprints(env, 'o', 2)).map((r) => r.id), ['v5', 'v3']);
});

test('speakerRefsForm sends base64 data URLs, skips empty blobs, and returns only what it sent', () => {
  const fd = new FormData();
  const refs = [{ person_id: 'p1', name: 'Sam' }, { person_id: 'p2', name: 'Pat' }];
  const sent = speakerRefsForm(fd, refs, [new Uint8Array([1, 2, 3]).buffer, new ArrayBuffer(0)]);
  assert.deepEqual(sent, [refs[0]]);
  assert.deepEqual(fd.getAll('known_speaker_names[]'), ['Sam']);
  const [ref] = fd.getAll('known_speaker_references[]');
  assert.equal(ref, 'data:audio/wav;base64,' + Buffer.from([1, 2, 3]).toString('base64'));
});

test('matchedSpeakerRefs pledges only labels that literally match a known reference name', () => {
  const segments = [{ speaker: 'Sam', text: 'hi' }, { speaker: 'B', text: 'hey' }];
  const refs = [{ person_id: 'p1', name: 'Sam' }, { person_id: 'p2', name: 'Taylor' }];
  assert.deepEqual(matchedSpeakerRefs(segments, refs), [{ label: 'Sam', name: 'Sam' }]);
  assert.deepEqual(matchedSpeakerRefs(segments, []), []);
  assert.deepEqual(matchedSpeakerRefs(undefined, refs), []);
});
/* --- /#14 voiceprint enrollment --- */

import { llmUrl, llmHeaders } from '../src/llm.js';
import { modelsFor, defaultModel } from '../src/config.js';

test('llm endpoint defaults to OpenAI and honors LLM_BASE_URL / LLM_API_KEY', () => {
  assert.equal(llmUrl({}), 'https://api.openai.com/v1/chat/completions');
  assert.equal(llmHeaders({ OPENAI_API_KEY: 'o' }).authorization, 'Bearer o');
  const env = { LLM_BASE_URL: 'https://openrouter.ai/api/v1/', LLM_API_KEY: 'r', OPENAI_API_KEY: 'o', LLM_MODELS: 'a/b, c/d' };
  assert.equal(llmUrl(env), 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(llmHeaders(env).authorization, 'Bearer r');
  assert.deepEqual(modelsFor(env).map((m) => m.id), ['a/b', 'c/d']);
  assert.equal(defaultModel(env), 'a/b');
  assert.equal(modelById('c/d', env).id, 'c/d');
  assert.equal(modelById('gpt-6-luna', env), null);
});

test('STT_BASE_URL / STT_MODELS redirect transcription and replace the transcriber list', async () => {
  const { sttUrl } = await import('../src/llm.js');
  const { transcribersFor, transcriberById, previewTranscriber } = await import('../src/config.js');
  assert.equal(sttUrl({}), 'https://api.openai.com/v1/audio/transcriptions');
  const env = { STT_BASE_URL: 'https://openrouter.ai/api/v1', STT_MODELS: 'openai/whisper-large-v3-turbo' };
  assert.equal(sttUrl(env), 'https://openrouter.ai/api/v1/audio/transcriptions');
  assert.equal(transcribersFor(env)[0].id, 'openai/whisper-large-v3-turbo');
  assert.equal(transcriberById('nope', env).id, 'openai/whisper-large-v3-turbo');
  assert.equal(previewTranscriber(env), 'openai/whisper-large-v3-turbo');
  assert.equal(previewTranscriber({}), 'gpt-transcribe');
});

test('openRouterSegments folds per-word speaker ids into A/B turns', async () => {
  const { openRouterSegments, sttDiarizes } = await import('../src/stt.js');
  const words = [
    { word: 'Hi', start: 0, end: 0.2, speaker: 3 }, { word: 'there.', start: 0.2, end: 0.5, speaker: 3 },
    { word: '[laugh]', type: 'audio_event', start: 0.5, end: 0.6, speaker: 3 },
    { word: 'Hello', start: 1, end: 1.3, speaker: 0 }, { word: 'back.', start: 1.3, end: 1.6, speaker: 0 },
    { word: 'Great', start: 2, end: 2.2, speaker: 3 },
  ];
  assert.deepEqual(openRouterSegments({ words }), [
    { speaker: 'A', text: 'Hi there.', start: 0, end: 0.5 },
    { speaker: 'B', text: 'Hello back.', start: 1, end: 1.6 },
    { speaker: 'A', text: 'Great', start: 2, end: 2.2 },
  ]);
  // falls back to segment-level speakers, and to [] when nothing is labeled
  assert.equal(openRouterSegments({ segments: [{ text: 'x', speaker: 1, start: 0, end: 1 }] })[0].speaker, 'A');
  assert.deepEqual(openRouterSegments({ text: 'plain', words: [{ word: 'plain' }] }), []);
  const or = { STT_BASE_URL: 'https://openrouter.ai/api/v1' };
  assert.equal(sttDiarizes(or, 'elevenlabs/scribe-v2'), true);
  assert.equal(sttDiarizes(or, 'openai/whisper-large-v3-turbo'), false);
  assert.equal(sttDiarizes({}, 'elevenlabs/scribe-v2'), false);
});

test('effectiveTranscriber maps an id the current provider does not offer to its first model', async () => {
  const { effectiveTranscriber } = await import('../src/config.js');
  const or = { STT_BASE_URL: 'https://openrouter.ai/api/v1', STT_MODELS: 'openai/whisper-large-v3-turbo,elevenlabs/scribe-v2' };
  assert.equal(effectiveTranscriber(or, 'gpt-4o-transcribe-diarize'), 'openai/whisper-large-v3-turbo');
  assert.equal(effectiveTranscriber(or, 'elevenlabs/scribe-v2'), 'elevenlabs/scribe-v2');
  assert.equal(effectiveTranscriber({}, 'gpt-4o-transcribe-diarize', Date.parse('2026-12-01')), 'gpt-4o-transcribe-diarize');
  assert.equal(effectiveTranscriber({}, 'openai/whisper-large-v3-turbo'), 'gpt-4o-transcribe-diarize'); // switched back to OpenAI
});

test('streaming base64 JSON body matches Buffer base64 for awkward sizes', async () => {
  const { jsonAudioBody, base64Length } = await import('../src/stream.js');
  for (const n of [0, 1, 2, 3, 4, 29999, 30000, 30001, 100003]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);
    // feed in uneven chunks so the 3-byte carry is exercised
    const chunks = []; for (let i = 0; i < n;) { const k = 1 + ((i * 7) % 977); chunks.push(bytes.slice(i, i + k)); i += k; }
    const src = new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } });
    const head = '{"a":1,"input_audio":{"data":"', tail = '"}}';
    const text = await new Response(jsonAudioBody(src, head, tail)).text();
    assert.equal(text, head + Buffer.from(bytes).toString('base64') + tail, `n=${n}`);
    assert.equal(JSON.parse(text).input_audio.data.length, base64Length(n));
  }
});

test('maxUpload is 24MB on OpenAI and larger on OpenRouter', async () => {
  const { maxUpload } = await import('../src/config.js');
  assert.equal(maxUpload({}), 24 * 1048576);
  assert.equal(maxUpload({ STT_BASE_URL: 'https://openrouter.ai/api/v1' }), 48 * 1048576);
});

/* --- #24 voice matching --- */
const vec = (i, noise = 0, j = 1) => Array.from({ length: 192 }, (_, k) => (k === i ? 1 : 0) + (k === j ? noise : 0));
const P = (id, name, ...embeddings) => ({ person_id: id, name, embeddings });
const L = (label, embedding, speech_ms = 9000) => ({ label, embedding, speech_ms });

test('normalizeEmbedding rejects wrong length, NaN and all-zero input, and L2-normalises', () => {
  assert.equal(normalizeEmbedding([1, 2, 3]), null);
  assert.equal(normalizeEmbedding(null), null);
  assert.equal(normalizeEmbedding(vec(0).map((x, i) => (i === 3 ? NaN : x))), null);
  assert.equal(normalizeEmbedding(vec(0).map((x, i) => (i === 3 ? 'a' : x))), null);
  assert.equal(normalizeEmbedding(new Array(192).fill(0)), null);
  const n = normalizeEmbedding(vec(0).map((x) => x * 5));
  assert.ok(Math.abs(n[0] - 1) < 1e-12);
});

test('matchVoices accepts above threshold with margin, rejects below threshold or within margin', () => {
  const sam = P('s', 'Sam', vec(0)), pat = P('p', 'Pat', vec(10));
  const hit = matchVoices([L('A', vec(0, 0.1))], [sam, pat]);
  assert.equal(hit.assignments[0].name, 'Sam');
  assert.ok(hit.assignments[0].score > 0.99);

  assert.deepEqual(matchVoices([L('A', vec(50))], [sam, pat]).assignments, []); // orthogonal: below threshold

  // Equidistant from two people: above threshold but no margin -> no guess.
  const mid = vec(0).map((x, i) => x + (i === 10 ? 1 : 0));
  assert.deepEqual(matchVoices([L('A', mid)], [sam, pat], { threshold: 0.5 }).assignments, []);
});

test('matchVoices is one-to-one and best score wins; max over a person\'s clips', () => {
  const sam = P('s', 'Sam', vec(0), vec(20));
  const r = matchVoices([L('A', vec(0, 0.3)), L('B', vec(0, 0.1))], [sam]);
  assert.deepEqual(r.assignments.map((a) => a.label), ['B']); // B is closer; A cannot also be Sam
  const clip2 = matchVoices([L('A', vec(20))], [sam]);
  assert.equal(clip2.assignments[0].name, 'Sam');
});

test('matchVoices skips labels with too little speech and honours exclude', () => {
  const sam = P('s', 'Sam', vec(0));
  assert.deepEqual(matchVoices([L('A', vec(0), 3999)], [sam]).assignments, []);
  assert.equal(matchVoices([L('A', vec(0), 4000)], [sam]).assignments.length, 1);
  assert.deepEqual(matchVoices([L('A', vec(0))], [sam], { exclude: new Set(['s']) }).assignments, []);
  assert.deepEqual(matchVoices([L('A', vec(0))], []).assignments, []);
});

test('applyVoiceMatches: never touches confirmed, keeps agreeing names, nulls conflicts, fills unnamed, no duplicate names', () => {
  const sp = [
    { label: 'A', name: 'Sam', evidence: 'x', confirmed: true },
    { label: 'B', name: 'Pat', evidence: 'thanks Pat', confirmed: false },
    { label: 'C', name: 'Lee', evidence: 'hi Lee', confirmed: false },
    { label: 'D', name: null, evidence: '', confirmed: false },
    { label: 'E', name: null, evidence: '', confirmed: false },
  ];
  const as = [
    { label: 'A', name: 'Zed', person_id: 'z', score: 0.9 },
    { label: 'B', name: 'pat', person_id: 'p', score: 0.81 },
    { label: 'C', name: 'Kim', person_id: 'k', score: 0.7 },
    { label: 'D', name: 'Ann', person_id: 'a', score: 0.66 },
    { label: 'E', name: 'Sam', person_id: 's', score: 0.9 }, // Sam is already confirmed on A
  ];
  const { speakers, changed } = applyVoiceMatches(sp, as);
  const by = Object.fromEntries(speakers.map((s) => [s.label, s]));
  assert.deepEqual(by.A, sp[0]);
  assert.equal(by.B.name, 'Pat');
  assert.equal(by.B.evidence, 'voice match 0.81 + transcript');
  assert.equal(by.C.name, null);
  assert.match(by.C.evidence, /conflict: transcript says Lee, voice says Kim/);
  assert.deepEqual([by.D.name, by.D.evidence, by.D.confirmed], ['Ann', 'voice match 0.66', false]);
  assert.equal(by.E.name, null);
  assert.equal(changed, true);
  assert.equal(applyVoiceMatches(sp, []).changed, false);
  assert.equal(applyVoiceMatches([sp[1]], [as[1]]).changed, false); // agreement alone changes no name
});
/* --- /#24 --- */

/* --- Today screen helpers --- */
test('validDate and weekStart (Monday-based, UTC maths)', () => {
  assert.equal(validDate('2026-11-10'), '2026-11-10');
  for (const bad of ['2026-13-40', '11/10/2026', '', null, undefined, 20261110]) assert.equal(validDate(bad), null);
  assert.equal(weekStart('2026-11-10'), '2026-11-09'); // Tuesday -> Monday
  assert.equal(weekStart('2026-11-09'), '2026-11-09');
  assert.equal(weekStart('2026-11-15'), '2026-11-09'); // Sunday belongs to the Monday before
  assert.equal(weekStart('2026-01-01'), '2025-12-29'); // across a year boundary
});

test('openItems: skips done, ranks overdue then slipping, future ISO dues are neither', () => {
  const day = 86400000, now = Date.parse('2026-11-10T00:00:00Z');
  const rows = [{ id: 'a', title: 'A', created_at: now - 20 * day, action_items: [
    { task: 'old free text', due: 'Friday' }, { task: 'past iso', due: '2026-11-01' }, { task: 'future iso', due: '2026-12-01' },
    { task: 'finished', done: true }, null, { owner: 'no task' },
  ] }, { id: 'b', title: 'B', created_at: now - 1 * day, action_items: [{ task: 'fresh' }] }];
  const out = openItems(rows, '2026-11-10');
  assert.deepEqual(out.map((x) => [x.task, x.overdue, x.slipping]), [
    ['past iso', true, false], ['old free text', false, true], ['future iso', false, false], ['fresh', false, false]]);
  assert.deepEqual(openItems([{ id: 'x', created_at: 0, action_items: 'bad' }], '2026-11-10'), []);
});

test('talkStats measures share, turns, questions, longest turn and overlaps by speaker name', () => {
  const segs = [
    { speaker: 'A', text: 'Hello. What do you think?', start: 0, end: 10 },
    { speaker: 'B', text: 'Fine.', start: 10, end: 12 },
    { speaker: 'A', text: 'Really? Sure?', start: 11.5, end: 20 },  // starts before B ended: overlap
  ];
  const out = talkStats(segs, [{ label: 'A', name: 'Jeff' }, { label: 'B', name: null }]);
  assert.deepEqual(out.map((r) => r.name), ['Jeff', 'Unknown 1']);
  assert.equal(out[0].turns, 2);
  assert.equal(out[0].questions, 3);
  assert.equal(out[0].longest_s, 10);
  assert.equal(out[0].overlaps, 1);
  assert.equal(out[1].overlaps, 0);
  assert.ok(Math.abs(out[0].share + out[1].share - 1) < 1e-9);
  assert.deepEqual(talkStats([], []), []);
  assert.deepEqual(talkStats(undefined, undefined), []);
});

test('buildContext filters by window and person, bounds the size, and quotes safely', () => {
  const day = 86400000, now = Date.now();
  const rows = Array.from({ length: 30 }, (_, i) => ({
    id: String(i), title: `T"${i}`, created_at: now - i * 1000, summary: 's', transcript: 'x'.repeat(10000),
    speakers: [{ name: i % 2 ? 'Ben' : 'Amy' }], action_items: [{ task: 'do', owner: 'Ben', done: i === 0 }], unanswered: ['why?'],
  }));
  const all = buildContext(rows, { since: 0 });
  assert.equal(all.sources.length, 12);
  assert.ok(all.text.length < 60000);
  assert.equal(buildContext(rows, { since: 0, deep: true }).sources.length, 20);
  const ben = buildContext(rows, { since: 0, person: 'ben' });
  assert.ok(ben.sources.every((s) => Number(s.id) % 2 === 1));
  assert.equal(buildContext(rows, { since: now + day }).sources.length, 0);
  assert.ok(!all.text.includes('title="T"0"'), 'quotes in titles are neutralised');
  assert.equal(involves({ speakers: [], transcript: 'talked to BEN today' }, 'ben'), true);
  assert.equal(involves({ speakers: [], transcript: '' }, 'ben'), false);
  assert.equal(involves({ speakers: [], transcript: '' }, ''), true);
});

/* --- structured memory --- */
test('normalizeFacts keeps only verbatim-quoted, well-formed facts and cleans the person', () => {
  const tx = 'Jeff: I will send the contract\non Friday.  Ben: we decided to launch in December.';
  const out = normalizeFacts([
    { kind: 'commitment', person: 'Jeff', text: 'Jeff sends contract', quote: 'I will send the contract on Friday' }, // whitespace differs: still verbatim
    { kind: 'decision', person: 'Unknown 1', text: 'Launch in December', quote: 'we decided to launch in december' },    // person dropped, case-insensitive
    { kind: 'decision', text: 'Launch in December', quote: 'we decided to launch in December' },                        // duplicate
    { kind: 'decision', text: 'Invented', quote: 'we never said this' },
    { kind: 'gossip', text: 'bad kind', quote: 'Ben' },
    { kind: 'fact', text: '', quote: 'Ben' },
    { kind: 'fact', text: 'x'.repeat(301), quote: 'Ben' },
    null, 'str',
  ], tx);
  assert.deepEqual(out.map((f) => [f.kind, f.person, f.text]), [['commitment', 'Jeff', 'Jeff sends contract'], ['decision', null, 'Launch in December']]);
  assert.deepEqual(normalizeFacts('nope', tx), []);
  const many = Array.from({ length: 40 }, (_, i) => ({ kind: 'fact', text: `t${i}`, quote: 'Ben' }));
  assert.equal(normalizeFacts(many, tx).length, 25);
});

test('chunkText overlaps at word boundaries and caps; buildChunks has stable ids and typed chunks', () => {
  const text = Array.from({ length: 600 }, (_, i) => `w${i}`).join(' ');
  const chunks = chunkText(text, 200, 40);
  assert.ok(chunks.length > 10);
  assert.ok(chunks.every((c) => c.length <= 200 && !c.startsWith(' ')));
  assert.ok(chunks[1].startsWith(chunks[0].split(' ').slice(-2)[0]) || chunks[0].includes(chunks[1].split(' ')[0]), 'chunks overlap');
  assert.equal(chunkText(text, 200, 40, 3).length, 3);
  assert.deepEqual(chunkText(''), []);
  const bc = buildChunks({ id: 'r', title: 'T', created_at: 0, summary: 'sum', transcript: 'hello world' }, [{ kind: 'decision', person: null, text: 'd', quote: 'q' }]);
  assert.deepEqual(bc.map((c) => [c.id, c.kind]), [['r:0', 'summary'], ['r:1', 'fact'], ['r:2', 'transcript']]);
  assert.match(bc[0].text, /1970-01-01/);
});

test('chunksToHits groups passages per recording in best-first order and bounds the text', () => {
  const hits = chunksToHits([
    { rec: 'a', title: 'A', text: 'one' }, { rec: 'b', title: 'B', text: 'two' }, { rec: 'a', title: 'A', text: 'three' },
  ]);
  assert.deepEqual(hits.map((h) => h.id), ['a', 'b']);
  assert.match(hits[0].transcript, /one\n…\nthree/);
  assert.equal(chunksToHits([{ rec: 'a', title: 'A', text: 'x'.repeat(5000) }])[0].transcript.length, 2800);
  assert.equal(vectorsEnabled({}), false);
  assert.equal(vectorsEnabled({ AI: { run() {} }, VECTORS: { upsert() {}, query() {} } }), true);
});

/* --- merging people --- */
test('suggestMerges pairs a name with a fuller version of itself, on whole words only', () => {
  const P = (id, name) => ({ id, name });
  const out = suggestMerges([P(1, 'Jeff'), P(2, 'Jeff Eberhard'), P(3, 'Al'), P(4, 'Alex Smith'), P(5, 'jeff'), P(6, 'Pat Lee'), P(7, 'Pat Kim')]);
  const pairs = out.map((x) => `${x.from_name}>${x.into_name}`).sort();
  assert.deepEqual(pairs, ['Jeff>Jeff Eberhard', 'Jeff>jeff', 'jeff>Jeff Eberhard']);
  // different people who merely share a first name are not suggested
  assert.ok(!pairs.some((p) => p.includes('Pat')));
  assert.deepEqual(suggestMerges([]), []);
  assert.deepEqual(suggestMerges([{ id: 1, name: '' }, null]), []);
});

test('renameSpeaker renames matching labels only and keeps confirmed; mergeAliases dedupes', () => {
  const sp = [{ label: 'A', name: 'Jeff', confirmed: true, evidence: 'e' }, { label: 'B', name: 'Ben', confirmed: false }, { label: 'C', name: null }];
  const r = renameSpeaker(sp, 'Jeff', 'Jeff Eberhard');
  assert.equal(r.changed, true);
  assert.deepEqual(r.speakers[0], { label: 'A', name: 'Jeff Eberhard', confirmed: true, evidence: 'e' });
  assert.deepEqual(r.speakers.slice(1), sp.slice(1));
  assert.equal(renameSpeaker(sp, 'Nobody', 'X').changed, false);
  assert.equal(mergeAliases('JE, Jeffrey', ['Jeff', 'je', ''], 'Jeff Eberhard'), 'JE, Jeffrey, Jeff');
  assert.equal(mergeAliases(null, ['Jeff Eberhard'], 'Jeff Eberhard'), '');
});

test('pickClipWindow treats a segment with no speaker key as the single "Speaker" (plain timestamped transcript)', () => {
  const segs = [{ text: 'a', start: 0, end: 3 }, { text: 'b', start: 3, end: 14 }];
  assert.deepEqual(pickClipWindow(segs, 'Speaker', 2000, 10000), { start: 3, end: 13 });
  assert.equal(pickClipWindow(segs, 'A', 2000, 10000), null, 'a labelled lookup does not claim unlabelled segments');
  assert.deepEqual(pickClipWindow([{ speaker: 'A', start: 0, end: 5 }, { start: 5, end: 9 }], 'A', 2000, 10000), { start: 0, end: 5 });
});

test('reassignSegments: move turns, create a new speaker, order by first appearance, report who vanished', () => {
  const seg = (sp) => ({ speaker: sp, text: 't', start: 0, end: 1 });
  const segs = [seg('A'), seg('B'), seg('A'), seg('C')];
  const sp = [{ label: 'A', name: 'Jeff', confirmed: true }, { label: 'B', name: null, confirmed: false }, { label: 'C', name: 'Kev', confirmed: false }];

  const m = reassignSegments(segs, sp, [3, 1], 'A');
  assert.deepEqual(m.segments.map((x) => x.speaker), ['A', 'A', 'A', 'A']);
  assert.deepEqual(m.speakers.map((x) => x.label), ['A']);
  assert.deepEqual(m.removed, ['Kev'], 'only named speakers are reported');

  const n = reassignSegments(segs, sp, [0], 'new');
  assert.equal(n.target, 'D', 'A, B and C are taken');
  assert.deepEqual(n.speakers.map((x) => x.label), ['D', 'B', 'A', 'C'], 'ordered by first appearance, which is how Unknown N is numbered');
  assert.deepEqual(n.speakers.find((x) => x.label === 'D'), { label: 'D', name: null, evidence: '', confirmed: false });
  assert.deepEqual(n.speakers.find((x) => x.label === 'A'), sp[0], 'untouched speakers are the same objects');

  assert.equal(reassignSegments(segs, sp, [9], 'A').error, 'no such segments');
  assert.equal(reassignSegments(segs, sp, [], 'A').error, 'no such segments');
  assert.equal(reassignSegments(segs, sp, [0.5], 'A').error, 'no such segments');
  assert.equal(reassignSegments(segs, sp, [0], 'Q').error, 'no such speaker');
  assert.equal(reassignSegments([], sp, [0], 'A').error, 'no such segments');
  assert.equal(reassignSegments(segs, sp, [0, 0, 0], 'B').segments.filter((x) => x.speaker === 'B').length, 2, 'duplicate indices are one move');

  // twelve speakers already: nowhere to put a new one
  const full = 'ABCDEFGHIJKL'.split('').map((l) => ({ label: l, name: null, confirmed: false }));
  assert.equal(reassignSegments(full.map((x) => seg(x.label)), full, [0], 'new').error, 'too many speakers');

  // segments with no speaker key are the "Speaker"; a new speaker can be split off them
  const plain = reassignSegments([{ text: 'x', start: 0, end: 1 }, { text: 'y', start: 1, end: 2 }], [{ label: 'Speaker', name: null, confirmed: false }], [1], 'new');
  assert.deepEqual(plain.segments.map((x) => x.speaker), [undefined, 'A']);
  assert.deepEqual(plain.speakers.map((x) => x.label), ['Speaker', 'A']);
});

import { withRateLimitRetry } from '../src/llm.js';
test('withRateLimitRetry waits out 429s then returns the success', async () => {
  const waits = [];
  let n = 0;
  const r = await withRateLimitRetry(async () => (++n < 3 ? new Response('x', { status: 429, headers: { 'retry-after': '1' } }) : new Response('ok')),
    { sleep: async (ms) => waits.push(ms) });
  assert.equal(r.status, 200);
  assert.equal(n, 3);
  assert.deepEqual(waits, [1000, 2000]);
});
test('withRateLimitRetry gives up after the last try and returns the 429', async () => {
  const r = await withRateLimitRetry(async () => new Response('x', { status: 429 }), { tries: 2, sleep: async () => {} });
  assert.equal(r.status, 429);
});

import { isListedFact, UNTAGGED_LISTED_MS } from '../src/memory.js';
test('isListedFact: named people always, unnamed only for a week after the recording', () => {
  const now = 1_000_000_000_000;
  assert.equal(isListedFact({ person: 'Ben', created_at: now - 365 * 86400000 }, now), true);
  assert.equal(isListedFact({ person: null, created_at: now - 6.9 * 86400000 }, now), true);
  assert.equal(isListedFact({ person: null, created_at: now - UNTAGGED_LISTED_MS - 1000 }, now), false);
  assert.equal(isListedFact({ person: '', created_at: now - 30 * 86400000 }, now), false);
});

import { isPlaceholderName } from '../src/text.js';
test('isPlaceholderName: placeholders with a digit or a single letter, never real names', () => {
  for (const n of ['Speaker 0', 'Speaker K', 'speaker_01', 'SPEAKER J', 'Unknown', 'Unknown 3', 'User 2', 'spk b', ' Speaker  ']) assert.equal(isPlaceholderName(n), true, n);
  for (const n of ['Jeff', 'Jeff Eberhard', 'Speaker Smith', 'Kate', 'Use', '', null, undefined]) assert.equal(isPlaceholderName(n), false, String(n));
});
test('a placeholder name never shows up as a speaker: it becomes Unknown N', () => {
  const segs = [{ speaker: 'A', text: 'hi' }, { speaker: 'B', text: 'yo' }, { speaker: 'C', text: 'hey' }];
  const out = applySpeakerNames(segs, [{ label: 'A', name: 'Speaker K' }, { label: 'B', name: 'Jeff' }, { label: 'C', name: 'Speaker 4' }]);
  assert.deepEqual(out.map((s) => s.speaker), ['Unknown 1', 'Jeff', 'Unknown 2']);
});
