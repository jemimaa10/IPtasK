import { Router } from 'express';
import { one, all, run, tx } from '../db.js';
import { requireAuth, publicUser, getUser } from '../auth.js';
import { notify, emitToGroup, emitToUser } from '../realtime.js';
import { aiEnabled, splitJobdesk } from '../gemini.js';
import { refreshMissionStatus, FINAL_STATUSES } from '../missions.js';

const router = Router();
router.use(requireAuth);

export function membership(groupId, userId) {
  return one('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?', groupId, userId);
}

/** Loads the group into req.group / req.member, or 404s. Pass leaderOnly to restrict. */
export const loadGroup = (leaderOnly = false) => (req, res, next) => {
  const group = one('SELECT * FROM groups WHERE id = ?', Number(req.params.groupId));
  const member = group && membership(group.id, req.user.id);
  if (!member) return res.status(404).json({ error: 'Group not found.' });
  if (leaderOnly && group.leader_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the group leader can do this.' });
  }
  req.group = group;
  req.member = member;
  next();
};

function groupMembers(groupId) {
  return all(
    `SELECT u.*, gm.role, gm.joined_at FROM group_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = ? ORDER BY gm.role = 'leader' DESC, u.display_name`,
    groupId
  ).map((u) => ({ ...publicUser(u), role: u.role, joinedAt: u.joined_at }));
}

function groupView(group, userId) {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    verifyGraceHours: group.verify_grace_hours,
    leaderId: group.leader_id,
    isLeader: group.leader_id === userId,
    createdAt: group.created_at,
  };
}

router.get('/groups', (req, res) => {
  const rows = all(
    `SELECT g.*,
       (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count,
       (SELECT COUNT(*) FROM missions WHERE group_id = g.id AND assignee_id = ? AND status IN ('open','revision')) AS my_open,
       (SELECT body FROM messages WHERE group_id = g.id ORDER BY id DESC LIMIT 1) AS last_message
     FROM groups g JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
     ORDER BY g.created_at DESC`,
    req.user.id, req.user.id
  );
  res.json({
    groups: rows.map((g) => ({
      ...groupView(g, req.user.id),
      memberCount: g.member_count,
      myOpenMissions: g.my_open,
      lastMessage: g.last_message,
    })),
  });
});

router.post('/groups', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name || name.length > 60) return res.status(400).json({ error: 'Group name must be 1–60 characters.' });
  const grace = Math.min(168, Math.max(1, Number(req.body.verifyGraceHours) || 24));
  const id = tx(() => {
    const info = run(
      'INSERT INTO groups (name, description, leader_id, verify_grace_hours, created_at) VALUES (?, ?, ?, ?, ?)',
      name, String(req.body.description || '').trim().slice(0, 300), req.user.id, grace, Date.now()
    );
    const groupId = Number(info.lastInsertRowid);
    run("INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'leader', ?)", groupId, req.user.id, Date.now());
    return groupId;
  });
  res.json({ group: groupView(one('SELECT * FROM groups WHERE id = ?', id), req.user.id) });
});

router.get('/groups/:groupId', loadGroup(), (req, res) => {
  const pendingInvites = req.group.leader_id === req.user.id
    ? all(
        `SELECT i.id AS invite_id, i.invitee_id, u.username, u.display_name, u.avatar_path
         FROM invites i JOIN users u ON u.id = i.invitee_id
         WHERE i.group_id = ? AND i.status = 'pending'`,
        req.group.id
      ).map((r) => ({ inviteId: r.invite_id, user: publicUser({ ...r, id: r.invitee_id }) }))
    : [];
  res.json({
    group: groupView(req.group, req.user.id),
    members: groupMembers(req.group.id),
    pendingInvites,
    aiEnabled: aiEnabled(),
  });
});

router.patch('/groups/:groupId', loadGroup(true), (req, res) => {
  const name = String(req.body.name ?? req.group.name).trim();
  if (!name || name.length > 60) return res.status(400).json({ error: 'Group name must be 1–60 characters.' });
  const grace = Math.min(168, Math.max(1, Number(req.body.verifyGraceHours ?? req.group.verify_grace_hours) || 24));
  run(
    'UPDATE groups SET name = ?, description = ?, verify_grace_hours = ? WHERE id = ?',
    name, String(req.body.description ?? req.group.description).trim().slice(0, 300), grace, req.group.id
  );
  emitToGroup(req.group.id, 'group:changed');
  res.json({ group: groupView(one('SELECT * FROM groups WHERE id = ?', req.group.id), req.user.id) });
});

