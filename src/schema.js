// Database schema as code, applied automatically by ensureSchema() so a deployer never
// runs SQL by hand, on first deploy or on upgrade.
//
// HOW TO CHANGE THE SCHEMA LATER: never edit a shipped migration. Append a new entry to
// MIGRATIONS with the next id and the statements to run, e.g.
//   { id: 2, sql: ['ALTER TABLE recordings ADD COLUMN foo TEXT'] }
// Each migration runs once, in order, atomically (D1 batch), and is recorded in the
// schema_migrations table. A fresh database runs all of them; an existing one runs
// only the ones it hasn't seen. Migration 1 is idempotent (IF NOT EXISTS) so it is also
// safe on a database created before this runner existed.

const BASELINE = [
  "CREATE TABLE IF NOT EXISTS recordings ( id           TEXT PRIMARY KEY, owner        TEXT NOT NULL DEFAULT 'local', title        TEXT NOT NULL, created_at   INTEGER NOT NULL, duration_ms  INTEGER, r2_key       TEXT NOT NULL, content_type TEXT NOT NULL DEFAULT 'audio/webm', status       TEXT NOT NULL DEFAULT 'uploaded', error        TEXT, template     TEXT NOT NULL DEFAULT 'meeting', model        TEXT, transcriber  TEXT NOT NULL DEFAULT 'gpt-4o-transcribe-diarize', transcript   TEXT, segments     TEXT, summary      TEXT, action_items TEXT, mindmap      TEXT, mindmaps     TEXT, tokens_in    INTEGER, tokens_out   INTEGER, speakers     TEXT, live_transcript TEXT, status_at    INTEGER, pocket_id    TEXT )",
  "CREATE INDEX IF NOT EXISTS recordings_owner_created ON recordings (owner, created_at DESC)",
  "CREATE UNIQUE INDEX IF NOT EXISTS recordings_pocket ON recordings (owner, pocket_id)",
  "CREATE TABLE IF NOT EXISTS custom_templates ( id         TEXT PRIMARY KEY, owner      TEXT NOT NULL, key        TEXT NOT NULL, label      TEXT NOT NULL, style      TEXT NOT NULL, length     TEXT, created_at INTEGER NOT NULL, UNIQUE(owner, key) )",
  "CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5( id UNINDEXED, title, transcript )",
  "CREATE TABLE IF NOT EXISTS people ( id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, aliases TEXT, notes TEXT, created_at INTEGER NOT NULL, UNIQUE(owner, name) )",
  "CREATE TABLE IF NOT EXISTS voiceprints ( id TEXT PRIMARY KEY, owner TEXT NOT NULL, person_id TEXT NOT NULL, r2_key TEXT NOT NULL, duration_ms INTEGER, created_at INTEGER NOT NULL )",
  "CREATE INDEX IF NOT EXISTS voiceprints_owner_created ON voiceprints (owner, created_at DESC)",
  "CREATE TABLE IF NOT EXISTS chats ( id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL )",
  "CREATE TABLE IF NOT EXISTS chat_messages ( id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, sources TEXT, created_at INTEGER NOT NULL )",
  "CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages (chat_id, created_at)",
]

