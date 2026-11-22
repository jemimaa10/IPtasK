import { Router } from '../router.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { one, all, run, tx } from '../db.js';
import { getUser, requireAuth } from '../auth.js';
import { notify, emitToGroup } from '../realtime.js';
import { precheckProof } from '../gemini.js';
import { proofUpload, saveUploads, removeFile, sendStoredFile, PROOFS } from '../uploads.js';
import { loadGroup, membership } from './groups.js';
import {
  FINAL_STATUSES, graceEnd, latestProof, requiredReviewerIds, reviewStates,
  refreshMissionStatus, markDailyReminderSent, parseReminderDays,
} from '../missions.js';

const router = Router();
router.use(requireAuth);

const DAY = 24 * 3600_000;

function parseDeadline(value) {
  const ts = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ts) ? Math.round(ts) : null;
}

async function missionView(m, group) {
  const proof = await latestProof(m.id);
  let checked = 0;
  let total = 0;
  if (proof) {
    const states = [...(await reviewStates(proof.id, await requiredReviewerIds(m))).values()];
    total = states.length;
    checked = states.filter((s) => s.state === 'checked').length;
  }
  return {
    id: m.id,
    groupId: m.group_id,
    groupName: group?.name,
    title: m.title,
    description: m.description,
    deadline: m.deadline,
    graceEnd: graceEnd(m, group),
    status: m.status,
    seriesId: m.series_id,
    // null = follows the group's default
    reminderEveryDays: m.reminder_every_days,
    effectiveReminderDays: m.reminder_every_days ?? group?.reminder_every_days ?? 1,
    createdAt: m.created_at,
    assignee: await getUser(m.assignee_id),
    latestProofId: proof?.id ?? null,
    proofCount: (await one('SELECT COUNT(*) AS c FROM proofs WHERE mission_id = ?', m.id)).c,
    review: { checked, total },
  };
}

async function loadMission(req, res) {
  const mission = await one('SELECT * FROM missions WHERE id = ?', Number(req.params.missionId));
  const group = mission && (await one('SELECT * FROM groups WHERE id = ?', mission.group_id));
  if (!mission || !(await membership(group.id, req.user.id))) {
    res.status(404).json({ error: 'Mission not found.' });
    return {};
  }
  return { mission, group };
}

