// Hallucination guard. Speech models invent text over silence and room noise: a phrase
// repeated dozens of times ("Thank you." x80), or words in a script nobody spoke (Russian
// or Japanese on an English call). Recordings started and stopped by hand (a Pocket pendant)
// always have that dead air at both ends. The guard removes the junk and keeps the speech.
// Switch: HALLUCINATION_GUARD=off in settings. Language: STT_LANGUAGE (e.g. "en").

export const guardOn = (env) => String(env?.HALLUCINATION_GUARD || 'on').toLowerCase() !== 'off';

const RUN_MIN = 5;        // a phrase repeated this many times in a row is not speech
const MAX_PHRASE = 6;     // longest repeated phrase (in words) we look for
const NON_LATIN = /[\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}\p{Script=Greek}]/u;

const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

// Drop every run of RUN_MIN+ repetitions of the same 1..MAX_PHRASE-word phrase.
export function dropRepeatedRuns(text) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const keys = words.map(norm);
  const out = [];
  for (let i = 0; i < words.length;) {
    let dropped = 0;
    for (let n = 1; n <= MAX_PHRASE && !dropped; n++) {
      if (i + n * RUN_MIN > words.length || !keys[i]) continue;
      let reps = 1;
      while (i + (reps + 1) * n <= words.length
        && keys.slice(i, i + n).every((k, j) => k === keys[i + reps * n + j])) reps++;
      if (reps >= RUN_MIN) dropped = reps * n;
    }
    if (dropped) i += dropped; else out.push(words[i++]);
  }
  return out.join(' ');
}

// With English expected, words in another script are noise, not speech.
export function dropForeignScript(text) {
  return String(text || '').split(/\s+/).filter((w) => w && !NON_LATIN.test(w)).join(' ');
}

export function cleanText(text, lang) {
  let t = dropRepeatedRuns(text);
  if (String(lang || '').toLowerCase().startsWith('en')) t = dropForeignScript(t);
  return dropRepeatedRuns(t);
}

// Clean each diarized turn and drop the ones that end up empty.
export function cleanSegments(segments, lang) {
  return (segments || [])
    .map((s) => ({ ...s, text: cleanText(s.text, lang) }))
    .filter((s) => s.text);
}
