import { Router } from 'express';
import { one } from '../db.js';
import { requireAuth, publicUser } from '../auth.js';
import { userStats } from '../stats.js';
import { loadGroup } from './groups.js';
import { activeLabelsForUser, activeLabelsForGroup, requestRedeem, castVote } from '../labels.js';

const router = Router();
router.use(requireAuth);

/** Public profile: anyone logged in can see someone's labels and track record. */
router.get('/users/:userId', (req, res) => {
  const user = one('SELECT * FROM users WHERE id = ?', Number(req.params.userId));
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({
    user: publicUser(user),
    labels: activeLabelsForUser(user.id, req.user.id),
    stats: userStats(user.id),
  });
});

router.get('/groups/:groupId/labels', loadGroup(), (req, res) => {
  res.json({ labels: activeLabelsForGroup(req.group.id, req.user.id) });
});

router.post('/labels/:labelId/redeem', (req, res) => {
  const result = requestRedeem(Number(req.params.labelId), req.user.id, req.body.message);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

router.post('/redeem/:requestId/vote', (req, res) => {
  const result = castVote(Number(req.params.requestId), req.user.id, req.body.approve === true);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

export default router;
