// One-off migration: set rating cho các sản phẩm đã có trong DB.
// Chạy 1 LẦN DUY NHẤT sau khi pull code này lên VPS:
//   cd /var/www/tiedohouse.com && node migrate-ratings.js
//
// Quy tắc:
//   - Tất cả sản phẩm: rating = 3
//   - Riêng 3 group Ham Sliced VN (Bellota/Cebo/Serrano): rating = 5

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'orders.db'));

const FIVE_STAR_GROUPS = [
  'Ham Sliced — Bellota (ủ muối 36 tháng)',
  'Ham Sliced — Cebo (ủ muối 24 tháng)',
  'Ham Sliced — Serrano (ủ muối 16 tháng)'
];

const run = db.transaction(() => {
  const totalBefore = db.prepare('SELECT COUNT(*) c FROM products').get().c;
  if (totalBefore === 0) {
    console.log('⚠️  Bảng products rỗng — chưa seed data, không có gì để migrate.');
    return { totalBefore, base: 0, five: 0 };
  }

  const base = db.prepare('UPDATE products SET rating = 3').run().changes;

  const setFive = db.prepare('UPDATE products SET rating = 5 WHERE grp = ?');
  let five = 0;
  for (const grp of FIVE_STAR_GROUPS) {
    const r = setFive.run(grp);
    five += r.changes;
    console.log(`  → "${grp}": ${r.changes} sản phẩm set 5*`);
  }

  return { totalBefore, base, five };
});

const result = run();
console.log(`✅ Migrate xong. Tổng sản phẩm: ${result.totalBefore}. Set 3*: ${result.base}. Set 5* (override): ${result.five}.`);

if (result.five === 0 && result.totalBefore > 0) {
  console.warn('⚠️  Không có sản phẩm nào khớp 3 group Ham Sliced 5* — kiểm tra lại tên group (grp) trong DB, có thể lệch dấu/khoảng trắng.');
}

db.close();
