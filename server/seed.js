// Demo data: `npm run seed`. Safe to run more than once — skips if the demo users exist.
import bcrypt from 'bcryptjs';
import { one, run, tx } from './db.js';

const PASSWORD = 'demo123';
const HOUR = 3600_000;
const now = Date.now();

if (one("SELECT 1 FROM users WHERE username = 'ketua'")) {
  console.log('Demo data already exists. Log in with ketua / anggota1 / anggota2, password: demo123');
  process.exit(0);
}

tx(() => {
  const hash = bcrypt.hashSync(PASSWORD, 10);
  const user = (username, displayName) =>
    Number(run('INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?)',
      username, hash, displayName, now).lastInsertRowid);
  const ketua = user('ketua', 'Raka (Ketua)');
  const a1 = user('anggota1', 'Nadia Ayu');
  const a2 = user('anggota2', 'Dimas Pratama');

  const groupId = Number(run(
    'INSERT INTO groups (name, description, leader_id, verify_grace_hours, created_at) VALUES (?, ?, ?, 24, ?)',
    'PBO Kelompok 3', 'Final project Pemrograman Berorientasi Objek', ketua, now
  ).lastInsertRowid);
  for (const [id, role] of [[ketua, 'leader'], [a1, 'member'], [a2, 'member']]) {
    run('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', groupId, id, role, now);
  }

  const today = new Date().toDateString();
  const mission = (assignee, title, description, hoursLeft) =>
    run(`INSERT INTO missions (group_id, assignee_id, created_by, title, description, deadline, last_daily_reminder, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      groupId, assignee, ketua, title, description, now + hoursLeft * HOUR, today, now);
  mission(ketua, 'Write the final report (Bab 1–2)', 'Introduction and literature review, min. 6 pages.', 72);
  mission(a1, 'Design the class diagram', 'UML class diagram for all modules, exported as PNG.', 20);
  mission(a2, 'Build the login & CRUD module', 'Java Swing login form + CRUD for the books table. Proof: screenshot of it running.', 48);

  for (const [id, body] of [
    [ketua, 'Halo semua! Jobdesk udah aku bagi di tab Missions ya 🙌'],
    [a1, 'Siap, class diagram aku kerjain malam ini'],
    [a2, 'Oke, CRUD aku handle'],
  ]) {
    run('INSERT INTO messages (group_id, user_id, body, created_at) VALUES (?, ?, ?, ?)', groupId, id, body, now);
  }
});

console.log(`Demo data created. Accounts (password: ${PASSWORD}):
  ketua     — group leader
  anggota1  — member
  anggota2  — member`);
