// One-time move from the old SQLite database (data/iptask.db) to Postgres, plus the uploads/ folder to storage.
//
//   npm run import:sqlite                 # data/iptask.db → the database in .env (DATABASE_URL, or local PGlite)
//   npm run import:sqlite -- other.db     # another SQLite file
//
// The target database must be empty (no users yet). Files are copied only when Supabase Storage is configured;
// with local storage they already sit in uploads/.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, UPLOAD_DIR } from './config.js';
import { one, all, run, tx, exec, closeDb, driver, TABLES } from './db.js';
import { storageMode, initStorage, saveFile, AVATARS, PROOFS } from './uploads.js';

const source = path.resolve(process.argv[2] || path.join(ROOT, 'data', 'iptask.db'));
if (!fs.existsSync(source)) {
  console.error(`SQLite file not found: ${source}`);
  process.exit(1);
}
if (await one('SELECT 1 FROM users LIMIT 1')) {
  console.error('The target database already has users. Import only into an empty database.');
  await closeDb();
  process.exit(1);
}

const sqlite = new DatabaseSync(source, { readOnly: true });
console.log(`Importing ${source}\n     into ${driver}${driver === 'postgres' ? ' (DATABASE_URL)' : ''}\n`);

const sqliteTables = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));

await tx(async () => {
  for (const table of TABLES) {
    if (!sqliteTables.has(table)) {
      console.log(`  ${table.padEnd(16)} (not in the old database, skipped)`);
      continue;
    }
    // Only columns both sides have (old columns such as missions.last_daily_reminder are left behind).
    const target = new Set((await all('SELECT column_name FROM information_schema.columns WHERE table_name = ?', table)).map((c) => c.column_name));
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).filter((c) => target.has(c));
    const rows = sqlite.prepare(`SELECT ${cols.join(', ')} FROM ${table}`).all();
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    for (const row of rows) await run(sql, ...cols.map((c) => (typeof row[c] === 'bigint' ? Number(row[c]) : row[c])));
    console.log(`  ${table.padEnd(16)} ${rows.length} rows`);
  }
  // Ids were copied as they were; new rows must continue after the highest one.
  for (const table of TABLES) {
    if (!(await one("SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = 'id'", table))) continue;
    await exec(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`);
  }
});

if (storageMode === 'supabase') {
  await initStorage();
  const wanted = [
    ...(await all('SELECT avatar_path AS name FROM users WHERE avatar_path IS NOT NULL')).map((r) => [AVATARS, r.name]),
    ...(await all('SELECT stored_name AS name, mime FROM proof_files')).map((r) => [PROOFS, r.name, r.mime]),
  ];
  let copied = 0;
  let missing = 0;
  for (const [kind, name, mime] of wanted) {
    const file = path.join(UPLOAD_DIR, kind, name);
    if (!fs.existsSync(file)) {
      missing++;
      continue;
    }
    await saveFile(kind, name, fs.readFileSync(file), mime || (name.endsWith('.png') ? 'image/png' : 'image/jpeg'));
    copied++;
    if (copied % 20 === 0) console.log(`  … ${copied}/${wanted.length} files`);
  }
  console.log(`\n  files            ${copied} copied to Supabase Storage${missing ? `, ${missing} missing on disk` : ''}`);
} else {
  console.log('\n  files            left in uploads/ (local storage)');
}

sqlite.close();
await closeDb();
console.log('\nDone. Everyone can log in with their old username and password.');
// No process.exit(): open HTTPS connections to Storage close by themselves (forcing exit can crash libuv on Windows).