async function insertMissions(group, creator, items) {
  const createdAt = Date.now();
  const ids = await tx(async () => {
    const out = [];
    for (const it of items) {
      const info = await run(
        `INSERT INTO missions (group_id, assignee_id, created_by, title, description, deadline, series_id, reminder_every_days, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        group.id, it.assigneeId, creator.id, it.title, it.description, it.deadline, it.seriesId ?? null,
        it.reminderEveryDays ?? null, createdAt
      );
      out.push(Number(info.lastInsertRowid));
    }
    return out;
  });
  for (const id of ids) await markDailyReminderSent(id); // first daily reminder arrives tomorrow

  const byAssignee = new Map();
  items.forEach((it) => byAssignee.set(it.assigneeId, [...(byAssignee.get(it.assigneeId) || []), it]));
  for (const [assigneeId, list] of byAssignee) {
    const first = list.reduce((a, b) => (a.deadline < b.deadline ? a : b));
    await notify(assigneeId, {
      type: 'mission',
      title: list.length === 1
        ? `New jobdesk: "${first.title}"`
        : `${list.length} new jobdesks assigned to you`,
      body: `From ${creator.display_name} in "${group.name}". First deadline: ${new Date(first.deadline).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`,
      link: `#/group/${group.id}/missions`,
      actorId: creator.id,
    });
  }
  emitToGroup(group.id, 'missions:changed');
  return ids;
}

async function validateMissionInput(group, body) {
  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim().slice(0, 1000);
  const assigneeId = Number(body.assigneeId);
  const deadline = parseDeadline(body.deadline);
  if (!title || title.length > 120) return { error: 'Title must be 1–120 characters.' };
  if (!Number.isInteger(assigneeId) || !(await membership(group.id, assigneeId))) {
    return { error: 'The assignee must be a member of this group.' };
  }
  if (!deadline || deadline <= Date.now() + 60_000) return { error: `Deadline for "${title}" must be in the future.` };
  // "group" or missing = follow the group's default.
  const reminderEveryDays = body.reminderEveryDays === 'group' ? null : parseReminderDays(body.reminderEveryDays, null);
  return { title, description, assigneeId, deadline, reminderEveryDays };
}

// ---------- missions ----------

router.get('/groups/:groupId/missions', loadGroup(), async (req, res) => {
  const rows = await all('SELECT * FROM missions WHERE group_id = ? ORDER BY deadline', req.group.id);
  res.json({ missions: await Promise.all(rows.map((m) => missionView(m, req.group))) });
});

router.post('/groups/:groupId/missions', loadGroup(true), async (req, res) => {
  const input = await validateMissionInput(req.group, req.body);
  if (input.error) return res.status(400).json(input);

  const repeat = ['daily', 'weekly'].includes(req.body.repeat) ? req.body.repeat : 'none';
  const count = repeat === 'none' ? 1 : Math.min(60, Math.max(1, Number(req.body.occurrences) || 1));
  const step = repeat === 'weekly' ? 7 * DAY : DAY;
  const seriesId = count > 1 ? crypto.randomBytes(6).toString('hex') : null;
  const items = Array.from({ length: count }, (_, i) => ({
    ...input,
    title: count > 1 ? `${input.title} (${i + 1}/${count})` : input.title,
    deadline: input.deadline + i * step,
    seriesId,
  }));
  const ids = await insertMissions(req.group, req.user, items);
  res.json({ created: ids.length });
});

router.post('/groups/:groupId/missions/bulk', loadGroup(true), async (req, res) => {
  const list = Array.isArray(req.body.missions) ? req.body.missions.slice(0, 60) : [];
  if (list.length === 0) return res.status(400).json({ error: 'No missions to save.' });
  const items = [];
  for (const raw of list) {
    const input = await validateMissionInput(req.group, raw);
    if (input.error) return res.status(400).json(input);
    items.push(input);
  }
  const ids = await insertMissions(req.group, req.user, items);
  res.json({ created: ids.length });
});

router.patch('/missions/:missionId', async (req, res) => {
  const { mission, group } = await loadMission(req, res);
  if (!mission) return;
  if (group.leader_id !== req.user.id) return res.status(403).json({ error: 'Only the group leader can edit missions.' });
  if (FINAL_STATUSES.includes(mission.status)) return res.status(400).json({ error: 'This mission is already closed.' });

  const merged = {
    title: req.body.title ?? mission.title,
    description: req.body.description ?? mission.description,
    assigneeId: req.body.assigneeId ?? mission.assignee_id,
    deadline: req.body.deadline ?? mission.deadline,
    reminderEveryDays: req.body.reminderEveryDays === undefined ? mission.reminder_every_days : req.body.reminderEveryDays,
  };
  const input = await validateMissionInput(group, merged);
  if (input.error) return res.status(400).json(input);
  if (input.assigneeId !== mission.assignee_id && (await latestProof(mission.id))) {
    return res.status(400).json({ error: 'Cannot reassign a mission that already has proof uploaded.' });
  }
  const deadlineMoved = input.deadline !== mission.deadline;
  await run(
    `UPDATE missions SET title = ?, description = ?, assignee_id = ?, deadline = ?, reminder_every_days = ?,
       h1_notified = CASE WHEN ?::int = 1 THEN 0 ELSE h1_notified END,
       reviewers_reminded = CASE WHEN ?::int = 1 THEN 0 ELSE reviewers_reminded END
     WHERE id = ?`,
    input.title, input.description, input.assigneeId, input.deadline, input.reminderEveryDays,
    deadlineMoved ? 1 : 0, deadlineMoved ? 1 : 0, mission.id
  );
  if (input.assigneeId !== mission.assignee_id) {
    await notify(input.assigneeId, {
      type: 'mission',
      title: `New jobdesk: "${input.title}"`,
      body: `Reassigned to you by ${req.user.display_name}.`,
      link: `#/group/${group.id}/missions`,
      actorId: req.user.id,
    });
  } else if (deadlineMoved) {
    await notify(mission.assignee_id, {
      type: 'mission',
      title: `Deadline changed: "${input.title}"`,
      body: `New deadline: ${new Date(input.deadline).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`,
      link: `#/group/${group.id}/missions`,
      actorId: req.user.id,
    });
  }
  emitToGroup(group.id, 'missions:changed');
  emitToGroup(group.id, 'feed:changed');
  res.json({ mission: await missionView(await one('SELECT * FROM missions WHERE id = ?', mission.id), group) });
});

router.delete('/missions/:missionId', async (req, res) => {
  const { mission, group } = await loadMission(req, res);
  if (!mission) return;
  if (group.leader_id !== req.user.id) return res.status(403).json({ error: 'Only the group leader can delete missions.' });
  const files = await all(
    'SELECT pf.stored_name FROM proof_files pf JOIN proofs p ON p.id = pf.proof_id WHERE p.mission_id = ?',
    mission.id
  );
  await run('DELETE FROM missions WHERE id = ?', mission.id);
  files.forEach((f) => removeFile(PROOFS, f.stored_name));
  emitToGroup(group.id, 'missions:changed');
  emitToGroup(group.id, 'feed:changed');
  res.json({ ok: true });
});

router.get('/me/missions', async (req, res) => {
  const groups = new Map(
    (await all('SELECT g.* FROM groups g JOIN group_members gm ON gm.group_id = g.id WHERE gm.user_id = ?', req.user.id))
      .map((g) => [g.id, g])
  );
  const mine = (await all(
    `SELECT * FROM missions WHERE assignee_id = ?
       AND (status NOT IN ('verified','failed','unverified') OR deadline > ?)
     ORDER BY deadline`,
    req.user.id, Date.now() - 7 * DAY
  )).filter((m) => groups.has(m.group_id));

  const toReview = [];
  const candidates = await all(
    `SELECT m.* FROM missions m JOIN group_members gm ON gm.group_id = m.group_id AND gm.user_id = ?
     WHERE m.status IN ('submitted','revision') AND m.assignee_id != ? ORDER BY m.deadline`,
    req.user.id, req.user.id
  );
  for (const m of candidates) {
    const proof = await latestProof(m.id);
    if (!proof) continue;
    const state = (await reviewStates(proof.id, await requiredReviewerIds(m))).get(req.user.id)?.state;
    if (state === 'pending') toReview.push(await missionView(m, groups.get(m.group_id)));
  }

  res.json({
    missions: await Promise.all(mine.map((m) => missionView(m, groups.get(m.group_id)))),
    toReview,
  });
});

// ---------- proof of work ----------

router.post('/missions/:missionId/proofs', proofUpload.array('files', 6), async (req, res) => {
  const files = req.files || [];
  const { mission, group } = await loadMission(req, res);
  if (!mission) return;
  const fail = (code, error) => res.status(code).json({ error });
  if (mission.assignee_id !== req.user.id) return fail(403, 'Only the assigned member can upload proof for this mission.');
  if (FINAL_STATUSES.includes(mission.status)) return fail(400, 'This mission is already closed.');
  if (Date.now() >= mission.deadline) return fail(400, 'The deadline has passed. Uploads are closed.');
  if (files.length === 0) return fail(400, 'Attach at least one screenshot or file as proof.');

  // Files are only written to storage once the upload is allowed.
  await saveUploads(PROOFS, files);
  const caption = String(req.body.caption || '').trim().slice(0, 1000);
  let proofId;
  try {
    proofId = await tx(async () => {
      const info = await run(
        'INSERT INTO proofs (mission_id, group_id, user_id, caption, created_at) VALUES (?, ?, ?, ?, ?)',
        mission.id, group.id, req.user.id, caption, Date.now()
      );
      const id = Number(info.lastInsertRowid);
      for (const f of files) {
        await run(
          'INSERT INTO proof_files (proof_id, stored_name, original_name, mime, size) VALUES (?, ?, ?, ?, ?)',
          id, f.filename, Buffer.from(f.originalname, 'latin1').toString('utf8').slice(0, 200), f.mimetype, f.size
        );
      }
      await run('UPDATE missions SET reviewers_reminded = 0 WHERE id = ?', mission.id);
      return id;
    });
  } catch (err) {
    files.forEach((f) => removeFile(PROOFS, f.filename));
    throw err;
  }

  await refreshMissionStatus(mission.id);
  const isResubmit = (await one('SELECT COUNT(*) AS c FROM proofs WHERE mission_id = ?', mission.id)).c > 1;
  for (const reviewerId of await requiredReviewerIds(mission)) {
    await notify(reviewerId, {
      type: 'proof',
      title: `${req.user.display_name} ${isResubmit ? 're-uploaded' : 'uploaded'} proof for "${mission.title}"`,
      body: `Give it a Checked or Revision before ${new Date(graceEnd(mission, group)).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}.`,
      link: `#/group/${group.id}/feed`,
      actorId: req.user.id,
    });
  }
  emitToGroup(group.id, 'feed:changed');
  emitToGroup(group.id, 'missions:changed');
  res.json({ proofId });

  // Non-blocking AI hint for reviewers.
  const images = files
    .filter((f) => /^image\/(png|jpe?g|webp)$/.test(f.mimetype) && f.size <= 4 * 1024 * 1024)
    .slice(0, 3)
    .map((f) => ({ mime: f.mimetype, base64: f.buffer.toString('base64') }));
  const note = await precheckProof({
    missionTitle: mission.title, missionDescription: mission.description, caption, images,
  });
  if (note) {
    await run('UPDATE proofs SET ai_note = ? WHERE id = ?', note, proofId);
    emitToGroup(group.id, 'feed:changed');
  }
});

router.post('/proofs/:proofId/review', async (req, res) => {
  const proof = await one('SELECT * FROM proofs WHERE id = ?', Number(req.params.proofId));
  const mission = proof && (await one('SELECT * FROM missions WHERE id = ?', proof.mission_id));
  if (!mission || !(await membership(mission.group_id, req.user.id))) return res.status(404).json({ error: 'Proof not found.' });
  const group = await one('SELECT * FROM groups WHERE id = ?', mission.group_id);

  const type = req.body.type === 'revision' ? 'revision' : req.body.type === 'checked' ? 'checked' : null;
  const message = String(req.body.message || '').trim().slice(0, 1000);
  if (!type) return res.status(400).json({ error: 'Unknown review type.' });
  if (proof.user_id === req.user.id) return res.status(403).json({ error: "You can't review your own work." });
  if ((await latestProof(mission.id)).id !== proof.id) return res.status(400).json({ error: 'A newer proof was uploaded. Review that one instead.' });
  if (FINAL_STATUSES.includes(mission.status)) return res.status(400).json({ error: 'This mission is already closed.' });
  if (Date.now() >= graceEnd(mission, group)) return res.status(400).json({ error: 'The verification window has closed.' });
  if (type === 'revision' && !message) return res.status(400).json({ error: 'Write what needs to be revised.' });

  const mine = (await reviewStates(proof.id, await requiredReviewerIds(mission))).get(req.user.id);
  if (!mine) return res.status(403).json({ error: 'You are not a reviewer for this work.' });
  if (mine.state === 'checked') return res.status(409).json({ error: 'You already checked this work.' });

  await run(
    'INSERT INTO reviews (proof_id, reviewer_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
    proof.id, req.user.id, type, message, Date.now()
  );
  await notify(mission.assignee_id, type === 'revision'
    ? {
        type: 'revision',
        title: `${req.user.display_name} gave you revision:`,
        body: `${message}\n— on "${mission.title}"`,
        link: `#/group/${group.id}/feed`,
        actorId: req.user.id,
      }
    : {
        type: 'checked',
        title: `${req.user.display_name} checked your work ✓`,
        body: `"${mission.title}"`,
        link: `#/group/${group.id}/feed`,
        actorId: req.user.id,
      });
  await refreshMissionStatus(mission.id);
  emitToGroup(group.id, 'feed:changed');
  emitToGroup(group.id, 'missions:changed');
  res.json({ ok: true });
});

router.get('/groups/:groupId/feed', loadGroup(), async (req, res) => {
  const before = Math.floor(Number(req.query.before)) || Number.MAX_SAFE_INTEGER;
  const LIMIT = 20;
  const now = Date.now();

  const proofRows = await all(
    'SELECT * FROM proofs WHERE group_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?',
    req.group.id, before, LIMIT
  );
  const proofs = await Promise.all(proofRows.map(async (p) => {
    const mission = await one('SELECT * FROM missions WHERE id = ?', p.mission_id);
    const latest = await latestProof(mission.id);
    const isLatest = latest.id === p.id;
    const end = graceEnd(mission, req.group);
    const states = await reviewStates(p.id, await requiredReviewerIds(mission));
    const isOwner = p.user_id === req.user.id;
    const reviewers = await Promise.all([...states].map(async ([userId, s]) => {
      const last = s.reviews.at(-1);
      const canSeeNotes = isOwner || userId === req.user.id;
      return {
        user: await getUser(userId),
        state: s.state,
        at: last?.created_at ?? null,
        revisions: canSeeNotes
          ? s.reviews.filter((r) => r.type === 'revision').map((r) => ({ message: r.message, at: r.created_at }))
          : [],
      };
    }));
    const myState = states.get(req.user.id)?.state ?? null;
    const files = await all('SELECT * FROM proof_files WHERE proof_id = ? ORDER BY id', p.id);
    return {
      type: 'proof',
      id: p.id,
      createdAt: p.created_at,
      caption: p.caption,
      aiNote: p.ai_note,
      author: await getUser(p.user_id),
      mission: { id: mission.id, title: mission.title, deadline: mission.deadline, status: mission.status, graceEnd: end },
      files: files.map((f) => ({
        id: f.id,
        url: `/api/files/${f.stored_name}`,
        name: f.original_name,
        mime: f.mime,
        size: f.size,
        isImage: /^image\/(png|jpe?g|webp|gif)$/.test(f.mime),
      })),
      isLatest,
      reviewers,
      myState,
      canReview: !isOwner && myState !== null && myState !== 'checked' && isLatest
        && !['verified', 'failed', 'unverified'].includes(mission.status) && now < end,
    };
  }));

  const confessionRows = await all(
    `SELECT c.*, m.title AS mission_title FROM confessions c LEFT JOIN missions m ON m.id = c.mission_id
     WHERE c.group_id = ? AND c.created_at < ? ORDER BY c.created_at DESC LIMIT ?`,
    req.group.id, before, LIMIT
  );
  const confessions = await Promise.all(confessionRows.map(async (c) => ({
    type: 'confession',
    id: c.id,
    createdAt: c.created_at,
    kind: c.kind,
    quote: c.quote,
    roast: c.roast,
    missionTitle: c.mission_title,
    user: await getUser(c.user_id),
    target: c.target_user_id ? await getUser(c.target_user_id) : null,
  })));

  const items = [...proofs, ...confessions].sort((a, b) => b.createdAt - a.createdAt).slice(0, LIMIT);
  res.json({ items, nextBefore: items.length === LIMIT ? items.at(-1).createdAt : null });
});

// Proof files are private to the group.
router.get('/files/:name', async (req, res) => {
  const file = await one(
    `SELECT pf.*, p.group_id FROM proof_files pf JOIN proofs p ON p.id = pf.proof_id WHERE pf.stored_name = ?`,
    path.basename(req.params.name)
  );
  if (!file || !(await membership(file.group_id, req.user.id))) return res.status(404).end();
  const inline = /^(image\/(png|jpe?g|webp|gif)|application\/pdf|video\/mp4)$/.test(file.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', inline ? file.mime : 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`
  );
  await sendStoredFile(req, res, PROOFS, file.stored_name);
});

export default router;
