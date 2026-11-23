// Scheduler rules from the README table, run against an in-memory Postgres (PGlite).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.IPTASK_DB_PATH = ':memory:';
process.env.DATABASE_URL = '';
process.env.GEMINI_API_KEY = '';

const { exec, one, all, run, tx, localDayNumber, schemaVersion } = await import('../server/db.js');
const { runScheduler, refreshMissionStatus } = await import('../server/missions.js');
const { streaks, userStats } = await import('../server/stats.js');
const { requestRedeem, castVote, reevaluateGroupRedeems } = await import('../server/labels.js');

const HOUR = 3600_000;
const DAY = 24 * HOUR;

let leader, alice, bob, groupId;

async function user(name) {
  const info = await run('INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?)', name, 'x', name, Date.now());
  return Number(info.lastInsertRowid);
}

async function mission({ assignee = alice, deadline, status = 'open' }) {
  const info = await run(
    `INSERT INTO missions (group_id, assignee_id, created_by, title, deadline, status, created_at)
     VALUES (?, ?, ?, 'Task', ?, ?, ?)`,
    groupId, assignee, leader, deadline, status, Date.now() - 2 * DAY
  );
  return Number(info.lastInsertRowid);
}

async function proof(missionId, userId = alice) {
  const info = await run('INSERT INTO proofs (mission_id, group_id, user_id, created_at) VALUES (?, ?, ?, ?)', missionId, groupId, userId, Date.now());
  return Number(info.lastInsertRowid);
}

const review = (proofId, reviewer, type) =>
  run('INSERT INTO reviews (proof_id, reviewer_id, type, created_at) VALUES (?, ?, ?, ?)', proofId, reviewer, type, Date.now());

const status = async (id) => (await one('SELECT status FROM missions WHERE id = ?', id)).status;
const confessions = () => all('SELECT user_id, kind, quote FROM confessions ORDER BY id');

beforeEach(async () => {
  await exec('DELETE FROM redeem_votes; DELETE FROM redeem_requests; DELETE FROM labels; DELETE FROM confessions; DELETE FROM notifications; DELETE FROM reviews; DELETE FROM proofs; DELETE FROM missions; DELETE FROM group_members; DELETE FROM groups; DELETE FROM sessions; DELETE FROM users;');
  leader = await user('leader');
  alice = await user('alice');
  bob = await user('bob');
  const g = await run('INSERT INTO groups (name, leader_id, verify_grace_hours, created_at) VALUES (?, ?, 24, ?)', 'G', leader, Date.now());
  groupId = Number(g.lastInsertRowid);
  for (const [id, role] of [[leader, 'leader'], [alice, 'member'], [bob, 'member']]) {
    await run('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', groupId, id, role, Date.now());
  }
});

test('schema is in place: version, columns, case-insensitive usernames', async () => {
  assert.equal(await schemaVersion(), 2);
  const cols = async (t) =>
    (await all('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?', t)).map((c) => c.column_name);
  assert.ok((await cols('events')).includes('payload'));
  assert.ok((await cols('users')).includes('recovery_hash'));
  assert.ok((await cols('users')).includes('google_sub'));
  assert.ok((await cols('groups')).includes('reminder_every_days'));
  assert.ok((await cols('missions')).includes('last_reminder_day'));
  await assert.rejects(user('ALICE'), /duplicate key/);
});

test('query helper: ? placeholders, a quoted ?, NaN, numbers come back as numbers', async () => {
  assert.equal((await one("SELECT '?' AS q, ?::int AS n", 5)).n, 5);
  assert.equal((await one("SELECT '?' AS q")).q, '?');
  assert.equal(await one('SELECT * FROM users WHERE id = ?', NaN), undefined);
  assert.equal((await one('SELECT COUNT(*) AS c FROM users')).c, 3);
  assert.equal(typeof (await one('SELECT created_at FROM users LIMIT 1')).created_at, 'number');
});

test('a failed transaction rolls back everything inside it', async () => {
  await assert.rejects(tx(async () => {
    await run('UPDATE users SET display_name = ? WHERE id = ?', 'changed', alice);
    await run('INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?)', 'bob', 'x', 'dup', 0);
  }));
  assert.equal((await one('SELECT display_name FROM users WHERE id = ?', alice)).display_name, 'alice');
});

test('deadline passes without proof → failed and assignee is exposed', async () => {
  const id = await mission({ deadline: Date.now() - HOUR });
  await runScheduler();
  assert.equal(await status(id), 'failed');
  assert.deepEqual((await confessions()).map((c) => [c.user_id, c.kind]), [[alice, 'missed_deadline']]);
});

test('every other member checks the proof → verified, no confession', async () => {
  const id = await mission({ deadline: Date.now() + DAY });
  const p = await proof(id);
  await review(p, leader, 'checked');
  await review(p, bob, 'checked');
  await refreshMissionStatus(id);
  assert.equal(await status(id), 'verified');
  await runScheduler();
  assert.equal((await confessions()).length, 0);
});

