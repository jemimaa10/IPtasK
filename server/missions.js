import { one, all, run } from './db.js';
import { notify, emitToGroup } from './realtime.js';
import { roastLine } from './gemini.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
export const FINAL_STATUSES = ['verified', 'failed', 'unverified'];

export function graceEnd(mission, group) {
  const g = group || one('SELECT verify_grace_hours FROM groups WHERE id = ?', mission.group_id);
  return mission.deadline + g.verify_grace_hours * HOUR;
}

/** Everyone in the group except the person who did the work must check it. */
export function requiredReviewerIds(mission) {
  return all(
    'SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?',
    mission.group_id, mission.assignee_id
  ).map((r) => r.user_id);
}

export function latestProof(missionId) {
  return one('SELECT * FROM proofs WHERE mission_id = ? ORDER BY id DESC LIMIT 1', missionId);
}

/** Per reviewer: 'checked' | 'revision' | 'pending' for one proof. */
export function reviewStates(proofId, reviewerIds) {
  const rows = all('SELECT * FROM reviews WHERE proof_id = ? ORDER BY id', proofId);
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
export function refreshMissionStatus(missionId) {
  const mission = one('SELECT * FROM missions WHERE id = ?', missionId);
  if (!mission || FINAL_STATUSES.includes(mission.status)) return mission;

  const proof = latestProof(mission.id);
  let status = 'open';
  if (proof) {
    const states = [...reviewStates(proof.id, requiredReviewerIds(mission)).values()];
    if (states.every((s) => s.state === 'checked')) status = 'verified';
    else if (states.some((s) => s.state === 'revision')) status = 'revision';
    else status = 'submitted';
  }
  if (status !== mission.status) {
    run('UPDATE missions SET status = ? WHERE id = ?', status, mission.id);
    if (status === 'verified') {
      notify(mission.assignee_id, {
        type: 'verified',
        title: 'Your work is fully verified 🎉',
        body: `Every teammate checked "${mission.title}".`,
        link: `#/group/${mission.group_id}/feed`,
      });
    }
    emitToGroup(mission.group_id, 'missions:changed');
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
  const user = one('SELECT * FROM users WHERE id = ?', userId);
  const target = targetUserId ? one('SELECT * FROM users WHERE id = ?', targetUserId) : null;
  const quote = QUOTES[quoteKey](target?.display_name);

  const info = run(
    `INSERT INTO confessions (group_id, mission_id, user_id, target_user_id, kind, quote, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    mission.group_id, mission.id, userId, targetUserId, kind, quote, Date.now()
  );
  const confessionId = Number(info.lastInsertRowid);

  const members = all('SELECT user_id FROM group_members WHERE group_id = ?', mission.group_id);
  for (const m of members) {
    notify(m.user_id, {
      type: 'confession',
      title: m.user_id === userId ? '🤖 IPtasK Bot posted your confession' : `🤖 IPtasK Bot exposed ${user.display_name}`,
      body: `"${quote}" — ${mission.title}`,
      link: `#/group/${mission.group_id}/feed`,
      actorId: userId,
    });
  }
  emitToGroup(mission.group_id, 'feed:changed');

  // The witty line is a bonus; post first, decorate when Gemini answers.
  roastLine({ kind, displayName: user.display_name, missionTitle: mission.title }).then((roast) => {
    run('UPDATE confessions SET roast = ? WHERE id = ?', roast, confessionId);
    emitToGroup(mission.group_id, 'feed:changed');
  });
}

function localDateKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function timeLeftText(ms) {
  if (ms >= DAY) {
    const days = Math.ceil(ms / DAY);
    return `${days} day${days > 1 ? 's' : ''}`;
  }
  const hours = Math.max(1, Math.round(ms / HOUR));
  return `${hours} hour${hours > 1 ? 's' : ''}`;
}

export function markDailyReminderSent(missionId) {
  run('UPDATE missions SET last_daily_reminder = ? WHERE id = ?', localDateKey(), missionId);
}

let running = false;