router.delete('/groups/:groupId', loadGroup(true), (req, res) => {
  emitToGroup(req.group.id, 'group:deleted', { groupId: req.group.id });
  run('DELETE FROM groups WHERE id = ?', req.group.id);
  res.json({ ok: true });
});

// ---------- invites & members ----------

router.post('/groups/:groupId/invites', loadGroup(true), (req, res) => {
  const invitee = one('SELECT * FROM users WHERE username = ?', String(req.body.username || '').trim());
  if (!invitee) return res.status(404).json({ error: 'No user with that username.' });
  if (membership(req.group.id, invitee.id)) return res.status(409).json({ error: 'They are already in this group.' });
  if (one("SELECT 1 FROM invites WHERE group_id = ? AND invitee_id = ? AND status = 'pending'", req.group.id, invitee.id)) {
    return res.status(409).json({ error: 'They already have a pending invite.' });
  }
  run(
    'INSERT INTO invites (group_id, inviter_id, invitee_id, created_at) VALUES (?, ?, ?, ?)',
    req.group.id, req.user.id, invitee.id, Date.now()
  );
  notify(invitee.id, {
    type: 'invite',
    title: `${req.user.display_name} invited you to "${req.group.name}"`,
    body: 'Open your home page to accept or decline.',
    link: '#/home',
    actorId: req.user.id,
  });
  emitToUser(invitee.id, 'invites:changed');
  res.json({ ok: true });
});

router.delete('/groups/:groupId/invites/:inviteId', loadGroup(true), (req, res) => {
  const invite = one('SELECT * FROM invites WHERE id = ? AND group_id = ?', Number(req.params.inviteId), req.group.id);
  if (invite) {
    run('DELETE FROM invites WHERE id = ?', invite.id);
    emitToUser(invite.invitee_id, 'invites:changed');
  }
  res.json({ ok: true });
});

router.get('/invites', (req, res) => {
  const rows = all(
    `SELECT i.id, i.created_at, i.inviter_id, g.name AS group_name, g.id AS group_id,
       u.username, u.display_name, u.avatar_path
     FROM invites i JOIN groups g ON g.id = i.group_id JOIN users u ON u.id = i.inviter_id
     WHERE i.invitee_id = ? AND i.status = 'pending' ORDER BY i.id DESC`,
    req.user.id
  );
  res.json({
    invites: rows.map((r) => ({
      id: r.id,
      groupId: r.group_id,
      groupName: r.group_name,
      createdAt: r.created_at,
      inviter: publicUser({ ...r, id: r.inviter_id }),
    })),
  });
});

router.post('/invites/:id/:action(accept|decline)', (req, res) => {
  const invite = one("SELECT * FROM invites WHERE id = ? AND invitee_id = ? AND status = 'pending'", Number(req.params.id), req.user.id);
  if (!invite) return res.status(404).json({ error: 'Invite not found.' });
  const accepted = req.params.action === 'accept';
  tx(() => {
    run('UPDATE invites SET status = ? WHERE id = ?', accepted ? 'accepted' : 'declined', invite.id);
    if (accepted) {
      run("INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)", invite.group_id, req.user.id, Date.now());
    }
  });
  const group = one('SELECT * FROM groups WHERE id = ?', invite.group_id);
  notify(invite.inviter_id, {
    type: 'invite_response',
    title: `${req.user.display_name} ${accepted ? 'joined' : 'declined to join'} "${group.name}"`,
    link: `#/group/${group.id}/members`,
    actorId: req.user.id,
  });
  if (accepted) {
    emitToGroup(group.id, 'group:changed');
    // A new reviewer joined: in-progress proofs now need their check too.
    for (const m of all("SELECT id FROM missions WHERE group_id = ? AND status IN ('submitted','revision')", group.id)) {
      refreshMissionStatus(m.id);
    }
  }
  res.json({ ok: true, groupId: accepted ? group.id : null });
});

