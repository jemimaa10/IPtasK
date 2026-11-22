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

Requires Node.js 22.13+. The database is Postgres: locally a built-in [PGlite](https://pglite.dev) database in `data/pglite` (nothing to install), and any Postgres such as Supabase once `DATABASE_URL` is set. Uploads go to `uploads/`, or to Supabase Storage once `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are set.

```bash
npm test               # scheduler rules, streaks, labels and the query layer, on an in-memory database
npm run seed           # demo users: ketua / anggota1 / anggota2, password demo123
npm run seed:beban     # label showcase: budi (2 labels), sari, rizky (hasn't voted), putri — password demo123
npm run import:sqlite  # one-time: copy the old SQLite data/iptask.db (+ uploads/) into the configured database/storage
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
  db.js            Postgres (pg or PGlite), async query helpers, schema + numbered migrations
  uploads.js       avatar/proof storage: uploads/ folder or Supabase Storage
  router.js        express.Router whose handlers may be async
  import-sqlite.js one-time move from the old SQLite database
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

Add an async function to the end of `MIGRATIONS` in `server/db.js` (for example `() => exec('ALTER TABLE …')`). It runs once on the next start and bumps the `schema_version` table. Never edit or reorder a migration that has already shipped. Queries use `?` placeholders and are all async: `await one(…)`, `await all(…)`, `await run(…)`, `await tx(async () => …)`.

## Deploying for free: Render + Supabase

Supabase holds the data (Postgres) and the files (Storage); Render runs the server. Both have free plans without a credit card.

**1. Supabase** (supabase.com → New project, region Singapore)
- *Connect* → **Session pooler** → copy the URI and put your database password in it → `DATABASE_URL`.
- *Project Settings → API Keys* → the **secret** key (or legacy `service_role`) → `SUPABASE_SERVICE_KEY`; the project URL `https://<ref>.supabase.co` → `SUPABASE_URL`. Keep the secret key on the server only.
- The app creates its tables and a private `iptask` storage bucket on first start.

**2. Move existing data (optional)** from your laptop: put the three values in `.env`, then `npm run import:sqlite`. It copies `data/iptask.db` and `uploads/` into Supabase (the target must be empty). Remove them from `.env` afterwards if you want local development to use the local database again.

**3. Render** (render.com → New → **Blueprint** → this GitHub repo). `render.yaml` sets everything up; fill in `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` and optionally `GEMINI_API_KEY`. The app runs at `https://<name>.onrender.com`.

**4. Keep it awake**: the free Render plan sleeps after 15 minutes without visits (the first visit then takes ~1 minute, and reminders wait). Create a free job on cron-job.org that opens `https://<name>.onrender.com/healthz` every 10 minutes. That also keeps the Supabase project active (free projects pause after a week without use).

**5. Google sign-in (optional)**: add `https://<name>.onrender.com/api/auth/google/callback` to the OAuth client's redirect URIs and set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `PUBLIC_URL=https://<name>.onrender.com` on Render.

Other hosts work the same way: a long-lived Node 22.13+ process (the scheduler and Socket.IO need it to stay up, so not serverless), `NODE_ENV=production`, HTTPS in front (Socket.IO needs WebSocket upgrade allowed), and **one** instance only (login limits and the scheduler live in memory).

### Backups

Supabase free projects have no automatic backups. To keep a copy: `pg_dump "$DATABASE_URL" > iptask-$(date +%F).sql`, and download the `iptask` bucket from the Supabase dashboard (Storage).
