// "Beban <group>" labels: put on a member who missed a jobdesk's deadline, shown on their profile to everyone,
// and removed only when every other member of that group approves a redeem vote.
import { one, all, run, tx } from './db.js';
import { notify, emitToGroup, emitToUser } from './realtime.js';
import { getUser } from './auth.js';

const HOUR = 3600_000;
export const REDEEM_COOLDOWN_MS = 24 * HOUR; // after a rejected vote

export const labelText = (groupName) => `Beban ${groupName}`;

/** Called when a mission fails. One active label per user per group; repeat misses raise its count. */
export function labelForMissedMission(mission) {
  const group = one('SELECT * FROM groups WHERE id = ?', mission.group_id);
  if (!group) return null;
  const existing = one(
    'SELECT * FROM labels WHERE user_id = ? AND group_id = ? AND redeemed_at IS NULL',
    mission.assignee_id, mission.group_id
  );
  if (existing) {
    run('UPDATE labels SET fail_count = fail_count + 1, reason = ?, mission_id = ? WHERE id = ?', mission.title, mission.id, existing.id);
  } else {
    run(
      'INSERT INTO labels (user_id, group_id, mission_id, reason, created_at) VALUES (?, ?, ?, ?, ?)',
      mission.assignee_id, mission.group_id, mission.id, mission.title, Date.now()
    );
  }
  notify(mission.assignee_id, {
    type: 'label',
    title: existing
      ? `Your "${labelText(group.name)}" label got heavier (${existing.fail_count + 1} missed jobdesks)`
      : `You got the label "${labelText(group.name)}"`,
    body: `Everyone can see it on your profile. Ask your group for a redeem vote to remove it.`,
    link: '#/profile',
  });
  emitToGroup(group.id, 'group:changed');
  return labelText(group.name);
}

/** Every other current member of the label's group must approve. */
function requiredVoterIds(label) {
  return all('SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?', label.group_id, label.user_id)
    .map((r) => r.user_id);
}

function openRequest(labelId) {
  return one("SELECT * FROM redeem_requests WHERE label_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", labelId);
}

/** Close the request if it is decided: any reject → rejected, every required voter approved → label removed. */
export function evaluateRedeem(requestId) {
  const request = one('SELECT * FROM redeem_requests WHERE id = ?', requestId);
  if (!request || request.status !== 'open') return request?.status ?? null;
  const label = one('SELECT l.*, g.name AS group_name FROM labels l JOIN groups g ON g.id = l.group_id WHERE l.id = ?', request.label_id);
  const required = requiredVoterIds(label);
  const votes = new Map(all('SELECT voter_id, approve FROM redeem_votes WHERE request_id = ?', request.id).map((v) => [v.voter_id, v.approve]));

  let status = 'open';
  if (required.some((id) => votes.get(id) === 0)) status = 'rejected';
  else if (required.every((id) => votes.get(id) === 1)) status = 'approved';
  if (status === 'open') return status;

  const now = Date.now();
  tx(() => {
    run('UPDATE redeem_requests SET status = ?, closed_at = ? WHERE id = ?', status, now, request.id);
    if (status === 'approved') run('UPDATE labels SET redeemed_at = ? WHERE id = ?', now, label.id);
  });
  const text = labelText(label.group_name);
  notify(label.user_id, status === 'approved'
    ? { type: 'redeem', title: `Redeemed! "${text}" is gone 🎉`, body: 'Every teammate voted to remove your label.', link: '#/profile' }
    : { type: 'redeem', title: `Redeem vote for "${text}" was rejected`, body: 'You can ask again in 24 hours.', link: '#/profile' });
  for (const id of required) {
    notify(id, {
      type: 'redeem',
      title: status === 'approved'
        ? `${getUser(label.user_id).displayName} is no longer "${text}"`
        : `Redeem vote for ${getUser(label.user_id).displayName} was rejected`,
      link: `#/group/${label.group_id}/members`,
    });
  }
  emitToGroup(label.group_id, 'group:changed');
  emitToUser(label.user_id, 'group:changed');
  return status;
}

/** Membership changed: a voter who left no longer blocks the vote. */
export function reevaluateGroupRedeems(groupId) {
  for (const r of all(
    `SELECT r.id FROM redeem_requests r JOIN labels l ON l.id = r.label_id WHERE l.group_id = ? AND r.status = 'open'`,
    groupId
  )) evaluateRedeem(r.id);
}

