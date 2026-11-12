// Where a person's recordings come from. Each user picks the ones they actually use (in setup and in
// Settings); the main screen, the setup wizard and the background sync all follow that choice, so
// nobody sees buttons for devices they do not own. Any number can be on at once.
//
//   mic      record or upload in the app itself (no key)
//   pocket   Pocket recorder, pulled with its API key
//   omi      Omi account (also where a Limitless pendant paired with the Omi app lands): transcripts
//   pendant  Limitless pendant straight over Bluetooth via the Attest Mac/iOS app: full audio. The
//            app uploads through the normal upload route, so the server has nothing to pull.

export const SOURCES = [
  { id: 'mic', label: 'Record or upload in this app', key: null, pull: false },
  { id: 'pocket', label: 'Pocket', key: 'POCKET_API_KEY', pull: true },
  { id: 'omi', label: 'Omi, or a Limitless pendant paired with the Omi app', key: 'OMI_API_KEY', pull: true },
  { id: 'pendant', label: 'Limitless pendant over Bluetooth (Attest app for Mac or iPhone)', key: null, pull: false },
];
export const SOURCE_IDS = SOURCES.map((s) => s.id);

// Chosen sources. Nothing saved yet (SOURCES unset): the mic plus every source that already has a key,
// so a deploy from before this choice existed keeps its Pocket button. 'none' means deliberately empty.
export function sourcesOf(env) {
  const raw = String(env.SOURCES || '').trim();
  if (!raw) return SOURCES.filter((s) => s.id === 'mic' || (s.key && env[s.key])).map((s) => s.id);
  const picked = raw.split(',').map((x) => x.trim());
  return SOURCE_IDS.filter((id) => picked.includes(id));
}

// For the main screen: the chosen sources, and whether each can import right now (has its key).
export function sourceStates(env) {
  const on = sourcesOf(env);
  return SOURCES.filter((s) => on.includes(s.id))
    .map((s) => ({ id: s.id, label: s.label, pull: s.pull, ready: s.pull ? Boolean(env[s.key]) : true }));
}

// A settings/body value -> the stored string, or {error}. An empty list is stored as 'none' because
// an empty saved setting means "unset it".
export function sourcesValue(list) {
  if (!Array.isArray(list)) return { error: 'sources must be a list' };
  const bad = list.find((x) => !SOURCE_IDS.includes(x));
  if (bad !== undefined) return { error: `unknown source: ${String(bad).slice(0, 30)}` };
  const ids = SOURCE_IDS.filter((id) => list.includes(id));
  return { value: ids.length ? ids.join(',') : 'none' };
}