test('verification window closes with a missing check → reviewer and assignee are exposed', async () => {
  const id = await mission({ deadline: Date.now() - 25 * HOUR, status: 'submitted' });
  const p = await proof(id);
  await review(p, leader, 'checked');
  await runScheduler();
  assert.equal(await status(id), 'unverified');
  const posted = await confessions();
  assert.deepEqual(posted.map((c) => [c.user_id, c.kind]), [[bob, 'unchecked'], [alice, 'unverified']]);
  assert.match(posted[0].quote, /didn't check alice's work/);
});

test('revision never fixed → assignee gets the "didn\'t fix the revision" confession', async () => {
  const id = await mission({ deadline: Date.now() - 25 * HOUR, status: 'revision' });
  const p = await proof(id);
  await review(p, leader, 'checked');
  await review(p, bob, 'revision');
  await runScheduler();
  assert.equal(await status(id), 'unverified');
  const posted = await confessions();
  assert.equal(posted.length, 1);
  assert.match(posted[0].quote, /didn't fix the revision/);
});

test('still inside the verification window → nothing happens yet', async () => {
  const id = await mission({ deadline: Date.now() - HOUR, status: 'submitted' });
  await proof(id);
  await runScheduler();
  assert.equal(await status(id), 'submitted');
  assert.equal((await confessions()).length, 0);
});

test('H-1 warning is sent exactly once', async () => {
  await mission({ deadline: Date.now() + 10 * HOUR });
  await runScheduler();
  await runScheduler();
  const h1 = await all("SELECT * FROM notifications WHERE type = 'deadline_h1' AND user_id = ?", alice);
  assert.equal(h1.length, 1);
});

test('reviewers are reminded 12 hours before the window closes', async () => {
  const id = await mission({ deadline: Date.now() - 14 * HOUR, status: 'submitted' });
  await proof(id);
  await runScheduler();
  const sent = await all("SELECT user_id FROM notifications WHERE type = 'review_reminder' ORDER BY user_id");
  assert.deepEqual(sent.map((n) => n.user_id), [leader, bob].sort((a, b) => a - b));
});

test('reminders follow the frequency: group default, per-mission override, and off', async () => {
  const today = localDayNumber();
  const reminded = async () => (await all("SELECT body FROM notifications WHERE type = 'daily'")).map((n) => n.body);
  const make = (title, lastDaysAgo, every) =>
    run(
      `INSERT INTO missions (group_id, assignee_id, created_by, title, deadline, reminder_every_days, last_reminder_day, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      groupId, alice, leader, title, Date.now() + 10 * DAY, every, today - lastDaysAgo, Date.now()
    );

  await run('UPDATE groups SET reminder_every_days = 2 WHERE id = ?', groupId);
  await make('group-2d, 1 day ago', 1, null); // not yet
  await make('group-2d, 2 days ago', 2, null); // due
  await make('daily override, 1 day ago', 1, 1); // due
  await make('weekly override, 3 days ago', 3, 7); // not yet
  await make('off override, 9 days ago', 9, 0); // never
  await runScheduler();
  assert.deepEqual((await reminded()).sort(), ['daily override, 1 day ago', 'group-2d, 2 days ago']);

  // Running again the same day sends nothing new.
  await runScheduler();
  assert.equal((await reminded()).length, 2);

  // Group switched off → missions following the group go quiet, overrides still fire.
  await exec('DELETE FROM notifications');
  await run('UPDATE missions SET last_reminder_day = ?', today - 30);
  await run('UPDATE groups SET reminder_every_days = 0 WHERE id = ?', groupId);
  await runScheduler();
  assert.deepEqual((await reminded()).sort(), ['daily override, 1 day ago', 'weekly override, 3 days ago']);
});

test('missed deadline puts a "Beban <group>" label; a repeat miss raises the count', async () => {
  await mission({ deadline: Date.now() - HOUR });
  await runScheduler();
  let labels = await all('SELECT * FROM labels WHERE user_id = ? AND redeemed_at IS NULL', alice);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].fail_count, 1);

  await mission({ deadline: Date.now() - HOUR });
  await runScheduler();
  labels = await all('SELECT * FROM labels WHERE user_id = ? AND redeemed_at IS NULL', alice);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].fail_count, 2);
});

test('redeem needs every other member to approve; one reject closes the vote with a cooldown', async () => {
  await mission({ deadline: Date.now() - HOUR });
  await runScheduler();
  const label = await one('SELECT * FROM labels WHERE user_id = ?', alice);

  assert.equal((await castVote(1, leader, true)).status, 404); // no such vote yet
  const first = await requestRedeem(label.id, alice, 'Maaf, aku janji lebih baik');
  assert.equal(first.status, 'open');
  assert.equal((await requestRedeem(label.id, alice)).error, 'A redeem vote is already running.');
  assert.equal((await castVote(first.requestId, alice, true)).status, 403); // can't vote on yourself

  assert.equal((await castVote(first.requestId, leader, true)).status, 'open');
  assert.equal((await castVote(first.requestId, bob, false)).status, 'rejected');
  assert.equal((await one('SELECT redeemed_at FROM labels WHERE id = ?', label.id)).redeemed_at, null);
  assert.equal((await requestRedeem(label.id, alice)).status, 429); // cooldown

  await run("UPDATE redeem_requests SET closed_at = ? WHERE status = 'rejected'", Date.now() - 25 * HOUR);
  const second = await requestRedeem(label.id, alice);
  await castVote(second.requestId, leader, true);
  assert.equal((await castVote(second.requestId, bob, true)).status, 'approved');
  assert.ok((await one('SELECT redeemed_at FROM labels WHERE id = ?', label.id)).redeemed_at);
});

test('a member who leaves no longer blocks a redeem vote', async () => {
  await mission({ deadline: Date.now() - HOUR });
  await runScheduler();
  const label = await one('SELECT * FROM labels WHERE user_id = ?', alice);
  const { requestId } = await requestRedeem(label.id, alice);
  await castVote(requestId, leader, true);
  await run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', groupId, bob);
  await reevaluateGroupRedeems(groupId);
  assert.equal((await one('SELECT status FROM redeem_requests WHERE id = ?', requestId)).status, 'approved');
});

test('profile stats count reviews done for teammates', async () => {
  const id = await mission({ deadline: Date.now() + DAY });
  const p = await proof(id);
  await review(p, bob, 'revision');
  await review(p, bob, 'checked');
  const stats = await userStats(bob);
  assert.equal(stats.checkedForOthers, 1);
  assert.equal(stats.revisionsAsked, 1);
  assert.equal((await userStats(alice)).proofs, 1);
});

test('expired sessions are cleaned up', async () => {
  await run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', 'old', alice, Date.now() - 1000);
  await run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', 'new', alice, Date.now() + DAY);
  await runScheduler();
  assert.deepEqual((await all('SELECT token FROM sessions')).map((s) => s.token), ['new']);
});

test('live updates: users get their own events and those of groups they belong to', async () => {
  const { emitToUser, emitToGroup, eventsSince, latestEventId, pruneEvents } = await import('../server/realtime.js');
  await exec('DELETE FROM events');
  const start = await latestEventId();
  await emitToUser(alice, 'notification', { title: 'hi' });
  await emitToGroup(groupId, 'message', { body: 'yo' });
  await emitToUser(bob, 'notification', { title: 'not for alice' });
  const g2 = Number((await run('INSERT INTO groups (name, leader_id, created_at) VALUES (?, ?, ?)', 'Other', bob, Date.now())).lastInsertRowid);
  await emitToGroup(g2, 'feed:changed');

  const forAlice = await eventsSince(alice, start, [groupId, g2]); // asks for g2 but is not a member
  assert.deepEqual(forAlice.map((e) => e.type), ['notification', 'message']);
  assert.equal(forAlice[1].payload.groupId, groupId);
  assert.deepEqual((await eventsSince(alice, start)).map((e) => e.type), ['notification']); // no group open
  assert.equal((await eventsSince(alice, forAlice.at(-1).id, [groupId])).length, 0);

  await run('UPDATE events SET created_at = ?', Date.now() - 2 * DAY);
  await pruneEvents();
  assert.equal((await one('SELECT COUNT(*) AS c FROM events')).c, 0);
});

test('calendar days and dates follow Asia/Jakarta, whatever the server time zone', async () => {
  const { tzOffsetMs, formatDateTime } = await import('../server/time.js');
  const lateNightWib = Date.UTC(2026, 10, 21, 16, 59); // 23:59 WIB
  const justAfterMidnight = Date.UTC(2026, 10, 21, 17, 1); // 00:01 WIB next day
  assert.equal(tzOffsetMs(lateNightWib), 7 * HOUR);
  assert.equal(localDayNumber(justAfterMidnight) - localDayNumber(lateNightWib), 1);
  assert.equal(formatDateTime(lateNightWib), '21 Nov 2026, 23:59');
});

test('vercel.json sends the same security policy as the Express app', async () => {
  const fs = await import('node:fs');
  const { CSP } = await import('../server/security.js');
  const config = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const headers = config.headers.find((h) => h.source === '/(.*)').headers;
  assert.equal(headers.find((h) => h.key === 'Content-Security-Policy').value, CSP);
});

test('streaks count consecutive days and survive a not-yet-done today', () => {
  const now = new Date(2026, 0, 10, 12).getTime();
  const at = (daysAgo) => now - daysAgo * DAY;
  assert.deepEqual(streaks([], now), { current: 0, best: 0 });
  assert.deepEqual(streaks([at(0), at(1), at(2)], now), { current: 3, best: 3 });
  assert.deepEqual(streaks([at(1), at(2)], now), { current: 2, best: 2 });
  assert.deepEqual(streaks([at(3), at(5), at(6), at(7), at(7)], now), { current: 0, best: 3 });
});
