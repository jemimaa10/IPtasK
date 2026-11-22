import { one, all, run, localDayNumber } from './db.js';
import { notify, emitToGroup } from './realtime.js';
import { roastLine } from './gemini.js';
import { labelForMissedMission } from './labels.js';
import { background } from './background.js';
import { pruneEvents } from './realtime.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
export const FINAL_STATUSES = ['verified', 'failed', 'unverified'];

/** End of the verification window. `group` is the mission's group (or any row with verify_grace_hours). */
export function graceEnd(mission, group = mission) {
  return mission.deadline + group.verify_grace_hours * HOUR;
}

/** Everyone in the group except the person who did the work must check it. */
export async function requiredReviewerIds(mission) {
  return (await all(
    'SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?',
    mission.group_id, mission.assignee_id
  )).map((r) => r.user_id);
}

export function latestProof(missionId) {
  return one('SELECT * FROM proofs WHERE mission_id = ? ORDER BY id DESC LIMIT 1', missionId);
}

/** Per reviewer: 'checked' | 'revision' | 'pending' for one proof. */
export async function reviewStates(proofId, reviewerIds) {
  const rows = await all('SELECT * FROM reviews WHERE proof_id = ? ORDER BY id', proofId);
  const states = new Map(reviewerIds.map((id) => [id, { state: 'pending', reviews: [] }]));
  for (const r of rows) {
    const entry = states.get(r.reviewer_id);
    if (!entry) continue; // reviewer left the group
    entry.reviews.push(r);
    if (r.type === 'checked') entry.state = 'checked';
    else if (entry.state !== 'checked') entry.state = 'revision';
  }
  return states;
}

/** Recompute a non-final mission's status from its latest proof and reviews. */
export async function refreshMissionStatus(missionId) {
  const mission = await one('SELECT * FROM missions WHERE id = ?', missionId);
  if (!mission || FINAL_STATUSES.includes(mission.status)) return mission;

  const proof = await latestProof(mission.id);
  let status = 'open';
  if (proof) {
    const states = [...(await reviewStates(proof.id, await requiredReviewerIds(mission))).values()];
    if (states.every((s) => s.state === 'checked')) status = 'verified';
    else if (states.some((s) => s.state === 'revision')) status = 'revision';
    else status = 'submitted';
  }
  if (status !== mission.status) {
    await run('UPDATE missions SET status = ? WHERE id = ?', status, mission.id);
    if (status === 'verified') {
      await notify(mission.assignee_id, {
        type: 'verified',
        title: 'Your work is fully verified 🎉',
        body: `Every teammate checked "${mission.title}".`,
        link: `#/group/${mission.group_id}/feed`,
      });
    }
    await emitToGroup(mission.group_id, 'missions:changed');
  }
  return { ...mission, status };
}

const QUOTES = {
  missed_deadline: () => "this user didn't finish the job by the deadline",
  unchecked: (target) => `this user didn't check ${target}'s work`,
  unverified: () => "this user's work didn't get verified by the deadline",
  unfixed_revision: () => "this user didn't fix the revision before the deadline",
};

export async function postConfession({ mission, userId, kind, targetUserId = null, quoteKey = kind }) {
  const user = await one('SELECT * FROM users WHERE id = ?', userId);
  const target = targetUserId ? await one('SELECT * FROM users WHERE id = ?', targetUserId) : null;
  const quote = QUOTES[quoteKey](target?.display_name);

  const info = await run(
    `INSERT INTO confessions (group_id, mission_id, user_id, target_user_id, kind, quote, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    mission.group_id, mission.id, userId, targetUserId, kind, quote, Date.now()
  );
  const confessionId = Number(info.lastInsertRowid);

  const members = await all('SELECT user_id FROM group_members WHERE group_id = ?', mission.group_id);
  for (const m of members) {
    await notify(m.user_id, {
      type: 'confession',
      title: m.user_id === userId ? '🤖 IPtasK Bot posted your confession' : `🤖 IPtasK Bot exposed ${user.display_name}`,
      body: `"${quote}" — ${mission.title}`,
      link: `#/group/${mission.group_id}/feed`,
      actorId: userId,
    });
  }
  await emitToGroup(mission.group_id, 'feed:changed');

  // The witty line is a bonus; post first, decorate when Gemini answers.
  background(
    roastLine({ kind, displayName: user.display_name, missionTitle: mission.title }).then(async (roast) => {
      await run('UPDATE confessions SET roast = ? WHERE id = ?', roast, confessionId);
      await emitToGroup(mission.group_id, 'feed:changed');
    }),
    'roast'
  );
}

function timeLeftText(ms) {
  if (ms >= DAY) {
    const days = Math.ceil(ms / DAY);
    return `${days} day${days > 1 ? 's' : ''}`;
  }
  const hours = Math.max(1, Math.round(ms / HOUR));
  return `${hours} hour${hours > 1 ? 's' : ''}`;
}

/** Allowed reminder frequencies, in days. 0 = no reminders. */
export const REMINDER_CHOICES = [0, 1, 2, 3, 7];

/** Returns a valid frequency, or `fallback` when the value is missing or not one of the choices. */
export function parseReminderDays(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return REMINDER_CHOICES.includes(n) ? n : fallback;
}

/** Called right after a mission is created: the first reminder comes one full interval later. */
export async function markDailyReminderSent(missionId) {
  await run('UPDATE missions SET last_reminder_day = ? WHERE id = ?', localDayNumber(), missionId);
}

