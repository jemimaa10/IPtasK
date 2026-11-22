// Postgres everywhere: Supabase (or any Postgres) when DATABASE_URL is set, otherwise a local PGlite database
// (Postgres compiled to WebAssembly, stored in data/pglite) so development needs no database server.
//
// Queries use `?` placeholders. All helpers are async:
//   await one(sql, ...params)   → first row or undefined
//   await all(sql, ...params)   → rows
//   await run(sql, ...params)   → { changes, lastInsertRowid }
//   await tx(async () => { … }) → runs every query inside in one transaction
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DATABASE_URL, DB_PATH } from './config.js';

// BIGINT (ids, timestamps, COUNT) and NUMERIC come back as text by default; every value here fits a JS number.
const toNumber = (v) => (v === null ? null : Number(v));

let base; // { query(text, values) → { rows, rowCount }, exec(sql), transaction(fn) }

if (DATABASE_URL) {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(20, toNumber);
  pg.types.setTypeParser(1700, toNumber);
  const url = new URL(DATABASE_URL);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  url.searchParams.delete('sslmode'); // TLS is configured below; the URL's sslmode would override it
  const pool = new pg.Pool({
    connectionString: url.toString(),
    // Supabase's pooler certificate is not in Node's CA list; the connection is still encrypted.
    ssl: local ? false : { rejectUnauthorized: false },
    // Serverless (Vercel): each instance keeps few, short-lived connections; use Supabase's transaction pooler there.
    max: Number(process.env.DATABASE_POOL_SIZE) || (process.env.VERCEL ? 2 : 5),
    idleTimeoutMillis: process.env.VERCEL ? 5_000 : 30_000,
  });
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  base = {
    close: () => pool.end(),
    query: (text, values) => pool.query(text, values),
    exec: (sql) => pool.query(sql),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (text, values) => client.query(text, values), exec: (sql) => client.query(sql) });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
} else {
  const { PGlite } = await import('@electric-sql/pglite');
  const memory = DB_PATH === ':memory:';
  if (!memory) fs.mkdirSync(DB_PATH, { recursive: true });
  const lite = await PGlite.create({ ...(memory ? {} : { dataDir: DB_PATH }), parsers: { 20: toNumber, 1700: toNumber } });
  base = {
    close: () => lite.close(),
    query: (text, values) => lite.query(text, values),
    exec: (sql) => lite.exec(sql),
    transaction: (fn) => lite.transaction((t) => fn({ query: (text, values) => t.query(text, values), exec: (sql) => t.exec(sql) })),
  };
}

export const driver = DATABASE_URL ? 'postgres' : DB_PATH === ':memory:' ? 'pglite (memory)' : 'pglite';

/** The transaction the current async call chain is inside, if any. */
const current = new AsyncLocalStorage();

/** `?` → `$1, $2, …`, skipping question marks inside '…' string literals. Cached per SQL string. */
const converted = new Map();
function toPg(sql) {
  let out = converted.get(sql);
  if (out) return out;
  out = '';
  let n = 0;
  let quoted = false;
  for (const ch of sql) {
    if (ch === "'") quoted = !quoted;
    out += ch === '?' && !quoted ? `$${++n}` : ch;
  }
  converted.set(sql, out);
  return out;
}

async function query(sql, params) {
  // NaN (e.g. Number('abc') from a URL) matches nothing, like it did in SQLite, instead of a type error.
  const values = params.map((v) => (typeof v === 'number' && Number.isNaN(v) ? null : v));
  const target = current.getStore() || base;
  return target.query(toPg(sql), values);
}

export const one = async (sql, ...params) => (await query(sql, params)).rows[0];
export const all = async (sql, ...params) => (await query(sql, params)).rows;
export async function run(sql, ...params) {
  // INSERTs return the new row so callers can read its id, like SQLite's lastInsertRowid.
  const wantsRow = /^\s*insert\b/i.test(sql) && !/\breturning\b/i.test(sql);
  const result = await query(wantsRow ? `${sql} RETURNING *` : sql, params);
  return { changes: result.rowCount ?? 0, lastInsertRowid: result.rows?.[0]?.id ?? null, row: result.rows?.[0] };
}

/** Runs fn in a transaction. Nested calls join the outer transaction. */
export function tx(fn) {
  if (current.getStore()) return fn();
  return base.transaction((client) => current.run(client, fn));
}

/** For scripts: flush and close the database so the process can exit. */
export const closeDb = () => base.close();

/** Runs several statements at once (no parameters). */
export const exec = (sql) => (current.getStore() || base).exec(sql);

// ---------- schema ----------

