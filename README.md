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

## How the rules work

| Event | What happens |
|---|---|
| Leader assigns a mission | Assignee gets an in-app notification. Can repeat daily/weekly for habits. |
| Every day until done | "You have unfinished jobdesk that will end in N days" |
| 24h before deadline | H-1 warning to the assignee |
| Proof uploaded | Every other member is notified to press **Checked** or **Revision** |
| Revision | Assignee gets "X gave you revision: …"; re-uploading resets the checks |
| All members checked | Mission becomes **Verified** |
| Deadline passes, no proof | Mission **Failed** → IPtasK Bot posts *"this user didn't finish the job by the deadline"* |
| Verification window closes (default 24h after deadline, set per group) with missing checks | Each member who didn't review gets *"this user didn't check X's work"*, and the owner gets *"this user's work didn't get verified by the deadline"* |
| Verification window closes, a revision was never fixed | Owner gets *"this user didn't fix the revision before the deadline"* |
| 12h before the window closes | Reminder to reviewers who haven't acted |

The scheduler runs every minute inside the server process (`server/missions.js`).

## Gemini features

- **AI jobdesk splitter** (leader, Missions tab): fair split + staggered deadlines, editable before saving.
- **AI proof hint**: short note on uploaded screenshots to help reviewers (never decides by itself).
- **AI roast caption** on confession cards (falls back to built-in lines without a key).

## Structure

```
server/
  index.js         Express + Socket.IO bootstrap
  db.js            SQLite schema
  missions.js      mission status, confessions, scheduler
  gemini.js        Gemini REST calls
  routes/          account, groups (chat, invites, AI split), missions (proofs, reviews, feed)
public/
  index.html       landing page
  app.html         single-page app (vanilla JS modules in js/)
```
