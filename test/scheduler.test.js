// Scheduler rules from the README table, run against an in-memory database.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.IPTASK_DB_PATH = ':memory:';
process.env.GEMINI_API_KEY = '';

const { db, one, all, run, localDayNumber } = await import('../server/db.js');
const { runScheduler, refreshMissionStatus } = await import('../server/missions.js');
const { streaks } = await import('../server/stats.js');
const { requestRedeem, castVote, reevaluateGroupRedeems } = await import('../server/labels.js');

const HOUR = 3600_000;
const DAY = 24 * HOUR;

let leader, alice, bob, groupId;

function user(name) {
  return Number(
    run('INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?)', name, 'x', name, Date.now())
      .lastInsertRowid
  );
}

function mission({ assignee = alice, deadline, status = 'open' }) {
  return Number(
    run(
      `INSERT INTO missions (group_id, assignee_id, created_by, title, deadline, status, created_at)
       VALUES (?, ?, ?, 'Task', ?, ?, ?)`,
      groupId, assignee, leader, deadline, status, Date.now() - 2 * DAY
    ).lastInsertRowid
  );
}

function proof(missionId, userId = alice) {
  return Number(
    run('INSERT INTO proofs (mission_id, group_id, user_id, created_at) VALUES (?, ?, ?, ?)', missionId, groupId, userId, Date.now())
      .lastInsertRowid
  );
}

const review = (proofId, reviewer, type) =>
  run('INSERT INTO reviews (proof_id, reviewer_id, type, created_at) VALUES (?, ?, ?, ?)', proofId, reviewer, type, Date.now());

const status = (id) => one('SELECT status FROM missions WHERE id = ?', id).status;
const confessions = () => all('SELECT user_id, kind, quote FROM confessions ORDER BY id');

beforeEach(() => {
  db.exec('DELETE FROM redeem_votes; DELETE FROM redeem_requests; DELETE FROM labels; DELETE FROM confessions; DELETE FROM notifications; DELETE FROM reviews; DELETE FROM proofs; DELETE FROM missions; DELETE FROM group_members; DELETE FROM groups; DELETE FROM sessions; DELETE FROM users;');
  leader = user('leader');
  alice = user('alice');
  bob = user('bob');
  groupId = Number(
    run('INSERT INTO groups (name, leader_id, verify_grace_hours, created_at) VALUES (?, ?, 24, ?)', 'G', leader, Date.now())
      .lastInsertRowid
  );
  for (const [id, role] of [[leader, 'leader'], [alice, 'member'], [bob, 'member']]) {
    run('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', groupId, id, role, Date.now());
  }
});

test('migrations ran: schema version and recovery column exist', () => {
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
  const cols = (t) => all(`PRAGMA table_info(${t})`).map((c) => c.name);
  assert.ok(cols('users').includes('recovery_hash'));
  assert.ok(cols('groups').includes('reminder_every_days'));
  assert.ok(cols('missions').includes('last_reminder_day'));
});

test('deadline passes without proof → failed and assignee is exposed', async () => {
  const id = mission({ deadline: Date.now() - HOUR });
  await runScheduler();
  assert.equal(status(id), 'failed');
  assert.deepEqual(confessions().map((c) => [c.user_id, c.kind]), [[alice, 'missed_deadline']]);
});

test('every other member checks the proof → verified, no confession', async () => {
  const id = mission({ deadline: Date.now() + DAY });
  const p = proof(id);
  review(p, leader, 'checked');
  review(p, bob, 'checked');
  refreshMissionStatus(id);
  assert.equal(status(id), 'verified');
  await runScheduler();
  assert.equal(confessions().length, 0);
});

test('verification window closes with a missing check → reviewer and assignee are exposed', async () => {
  const id = mission({ deadline: Date.now() - 25 * HOUR, status: 'submitted' });
  const p = proof(id);
  review(p, leader, 'checked');
  await runScheduler();
  assert.equal(status(id), 'unverified');
  const posted = confessions();
  assert.deepEqual(posted.map((c) => [c.user_id, c.kind]), [[bob, 'unchecked'], [alice, 'unverified']]);
  assert.match(posted[0].quote, /didn't check alice's work/);
});