export function requestRedeem(labelId, userId, message) {
  const label = one('SELECT l.*, g.name AS group_name FROM labels l JOIN groups g ON g.id = l.group_id WHERE l.id = ?', labelId);
  if (!label || label.user_id !== userId) return { status: 404, error: 'Label not found.' };
  if (label.redeemed_at) return { status: 400, error: 'This label is already removed.' };
  if (!one('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?', label.group_id, userId)) {
    return { status: 400, error: 'Only members of the group can be redeemed. Rejoin the group first.' };
  }
  if (openRequest(label.id)) return { status: 400, error: 'A redeem vote is already running.' };
  const lastRejected = one(
    "SELECT closed_at FROM redeem_requests WHERE label_id = ? AND status = 'rejected' ORDER BY id DESC LIMIT 1",
    label.id
  );
  if (lastRejected && Date.now() - lastRejected.closed_at < REDEEM_COOLDOWN_MS) {
    const hours = Math.ceil((REDEEM_COOLDOWN_MS - (Date.now() - lastRejected.closed_at)) / HOUR);
    return { status: 429, error: `The last vote was rejected. You can ask again in ${hours} hour${hours > 1 ? 's' : ''}.` };
  }

  const requestId = Number(run(
    'INSERT INTO redeem_requests (label_id, message, created_at) VALUES (?, ?, ?)',
    label.id, String(message || '').trim().slice(0, 300), Date.now()
  ).lastInsertRowid);
  const who = getUser(userId).displayName;
  for (const id of requiredVoterIds(label)) {
    notify(id, {
      type: 'redeem',
      title: `🗳️ ${who} asks to remove "${labelText(label.group_name)}"`,
      body: message ? `"${String(message).slice(0, 120)}"` : 'Vote in the Members tab. Everyone has to approve.',
      link: `#/group/${label.group_id}/members`,
      actorId: userId,
    });
  }
  // Nobody else in the group → nothing to wait for.
  const status = evaluateRedeem(requestId);
  emitToGroup(label.group_id, 'group:changed');
  return { requestId, status };
}

export function castVote(requestId, voterId, approve) {
  const request = one('SELECT * FROM redeem_requests WHERE id = ?', requestId);
  const label = request && one('SELECT * FROM labels WHERE id = ?', request.label_id);
  if (!label) return { status: 404, error: 'Vote not found.' };
  if (!one('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?', label.group_id, voterId)) {
    return { status: 404, error: 'Vote not found.' };
  }
  if (label.user_id === voterId) return { status: 403, error: "You can't vote on your own label." };
  if (request.status !== 'open') return { status: 400, error: 'This vote is already closed.' };
  run(
    `INSERT INTO redeem_votes (request_id, voter_id, approve, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (request_id, voter_id) DO UPDATE SET approve = excluded.approve, created_at = excluded.created_at`,
    request.id, voterId, approve ? 1 : 0, Date.now()
  );
  const status = evaluateRedeem(request.id);
  emitToGroup(label.group_id, 'group:changed');
  return { status };
}

/** API shape of a label, from the point of view of `viewerId`. */
export function labelView(label, viewerId) {
  const request = openRequest(label.id);
  let redeem = null;
  if (request) {
    const required = requiredVoterIds(label);
    const votes = all('SELECT voter_id, approve FROM redeem_votes WHERE request_id = ?', request.id);
    const approved = votes.filter((v) => v.approve === 1 && required.includes(v.voter_id)).length;
    const mine = votes.find((v) => v.voter_id === viewerId);
    redeem = {
      id: request.id,
      message: request.message,
      createdAt: request.created_at,
      approvals: approved,
      required: required.length,
      voters: required.map((id) => ({ user: getUser(id), vote: votes.find((v) => v.voter_id === id)?.approve ?? null })),
      myVote: mine ? Boolean(mine.approve) : null,
      canVote: required.includes(viewerId),
    };
  }
  const lastRejected = one(
    "SELECT closed_at FROM redeem_requests WHERE label_id = ? AND status = 'rejected' ORDER BY id DESC LIMIT 1",
    label.id
  );
  return {
    id: label.id,
    text: labelText(label.group_name),
    groupId: label.group_id,
    groupName: label.group_name,
    reason: label.reason,
    failCount: label.fail_count,
    createdAt: label.created_at,
    user: getUser(label.user_id),
    redeem,
    retryAt: !request && lastRejected ? lastRejected.closed_at + REDEEM_COOLDOWN_MS : null,
  };
}

export function activeLabelsForUser(userId, viewerId) {
  return all(
    `SELECT l.*, g.name AS group_name FROM labels l JOIN groups g ON g.id = l.group_id
     WHERE l.user_id = ? AND l.redeemed_at IS NULL ORDER BY l.created_at DESC`,
    userId
  ).map((l) => labelView(l, viewerId));
}

export function activeLabelsForGroup(groupId, viewerId) {
  return all(
    `SELECT l.*, g.name AS group_name FROM labels l JOIN groups g ON g.id = l.group_id
     WHERE l.group_id = ? AND l.redeemed_at IS NULL ORDER BY l.created_at DESC`,
    groupId
  ).map((l) => labelView(l, viewerId));
}
