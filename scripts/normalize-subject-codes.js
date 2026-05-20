const { getDB, initDatabase } = require('../database');

initDatabase();
const db = getDB();

function slugFor(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  let s = '';
  if (words.length === 1) {
    s = words[0].slice(0, 4).toUpperCase();
  } else {
    s = words.map(w => w[0]).join('').toUpperCase().slice(0, 6);
  }
  return s.replace(/[^A-Z0-9]/g, '');
}

const rows = db.prepare('SELECT id, name, code FROM subjects ORDER BY id').all();
const used = new Set();
const update = db.prepare("UPDATE subjects SET code = ?, updated_at = datetime('now') WHERE id = ?");

db.exec('BEGIN');
try {
  for (const r of rows) {
    let base = slugFor(r.name);
    if (!base) base = 'SUB' + r.id;
    let candidate = base;
    let n = 2;
    while (used.has(candidate)) {
      candidate = base.slice(0, 4) + n;
      n++;
    }
    used.add(candidate);
    update.run(candidate, r.id);
    console.log(`#${r.id}  ${r.name.padEnd(35)} ${(r.code || '').padEnd(20)} -> ${candidate}`);
  }
  db.exec('COMMIT');
  console.log('\nDone. ' + rows.length + ' subject(s) normalized.');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('Rolled back:', e.message);
  process.exit(1);
}
