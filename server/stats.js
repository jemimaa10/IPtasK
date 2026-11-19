import { all, one } from './db.js';

const DAY = 24 * 3600_000;

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * Streak = consecutive calendar days with at least one proof upload.
 * Today not having one yet does not break it: the count starts from yesterday then.
 */
export function streaks(timestamps, now = Date.now()) {
  const days = new Set(timestamps.map(dayKey));
  let current = 0;
  let cursor = days.has(dayKey(now)) ? now : now - DAY;
  while (days.has(dayKey(cursor))) {
    current++;
    cursor -= DAY;
  }

  let best = 0;
  let run = 0;
  let prev = null;
  for (const ts of [...timestamps].sort((a, b) => a - b)) {
    const key = dayKey(ts);
    if (key === prev) continue;
    run = prev && dayKey(ts - DAY) === prev ? run + 1 : 1;
    best = Math.max(best, run);
    prev = key;
  }
  return { current, best: Math.max(best, current) };
}

function summarize(rows) {
  const count = (s) => rows.filter((r) => r.status === s).length;
  const verified = count('verified');
  const failed = count('failed');
  const unverified = count('unverified');
  const finished = verified + failed + unverified;
  return {
    verified,
    failed,
    unverified,
    open: rows.length - finished,
    completionRate: finished ? Math.round((verified / finished) * 100) : null,
  };
}

export function userStats(userId, now = Date.now()) {
  const missions = all('SELECT status FROM missions WHERE assignee_id = ?', userId);
  const proofTimes = all('SELECT created_at FROM proofs WHERE user_id = ?', userId).map((r) => r.created_at);
  return {
    ...summarize(missions),
    confessions: one('SELECT COUNT(*) AS c FROM confessions WHERE user_id = ?', userId).c,
    proofs: proofTimes.length,
    streak: streaks(proofTimes, now),
  };
}

/** Group ranking: most verified work first, fewest confessions as tie-breaker. */
export function groupLeaderboard(groupId, now = Date.now()) {
  const members = all(
    `SELECT u.* FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ?`,
    groupId
  );
  return members
    .map((u) => {
      const missions = all('SELECT status FROM missions WHERE group_id = ? AND assignee_id = ?', groupId, u.id);
      const proofTimes = all('SELECT created_at FROM proofs WHERE group_id = ? AND user_id = ?', groupId, u.id)
        .map((r) => r.created_at);
      return {
        user: u,
        ...summarize(missions),
        confessions: one('SELECT COUNT(*) AS c FROM confessions WHERE group_id = ? AND user_id = ?', groupId, u.id).c,
        streak: streaks(proofTimes, now).current,
      };
    })
    .sort((a, b) => b.verified - a.verified || a.confessions - b.confessions || b.streak - a.streak);
}
