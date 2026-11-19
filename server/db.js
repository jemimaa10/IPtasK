import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from './config.js';

if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  avatar_path   TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  leader_id          INTEGER NOT NULL REFERENCES users(id),
  verify_grace_hours INTEGER NOT NULL DEFAULT 24,
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  inviter_id INTEGER NOT NULL REFERENCES users(id),
  invitee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- status: open | submitted | revision | verified | failed | unverified
CREATE TABLE IF NOT EXISTS missions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id            INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  assignee_id         INTEGER NOT NULL REFERENCES users(id),
  created_by          INTEGER NOT NULL REFERENCES users(id),
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  deadline            INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open',
  series_id           TEXT,
  h1_notified         INTEGER NOT NULL DEFAULT 0,
  reviewers_reminded  INTEGER NOT NULL DEFAULT 0,
  last_daily_reminder TEXT,
  created_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS proofs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  caption    TEXT NOT NULL DEFAULT '',
  ai_note    TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS proof_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  proof_id      INTEGER NOT NULL REFERENCES proofs(id) ON DELETE CASCADE,
  stored_name   TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL
);

-- type: checked | revision
CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  proof_id    INTEGER NOT NULL REFERENCES proofs(id) ON DELETE CASCADE,
  reviewer_id INTEGER NOT NULL REFERENCES users(id),
  type        TEXT NOT NULL,
  message     TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

-- kind: missed_deadline | unchecked | unverified
CREATE TABLE IF NOT EXISTS confessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id       INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  mission_id     INTEGER REFERENCES missions(id) ON DELETE SET NULL,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  target_user_id INTEGER REFERENCES users(id),
  kind           TEXT NOT NULL,
  quote          TEXT NOT NULL,
  roast          TEXT,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  link       TEXT,
  actor_id   INTEGER REFERENCES users(id),
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_group  ON messages(group_id, id);
CREATE INDEX IF NOT EXISTS idx_missions_group  ON missions(group_id);
CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status, deadline);
CREATE INDEX IF NOT EXISTS idx_proofs_mission  ON proofs(mission_id);
CREATE INDEX IF NOT EXISTS idx_reviews_proof   ON reviews(proof_id);
CREATE INDEX IF NOT EXISTS idx_notif_user      ON notifications(user_id, id);
CREATE INDEX IF NOT EXISTS idx_conf_group      ON confessions(group_id, id);
`);

/**
 * Schema changes after the base schema above. Never edit an entry once it has shipped:
 * append a new one. PRAGMA user_version records how many have run on this database.
 */
const MIGRATIONS = [
  // 1: self-service recovery code (hashed) for "forgot password", plus a session expiry index.
  () => db.exec(`
    ALTER TABLE users ADD COLUMN recovery_hash TEXT;
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  `),
  // 2: reminder frequency. Group default (0 = off, 1 = daily, 2 = every 2 days, …),
  //    optional per-mission override (NULL = follow the group), and the local day number of the last reminder.
  () => {
    db.exec(`
      ALTER TABLE groups ADD COLUMN reminder_every_days INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE missions ADD COLUMN reminder_every_days INTEGER;
      ALTER TABLE missions ADD COLUMN last_reminder_day INTEGER;
    `);
    // Carry over "already reminded today" from the old date-string column.
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    db.prepare('UPDATE missions SET last_reminder_day = ? WHERE last_daily_reminder = ?').run(localDayNumber(), todayKey);
  },
  // 3: "Beban <group>" labels for missed jobdesks, removed by a unanimous redeem vote of the group.
  () => db.exec(`
    CREATE TABLE IF NOT EXISTS labels (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      mission_id  INTEGER REFERENCES missions(id) ON DELETE SET NULL,
      reason      TEXT NOT NULL,          -- title of the last missed jobdesk
      fail_count  INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL,
      redeemed_at INTEGER                 -- NULL while the label is active
    );
    CREATE INDEX IF NOT EXISTS idx_labels_user  ON labels(user_id, redeemed_at);
    CREATE INDEX IF NOT EXISTS idx_labels_group ON labels(group_id, redeemed_at);

    -- status: open | approved | rejected
    CREATE TABLE IF NOT EXISTS redeem_requests (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      label_id   INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      message    TEXT NOT NULL DEFAULT '',
      status     TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      closed_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_redeem_label ON redeem_requests(label_id, status);

    CREATE TABLE IF NOT EXISTS redeem_votes (
      request_id INTEGER NOT NULL REFERENCES redeem_requests(id) ON DELETE CASCADE,
      voter_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      approve    INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (request_id, voter_id)
    );
  `),
];

/** Days since 1970-01-01 in the server's local time zone, so "every 2 days" follows calendar days. */
export function localDayNumber(ts = Date.now()) {
  return Math.floor((ts - new Date(ts).getTimezoneOffset() * 60_000) / 86_400_000);
}

function migrate() {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    tx(() => {
      MIGRATIONS[v]();
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
    console.log(`[db] migrated to schema v${v + 1}`);
  }
}

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const one = (sql, ...params) => db.prepare(sql).get(...params);
export const all = (sql, ...params) => db.prepare(sql).all(...params);
export const run = (sql, ...params) => db.prepare(sql).run(...params);

migrate();
