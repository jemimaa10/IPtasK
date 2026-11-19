// Showcase for "Beban <group>" labels: `npm run seed:beban`. Safe to run more than once.
//
//   budi    — carries two labels: one with a redeem vote in progress, one without
//   sari    — leader of "RPL Kelompok 5", already approved Budi's redeem
//   rizky   — has NOT voted yet: log in as rizky to approve or reject
//   putri   — leader of "Kewirausahaan B"
// Password for all: demo123
import bcrypt from 'bcryptjs';
import { one, run, tx, localDayNumber } from './db.js';
import { labelForMissedMission, requestRedeem, castVote } from './labels.js';

const PASSWORD = 'demo123';
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const now = Date.now();

if (one("SELECT 1 FROM users WHERE username = 'budi'")) {
  console.log('Beban showcase already exists. Log in with budi / sari / rizky / putri, password: demo123');
  process.exit(0);
}

const hash = bcrypt.hashSync(PASSWORD, 10);
const user = (username, displayName) =>
  Number(run('INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?)',
    username, hash, displayName, now - 30 * DAY).lastInsertRowid);

function group(name, description, leaderId, memberIds) {
  const id = Number(run(
    'INSERT INTO groups (name, description, leader_id, verify_grace_hours, created_at) VALUES (?, ?, ?, 24, ?)',
    name, description, leaderId, now - 20 * DAY
  ).lastInsertRowid);
  run("INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'leader', ?)", id, leaderId, now - 20 * DAY);
  for (const m of memberIds) {
    run("INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)", id, m, now - 20 * DAY);
  }
  return id;
}

function mission(groupId, assignee, creator, title, description, deadline, status) {
  const id = Number(run(
    `INSERT INTO missions (group_id, assignee_id, created_by, title, description, deadline, status, last_reminder_day, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    groupId, assignee, creator, title, description, deadline, status, localDayNumber(), deadline - 7 * DAY
  ).lastInsertRowid);
  return one('SELECT * FROM missions WHERE id = ?', id);
}

/** What the scheduler does when a deadline passes without proof. */
function missDeadline(m, roast) {
  run(
    `INSERT INTO confessions (group_id, mission_id, user_id, kind, quote, roast, created_at)
     VALUES (?, ?, ?, 'missed_deadline', ?, ?, ?)`,
    m.group_id, m.id, m.assignee_id, "this user didn't finish the job by the deadline", roast, m.deadline + 60_000
  );
  labelForMissedMission(m);
  // Backdate so the showcase reads like it happened at the deadline, not when the seed ran.
  run(
    'UPDATE labels SET created_at = MIN(created_at, ?) WHERE user_id = ? AND group_id = ? AND redeemed_at IS NULL',
    m.deadline + 60_000, m.assignee_id, m.group_id
  );
  run('UPDATE notifications SET created_at = ? WHERE user_id = ? AND type = ? AND created_at >= ?', m.deadline + 60_000, m.assignee_id, 'label', now);
}

tx(() => {
  const budi = user('budi', 'Budi Santoso');
  const sari = user('sari', 'Sari Wulandari');
  const rizky = user('rizky', 'Rizky Hidayat');
  const putri = user('putri', 'Putri Amelia');

  // Group 1: Budi missed two jobdesks → "Beban RPL Kelompok 5" ×2, redeem vote half-way.
  const rpl = group('RPL Kelompok 5', 'Tugas besar Rekayasa Perangkat Lunak — sistem informasi perpustakaan', sari, [rizky, budi]);
  mission(rpl, sari, sari, 'Bab 1 — Pendahuluan', 'Latar belakang, rumusan masalah, tujuan.', now - 9 * DAY, 'verified');
  mission(rpl, rizky, sari, 'ERD dan normalisasi 3NF', 'ERD final + tabel normalisasi, export PNG.', now - 8 * DAY, 'verified');
  missDeadline(
    mission(rpl, budi, sari, 'Bab 3 — Perancangan sistem', 'Use case, activity diagram, dan rancangan UI.', now - 6 * DAY, 'failed'),
    'Bab 3 masih dalam tahap perancangan… di kepala Budi.'
  );
  missDeadline(
    mission(rpl, budi, sari, 'Revisi use case diagram', 'Perbaiki sesuai catatan dosen minggu lalu.', now - 3 * DAY, 'failed'),
    'Revisinya juga butuh direvisi: dikerjakan dulu.'
  );
  mission(rpl, rizky, sari, 'Implementasi modul peminjaman', 'CRUD peminjaman + screenshot berjalan.', now + 4 * DAY, 'open');
  mission(rpl, budi, sari, 'Testing black box', '20 test case + hasil, format tabel.', now + 5 * DAY, 'open');
  for (const [id, body, ago] of [
    [sari, 'Bud, bab 3 gimana? Udah lewat deadline nih 😅', 6 * DAY],
    [budi, 'Sorry banget, minggu kemarin aku sakit. Sekarang udah aku kerjain semua.', 2 * DAY],
    [rizky, 'Oke, nanti aku cek dulu hasilnya ya sebelum vote redeem.', DAY],
  ]) {
    run('INSERT INTO messages (group_id, user_id, body, created_at) VALUES (?, ?, ?, ?)', rpl, id, body, now - ago);
  }

  const rplLabel = one('SELECT id FROM labels WHERE user_id = ? AND group_id = ?', budi, rpl);
  const { requestId } = requestRedeem(rplLabel.id, budi, 'Maaf ya guys, minggu lalu aku sakit. Bab 3 dan revisi use case sudah aku selesaikan dan upload di drive. Aku janji testing black box tepat waktu.');
  castVote(requestId, sari, true); // Rizky has not voted yet.
  run('UPDATE redeem_requests SET created_at = ? WHERE id = ?', now - DAY, requestId);
  run('UPDATE redeem_votes SET created_at = ? WHERE request_id = ?', now - 20 * HOUR, requestId);

  // Group 2: another label, no redeem vote yet → Budi can press "Ask for redeem".
  const kwu = group('Kewirausahaan B', 'Proyek usaha minuman kekinian', putri, [budi, rizky]);
  mission(kwu, putri, putri, 'Business model canvas', 'BMC lengkap 9 blok.', now - 10 * DAY, 'verified');
  missDeadline(
    mission(kwu, budi, putri, 'Laporan keuangan minggu 2', 'Pemasukan, pengeluaran, dan laba harian.', now - 2 * DAY, 'failed'),
    'Laporan keuangannya defisit: defisit progres.'
  );
});

console.log(`Beban showcase created. Accounts (password: ${PASSWORD}):
  budi   — has "Beban RPL Kelompok 5" (×2, redeem vote running) and "Beban Kewirausahaan B"
  sari   — leader of RPL Kelompok 5, already approved the redeem
  rizky  — hasn't voted yet: log in and open RPL Kelompok 5 → Members
  putri  — leader of Kewirausahaan B`);