test('revision never fixed → assignee gets the "didn\'t fix the revision" confession', async () => {
  const id = mission({ deadline: Date.now() - 25 * HOUR, status: 'revision' });
  const p = proof(id);
  review(p, leader, 'checked');
  review(p, bob, 'revision');
  await runScheduler();
  assert.equal(status(id), 'unverified');
  const posted = confessions();
  assert.equal(posted.length, 1);
  assert.match(posted[0].quote, /didn't fix the revision/);
});

test('still inside the verification window → nothing happens yet', async () => {
  const id = mission({ deadline: Date.now() - HOUR, status: 'submitted' });
  proof(id);
  await runScheduler();
  assert.equal(status(id), 'submitted');
  assert.equal(confessions().length, 0);
});

test('H-1 warning is sent exactly once', async () => {
  mission({ deadline: Date.now() + 10 * HOUR });
  await runScheduler();
  await runScheduler();
  const h1 = all("SELECT * FROM notifications WHERE type = 'deadline_h1' AND user_id = ?", alice);
  assert.equal(h1.length, 1);
});

test('reminders follow the frequency: group default, per-mission override, and off', async () => {
  const today = localDayNumber();
  const reminded = () => all("SELECT body FROM notifications WHERE type = 'daily'").map((n) => n.body);
  const make = (title, lastDaysAgo, every) =>
    run(
      `INSERT INTO missions (group_id, assignee_id, created_by, title, deadline, reminder_every_days, last_reminder_day, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      groupId, alice, leader, title, Date.now() + 10 * DAY, every, today - lastDaysAgo, Date.now()
    );

  run('UPDATE groups SET reminder_every_days = 2 WHERE id = ?', groupId);
  make('group-2d, 1 day ago', 1, null); // not yet
  make('group-2d, 2 days ago', 2, null); // due
  make('daily override, 1 day ago', 1, 1); // due
  make('weekly override, 3 days ago', 3, 7); // not yet
  make('off override, 9 days ago', 9, 0); // never
  await runScheduler();
  assert.deepEqual(reminded().sort(), ['daily override, 1 day ago', 'group-2d, 2 days ago']);

  // Running again the same day sends nothing new.
  await runScheduler();
  assert.equal(reminded().length, 2);

  // Group switched off → missions following the group go quiet, overrides still fire.
  db.exec('DELETE FROM notifications');
  run('UPDATE missions SET last_reminder_day = ?', today - 30);
  run('UPDATE groups SET reminder_every_days = 0 WHERE id = ?', groupId);
  await runScheduler();
  assert.deepEqual(reminded().sort(), ['daily override, 1 day ago', 'weekly override, 3 days ago']);
});

test('missed deadline puts a "Beban <group>" label; a repeat miss raises the count', async () => {
  mission({ deadline: Date.now() - HOUR });
  await runScheduler();
  let labels = all('SELECT * FROM labels WHERE user_id = ? AND redeemed_at IS NULL', alice);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].fail_count, 1);

  mission({ deadline: Date.now() - HOUR });
  await runScheduler();
  labels = all('SELECT * FROM labels WHERE user_id = ? AND redeemed_at IS NULL', alice);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].fail_count, 2);
});

test('redeem needs every other member to approve; one reject closes the vote with a cooldown', async () => {
  mission({ deadline: Date.now() - HOUR });
  await runScheduler();
  const label = one('SELECT * FROM labels WHERE user_id = ?', alice);

  assert.equal(castVote(1, leader, true).status, 404); // no such vote yet
  const first = requestRedeem(label.id, alice, 'Maaf, aku janji lebih baik');
  assert.equal(first.status, 'open');
  assert.equal(requestRedeem(label.id, alice).error, 'A redeem vote is already running.');
  assert.equal(castVote(first.requestId, alice, true).status, 403); // can't vote on yourself

  assert.equal(castVote(first.requestId, leader, true).status, 'open');
  assert.equal(castVote(first.requestId, bob, false).status, 'rejected');
  assert.equal(one('SELECT redeemed_at FROM labels WHERE id = ?', label.id).redeemed_at, null);
  assert.equal(requestRedeem(label.id, alice).status, 429); // cooldown

  run("UPDATE redeem_requests SET closed_at = ? WHERE status = 'rejected'", Date.now() - 25 * HOUR);
  const second = requestRedeem(label.id, alice);
  castVote(second.requestId, leader, true);
  assert.equal(castVote(second.requestId, bob, true).status, 'approved');
  assert.ok(one('SELECT redeemed_at FROM labels WHERE id = ?', label.id).redeemed_at);
});

test('a member who leaves no longer blocks a redeem vote', async () => {
  mission({ deadline: Date.now() - HOUR });
  await runScheduler();
  const label = one('SELECT * FROM labels WHERE user_id = ?', alice);
  const { requestId } = requestRedeem(label.id, alice);
  castVote(requestId, leader, true);
  run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', groupId, bob);
  reevaluateGroupRedeems(groupId);
  assert.equal(one('SELECT status FROM redeem_requests WHERE id = ?', requestId).status, 'approved');
});

test('expired sessions are cleaned up', async () => {
  run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', 'old', alice, Date.now() - 1000);
  run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', 'new', alice, Date.now() + DAY);
  await runScheduler();
  assert.deepEqual(all('SELECT token FROM sessions').map((s) => s.token), ['new']);
});

test('streaks count consecutive days and survive a not-yet-done today', () => {
  const now = new Date(2026, 0, 10, 12).getTime();
  const at = (daysAgo) => now - daysAgo * DAY;
  assert.deepEqual(streaks([], now), { current: 0, best: 0 });
  assert.deepEqual(streaks([at(0), at(1), at(2)], now), { current: 3, best: 3 });
  assert.deepEqual(streaks([at(1), at(2)], now), { current: 2, best: 2 });
  assert.deepEqual(streaks([at(3), at(5), at(6), at(7), at(7)], now), { current: 0, best: 3 });
});