router.delete('/groups/:groupId/members/:userId', loadGroup(), (req, res) => {
  const targetId = Number(req.params.userId);
  const isSelf = targetId === req.user.id;
  if (!isSelf && req.group.leader_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the group leader can remove members.' });
  }
  if (targetId === req.group.leader_id) {
    return res.status(400).json({ error: 'The leader cannot leave. Delete the group instead.' });
  }
  tx(() => {
    run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', req.group.id, targetId);
    // Unfinished missions of someone who left are no longer meaningful.
    run(
      `DELETE FROM missions WHERE group_id = ? AND assignee_id = ? AND status NOT IN (${FINAL_STATUSES.map(() => '?').join(',')})`,
      req.group.id, targetId, ...FINAL_STATUSES
    );
  });
  // Their missing check no longer blocks anyone's verification.
  for (const m of all("SELECT id FROM missions WHERE group_id = ? AND status IN ('submitted','revision')", req.group.id)) {
    refreshMissionStatus(m.id);
  }
  if (!isSelf) {
    notify(targetId, { type: 'removed', title: `You were removed from "${req.group.name}"`, link: '#/home' });
  }
  emitToGroup(req.group.id, 'group:changed');
  emitToGroup(req.group.id, 'missions:changed');
  emitToUser(targetId, 'group:deleted', { groupId: req.group.id });
  res.json({ ok: true });
});

// ---------- free chat ----------

router.get('/groups/:groupId/messages', loadGroup(), (req, res) => {
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = all(
    `SELECT m.id, m.body, m.created_at, m.user_id, u.username, u.display_name, u.avatar_path
     FROM messages m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT 50`,
    req.group.id, before
  );
  res.json({
    messages: rows.reverse().map((m) => ({
      id: m.id,
      body: m.body,
      createdAt: m.created_at,
      user: publicUser({ ...m, id: m.user_id }),
    })),
  });
});

router.post('/groups/:groupId/messages', loadGroup(), (req, res) => {
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message is empty.' });
  if (body.length > 2000) return res.status(400).json({ error: 'Message is too long.' });
  const createdAt = Date.now();
  const info = run('INSERT INTO messages (group_id, user_id, body, created_at) VALUES (?, ?, ?, ?)', req.group.id, req.user.id, body, createdAt);
  const message = { id: Number(info.lastInsertRowid), body, createdAt, user: getUser(req.user.id), groupId: req.group.id };
  emitToGroup(req.group.id, 'message', message);
  res.json({ message });
});

// ---------- AI jobdesk splitter ----------

router.post('/groups/:groupId/ai/split', loadGroup(true), async (req, res) => {
  if (!aiEnabled()) return res.status(400).json({ error: 'Add GEMINI_API_KEY to your .env to use the AI planner.' });
  const brief = String(req.body.brief || '').trim();
  if (brief.length < 10) return res.status(400).json({ error: 'Describe the project in a bit more detail.' });
  try {
    const result = await splitJobdesk({
      groupName: req.group.name,
      brief: brief.slice(0, 4000),
      members: groupMembers(req.group.id),
      startDate: String(req.body.startDate || new Date().toISOString().slice(0, 10)),
      endDate: String(req.body.endDate || ''),
    });
    res.json(result);
  } catch (err) {
    console.error('[ai split]', err.message);
    res.status(502).json({ error: 'The AI planner could not answer right now. Try again in a moment.' });
  }
});

// ---------- stories (confessions across my circles) ----------

router.get('/stories', (req, res) => {
  const rows = all(
    `SELECT c.*, g.name AS group_name, m.title AS mission_title,
       u.username, u.display_name, u.avatar_path
     FROM confessions c
     JOIN group_members gm ON gm.group_id = c.group_id AND gm.user_id = ?
     JOIN groups g ON g.id = c.group_id
     JOIN users u ON u.id = c.user_id
     LEFT JOIN missions m ON m.id = c.mission_id
     WHERE c.created_at > ? ORDER BY c.id DESC LIMIT 30`,
    req.user.id, Date.now() - 7 * 24 * 3600_000
  );
  res.json({
    stories: rows.map((c) => ({
      id: c.id,
      groupId: c.group_id,
      groupName: c.group_name,
      kind: c.kind,
      quote: c.quote,
      roast: c.roast,
      missionTitle: c.mission_title,
      createdAt: c.created_at,
      user: publicUser({ ...c, id: c.user_id }),
    })),
  });
});

export default router;
