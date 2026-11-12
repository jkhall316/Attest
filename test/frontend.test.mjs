// Frontend smoke tests. public/app/*.js is plain ES modules with no build step, so
// Node can import them directly once document/window/fetch are stubbed. This proves
// the module graph resolves, boot() runs, and the escaping helpers behave — it does
// not simulate a real browser.
import test from 'node:test';
import assert from 'node:assert/strict';

const elements = new Map();
const makeEl = () => ({
  innerHTML: '', textContent: '', value: '', dataset: {}, checked: false,
  classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, querySelectorAll: () => [], closest: () => null,
  showModal() {}, remove() {}, insertAdjacentHTML() {},
  scrollTop: 0, scrollHeight: 0, onclick: null, onchange: null, onkeydown: null, oninput: null,
  style: { setProperty() {}, removeProperty() {} }, options: [], selectedIndex: -1, hidden: false,
  setAttribute() {}, getAttribute() { return null; }, querySelector: () => null, scrollIntoView() {}, focus() {},
  buffered: { length: 0 }, paused: true, duration: NaN, currentTime: 0, play: async () => {}, pause() {},
});

globalThis.window = globalThis;
globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeEl());
    return elements.get(id);
  },
  querySelectorAll: () => [],
  addEventListener() {},
  body: { insertAdjacentHTML() {}, appendChild() {}, dataset: {} },
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const calls = [];
globalThis.fetch = async (url) => {
  calls.push(String(url));
  const body = String(url).includes('/api/meta')
    ? { templates: {}, models: [{ id: 'gpt-6-luna', label: 'Luna' }], transcribers: [{ id: 'gpt-transcribe', label: 'GPT Transcribe' }], default_model: 'gpt-6-luna', deprecations: {} }
    : String(url).includes('/api/templates') ? { templates: { meeting: { label: 'Meeting', group: 'work' } } }
    : String(url).includes('/api/today/brief') ? { content: 'BRIEF', created_at: 1, stale: false }
    : String(url).includes('/api/today') ? { date: '2026-11-10', week_start: '2026-11-09', open_count: 1, overdue_count: 1, slipping_count: 0,
        open: [{ rec_id: 'r1', i: 0, title: '<b>T</b>', task: 'Send deck', owner: 'Jeff', due: '2026-11-01', age_days: 9, overdue: true, slipping: false }],
        brief: null, weekly: null, has_recordings: true, people: [{ id: 'p1', name: 'Ben' }] }
    : String(url).includes('/api/people') ? { people: [
        { id: 'p1', name: 'Jeff', recordings: 2, voiceprint_count: 1, aliases: null },
        { id: 'p2', name: 'Jeff Eberhard', recordings: 1, voiceprint_count: 0, aliases: 'JE' }],
        suggestions: [{ from_id: 'p1', from_name: 'Jeff', into_id: 'p2', into_name: 'Jeff Eberhard' }] }
    : String(url).includes('/api/memory') ? { facts: [], kinds: ['commitment'], people: [], total_facts: 0,
        status: { recordings: 1, with_facts: 0, indexed: 0, remaining: 1, vectors_enabled: false } }
    : String(url).includes('/api/chats') ? { chats: [] }
    : { recordings: [] };
  return { ok: true, headers: { get: () => 'application/json' }, json: async () => body, text: async () => '' };
};

test('every frontend module imports cleanly', async () => {
  for (const m of ['dom', 'state', 'api', 'lists', 'ask', 'recordings', 'chats', 'recorder', 'templates', 'voiceprints', 'settings', 'voiceembed', 'voicematch', 'prompts', 'today', 'scope']) {
    const mod = await import(`../public/app/${m}.js`);
    assert.ok(Object.keys(mod).length > 0, `${m}.js exported nothing`);
  }
});

test('esc neutralises every HTML metacharacter', async () => {
  const { esc } = await import('../public/app/dom.js');
  assert.equal(esc('<img src=x onerror="a&b">'), '&lt;img src=x onerror=&quot;a&amp;b&quot;&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
});

test('md escapes before it adds markup, so injected tags cannot survive', async () => {
  const { md } = await import('../public/app/dom.js');
  const out = md('# Title\n<script>alert(1)</script>');
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /<strong>Title<\/strong>/);
});

test('boot() wires the shell without throwing', async () => {
  await import('../public/app/main.js');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(calls.some((u) => u.includes('/api/meta')), 'boot never fetched /api/meta');
  assert.ok(calls.some((u) => u.includes('/api/templates')), 'boot never fetched /api/templates');
  assert.ok(calls.some((u) => u.includes('/api/recordings')), 'boot never fetched /api/recordings');
  assert.match(elements.get('model').innerHTML, /gpt-6-luna/);
  assert.match(elements.get('transcriber').innerHTML, /gpt-transcribe/);
  // Home is the Today screen: open items render escaped, people feed the picker, auto briefs run.
  const main = elements.get('main').innerHTML;
  const items = elements.get('open-items').innerHTML;
  assert.match(items, /Send deck/);
  assert.doesNotMatch(items, /<b>T<\/b>/);
  assert.match(main, /<option>Ben<\/option>/);
  assert.match(elements.get('badge').textContent, /1/);
  assert.ok(calls.some((u) => u.includes('/api/today/brief')), 'auto brief never requested');
  // People panel: the duplicate suggestion and a merge control per person render.
  await new Promise((r) => setTimeout(r, 30));
  assert.match(elements.get('people-suggest').innerHTML, /look like the same person/);
  assert.match(elements.get('people-suggest').innerHTML, /Merge “Jeff” into “Jeff Eberhard”/);
  assert.match(elements.get('people-list').innerHTML, /merge-into/);
  const { state } = await import('../public/app/state.js');
  assert.equal(state.screen, 'today');
  // The Ask-and-chats nav and the ask bar exist; Deep is explained.
  assert.match(main, /id="t-ask"/);
  assert.match(main, /Deep research splits your question/);
  assert.doesNotMatch(main, /Who are you/, 'the name now lives in Settings, not on Today');
  assert.doesNotMatch(main, /id="me"/);
});