export async function runScheduler() {
  if (running) return;
  running = true;
  try {
    const now = Date.now();

    // 1. Deadline passed with no proof at all → assignee gets exposed.
    for (const m of all("SELECT * FROM missions WHERE status = 'open' AND deadline <= ?", now)) {
      if (latestProof(m.id)) {
        refreshMissionStatus(m.id);
        continue;
      }
      run("UPDATE missions SET status = 'failed' WHERE id = ?", m.id);
      emitToGroup(m.group_id, 'missions:changed');
      await postConfession({ mission: m, userId: m.assignee_id, kind: 'missed_deadline' });
    }

    // 2. Verification window closed with missing checks → lazy reviewers AND the assignee get exposed.
    const closing = all(
      `SELECT m.*, g.verify_grace_hours FROM missions m JOIN groups g ON g.id = m.group_id
       WHERE m.status IN ('submitted', 'revision')
         AND m.deadline + g.verify_grace_hours * ${HOUR} <= ?`,
      now
    );
    for (const m of closing) {
      const fresh = refreshMissionStatus(m.id);
      if (fresh.status === 'verified') continue;
      const proof = latestProof(m.id);
      const states = reviewStates(proof.id, requiredReviewerIds(m));
      const pending = [...states].filter(([, s]) => s.state === 'pending').map(([id]) => id);
      const revisionOpen = [...states.values()].some((s) => s.state === 'revision');

      run("UPDATE missions SET status = 'unverified' WHERE id = ?", m.id);
      emitToGroup(m.group_id, 'missions:changed');

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
    for (const m of all(
      `SELECT * FROM missions WHERE status IN ('open', 'revision') AND h1_notified = 0
       AND deadline > ? AND deadline <= ?`,
      now, now + DAY
    )) {
      run('UPDATE missions SET h1_notified = 1 WHERE id = ?', m.id);
      notify(m.assignee_id, {
        type: 'deadline_h1',
        title: `⏰ H-1: "${m.title}" is due in ${timeLeftText(m.deadline - now)}`,
        body: m.status === 'revision'
          ? 'You still have a revision to fix. Upload the new proof before the deadline.'
          : "Upload your proof before the deadline, or IPtasK Bot will post your confession.",
        link: `#/group/${m.group_id}/missions`,
      });
    }

    // 4. Reviewers: 12 hours before the verification window closes.
    const reviewWindow = all(
      `SELECT m.*, g.verify_grace_hours FROM missions m JOIN groups g ON g.id = m.group_id
       WHERE m.status IN ('submitted', 'revision') AND m.reviewers_reminded = 0
         AND m.deadline + g.verify_grace_hours * ${HOUR} > ?
         AND m.deadline + g.verify_grace_hours * ${HOUR} <= ?`,
      now, now + 12 * HOUR
    );
    for (const m of reviewWindow) {
      run('UPDATE missions SET reviewers_reminded = 1 WHERE id = ?', m.id);
      const proof = latestProof(m.id);
      const owner = one('SELECT display_name FROM users WHERE id = ?', m.assignee_id);
      for (const [reviewerId, s] of reviewStates(proof.id, requiredReviewerIds(m))) {
        if (s.state !== 'pending') continue;
        notify(reviewerId, {
          type: 'review_reminder',
          title: `👀 Check ${owner.display_name}'s work within ${timeLeftText(graceEnd(m) - now)}`,
          body: `"${m.title}" is waiting for your Checked or Revision. Skip it and you'll be exposed too.`,
          link: `#/group/${m.group_id}/feed`,
        });
      }
    }

    // 5. Daily reminder for every unfinished jobdesk.
    const today = localDateKey(now);
    for (const m of all(
      `SELECT * FROM missions WHERE status IN ('open', 'revision') AND deadline > ?
       AND (last_daily_reminder IS NULL OR last_daily_reminder != ?)`,
      now, today
    )) {
      run('UPDATE missions SET last_daily_reminder = ? WHERE id = ?', today, m.id);
      notify(m.assignee_id, {
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