let running = false;

export async function runScheduler() {
  if (running) return;
  running = true;
  try {
    const now = Date.now();

    // 1. Deadline passed with no proof at all → assignee gets exposed.
    for (const m of await all("SELECT * FROM missions WHERE status = 'open' AND deadline <= ?", now)) {
      if (await latestProof(m.id)) {
        await refreshMissionStatus(m.id);
        continue;
      }
      await run("UPDATE missions SET status = 'failed' WHERE id = ?", m.id);
      await emitToGroup(m.group_id, 'missions:changed');
      await labelForMissedMission(m);
      await postConfession({ mission: m, userId: m.assignee_id, kind: 'missed_deadline' });
    }

    // 2. Verification window closed with missing checks → lazy reviewers AND the assignee get exposed.
    const closing = await all(
      `SELECT m.*, g.verify_grace_hours FROM missions m JOIN groups g ON g.id = m.group_id
       WHERE m.status IN ('submitted', 'revision')
         AND m.deadline + g.verify_grace_hours * ${HOUR}::bigint <= ?`,
      now
    );
    for (const m of closing) {
      const fresh = await refreshMissionStatus(m.id);
      if (fresh.status === 'verified') continue;
      const proof = await latestProof(m.id);
      const states = await reviewStates(proof.id, await requiredReviewerIds(m));
      const pending = [...states].filter(([, s]) => s.state === 'pending').map(([id]) => id);
      const revisionOpen = [...states.values()].some((s) => s.state === 'revision');

      await run("UPDATE missions SET status = 'unverified' WHERE id = ?", m.id);
      await emitToGroup(m.group_id, 'missions:changed');

      for (const reviewerId of pending) {
        await postConfession({ mission: m, userId: reviewerId, kind: 'unchecked', targetUserId: m.assignee_id });
      }
      await postConfession({
        mission: m,
        userId: m.assignee_id,
        kind: 'unverified',
        quoteKey: revisionOpen && pending.length === 0 ? 'unfixed_revision' : 'unverified',
      });
    }

    // 3. H-1: one day before the deadline.
    for (const m of await all(
      `SELECT * FROM missions WHERE status IN ('open', 'revision') AND h1_notified = 0
       AND deadline > ? AND deadline <= ?`,
      now, now + DAY
    )) {
      await run('UPDATE missions SET h1_notified = 1 WHERE id = ?', m.id);
      await notify(m.assignee_id, {
        type: 'deadline_h1',
        title: `⏰ H-1: "${m.title}" is due in ${timeLeftText(m.deadline - now)}`,
        body: m.status === 'revision'
          ? 'You still have a revision to fix. Upload the new proof before the deadline.'
          : "Upload your proof before the deadline, or IPtasK Bot will post your confession.",
        link: `#/group/${m.group_id}/missions`,
      });
    }

    // 4. Reviewers: 12 hours before the verification window closes.
    const reviewWindow = await all(
      `SELECT m.*, g.verify_grace_hours FROM missions m JOIN groups g ON g.id = m.group_id
       WHERE m.status IN ('submitted', 'revision') AND m.reviewers_reminded = 0
         AND m.deadline + g.verify_grace_hours * ${HOUR}::bigint > ?
         AND m.deadline + g.verify_grace_hours * ${HOUR}::bigint <= ?`,
      now, now + 12 * HOUR
    );
    for (const m of reviewWindow) {
      await run('UPDATE missions SET reviewers_reminded = 1 WHERE id = ?', m.id);
      const proof = await latestProof(m.id);
      const owner = await one('SELECT display_name FROM users WHERE id = ?', m.assignee_id);
      for (const [reviewerId, s] of await reviewStates(proof.id, await requiredReviewerIds(m))) {
        if (s.state !== 'pending') continue;
        await notify(reviewerId, {
          type: 'review_reminder',
          title: `👀 Check ${owner.display_name}'s work within ${timeLeftText(graceEnd(m) - now)}`,
          body: `"${m.title}" is waiting for your Checked or Revision. Skip it and you'll be exposed too.`,
          link: `#/group/${m.group_id}/feed`,
        });
      }
    }

    // Housekeeping: expired sessions, old live-update events.
    await run('DELETE FROM sessions WHERE expires_at <= ?', now);
    await pruneEvents(now);

    // 5. Reminder for every unfinished jobdesk, at the mission's frequency (or the group's default).
    const today = localDayNumber(now);
    const EVERY = 'COALESCE(m.reminder_every_days, g.reminder_every_days)';
    for (const m of await all(
      `SELECT m.* FROM missions m JOIN groups g ON g.id = m.group_id
       WHERE m.status IN ('open', 'revision') AND m.deadline > ? AND ${EVERY} > 0
         AND (m.last_reminder_day IS NULL OR ?::int - m.last_reminder_day >= ${EVERY})`,
      now, today
    )) {
      await run('UPDATE missions SET last_reminder_day = ? WHERE id = ?', today, m.id);
      await notify(m.assignee_id, {
        type: 'daily',
        title: `You have unfinished jobdesk that will end in ${timeLeftText(m.deadline - now)}`,
        body: m.title,
        link: `#/group/${m.group_id}/missions`,
      });
    }
  } catch (err) {
    console.error('[scheduler]', err);
  } finally {
    running = false;
  }
}