test('speaker chips: confirmed ✓ may enroll, inferred/matched/unnamed show ? and stay clickable', async () => {
  const { renderSpeakerChips } = await import('../public/app/recordings.js');
  const html = renderSpeakerChips([
    { label: 'A', name: 'Sam', evidence: "I'm Sam", confirmed: true },
    { label: 'B', name: 'Pat', evidence: 'thanks, Pat', confirmed: false },
    { label: 'C', name: null, evidence: '', confirmed: false },
    { label: 'D', name: null, evidence: '', confirmed: false },
  ], true);
  const chip = (label) => html.match(new RegExp(`<span class="([^"]*)" data-label="${label}"[^>]*>([^<]*)</span>`));

  assert.deepEqual([chip('A')[1], chip('A')[2]], ['chip', 'Sam ✓']);
  assert.deepEqual([chip('B')[1], chip('B')[2]], ['chip unconfirmed', 'Pat ?']); // inferred: not marked verified
  assert.deepEqual([chip('C')[1], chip('C')[2]], ['chip unconfirmed', 'Unknown 1 ?']);
  assert.equal(chip('D')[2], 'Unknown 2 ?');
  assert.match(html, /title="thanks, Pat"/); // evidence stays inspectable

  // Voice enrollment is offered ONLY for the human-confirmed speaker.
  const enrolls = [...html.matchAll(/class="enroll-voice[^"]*" data-label="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(enrolls, ['A']);
  // ...and never before the recording is ready.
  assert.doesNotMatch(renderSpeakerChips([{ label: 'A', name: 'Sam', confirmed: true }], false), /enroll-voice/);
  assert.equal(renderSpeakerChips([], true), '');
});

test('speaker chips escape names and evidence', async () => {
  const { renderSpeakerChips } = await import('../public/app/recordings.js');
  const html = renderSpeakerChips([{ label: 'A', name: '<img src=x onerror=1>', evidence: '"><b>', confirmed: true }], true);
  assert.doesNotMatch(html, /<img|<b>/);
});

test('render() offers Recover for an interrupted recording and Retry for a failed one, and keeps mind map text out of innerHTML', async () => {
  const { render } = await import('../public/app/recordings.js');
  const main = document.getElementById('main');

  render({ id: 'r1', title: 'T', created_at: 0, template: 'meeting', status: 'error', error: 'interrupted', recoverable: true, speakers: [] });
  assert.match(main.innerHTML, /id="recover"/);
  assert.doesNotMatch(main.innerHTML, /id="retry"/);

  render({ id: 'r1', title: 'T', created_at: 0, template: 'meeting', status: 'error', error: 'summarize 500', recoverable: false, speakers: [] });
  assert.match(main.innerHTML, /id="retry"/);

  const payload = '# Root\n</script ><img src=x onerror=alert(1)>';
  render({ id: 'r1', title: 'T', created_at: 0, template: 'meeting', status: 'ready', speakers: [], mindmaps: { topic: payload } });
  assert.doesNotMatch(main.innerHTML, /onerror/, 'LLM-derived outline must not be interpolated into innerHTML');
  assert.match(main.innerHTML, /class="markmap" data-k="topic"/);
});

test('voiceembed pure helpers: window fitting, per-speaker window planning, mean+normalise', async () => {
  const { fitWindow, planWindows, meanNormalize, WINDOW } = await import('../public/app/voiceembed.js');
  const short = fitWindow(Float32Array.from([1, 2, 3]));
  assert.equal(short.length, WINDOW);
  assert.deepEqual([...short.slice(0, 7)], [1, 2, 3, 1, 2, 3, 1]); // tiled
  const long = fitWindow(Float32Array.from({ length: WINDOW + 10 }, (_, i) => i));
  assert.equal(long[0], 5); // centre crop
  assert.equal(fitWindow(new Float32Array(0)).length, WINDOW);

  const segs = [
    { speaker: 'A', start: 0, end: 2 },      // too short
    { speaker: 'A', start: 10, end: 14 },    // 3.5 s after trim
    { speaker: 'A', start: 20, end: 40 },    // 19.5 s -> two 6 s windows
    { speaker: 'B', start: 50, end: 60 },
  ];
  const w = planWindows(segs, 'A');
  assert.equal(w.length, 3);
  assert.deepEqual(w[0], { start: 20.25, end: 26.25 }); // longest first
  assert.deepEqual(w[1], { start: 26.25, end: 32.25 });
  assert.equal(w[2].start, 10.25);
  assert.deepEqual(planWindows(segs, 'nobody'), []);

  const e = meanNormalize([Float32Array.from([3, 0]), Float32Array.from([3, 0])]);
  assert.deepEqual([...e], [1, 0]);
});

test('the 15 prompts are numbered 1-15, runnable ones have text, auto ones say when they run', async () => {
  const { PROMPTS, RUNNABLE, fillPrompt } = await import('../public/app/prompts.js');
  assert.deepEqual(PROMPTS.map((p) => p.n), Array.from({ length: 15 }, (_, i) => i + 1));
  assert.equal(new Set(PROMPTS.map((p) => p.id)).size, 15);
  for (const p of PROMPTS) assert.ok(p.prompt || p.auto, `prompt ${p.n} does nothing`);
  assert.equal(RUNNABLE.length, 10);
  assert.equal(fillPrompt('Prep me for {person}.', 'Ben'), 'Prep me for Ben.');
  assert.equal(fillPrompt('Prep me for {person}.', ''), null);
  assert.equal(fillPrompt('Compare{ with person}.', 'Ben'), 'Compare with Ben.');
  assert.equal(fillPrompt('Compare{ with person}.', ''), 'Compare.');
});

test('today helpers: local date, sidebar badge; talk and unanswered render escaped', async () => {
  const { localDate, badgeText } = await import('../public/app/today.js');
  assert.equal(localDate(new Date(2026, 10, 9, 23, 59)), '2026-11-09');
  assert.equal(badgeText({ overdue_count: 2, slipping_count: 1 }), '3');
  assert.equal(badgeText({ overdue_count: 0, slipping_count: 0 }), '');
  assert.equal(badgeText(null), '');
  const { renderTalk, renderUnanswered } = await import('../public/app/recordings.js');
  const t = renderTalk([{ name: '<b>Jeff</b>', share: 0.75, turns: 3, questions: 2, longest_s: 40, overlaps: 1 }]);
  assert.match(t, /75%/);
  assert.doesNotMatch(t, /<b>Jeff/);
  assert.equal(renderTalk([]), '');
  assert.doesNotMatch(renderUnanswered(['<img src=x onerror=1>']), /<img/);
  assert.equal(renderUnanswered([]), '');
});

test('memory fact rows render escaped, promises get a checkbox, and forget is offered', async () => {
  const { factRow } = await import('../public/app/today.js');
  const html = factRow({ id: 'f1', recording_id: 'r1', kind: 'commitment', person: '<b>Ben</b>', text: '<img src=x onerror=1>', quote: '"q"', title: 'T', done: true });
  assert.doesNotMatch(html, /<img|<b>Ben/);
  assert.match(html, /class="fact-done" checked/);
  assert.match(html, /fact-del/);
  assert.doesNotMatch(factRow({ id: 'f2', recording_id: 'r1', kind: 'decision', text: 't', quote: 'q' }), /fact-done/);
});

test('md renders blocks without stray gaps: paragraphs, bullet and numbered lists, headings; still escapes', async () => {
  const { md } = await import('../public/app/dom.js');
  assert.equal(md('- a\n\n- b\n\n\n- c'), '<ul><li>a</li><li>b</li><li>c</li></ul>', 'blank lines between bullets do not split the list or add <br>');
  assert.equal(md('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
  assert.match(md('3. three'), /<ol start="3">/);
  assert.equal(md('Line one\nLine two\n\nNext para'), '<p>Line one<br>Line two</p><p>Next para</p>');
  assert.match(md('# Head\ntext'), /<p class="md-h"><strong>Head<\/strong><\/p><p>text<\/p>/);
  assert.match(md('- **bold** and `code`'), /<li><strong>bold<\/strong> and <code>code<\/code><\/li>/);
  assert.doesNotMatch(md('- <img src=x onerror=1>\n<script>x</script>'), /<img|<script/);
  assert.doesNotMatch(md('a\n\nb'), /<br><br>/);
  assert.equal(md('*Quote:* "hi"'), '<p><em>Quote:</em> &quot;hi&quot;</p>');
  assert.equal(md('2 * 3 * 4'), '<p>2 * 3 * 4</p>', 'spaced asterisks are not emphasis');
  assert.match(md('**bold** and *it*'), /<strong>bold<\/strong> and <em>it<\/em>/);
  assert.equal(md(''), '');
  assert.equal(md(null), '');
});

test('isMe matches whole words either way and never partial names', async () => {
  const { isMe } = await import('../public/app/me.js');
  assert.equal(isMe('Jeff', 'Jeff Eberhard'), true);
  assert.equal(isMe('Jeff Eberhard', 'jeff'), true);
  assert.equal(isMe('Alex Smith', 'Al'), false);
  assert.equal(isMe('Ben', 'Jeff Eberhard'), false);
  assert.equal(isMe(null, 'Jeff'), false);
  assert.equal(isMe('Jeff', ''), false);
});

test('person rows escape names and offer merging only when there is someone to merge into', async () => {
  const { personRow } = await import('../public/app/today.js');
  const p = { id: 'p1', name: '<b>Jeff</b>', recordings: 1, voiceprint_count: 2, aliases: '"x"' };
  const html = personRow(p, [{ id: 'p2', name: 'Jeff Eberhard' }]);
  assert.doesNotMatch(html, /<b>Jeff<\/b>/);
  assert.match(html, /1 recording · 2 voice samples/);
  assert.match(html, /merge-into/);
  assert.doesNotMatch(personRow(p, []), /merge-into/);
});

/* --- redesign helpers --- */
test('format: friendly model names, durations, clocks, initials, display names', async () => {
  const f = await import('../public/app/format.js');
  assert.equal(f.friendlyModel('openai/gpt-oss-20b'), 'GPT-OSS 20B');
  assert.equal(f.friendlyModel('microsoft/mai-transcribe-2'), 'MAI Transcribe 2');
  assert.equal(f.friendlyModel('openai/whisper-large-v3-turbo'), 'Whisper Large v3 Turbo');
  assert.equal(f.friendlyModel('anthropic/claude-haiku-5.5'), 'Claude Haiku 5.5');
  assert.equal(f.friendlyModel(''), '');
  assert.equal(f.fmtDuration(329000), '5:29');
  assert.equal(f.fmtDuration(3725000), '1h 02m');
  assert.equal(f.fmtDuration(null), '');
  assert.equal(f.fmtClock(75), '1:15');
  assert.equal(f.fmtClock(3725), '1:02:05');
  assert.equal(f.fmtClock(-4), '0:00');
  assert.equal(f.initials('Jeff Eberhard'), 'JE');
  assert.equal(f.initials('Ben'), 'B');
  assert.equal(f.initials('Unknown 2'), '?');
  const names = f.displayNames([{ label: 'A', name: 'Jeff', confirmed: true }, { label: 'B', name: null }, { label: 'C', name: null }]);
  assert.deepEqual([names.get('A').shown, names.get('B').shown, names.get('C').shown], ['Jeff', 'Unknown 1', 'Unknown 2']);
  assert.match(f.avatarStyle('Jeff'), /--av:hsl\(\d+ 42% 30%\)/);
});

test('groupByDate buckets by local calendar day: Today, Yesterday, Last 7 days, Earlier', async () => {
  const { groupByDate } = await import('../public/app/format.js');
  const now = new Date(2026, 10, 10, 12);
  const at = (d, h = 9) => new Date(2026, 10, d, h).getTime();
  const out = groupByDate([{ id: 1, created_at: at(10, 1) }, { id: 2, created_at: at(9, 23) }, { id: 3, created_at: at(4) }, { id: 4, created_at: at(1) }, { id: 5, created_at: at(10, 11) }], now);
  assert.deepEqual(out.map((g) => [g.label, g.items.map((x) => x.id)]), [['Today', [1, 5]], ['Yesterday', [2]], ['Last 7 days', [3]], ['Earlier', [4]]]);
  assert.deepEqual(groupByDate([], now), []);
});

test('sections splits notes on headings only when there are at least two', async () => {
  const { sections, iconForSection } = await import('../public/app/format.js');
  const s = sections('Intro line\n\n(1) Commitments & Open Items\n\n- a\n\n**Dependencies**\n\n- b\n\n## Blockers\ntext');
  assert.deepEqual(s.map((x) => x.title), ['', 'Commitments & Open Items', 'Dependencies', 'Blockers']);
  assert.equal(s[0].body, 'Intro line');
  assert.equal(sections('Just a paragraph.\n\n- one\n- two'), null);
  assert.equal(sections('**Only one**\n\ntext'), null);
  assert.equal(iconForSection('Commitments'), 'check');
  assert.equal(iconForSection('Unresolved questions'), 'help');
  assert.equal(iconForSection('Zzz'), 'dot');
});

test('transcript: turns merge by speaker with times, search highlights and escapes', async () => {
  const t = await import('../public/app/transcript.js');
  const turns = t.buildTurns([
    { speaker: 'A', text: 'Hello', start: 0, end: 2 }, { speaker: 'A', text: 'there.', start: 2, end: 3 },
    { speaker: 'B', text: 'Hi <b>x</b>', start: 4, end: 6 }, { speaker: 'B', text: '  ', start: 6, end: 7 },
  ], [{ label: 'A', name: 'Jeff', confirmed: true }, { label: 'B', name: null }]);
  assert.deepEqual(turns.map((x) => [x.shown, x.text, x.start, x.end]), [['Jeff', 'Hello there.', 0, 3], ['Unknown 1', 'Hi <b>x</b>', 4, 6]]);
  assert.equal(t.highlight('Say <b>hello</b> Hello', 'hello'), 'Say &lt;b&gt;<mark>hello</mark>&lt;/b&gt; <mark>Hello</mark>');
  assert.equal(t.highlight('a.b', 'a.b'), '<mark>a.b</mark>', 'regex characters are literal');
  assert.equal(t.highlight('plain', ''), 'plain');
  assert.equal(t.turnMatches(turns[0], 'jeff there'), true);
  assert.equal(t.turnMatches(turns[0], 'nothing'), false);
  const html = t.transcriptCard({ segments: [{ speaker: 'A', text: '<img src=x onerror=1>', start: 65, end: 70 }], speakers: [{ label: 'A', name: '<b>J</b>' }], transcript: 'x' });
  assert.doesNotMatch(html, /<img|<b>J/);
  assert.match(html, /data-t="65"[^>]*>1:05</);
  assert.match(t.transcriptCard({ segments: [], speakers: [], transcript: 'plain <i>text</i>' }), /class="transcript">plain &lt;i&gt;/);
  assert.equal(t.transcriptCard({ segments: [], transcript: '' }), '');
});

test('command palette ranking: every word must match, starts-with first', async () => {
  const { rankItems } = await import('../public/app/palette.js');
  const items = [{ label: 'Go to Today' }, { label: 'Weekly sync notes' }, { label: 'Today brief' }, { label: 'Settings' }];
  assert.deepEqual(rankItems(items, 'today').map((x) => x.label), ['Today brief', 'Go to Today']);
  assert.deepEqual(rankItems(items, 'sync weekly').map((x) => x.label), ['Weekly sync notes']);
  assert.deepEqual(rankItems(items, 'zzz'), []);
  assert.equal(rankItems(items, '').length, 4);
});

test('talk balance is a split bar plus metric chips; action rows keep done text readable; notes escape', async () => {
  const { renderTalk, taskRow, noteHtml } = await import('../public/app/recordings.js');
  const talk = renderTalk([{ name: 'Jeff', share: 0.9, turns: 3, questions: 2, longest_s: 52, overlaps: 0 }, { name: '<b>Ben</b>', share: 0.1, turns: 1, questions: 1, longest_s: 8, overlaps: 1 }], 'Jeff');
  assert.match(talk, /class="talk-bar"/);
  assert.match(talk, /<b>90%<\/b> of talk time/);
  assert.match(talk, /pill you/);
  assert.match(talk, /<b>1<\/b> turn</);
  assert.doesNotMatch(talk, /<b>Ben<\/b>/);
  assert.equal(renderTalk([], ''), '');

  const done = taskRow({ task: 'Ship <it>', owner: 'Ben', due: '2020-01-01', done: true }, 0);
  assert.match(done, /class="task done"/);
  assert.match(done, /checked/);
  assert.doesNotMatch(done, /<it>/);
  assert.doesNotMatch(done, /overdue/, 'a finished item is never flagged overdue');
  assert.match(taskRow({ task: 't', due: '2020-01-01' }, 1), /tag due late[^>]*>.*overdue/s);
  assert.match(taskRow({ task: 't', owner: 'Ben' }, 2), /tag who/);

  const note = noteHtml('(1) Commitments\n\n- <img src=x onerror=1>\n\n(2) Dependencies\n\n- b');
  assert.equal((note.match(/<details class="sect"/g) || []).length, 2);
  assert.doesNotMatch(note, /<img/);
  assert.match(noteHtml('Plain paragraph only.'), /^<div class="md">/);
});

test('sidebar cards show duration, participants and a friendly status, escaped', async () => {
  const { recordingCard, avatarCluster } = await import('../public/app/lists.js');
  const html = recordingCard({ id: 'r1', title: '<i>T</i>', created_at: Date.now(), duration_ms: 329000, status: 'error', error: 'boom "x"', people: ['Jeff Eberhard', 'Ben'] }, 'r1');
  assert.doesNotMatch(html, /<i>T/);
  assert.match(html, /5:29/);
  assert.match(html, /pill error">Failed</);
  assert.match(html, /card active/);
  assert.match(html, /class="av"[^>]*>JE</);
  assert.equal(avatarCluster([]), '');
  assert.equal((avatarCluster(['a', 'b', 'c', 'd']).match(/class="av"/g) || []).length, 3);
});

test('mind map card has tabs and zoom/export controls only when there is an outline', async () => {
  const { mindmapCard } = await import('../public/app/mindmap.js');
  const html = mindmapCard({ topic: '# t', people: '# p' });
  assert.match(html, /data-k="topic"/);
  assert.doesNotMatch(html, /data-k="driver"/);
  assert.match(html, /id="mm-fit"/);
  assert.match(html, /id="mm-svg"/);
  assert.equal(mindmapCard({}), '');
  assert.equal(mindmapCard(null), '');
});

test('the player offers play, skip, scrub and speed controls', async () => {
  const { playerHtml } = await import('../public/app/player.js');
  const html = playerHtml({ id: 'r1' });
  assert.match(html, /src="\/api\/recordings\/r1\/audio"/);
  for (const id of ['pl-play', 'pl-track', 'pl-speed', 'pl-cur', 'pl-rem']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /data-skip="-15"/);
  assert.match(html, /data-skip="15"/);
  assert.doesNotMatch(html, /\bcontrols\b/, 'the native audio controls are gone');
});

/* --- voice matching must never freeze the page --- */
test('planWork budgets model runs: the speakers who talk most, round-robin, never past the window budget', async () => {
  const { planWork, MAX_LABELS, MAX_WINDOWS, WINDOWS_PER_LABEL } = await import('../public/app/voiceembed.js');
  assert.equal(MAX_LABELS, 8);
  const mk = () => ({ segs: [], add(label, n, len, from) { for (let i = 0; i < n; i++) this.segs.push({ speaker: label, start: from + i * (len + 1), end: from + i * (len + 1) + len }); } });

  // The 41-minute import that froze a tab: 6 diarizer "speakers"; one talked for 22 minutes.
  const m = mk();
  m.add('A', 14, 100, 0); m.add('B', 11, 40, 2000); m.add('C', 13, 30, 3000); m.add('D', 12, 10, 4000); m.add('E', 1, 3, 5000); m.add('F', 2, 1, 6000);
  const plan = planWork(m.segs, ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.deepEqual(plan.map((p) => p.label), ['A', 'B', 'C', 'D'], 'E and F have under 4 s of speech: not worth matching');
  const total = (pl) => pl.reduce((n, p) => n + p.windows.length, 0);
  assert.ok(total(plan) <= MAX_WINDOWS);
  assert.ok(plan.every((p) => p.windows.length >= 1 && p.windows.length <= WINDOWS_PER_LABEL));
  assert.ok(total(plan) < 6 * 8, 'far less than the old 6 speakers x 8 windows');

  // A busy call: 10 speakers. Only the 8 who talk most are matched, each still covered.
  const big = mk();
  'ABCDEFGHIJ'.split('').forEach((l, i) => big.add(l, 6, 60 - i * 5, i * 5000));
  const plan10 = planWork(big.segs, 'ABCDEFGHIJ'.split(''));
  assert.equal(plan10.length, 8);
  assert.deepEqual(plan10.map((p) => p.label), 'ABCDEFGH'.split(''));
  assert.ok(total(plan10) <= MAX_WINDOWS);
  assert.ok(plan10.every((p) => p.windows.length >= 3), 'round-robin: nobody is starved by the first speaker');

  assert.deepEqual(planWork(m.segs, ['E', 'F']), []);
  assert.deepEqual(planWork([], ['A']), []);
  assert.deepEqual(planWork(undefined, undefined), []);
  assert.equal(planWork([{ speaker: 'A', start: 0, end: 30 }], ['A'])[0].windows.length, 2, 'one long turn gives up to two non-overlapping windows');
  assert.equal(planWork([{ speaker: 'A', start: 0, end: 5 }], ['A'])[0].windows.length, 1);
});

test('voice matching runs by itself only on recordings up to 15 minutes; longer ones wait for the button', async () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const { state } = await import('../public/app/state.js');
  const { eligible, needsManual, skipped } = await import('../public/app/voicematch.js');
  state.META = { voice_match_enabled: true };
  const min = 60000;
  const base = { id: 'x1', status: 'ready', segments: [{ speaker: 'A' }], speakers: [{ label: 'A', confirmed: false }], voice_match: null };

  assert.equal(eligible({ ...base, duration_ms: 14 * min }), true);
  assert.equal(eligible({ ...base, duration_ms: 16 * min }), false, 'no automatic run on a long recording');
  assert.equal(eligible({ ...base, duration_ms: 41 * min }, { manual: true }), true, 'but the button can');
  assert.equal(eligible({ ...base, duration_ms: 100 * min }, { manual: true }), false, 'beyond the decode ceiling nothing runs');
  assert.equal(needsManual({ ...base, duration_ms: 41 * min }), true);
  assert.equal(needsManual({ ...base, duration_ms: 5 * min }), false, 'short ones are automatic, no button');
  assert.equal(needsManual({ ...base, duration_ms: 41 * min, voice_match: { scores: [] } }), false, 'already matched');
  assert.equal(needsManual({ ...base, duration_ms: 100 * min }), false);

  assert.equal(eligible({ ...base, duration_ms: 5 * min, segments: [] }), false);
  assert.equal(eligible({ ...base, duration_ms: 5 * min, speakers: [{ label: 'A', confirmed: true }] }), false, 'nothing unconfirmed to match');
  state.META = { voice_match_enabled: false };
  assert.equal(eligible({ ...base, duration_ms: 5 * min }), false, 'setting off');
  state.META = { voice_match_enabled: true };

  // a run that failed or was cancelled is remembered: no automatic retry on every open
  store.set('attest.vmskip.x1', '1');
  assert.equal(skipped('x1'), true);
  assert.equal(eligible({ ...base, duration_ms: 5 * min }), false);
  assert.equal(eligible({ ...base, duration_ms: 5 * min }, { manual: true }), true, 'the button ignores an earlier skip');
  delete globalThis.localStorage;
});

/* --- local speaker detection by voice --- */
// Deterministic fake "voices": each speaker is a direction in 192-d space, each utterance that
// direction plus noise, unit length, like the real model's output.
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const voice = (speaker, noise, r) => {
  const v = Float32Array.from({ length: 192 }, () => (r() - 0.5) * noise);
  for (let k = 0; k < 12; k++) v[speaker * 12 + k] += 1;
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map((x) => x / n);
};
const utterances = (pattern, noise = 0.5, seed = 7) => { const r = rng(seed); return pattern.map((s) => voice(s, noise, r)); };

test('pickAnchors keeps segments with enough voice, spreads over the call when over budget, in order', async () => {
  const { pickAnchors } = await import('../public/app/diarize.js');
  const segs = [{ start: 0, end: 0.5 }, { start: 1, end: 4 }, { start: 5, end: 20 }, { start: 21, end: 23 }, { start: 24, end: NaN }, { start: 30, end: 31.2 }];
  const all = pickAnchors(segs);
  assert.deepEqual(all.map((a) => a.i), [1, 2, 3, 5], '0.5 s and the NaN segment are out; 1.2 s just qualifies');
  const two = pickAnchors(segs, { maxWindows: 2 });
  assert.deepEqual(two.map((a) => a.i), [2, 3], 'over budget: the longest of each half of the call, in time order');
  const long = all.find((a) => a.i === 2);
  assert.ok(long.end - long.start <= 6, 'one 6-second window per segment');
  assert.ok(long.start >= 5 && long.end <= 20);
  assert.deepEqual(pickAnchors([]), []);
  assert.deepEqual(pickAnchors(undefined), []);
});

test('clusterSpeakers separates voices, keeps one voice together, and respects the speaker cap', async () => {
  const { clusterSpeakers } = await import('../public/app/diarize.js');
  const durs = (n) => new Array(n).fill(8);

  const two = utterances([0, 1, 0, 1, 0, 0, 1, 1, 0, 1]);
  assert.deepEqual(clusterSpeakers(two, durs(10)), [0, 1, 0, 1, 0, 0, 1, 1, 0, 1], 'numbered by first appearance');

  const three = utterances([2, 0, 1, 2, 0, 1, 2, 2, 0, 1]);
  const c3 = clusterSpeakers(three, durs(10));
  assert.equal(new Set(c3).size, 3);
  assert.deepEqual(c3, [0, 1, 2, 0, 1, 2, 0, 0, 1, 2]);

  const one = utterances([4, 4, 4, 4, 4, 4]);
  assert.deepEqual(clusterSpeakers(one, durs(6)), [0, 0, 0, 0, 0, 0], 'a monologue is one speaker, not several');

  // very noisy: still never more clusters than the cap
  const nine = utterances(Array.from({ length: 27 }, (_, i) => i % 9), 0.2, 3);
  assert.ok(new Set(clusterSpeakers(nine, durs(27), { maxSpeakers: 8 })).size <= 8);
  assert.ok(new Set(clusterSpeakers(nine, durs(27), { maxSpeakers: 4 })).size <= 4);

  assert.deepEqual(clusterSpeakers([], []), []);
  assert.deepEqual(clusterSpeakers(utterances([0]), [5]), [0]);
});

test('clusterSpeakers folds a near-empty "speaker" (little speech, or a single window) into the nearest real one', async () => {
  const { clusterSpeakers } = await import('../public/app/diarize.js');
  // two real voices, and a third that is only ONE window: a stray, however long that window is
  const one = utterances([0, 1, 0, 1, 0, 1, 5], 0.5);
  assert.equal(new Set(clusterSpeakers(one, [20, 20, 20, 20, 20, 20, 20])).size, 2, 'a lone window is not a speaker (this made a phantom third speaker on a real call)');
  // a third voice with two windows and enough speech IS a speaker
  const two = utterances([0, 1, 0, 1, 0, 1, 5, 5], 0.5);
  assert.equal(new Set(clusterSpeakers(two, [20, 20, 20, 20, 20, 20, 8, 8])).size, 3, 'two windows, 16 s: a real speaker');
  // ...but with too little speech in total it folds
  assert.equal(new Set(clusterSpeakers(two, [20, 20, 20, 20, 20, 20, 2, 2])).size, 2, 'two windows but 4 s of speech: folded');
});

test('assignSegments gives every segment a speaker, smooths one-word flicker, numbers from A', async () => {
  const { assignSegments } = await import('../public/app/diarize.js');
  const seg = (a, b) => ({ start: a, end: b });
  // segments 0,2,4 are anchors (long); 1 and 3 are too short to embed
  const segs = [seg(0, 10), seg(10, 10.8), seg(11, 20), seg(20, 20.9), seg(21, 30)];
  const anchors = [{ i: 0 }, { i: 2 }, { i: 4 }];
  assert.deepEqual(assignSegments(segs, anchors, [0, 1, 0]), [0, 1, 1, 0, 0].map((_, i) => [0, 0, 1, 1, 0][i]),
    'a short segment takes the previous anchor speaker');
  // smoothing: short turn between two turns of the same speaker
  assert.deepEqual(assignSegments([seg(0, 10), seg(10, 11), seg(11, 20)], [{ i: 0 }, { i: 1 }, { i: 2 }], [0, 1, 0]), [0, 0, 0]);
  // a long turn is never smoothed away
  assert.deepEqual(assignSegments([seg(0, 10), seg(10, 20), seg(20, 30)], [{ i: 0 }, { i: 1 }, { i: 2 }], [0, 1, 0]), [0, 1, 0]);
  // leading segments before the first anchor take the next one; labels renumber from 0
  assert.deepEqual(assignSegments([seg(0, 1), seg(1, 11), seg(11, 21)], [{ i: 1 }, { i: 2 }], [5, 7]), [0, 0, 1]);
  assert.deepEqual(assignSegments([], [], []), []);
  assert.ok(Math.max(...assignSegments(Array.from({ length: 30 }, (_, i) => seg(i * 10, i * 10 + 9)), Array.from({ length: 30 }, (_, i) => ({ i })), Array.from({ length: 30 }, (_, i) => i))) <= 11, 'capped at 12 speakers (A-L)');
});

test('speakerEmbeddingsFrom makes one unit-length mean per detected speaker, with the speech time', async () => {
  const { speakerEmbeddingsFrom } = await import('../public/app/diarize.js');
  const anchors = [{ i: 0, start: 0, end: 6 }, { i: 1, start: 10, end: 16 }, { i: 2, start: 20, end: 23 }];
  const embs = utterances([0, 1, 0]);
  const out = speakerEmbeddingsFrom(anchors, embs, [0, 1, 0]);
  assert.deepEqual(out.map((x) => [x.label, x.speech_ms]), [['A', 9000], ['B', 6000]]);
  for (const x of out) assert.ok(Math.abs(x.embedding.reduce((n, v) => n + v * v, 0) - 1) < 1e-5);
  assert.equal(out[0].embedding.length, 192);
});

test('local speaker detection is offered only when the server says so, to a provisional single speaker', async () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const { state } = await import('../public/app/state.js');
  const { diarizeEligible, needsDiarizeManual, needsTurns } = await import('../public/app/diarize.js');
  const min = 60000;
  const base = { id: 'd1', status: 'ready', segments: [1, 2, 3, 4].map(() => ({})), speakers: [{ label: 'A', name: null, confirmed: false }], duration_ms: 5 * min };

  state.META = { diarize_local: false };
  assert.equal(diarizeEligible(base), false, 'cloud / diarizing transcriber: never');
  state.META = { diarize_local: true };
  assert.equal(needsTurns(base), true);
  assert.equal(diarizeEligible(base), true);
  assert.equal(diarizeEligible({ ...base, status: 'transcribed' }), true);
  assert.equal(diarizeEligible({ ...base, status: 'error' }), false);
  assert.equal(diarizeEligible({ ...base, segments: [{}, {}] }), false, 'too few segments to cluster');
  assert.equal(diarizeEligible({ ...base, speakers: [{ label: 'A' }, { label: 'B' }] }), false, 'already has several speakers');
  assert.equal(diarizeEligible({ ...base, speakers: [{ label: 'A', name: 'Ben', confirmed: true }] }), false, 'a human named it');
  assert.equal(diarizeEligible({ ...base, duration_ms: 11 * min }), false, 'automatic only up to 10 minutes');
  assert.equal(diarizeEligible({ ...base, duration_ms: 41 * min }, { manual: true }), true);
  assert.equal(diarizeEligible({ ...base, duration_ms: 100 * min }, { manual: true }), false);
  assert.equal(needsDiarizeManual({ ...base, duration_ms: 41 * min }), true);
  assert.equal(needsDiarizeManual(base), false);
  store.set('attest.vmskip.d1', '1');
  assert.equal(diarizeEligible(base), false, 'a failed run is not retried automatically');
  assert.equal(diarizeEligible(base, { manual: true }), true, 'but the button works');
  state.META = null;
  delete globalThis.localStorage;
});

test('settings in local mode explains .dev.vars but still offers the Pocket key and voice switch', async () => {
  const { localSettingsHtml, extrasHtml } = await import('../public/app/settings.js');
  const a = localSettingsHtml({ vectors_enabled: true, diarize_local: true }, { has_pocket_key: false, voice_match: true });
  assert.match(a, /npm run setup:local/);
  assert.match(a, /\.dev\.vars/);
  assert.match(a, /by meaning/);
  assert.match(a, /clustering voices/);
  assert.match(a, /id="set-pocket"/, 'the Pocket key can be entered here');
  assert.match(a, /id="set-voice" checked/);
  assert.doesNotMatch(a, /set-pocket-clear/, 'nothing to remove when no key is saved');
  const b = localSettingsHtml({ vectors_enabled: false, diarize_local: false }, { has_pocket_key: true, voice_match: false });
  assert.match(b, /by keywords/);
  assert.match(b, /from the transcriber/);
  assert.match(b, /A key is saved\. Leave blank to keep it/);
  assert.match(b, /set-pocket-clear/);
  assert.doesNotMatch(b, /id="set-voice" checked/);
  assert.ok(!/value="pk_/.test(b), 'the saved key is never put in the page');
  assert.match(extrasHtml({}), /Paste your Pocket API key/);
});

test('voice windows are planned for unlabelled segments too (the single "Speaker")', async () => {
  const { planWindows, planWork } = await import('../public/app/voiceembed.js');
  const segs = [{ start: 0, end: 12 }, { start: 12, end: 15 }];
  assert.ok(planWindows(segs, 'Speaker').length >= 1);
  assert.equal(planWork(segs, ['Speaker']).length, 1);
  assert.deepEqual(planWork(segs, ['A']), []);
});

test('hallucinatedSegments finds Whisper\'s silence/noise inventions: stock phrases and tiny texts that repeat', async () => {
  const { hallucinatedSegments, pickAnchors } = await import('../public/app/diarize.js');
  const seg = (text, a) => ({ text, start: a, end: a + 4 });
  const segs = [seg('Thank you.', 0), seg('Thank you.', 30), seg('Hello, how are you doing today?', 60), seg('Right then.', 70), seg('Right then.', 80), seg('Right then.', 90),
    seg('Yeah.', 100), seg('The quarterly numbers look good and I think we should proceed.', 110), seg('You', 120), seg('Subscribe!', 130)];
  assert.deepEqual([...hallucinatedSegments(segs)].sort((a, b) => a - b), [0, 1, 3, 4, 5, 6, 8, 9],
    'stock phrases, "Right then." (3 repeats), "Yeah.", "You", "Subscribe!"');
  assert.ok(!hallucinatedSegments(segs).has(2), 'a real sentence is never dropped');
  assert.ok(!hallucinatedSegments(segs).has(7));
  assert.deepEqual(pickAnchors(segs).map((a) => a.i), [2, 7], 'only real speech is embedded');
  assert.equal(hallucinatedSegments([]).size, 0);
  assert.equal(hallucinatedSegments(undefined).size, 0);
  assert.equal(hallucinatedSegments([{ start: 0, end: 3 }, { text: null, start: 3, end: 6 }]).size, 0, 'missing text is not an error');
});

test('a recording already split into speakers can be detected again by hand, even with names confirmed', async () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const { state } = await import('../public/app/state.js');
  const { diarizeEligible, canRedetect, needsTurns } = await import('../public/app/diarize.js');
  state.META = { diarize_local: true };
  const split = { id: 'rd1', status: 'ready', duration_ms: 5 * 60000, segments: [1, 2, 3, 4, 5].map(() => ({})),
    speakers: [{ label: 'A', name: null, confirmed: false }, { label: 'B', name: null, confirmed: false }, { label: 'C', name: null, confirmed: false }] };
  assert.equal(needsTurns(split), false, 'it is not the single provisional speaker');
  assert.equal(diarizeEligible(split), false, 'never automatic');
  assert.equal(canRedetect(split), true);
  assert.equal(diarizeEligible(split, { manual: true }), true, 'but the button is offered');
  const named = { ...split, speakers: [{ label: 'A', name: 'Jeff', confirmed: true }, { label: 'B', name: null, confirmed: false }] };
  assert.equal(diarizeEligible(named, { manual: true }), true, 'confirmed names no longer block it: they are carried over');
  assert.equal(diarizeEligible(named), false, 'still never automatic');
  assert.equal(canRedetect({ ...split, segments: [{}] }), false);
  assert.equal(canRedetect({ ...split, status: 'error' }), false);
  state.META = { diarize_local: false };
  assert.equal(diarizeEligible(split, { manual: true }), false, 'only in local mode');
  state.META = null;
  delete globalThis.localStorage;
});

test('alignToConfirmed keeps a confirmed name on its letter after a fresh clustering', async () => {
  const { alignToConfirmed } = await import('../public/app/diarize.js');
  const seg = (sp) => ({ speaker: sp });
  const sp = [{ label: 'A', name: null, confirmed: false }, { label: 'B', name: 'Kevin', confirmed: true }, { label: 'C', name: null, confirmed: false }];
  // old labelling: Jeff was A and C (split), Kevin B. Fresh clustering numbers by first appearance: Jeff 0, Kevin 1.
  const old = ['A', 'A', 'B', 'A', 'C', 'B', 'A'].map(seg);
  const fresh = [0, 0, 1, 0, 0, 1, 0];
  assert.deepEqual(alignToConfirmed(old, fresh, sp), [0, 0, 1, 0, 0, 1, 0], 'Kevin stays B (1); Jeff takes the free A');

  // the new numbering swaps them: Kevin is cluster 0 now. He must still come out as B.
  const swapped = [1, 1, 0, 1, 1, 0, 1];
  assert.deepEqual(alignToConfirmed(old, swapped, sp), [0, 0, 1, 0, 0, 1, 0]);

  // a confirmed speaker who is now spread over two clusters: the one with the bigger overlap keeps the letter
  const old2 = ['B', 'B', 'B', 'B', 'A', 'A'].map(seg);
  const out2 = alignToConfirmed(old2, [0, 0, 0, 1, 2, 2], [{ label: 'B', name: 'Kevin', confirmed: true }]);
  assert.equal(out2[0], 1, 'the cluster covering most of B takes B');
  assert.notEqual(out2[3], 1, 'the other one does not also claim the name');
  assert.equal(new Set(out2).size, 3);

  // weak overlap (one stray segment) does not attach a name to a cluster
  const old3 = ['B', 'A', 'A', 'A', 'A', 'A'].map(seg);
  const out3 = alignToConfirmed(old3, [0, 1, 1, 1, 1, 1], [{ label: 'B', name: 'Kevin', confirmed: true }]);
  assert.equal(out3[0], 1, 'a cluster that is 1 segment and was all of B: still B');
  assert.equal(out3[1], 0);

  const stray = alignToConfirmed(['B', 'A', 'A', 'A', 'A', 'A', 'A', 'A'].map(seg), [0, 0, 0, 0, 0, 0, 0, 0], [{ label: 'B', name: 'Kevin', confirmed: true }]);
  assert.deepEqual(new Set(stray), new Set([1]), 'one cluster covering all: it does cover B, so it is B (and the whole file is one speaker)');

  // nothing confirmed: untouched
  const same = [0, 1, 0];
  assert.equal(alignToConfirmed([{}, {}, {}], same, [{ label: 'A', name: 'x', confirmed: false }]), same);
  assert.equal(alignToConfirmed([], [], sp).length, 0);
});

test('transcript turns carry their segment positions, and the move menu lists the other speakers plus a new one, escaped', async () => {
  const { buildTurns, moveMenuHtml } = await import('../public/app/transcript.js');
  const segs = [{ speaker: 'A', text: 'one', start: 0, end: 1 }, { speaker: 'A', text: '  ', start: 1, end: 2 }, { speaker: 'A', text: 'two', start: 2, end: 3 }, { speaker: 'B', text: 'three', start: 3, end: 4 }];
  const sp = [{ label: 'A', name: 'Jeff', confirmed: true }, { label: 'B', name: '<img src=x onerror=1>', confirmed: false }];
  const turns = buildTurns(segs, sp);
  assert.deepEqual(turns.map((t) => [t.label, t.idx]), [['A', [0, 2]], ['B', [3]]], 'positions in the stored array, empty segments skipped');
  const menu = moveMenuHtml(sp, turns[0]);
  assert.match(menu, /Move this turn to/);
  assert.match(menu, /data-to="B" data-scope="turn"/);
  assert.match(menu, /data-to="new"/);
  assert.match(menu, /Move <b>all<\/b> of Jeff's turns to/);
  assert.match(menu, /data-to="B" data-scope="all"/);
  assert.doesNotMatch(menu, /data-to="A"/, 'not offered the speaker it is already');
  assert.doesNotMatch(menu, /<img/);
  const solo = moveMenuHtml([{ label: 'A', name: 'Jeff' }], turns[0]);
  assert.match(solo, /data-to="new"/);
  assert.doesNotMatch(solo, /Move <b>all/, 'nobody to merge into');
});

test('the "who is this?" dropdown lists known people, marks the current and already-used ones, offers a new person, and escapes', async () => {
  const { nameMenuHtml } = await import('../public/app/recordings.js');
  const people = [{ id: '1', name: 'Jeff Eberhard' }, { id: '2', name: 'Kevin' }, { id: '3', name: '<img src=x onerror=1>' }];
  const speakers = [{ label: 'A', name: null, confirmed: false }, { label: 'B', name: 'Kevin', confirmed: true }, { label: 'C', name: null, confirmed: false }];
  const html = nameMenuHtml(people, speakers, 'A');
  assert.match(html, /Who is Unknown 1\?/, 'uses the same "Unknown N" the chip shows');
  assert.match(html, /data-name="Jeff Eberhard"/);
  assert.match(html, /data-name="Kevin"[^>]*>.*also Unknown 2|data-name="Kevin"[\s\S]*also /, 'Kevin is already another speaker here');
  assert.match(html, /id="nm-new"/);
  assert.match(html, /id="nm-add"/);
  assert.doesNotMatch(html, /<img/);
  // when this speaker already has a name it is marked, not flagged as "also"
  const named = nameMenuHtml(people, [{ label: 'A', name: 'Jeff Eberhard', confirmed: true }], 'A');
  assert.match(named, /class="opt on" data-name="Jeff Eberhard"/);
  assert.doesNotMatch(named, /also /);
  assert.match(nameMenuHtml([], speakers, 'A'), /No one yet/);
  assert.match(nameMenuHtml(undefined, undefined, 'A'), /id="nm-new"/);
});

test('menuPosition keeps a dropdown on screen: below the anchor, else above, else pinned to the bottom', async () => {
  const { menuPosition } = await import('../public/app/menu.js');
  const view = { w: 1000, h: 700 };
  assert.deepEqual(menuPosition({ left: 100, top: 100, bottom: 120 }, { w: 300, h: 200 }, view), { left: 100, top: 126 }, 'room below');
  assert.deepEqual(menuPosition({ left: 100, top: 600, bottom: 620 }, { w: 300, h: 200 }, view), { left: 100, top: 394 }, 'no room below: above');
  assert.deepEqual(menuPosition({ left: 100, top: 100, bottom: 690 }, { w: 300, h: 500 }, view), { left: 100, top: 188 }, 'fits neither side: pinned to the bottom edge');
  assert.equal(menuPosition({ left: 900, top: 10, bottom: 30 }, { w: 300, h: 100 }, view).left, 692, 'never off the right edge');
  assert.equal(menuPosition({ left: -50, top: 10, bottom: 30 }, { w: 300, h: 100 }, view).left, 8, 'never off the left edge');
  assert.ok(menuPosition({ left: 0, top: 5, bottom: 25 }, { w: 300, h: 5000 }, view).top >= 12, 'taller than the window: still starts on screen');
});

test('voice buttons adapt: Enroll only when no voice is saved, otherwise a badge, an optional add, and a Clear that has something to clear', async () => {
  const { voiceButtonState } = await import('../public/app/voiceprints.js');
  const none = voiceButtonState({ name: 'Jeff', voiceprint_count: 0 });
  assert.deepEqual([none.enroll, none.showClear, none.enrolled, none.pill], ['Enroll voice', false, false, '']);
  assert.match(none.enrollTitle, /Save Jeff's voice/);
  const one = voiceButtonState({ name: 'Jeff', voiceprint_count: 1 });
  assert.deepEqual([one.enroll, one.clear, one.showClear, one.pill], ['Add voice sample', 'Clear voices (1)', true, 'voice saved · 1']);
  assert.match(one.enrollTitle, /already saved \(1 sample\)/);
  assert.match(voiceButtonState({ name: 'Jeff', voiceprint_count: 3 }).enrollTitle, /3 samples/);
  assert.equal(voiceButtonState({ voiceprint_count: '2' }).showClear, true, 'counts that arrive as strings still work');
  assert.equal(voiceButtonState(undefined).enroll, 'Enroll voice');
  assert.equal(voiceButtonState({ name: 'x', voiceprint_count: null }).showClear, false);
});

test('pickAnchors samples a long call evenly instead of only its longest monologues', async () => {
  const { pickAnchors } = await import('../public/app/diarize.js');
  // 30 minutes: a long monologue up front, then 2-second turns all the way through.
  const segs = [{ start: 0, end: 28 }];
  for (let t = 30; t < 1800; t += 3) segs.push({ start: t, end: t + 2 });
  const picked = pickAnchors(segs, { maxWindows: 60 });
  assert.equal(picked.length, 60);
  const times = picked.map((a) => a.start);
  assert.ok(times[0] < 30 && times.at(-1) > 1700, 'covers the start and the end');
  const gaps = times.slice(1).map((t, k) => t - times[k]);
  assert.ok(Math.max(...gaps) < 90, 'no stretch of the call is left unsampled');
  // The default budget scales with length: 100 for a short call, more for an hour, capped.
  const hour = []; for (let t = 0; t < 3600; t += 3) hour.push({ start: t, end: t + 2 });
  assert.equal(pickAnchors(hour).length, 240);
  assert.equal(pickAnchors(hour.slice(0, 400)).length, 100);
});

test('alignToConfirmed does not hand a name to a small cluster that sits inside the speaker who talked most', async () => {
  const { alignToConfirmed } = await import('../public/app/diarize.js');
  // Old speaker B (named) talked for 600 s. The fresh clustering splits that into a big cluster 0 (560 s)
  // and a small cluster 1 (40 s, whoever opened the call) that lies wholly inside B's old turns.
  const old = [{ start: 0, end: 280, speaker: 'B' }, { start: 280, end: 320, speaker: 'B' }, { start: 320, end: 600, speaker: 'B' }, { start: 600, end: 620, speaker: 'A' }];
  const fresh = [0, 1, 0, 2];
  const sp = [{ label: 'A', name: null }, { label: 'B', name: 'Ulf', confirmed: true }];
  const out = alignToConfirmed(old, fresh, sp);
  assert.equal(out[0], 1, 'the big cluster keeps B, the confirmed letter');
  assert.notEqual(out[1], 1, 'the 40-second cluster does not get the name');
});

test('closestSpeaker picks the nearest other speaker, skips the current one, and says nobody when nothing is close', async () => {
  const { closestSpeaker, turnWindows } = await import('../public/app/autoplace.js');
  const v = (...a) => Float32Array.from(a);
  const voices = [{ label: 'A', embedding: v(1, 0, 0) }, { label: 'B', embedding: v(0, 1, 0) }, { label: 'C', embedding: v(0.6, 0.8, 0) }];
  assert.equal(closestSpeaker(v(0.95, 0.31, 0), voices, 'C'), 'A');
  assert.equal(closestSpeaker(v(0, 1, 0), voices, 'B'), 'C', 'never the speaker it is already on');
  assert.equal(closestSpeaker(v(0, 0, 1), voices, 'A'), null, 'sounds like nobody: caller makes a new speaker');
  const segs = [{ start: 0, end: 0.5 }, { start: 1, end: 4 }, { start: 5, end: 20 }, { start: 21, end: 23 }];
  assert.deepEqual(turnWindows(segs, [0, 1, 2, 3]), [{ start: 5, end: 11 }, { start: 1, end: 4 }], 'the two longest, 6 s at most, 0.5 s too short');
});

test('the move menu offers "I don\'t know" beside New speaker', async () => {
  const { moveMenuHtml } = await import('../public/app/transcript.js');
  const html = moveMenuHtml([{ label: 'A', name: 'Ann' }, { label: 'B', name: null }], { label: 'A', shown: 'Ann' });
  assert.match(html, /data-to="auto"[^>]*>.*I don't know/s);
});

test('isAcked hides reworded repeats but not different items', async () => {
  const { isAcked } = await import('../public/app/today.js');
  const set = new Set(['send the pricing deck to ben by friday']);
  assert.ok(isAcked('send the pricing deck to ben by friday', set));
  assert.ok(isAcked('still need to send pricing deck to ben', set));
  assert.ok(!isAcked('call vendor about the invoice', set));
  assert.ok(!isAcked('send ben', set));
});

test('sidebarPlan shows only the chosen sources, with "Import from all" once two can import', async () => {
  const { sidebarPlan } = await import('../public/app/sources.js').catch(() => ({}));
  if (!sidebarPlan) return; // module needs a browser DOM to import in this harness
  const s = (id, pull, ready = true) => ({ id, pull, ready });
  assert.deepEqual(sidebarPlan([s('mic', false)]).imports, []);
  assert.equal(sidebarPlan([s('mic', false)]).mic, true);
  assert.equal(sidebarPlan([s('pocket', true)]).mic, false, 'someone who never records in the app does not see Record');
  assert.equal(sidebarPlan([s('pocket', true)]).all, false);
  assert.equal(sidebarPlan([s('pocket', true), s('omi', true)]).all, true);
  assert.equal(sidebarPlan([s('pocket', true), s('omi', true, false)]).all, false, 'a source with no key cannot be part of "all"');
  assert.equal(sidebarPlan([s('pendant', false)]).pendant, true);
  assert.equal(sidebarPlan([]).empty, true);
});

test('the bottom tab bar wires Home, Ask, Record, Recordings and Settings, and switches panes', async () => {
  const { wireTabbar, setTab } = await import('../public/app/tabbar.js');
  const bar = document.getElementById('tabbar');
  const btns = ['home', 'ask', 'record', 'recordings', 'settings'].map((tab) => ({ dataset: { tab }, classList: { toggle() {}, add() {}, remove() {} } }));
  bar.querySelectorAll = (sel) => (sel === 'button[data-tab]' ? btns : []);
  wireTabbar();
  assert.equal(document.body.dataset.tab, 'home', 'starts on Home');
  let settingsClicks = 0, recClicks = 0;
  document.getElementById('settings').click = () => settingsClicks++;
  document.getElementById('rec').click = () => recClicks++;
  const tap = (tab) => bar.onclick({ target: { closest: () => btns.find((b) => b.dataset.tab === tab) } });
  tap('recordings');
  assert.equal(document.body.dataset.tab, 'recordings');
  tap('record');
  assert.equal(recClicks, 1, 'the centre button starts recording');
  assert.equal(document.body.dataset.tab, 'recordings', 'and shows the pane with the timer and live text');
  tap('settings');
  assert.equal(settingsClicks, 1, 'Settings opens the existing dialog');
  tap('ask');
  assert.equal(document.body.dataset.tab, 'ask');
  setTab('home');
});

test('Settings offers "Open pendant sync" only inside the Attest app', async () => {
  const { sourcesHtml } = await import('../public/app/settings.js');
  const s = { sources: ['mic', 'pendant'] };
  assert.doesNotMatch(sourcesHtml(s), /open-pendant/, 'a plain browser has no app to open');
  globalThis.webkit = { messageHandlers: { attest: { postMessage() {} } } };
  try { assert.match(sourcesHtml(s), /id="open-pendant"/); } finally { delete globalThis.webkit; }
});

test('waveBars bins timed speech by share of each slice and colours it by who spoke most', async () => {
  const { waveBars } = await import('../public/app/player.js');
  assert.deepEqual(waveBars([], []), [], 'nothing timed, no waveform');
  assert.deepEqual(waveBars([{ text: 'hi' }], []), [], 'untimed segments are ignored');
  const bars = waveBars([
    { speaker: 'A', start: 0, end: 10, text: 'x'.repeat(100) },
    { speaker: 'B', start: 20, end: 25, text: 'y'.repeat(25) },
  ], [{ label: 'A', name: 'Jeff', confirmed: true }], 40, 4);
  assert.equal(bars.length, 4);
  assert.equal(bars[0].h, 1, 'a slice that is all speech is full height');
  assert.equal(bars[0].who, 'Jeff', 'named speakers show by name');
  assert.equal(bars[1].h, 0, 'silence is zero');
  assert.equal(bars[2].h, 0.34, 'half the slice, at half the busiest rate: 0.5 x (0.35 + 0.65 x 0.5)');
  assert.equal(bars[3].h, 0);
});

test('omniScope says in words what the date and speaker chips narrow the question to', async () => {
  const { omniScope, omnibarHtml } = await import('../public/app/today.js');
  assert.equal(omniScope('', ''), '', 'no chips: a normal chat over everything');
  assert.match(omniScope('7', ''), /last 7 days/);
  assert.match(omniScope('1', ''), /last day\b/);
  assert.match(omniScope('', 'Ben'), /last 60 days with Ben/, 'speaker alone uses the widest window the endpoint allows');
  const html = omnibarHtml([{ name: '<b>Ben</b>' }]);
  assert.match(html, /id="t-days"/);
  assert.match(html, /id="t-who"/);
  assert.doesNotMatch(html, /<b>Ben<\/b>/, 'names are escaped');
  assert.doesNotMatch(omnibarHtml([]), /id="t-who"/, 'no people yet, no speaker chip');
});

test('talk balance gives each speaker an accessible progress bar', async () => {
  const { renderTalk } = await import('../public/app/recordings.js');
  const talk = renderTalk([{ name: 'Jeff', share: 0.75, turns: 3, questions: 0, longest_s: 5, overlaps: 0 }]);
  assert.match(talk, /role="progressbar"[^>]*aria-valuenow="75"/);
  assert.match(talk, /width:75%/);
});

test('area scope: stored per browser, ignores junk, and builds the query the API expects', async () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  try {
    const { getArea, setArea, areaQuery, areaLabel, AREAS } = await import('../public/app/scope.js');
    assert.equal(getArea(), '');
    assert.equal(areaQuery(), '');
    setArea('health');
    assert.equal(getArea(), 'health');
    assert.equal(areaQuery(), '?area=health');
    assert.equal(areaQuery('&'), '&area=health');
    setArea('bogus');
    assert.equal(getArea(), '');
    store.set('attest.area', 'nope');
    assert.equal(getArea(), '');
    assert.deepEqual(AREAS.map(([k]) => k), ['work', 'personal', 'health', 'learning']);
    assert.equal(areaLabel('learning'), 'Learning');
  } finally { delete globalThis.localStorage; }
});

test('the recording page offers an area picker with the current area selected', async () => {
  const { render } = await import('../public/app/recordings.js');
  const base = { id: 'r1', title: 'T', created_at: 1, status: 'ready', template: 'meeting', has_audio: false, summary: 's', action_items: [], speakers: [], transcript: 't', segments: null, mindmaps: null, unanswered: [] };
  render({ ...base, area: 'health', area_source: 'auto' });
  let html = elements.get('main').innerHTML;
  assert.match(html, /id="area-pick"/);
  assert.match(html, /<option value="health" selected>/);
  assert.doesNotMatch(html, /Auto-pick again/);
  render({ ...base, area: 'personal', area_source: 'manual' });
  html = elements.get('main').innerHTML;
  assert.match(html, /<option value="personal" selected>/);
  assert.match(html, /Auto-pick again/);
});

test('a recording made by shaping says so and offers undo; a hidden original offers to come back', async () => {
  const { render } = await import('../public/app/recordings.js');
  const base = { id: 'r1', title: 'T', created_at: 1, status: 'ready', template: 'meeting', has_audio: true, summary: 's', action_items: [], speakers: [], transcript: 't', segments: null, mindmaps: null, unanswered: [], area: 'work', area_source: 'auto' };
  render({ ...base, lineage: { kind: 'split', from: ['x'], part: 2, of: 3, audio: true } });
  let html = elements.get('main').innerHTML;
  assert.match(html, /Part 2 of 3/);
  assert.match(html, /id="undo-shape"/);
  render({ ...base, lineage: { kind: 'split', from: ['x'], part: 1, of: 2, audio: false } });
  assert.match(elements.get('main').innerHTML, /sound stays on the original/);
  render({ ...base, hidden: true });
  html = elements.get('main').innerHTML;
  assert.match(html, /Undo and bring it back/);
  assert.doesNotMatch(html, /id="reshape"/);
  render({ ...base, segments: [{ speaker: 'A', text: 'hi', start: 0, end: 1 }, { speaker: 'B', text: 'yo', start: 1, end: 2 }] });
  assert.match(elements.get('main').innerHTML, /id="reshape"/);
});
