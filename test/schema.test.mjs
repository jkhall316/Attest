import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, MIGRATIONS } from '../src/schema.js';

// Minimal D1-shaped wrapper over a real in-memory SQLite, so the migrations are
// actually executed (not mocked).
function d1() {
  const raw = new DatabaseSync(':memory:');
  const db = {
    raw,
    prepare(sql) {
      const st = { args: [], bind(...a) { st.args = a; return st; },
        all: async () => ({ results: raw.prepare(sql).all(...st.args) }),
        run: async () => { raw.prepare(sql).run(...st.args); return {}; }, sql };
      return st;
    },
    async batch(stmts) {
      raw.exec('BEGIN');
      try { for (const s of stmts) raw.prepare(s.sql).run(...s.args); raw.exec('COMMIT'); }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
  };
  return db;
}

test('fresh database gets every migration and is usable', async () => {
  const db = d1();
  assert.deepEqual(await runMigrations(db), MIGRATIONS.map((m) => m.id));
  const cols = db.raw.prepare('PRAGMA table_info(recordings)').all().map((c) => c.name);
  assert.ok(cols.includes('pocket_id'));
});

test('re-running applies nothing', async () => {
  const db = d1();
  await runMigrations(db);
  assert.deepEqual(await runMigrations(db), []);
});

test('a later migration is applied once to an existing database', async () => {
  const db = d1();
  await runMigrations(db);
  const more = [...MIGRATIONS, { id: 99, sql: ['ALTER TABLE recordings ADD COLUMN foo TEXT'] }];
  assert.deepEqual(await runMigrations(db, more), [99]);
  assert.deepEqual(await runMigrations(db, more), []);
  assert.ok(db.raw.prepare('PRAGMA table_info(recordings)').all().some((c) => c.name === 'foo'));
});

test('a failing migration rolls back whole and is not recorded', async () => {
  const db = d1();
  await runMigrations(db);
  const bad = [...MIGRATIONS, { id: 99, sql: ['ALTER TABLE recordings ADD COLUMN ok1 TEXT', 'NOT SQL'] }];
  await assert.rejects(() => runMigrations(db, bad));
  assert.ok(!db.raw.prepare('PRAGMA table_info(recordings)').all().some((c) => c.name === 'ok1'));
  assert.deepEqual(db.raw.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('migration 4 adds recordings.unanswered and the briefs table', async () => {
  const db = d1();
  await runMigrations(db);
  assert.ok(db.raw.prepare('PRAGMA table_info(recordings)').all().some((c) => c.name === 'unanswered'));
  db.raw.prepare("INSERT INTO briefs (owner, kind, period, content, created_at) VALUES ('o','today','2026-11-10','x',1)").run();
  assert.throws(() => db.raw.prepare("INSERT INTO briefs (owner, kind, period, content, created_at) VALUES ('o','today','2026-11-10','y',2)").run());
});

test('migration 5 adds facts, facts_at and vec_chunks', async () => {
  const db = d1();
  await runMigrations(db);
  const cols = db.raw.prepare('PRAGMA table_info(recordings)').all().map((c) => c.name);
  assert.ok(cols.includes('facts_at') && cols.includes('vec_chunks'));
  db.raw.prepare("INSERT INTO facts (id, owner, recording_id, kind, text, quote, created_at) VALUES ('f','o','r','decision','t','q',1)").run();
  assert.equal(db.raw.prepare('SELECT done FROM facts').get().done, 0);
});

test('migration 9 adds recordings.omi_id, unique per owner', async () => {
  const db = d1();
  await runMigrations(db);
  assert.ok(db.raw.prepare('PRAGMA table_info(recordings)').all().some((c) => c.name === 'omi_id'));
  const ins = (id, owner, omi) => db.raw.prepare(
    "INSERT INTO recordings (id, owner, title, created_at, r2_key, omi_id) VALUES (?,?,'t',1,'',?)").run(id, owner, omi);
  ins('a', 'me', 'o1');
  ins('b', 'other', 'o1');
  ins('c', 'me', null);
  ins('d', 'me', null);
  assert.throws(() => ins('e', 'me', 'o1'), /UNIQUE/);
});
