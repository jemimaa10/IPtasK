// Live updates for open pages. Events are rows in the `events` table; each open page long-polls
// GET /api/events (see routes/events.js). Works on serverless hosts, where a socket cannot stay open.
//
//   emitToUser(userId, type, payload)    → that user's open pages
//   emitToGroup(groupId, type, payload)  → pages that currently show that group
import { one, all, run } from './db.js';

export const EVENT_TYPES = ['notification', 'message', 'feed:changed', 'missions:changed', 'group:changed', 'group:deleted', 'invites:changed'];

export async function emitToUser(userId, type, payload = {}) {
  await run('INSERT INTO events (user_id, type, payload, created_at) VALUES (?, ?, ?, ?) RETURNING id',
    userId, type, JSON.stringify(payload), Date.now());
}

export async function emitToGroup(groupId, type, payload = {}) {
  await run('INSERT INTO events (group_id, type, payload, created_at) VALUES (?, ?, ?, ?) RETURNING id',
    groupId, type, JSON.stringify({ ...payload, groupId }), Date.now());
}

export async function notify(userId, { type, title, body = '', link = null, actorId = null }) {
  const info = await run(
    `INSERT INTO notifications (user_id, type, title, body, link, actor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    userId, type, title, body, link, actorId, Date.now()
  );
  await emitToUser(userId, 'notification', { id: Number(info.lastInsertRowid), type, title, body, link });
}

/** Newest event id, where a page that just opened starts listening. */
export async function latestEventId() {
  return (await one('SELECT MAX(id) AS id FROM events'))?.id ?? 0;
}

/** Events after `since` for this user and for those of `groupIds` the user is a member of. */
export async function eventsSince(userId, since, groupIds = []) {
  const mine = groupIds.length
    ? (await all(
        `SELECT group_id FROM group_members WHERE user_id = ? AND group_id IN (${groupIds.map(() => '?').join(',')})`,
        userId, ...groupIds
      )).map((r) => r.group_id)
    : [];
  const groupClause = mine.length ? ` OR group_id IN (${mine.map(() => '?').join(',')})` : '';
  const rows = await all(
    `SELECT id, type, payload FROM events WHERE id > ? AND (user_id = ?${groupClause}) ORDER BY id LIMIT 100`,
    since, userId, ...mine
  );
  return rows.map((r) => ({ id: r.id, type: r.type, payload: JSON.parse(r.payload) }));
}

/** Housekeeping: pages that were closed for more than a day reload everything anyway. */
export async function pruneEvents(now = Date.now()) {
  await run('DELETE FROM events WHERE created_at < ?', now - 24 * 3600_000);
}
