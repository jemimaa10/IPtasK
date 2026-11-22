// GET /api/events?since=<id>&groups=1,2 — long poll for live updates.
// Answers as soon as there is something newer than `since`, or after ~20 s with nothing.
// `since` missing → answers at once with the current cursor, where the page starts listening.
import { Router } from '../router.js';
import { requireAuth } from '../auth.js';
import { eventsSince, latestEventId } from '../realtime.js';

const router = Router();
const HOLD_MS = Number(process.env.EVENTS_HOLD_MS) || 20_000;
const CHECK_EVERY_MS = 1_500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

router.get('/events', requireAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const since = Math.floor(Number(req.query.since));
  if (!Number.isFinite(since) || since <= 0) return res.json({ cursor: await latestEventId(), events: [] });
  const groupIds = String(req.query.groups || '')
    .split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 20);

  let closed = false;
  // The page went away (navigation, closed tab): stop polling the database for it.
  res.on('close', () => { if (!res.writableEnded) closed = true; });
  const until = Date.now() + HOLD_MS;
  for (;;) {
    const events = await eventsSince(req.user.id, since, groupIds);
    if (events.length || Date.now() >= until || closed) {
      if (closed) return;
      return res.json({ cursor: events.at(-1)?.id ?? since, events });
    }
    await sleep(CHECK_EVERY_MS);
  }
});

export default router;