export const MIGRATIONS = [
  { id: 1, sql: BASELINE },
  // In-app settings (provider, models, keys). Overlaid on the Worker env at request time.
  { id: 2, sql: ['CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL )'] },
  // Provider-independent voice matching (#24): 192-float speaker embeddings computed in the
  // browser, and the scores of the last match run on a recording.
  { id: 3, sql: [
    'ALTER TABLE voiceprints ADD COLUMN embedding TEXT',
    'ALTER TABLE voiceprints ADD COLUMN embedding_model TEXT',
    'ALTER TABLE recordings ADD COLUMN voice_match TEXT',
  ] },
  // Today screen: questions left unanswered (from the summarize call) and cached
  // daily / weekly briefs, one per (owner, kind, period).
  { id: 4, sql: [
    'ALTER TABLE recordings ADD COLUMN unanswered TEXT',
    'CREATE TABLE IF NOT EXISTS briefs ( owner TEXT NOT NULL, kind TEXT NOT NULL, period TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (owner, kind, period) )',
  ] },
  // Structured memory + semantic index bookkeeping (see src/memory.js, src/vectors.js).
  // facts_at: facts extracted. vec_chunks: how many vectors this recording has in Vectorize.
  { id: 5, sql: [
    'CREATE TABLE IF NOT EXISTS facts ( id TEXT PRIMARY KEY, owner TEXT NOT NULL, recording_id TEXT NOT NULL, kind TEXT NOT NULL, person TEXT, text TEXT NOT NULL, quote TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL )',
    'CREATE INDEX IF NOT EXISTS facts_owner_recording ON facts (owner, recording_id)',
    'CREATE INDEX IF NOT EXISTS facts_owner_person ON facts (owner, person)',
    'ALTER TABLE recordings ADD COLUMN facts_at INTEGER',
    'ALTER TABLE recordings ADD COLUMN vec_chunks INTEGER',
  ] },
  // Local mode (src/local.js): a vector index inside D1, standing in for Vectorize, which does
  // not run locally. Vectors are float32, normalised, stored base64 so any D1/SQLite returns
  // them the same way. Always created (it is empty and harmless on Cloudflare).
  { id: 6, sql: [
    'CREATE TABLE IF NOT EXISTS local_vectors ( id TEXT PRIMARY KEY, namespace TEXT NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL, vec TEXT NOT NULL, metadata TEXT )',
    'CREATE INDEX IF NOT EXISTS local_vectors_ns ON local_vectors (namespace, model)',
  ] },
  // How long each processing stage took, per audio length, to estimate time remaining (src/timings.js).
  { id: 7, sql: [
    'CREATE TABLE IF NOT EXISTS process_timings ( id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, stage TEXT NOT NULL, key TEXT NOT NULL DEFAULT \'\', audio_ms INTEGER NOT NULL, work_ms INTEGER NOT NULL, at INTEGER NOT NULL )',
    'CREATE INDEX IF NOT EXISTS process_timings_lookup ON process_timings (owner, stage, key, at DESC)',
  ] },
  // Brief items the owner has acknowledged on Today; hidden from the daily brief and weekly review.
  { id: 8, sql: [
    'CREATE TABLE IF NOT EXISTS brief_acks ( owner TEXT NOT NULL, key TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (owner, key) )',
  ] },
  // Omi import: the Omi conversation id a row came from (one row per conversation). Imported rows
  // have no audio, so their r2_key is '' (see src/routes/omi.js).
  { id: 9, sql: [
    'ALTER TABLE recordings ADD COLUMN omi_id TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS recordings_omi ON recordings (owner, omi_id)',
  ] },
  // Idempotent uploads from a device app (the Bluetooth pendant app retries until the server says yes):
  // the client's own id for the recording, one row per (owner, ingest_id).
  { id: 10, sql: [
    'ALTER TABLE recordings ADD COLUMN ingest_id TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS recordings_ingest ON recordings (owner, ingest_id)',
  ] },
  // Areas (#5): work / personal / health / learning. area_source is 'auto' (inferred from the
  // template, then the content) or 'manual' (a person chose it; never overwritten automatically).
  { id: 11, sql: [
    "ALTER TABLE recordings ADD COLUMN area TEXT NOT NULL DEFAULT 'work'",
    "ALTER TABLE recordings ADD COLUMN area_source TEXT NOT NULL DEFAULT 'auto'",
    'CREATE INDEX IF NOT EXISTS recordings_owner_area ON recordings (owner, area, created_at DESC)',
  ] },
  // Conversation shaping: dead air trimmed, long recordings split into separate conversations, pieces of
  // one call merged back together. The original rows stay (hidden = 1) so imports remain idempotent and
  // the change can be undone; the new rows say where they came from in lineage
  // ({kind: 'trim'|'split'|'merge', from: [ids]}). src is who made the recording ('device' = the pendant
  // app, 'pocket'); only recordings from the same source are ever merged automatically.
  { id: 12, sql: [
    'ALTER TABLE recordings ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE recordings ADD COLUMN lineage TEXT',
    'ALTER TABLE recordings ADD COLUMN src TEXT',
  ] },
];

// Applies every migration not yet recorded. `db` is a D1 binding (or anything with the
// same prepare/batch/all/run shape). Returns the ids it applied.
export async function runMigrations(db, migrations = MIGRATIONS) {
  await db.prepare(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)'
  ).run();
  const appliedIds = async () =>
    new Set(((await db.prepare('SELECT id FROM schema_migrations').all()).results || []).map((r) => r.id));
  const done = await appliedIds();
  const applied = [];
  for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
    if (done.has(m.id)) continue;
    try {
      await db.batch([
        ...m.sql.map((q) => db.prepare(q)),
        db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?,?)').bind(m.id, Date.now()),
      ]);
      applied.push(m.id);
    } catch (e) {
      // Two Worker instances can race on a cold database; if the other one won, we're fine.
      if ((await appliedIds()).has(m.id)) continue;
      throw e;
    }
  }
  return applied;
}

let ready = null;

// One probe per Worker isolate once everything is applied.
export function ensureSchema(env) {
  if (!ready) ready = runMigrations(env.DB).catch((e) => { ready = null; throw e; });
  return ready;
}