// Version 0 is the full schema below (it matches the old SQLite schema v4).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,          -- '' for Google-only accounts
  display_name  TEXT NOT NULL,
  avatar_path   TEXT,
  recovery_hash TEXT,
  google_sub    TEXT,
  email         TEXT,
  created_at    BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (LOWER(username));
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google ON users (google_sub);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS groups (
  id                  BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name                TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  leader_id           BIGINT NOT NULL REFERENCES users(id),
  verify_grace_hours  INTEGER NOT NULL DEFAULT 24,
  reminder_every_days INTEGER NOT NULL DEFAULT 1,   -- 0 = off, 1 = daily, 2 = every 2 days, …
  created_at          BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id  BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member',
  joined_at BIGINT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON group_members (user_id);

CREATE TABLE IF NOT EXISTS invites (
  id         BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  group_id   BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  inviter_id BIGINT NOT NULL REFERENCES users(id),
  invitee_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  group_id   BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages (group_id, id);

-- status: open | submitted | revision | verified | failed | unverified
CREATE TABLE IF NOT EXISTS missions (
  id                  BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  group_id            BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  assignee_id         BIGINT NOT NULL REFERENCES users(id),
  created_by          BIGINT NOT NULL REFERENCES users(id),
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  deadline            BIGINT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open',
  series_id           TEXT,
  h1_notified         INTEGER NOT NULL DEFAULT 0,
  reviewers_reminded  INTEGER NOT NULL DEFAULT 0,
  reminder_every_days INTEGER,          -- NULL = follow the group
  last_reminder_day   INTEGER,          -- local day number of the last reminder
  created_at          BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_missions_group  ON missions (group_id);
CREATE INDEX IF NOT EXISTS idx_missions_status ON missions (status, deadline);

CREATE TABLE IF NOT EXISTS proofs (
  id         BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  mission_id BIGINT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  group_id   BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  caption    TEXT NOT NULL DEFAULT '',
  ai_note    TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proofs_mission ON proofs (mission_id);
CREATE INDEX IF NOT EXISTS idx_proofs_group   ON proofs (group_id, created_at);

CREATE TABLE IF NOT EXISTS proof_files (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  proof_id      BIGINT NOT NULL REFERENCES proofs(id) ON DELETE CASCADE,
  stored_name   TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proof_files_proof ON proof_files (proof_id);

-- type: checked | revision
CREATE TABLE IF NOT EXISTS reviews (
  id          BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  proof_id    BIGINT NOT NULL REFERENCES proofs(id) ON DELETE CASCADE,
  reviewer_id BIGINT NOT NULL REFERENCES users(id),
  type        TEXT NOT NULL,
  message     TEXT NOT NULL DEFAULT '',
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_proof ON reviews (proof_id);

-- kind: missed_deadline | unchecked | unverified
CREATE TABLE IF NOT EXISTS confessions (
  id             BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  group_id       BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  mission_id     BIGINT REFERENCES missions(id) ON DELETE SET NULL,
  user_id        BIGINT NOT NULL REFERENCES users(id),
  target_user_id BIGINT REFERENCES users(id),
  kind           TEXT NOT NULL,
  quote          TEXT NOT NULL,
  roast          TEXT,
  created_at     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conf_group ON confessions (group_id, id);

CREATE TABLE IF NOT EXISTS notifications (
  id         BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  link       TEXT,
  actor_id   BIGINT REFERENCES users(id),
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications (user_id, id);

-- "Beban <group>" labels for missed jobdesks, removed by a unanimous redeem vote of the group.
CREATE TABLE IF NOT EXISTS labels (
  id          BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id    BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  mission_id  BIGINT REFERENCES missions(id) ON DELETE SET NULL,
  reason      TEXT NOT NULL,          -- title of the last missed jobdesk
  fail_count  INTEGER NOT NULL DEFAULT 1,
  created_at  BIGINT NOT NULL,
  redeemed_at BIGINT                  -- NULL while the label is active
);
CREATE INDEX IF NOT EXISTS idx_labels_user  ON labels (user_id, redeemed_at);
CREATE INDEX IF NOT EXISTS idx_labels_group ON labels (group_id, redeemed_at);

-- status: open | approved | rejected
CREATE TABLE IF NOT EXISTS redeem_requests (
  id         BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  label_id   BIGINT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  message    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'open',
  created_at BIGINT NOT NULL,
  closed_at  BIGINT
);
CREATE INDEX IF NOT EXISTS idx_redeem_label ON redeem_requests (label_id, status);

CREATE TABLE IF NOT EXISTS redeem_votes (
  request_id BIGINT NOT NULL REFERENCES redeem_requests(id) ON DELETE CASCADE,
  voter_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approve    INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (request_id, voter_id)
);
`;

/**
 * Schema changes after the base schema above. Never edit an entry once it has shipped:
 * append a new async function. The schema_version table records how many have run.
 */
const MIGRATIONS = [
  // 1: live updates for open pages (replaces Socket.IO, which serverless hosts cannot keep open).
  //    Pages long-poll GET /api/events; rows older than a day are deleted by the scheduler.
  () => exec(`
    CREATE TABLE IF NOT EXISTS events (
      id         BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      user_id    BIGINT,          -- for one user, or
      group_id   BIGINT,          -- for everyone looking at this group
      type       TEXT NOT NULL,
      payload    TEXT NOT NULL DEFAULT '{}',
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_user  ON events (user_id, id);
    CREATE INDEX IF NOT EXISTS idx_events_group ON events (group_id, id);
  `),
];

/** Tables in foreign-key order (parents first). Used by the SQLite importer. */
export const TABLES = [
  'users', 'sessions', 'groups', 'group_members', 'invites', 'messages', 'missions', 'proofs',
  'proof_files', 'reviews', 'confessions', 'notifications', 'labels', 'redeem_requests', 'redeem_votes',
];

export { localDayNumber } from './time.js';

export async function schemaVersion() {
  return (await one('SELECT version FROM schema_version'))?.version ?? 0;
}

async function migrate() {
  // Serverless cold starts: one cheap query when the schema is already up to date.
  const fresh = !(await one("SELECT to_regclass('schema_version') AS t")).t;
  if (!fresh && (await schemaVersion()) === MIGRATIONS.length) return;
  await exec(SCHEMA);
  if (!(await one('SELECT 1 FROM schema_version'))) await run('INSERT INTO schema_version (version) VALUES (0)');
  for (let v = await schemaVersion(); v < MIGRATIONS.length; v++) {
    await tx(async () => {
      await MIGRATIONS[v]();
      await run('UPDATE schema_version SET version = ?', v + 1);
    });
    console.log(`[db] migrated to schema v${v + 1}`);
  }
}

await migrate();
