# IPtasK

Group study planner / habit tracker with **peer-verified proof of work** and **auto confession posts**.

## Run

```bash
npm install
cp .env.example .env   # then put your GEMINI_API_KEY in .env
npm start              # or: npm run dev (auto-restart on changes)
```

- Landing page: http://localhost:3000
- App: http://localhost:3000/app

Requires Node.js 22.13+ (uses the built-in `node:sqlite`). Data lives in `data/iptask.db`, uploads in `uploads/`.

```bash
npm test               # scheduler rules, streaks and migrations, on an in-memory database
npm run seed           # demo users: ketua / anggota1 / anggota2, password demo123
npm run seed:beban     # label showcase: budi (2 labels), sari, rizky (hasn't voted), putri — password demo123
```

## How the rules work

| Event | What happens |
|---|---|
| Leader assigns a mission | Assignee gets an in-app notification. Can repeat daily/weekly for habits. |
| Until done, at the reminder frequency (every day / 2 days / 3 days / week / off; group default, each mission can override) | "You have unfinished jobdesk that will end in N days" |
| 24h before deadline | H-1 warning to the assignee |
| Proof uploaded | Every other member is notified to press **Checked** or **Revision** |
| Revision | Assignee gets "X gave you revision: …"; re-uploading resets the checks |
| All members checked | Mission becomes **Verified** |
| Deadline passes, no proof | Mission **Failed** → IPtasK Bot posts *"this user didn't finish the job by the deadline"* |
| … and | The assignee gets the label **"Beban [group]"** on their public profile (one per group; repeat misses raise its count) |
| Label owner asks for a **redeem vote** | Every other member votes; **all approve** → label removed, **one rejects** → vote closes, ask again after 24h |
| Verification window closes (default 24h after deadline, set per group) with missing checks | Each member who didn't review gets *"this user didn't check X's work"*, and the owner gets *"this user's work didn't get verified by the deadline"* |
| Verification window closes, a revision was never fixed | Owner gets *"this user didn't fix the revision before the deadline"* |
| 12h before the window closes | Reminder to reviewers who haven't acted |

The scheduler runs every minute inside the server process (`server/missions.js`).

## Accounts & security

- **Forgot password**: there is no email, so each user makes a **recovery code** on their Profile page (shown once, single use). The login page has *Forgot password?* → username + code + new password. Resetting logs out every other device.
- Failed logins are limited to 5 per username+IP and 30 per IP every 15 minutes; sign-ups to 10 per IP per hour (in memory, per server process).
- Security headers (CSP, frame blocking, nosniff) on every response; session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` when `NODE_ENV=production`.
- Proof files are only served to members of the group.
- **Continue with Google** (optional): the button appears on the login/sign-up page once `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.
  1. Google Cloud Console → APIs & Services → Credentials → *Create OAuth client ID* → **Web application**.
  2. Authorized redirect URI: `http://localhost:3000/api/auth/google/callback` (and `https://<your domain>/api/auth/google/callback` when deployed; set `PUBLIC_URL` to that domain).
  3. Put the ID and secret in `.env` and restart.

  A first Google sign-in creates an account (username from the email, editable display name). Existing users can connect Google from Profile. Google-only accounts can set a password later; Google can be disconnected only once a password exists.

## Group features

- **Leaderboard** (Members tab): verified missions, failed/unverified, confessions, on-time rate, current streak.
- **Profile stats**: your streak (days in a row with at least one proof upload), best streak and completion rate.
- **Hand over leadership**: the leader can make another member leader, then leave.
- **Export missions as CSV** (leader, Members tab → Group settings).
- **Installable app (PWA)**: "Install app" in Chrome/Edge or "Add to Home Screen" on phones. Alerts appear while the app is open; real push with the app fully closed would need Web Push (VAPID keys) and is not set up.

## Gemini features

- **AI jobdesk splitter** (leader, Missions tab): fair split + staggered deadlines, editable before saving.
- **AI proof hint**: short note on uploaded screenshots to help reviewers (never decides by itself).
- **AI roast caption** on confession cards (falls back to built-in lines without a key).

## Structure

```
server/
  index.js         Express + Socket.IO bootstrap
  db.js            SQLite schema + numbered migrations (PRAGMA user_version)
  security.js      login rate limiting, security headers
  stats.js         streaks, profile stats, group leaderboard
  labels.js        "Beban <group>" labels and redeem votes
  missions.js      mission status, confessions, scheduler
  gemini.js        Gemini REST calls
  routes/          account, groups (chat, invites, AI split), missions (proofs, reviews, feed)
public/
  index.html       landing page
  app.html         single-page app (vanilla JS modules in js/)
  sw.js            service worker (offline shell, notification clicks)
test/              node:test suites
```

## Changing the database schema

Add a function to the end of `MIGRATIONS` in `server/db.js` (for example an `ALTER TABLE`). It runs once on the next start and bumps `PRAGMA user_version`. Never edit or reorder a migration that has already shipped.

## Deploying

Any host that runs a long-lived Node 22.13+ process with a persistent disk works (a VPS, Railway or Render with a volume, Fly.io with a volume). Serverless platforms do not: the scheduler and Socket.IO need the process to stay up, and SQLite needs a real disk.

1. `npm ci --omit=dev`
2. Set the environment: `NODE_ENV=production`, `PORT`, `GEMINI_API_KEY` (optional), and `TRUST_PROXY` = how many proxies sit in front (default `1` in production).
3. Put it behind HTTPS (the platform's TLS, or nginx/Caddy). Secure cookies need HTTPS, and Socket.IO needs WebSocket upgrade allowed (`proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";` on nginx).
4. Keep it running with the platform's process manager, `pm2 start server/index.js --name iptask`, or a systemd service.
5. Run **one** instance only: login limits and the scheduler live in memory.

### Backups

Everything is in two folders: `data/` (database) and `uploads/` (avatars and proofs). For a consistent database copy while the server runs:

```bash
sqlite3 data/iptask.db ".backup 'backup/iptask-$(date +%F).db'"
tar czf backup/uploads-$(date +%F).tgz uploads/
```

Run it daily (cron) and keep copies off the server.
