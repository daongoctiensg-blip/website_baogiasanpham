#!/usr/bin/env node
/**
 * Migration 1 lần: gán image / description / retail_price cho các sản phẩm
 * đã seed sẵn trong bảng `products`, dựa theo file products_media.json
 * (được tách ra từ index.html bản cũ — mảng RETAIL_PRICES / IMGS / DESCRIPTIONS).
 *
 * Idempotent: chạy lại nhiều lần không sao, chỉ ghi đè lại đúng các field này
 * theo đúng tên sản phẩm khớp trong DB.
 *
 * Cách chạy (đứng tại thư mục gốc project, cạnh server.js):
 *   node scripts/migrate_media.js
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const mediaPath = path.join(ROOT, 'products_media.json');

if (!fs.existsSync(mediaPath)) {
  console.error('Không tìm thấy products_media.json ở gốc project. Dừng lại.');
  process.exit(1);
}

const media = JSON.parse(fs.readFileSync(mediaPath, 'utf8'));
const db = new Database(path.join(ROOT, 'orders.db'));

const getByName = db.prepare('SELECT id FROM products WHERE name = ?');
const update = db.prepare(
  'UPDATE products SET image = ?, description = ?, retail_price = ? WHERE id = ?'
);

let matched = 0, missing = 0;
const missingNames = [];

const run = db.transaction((entries) => {
  for (const [name, m] of entries) {
    const row = getByName.get(name);
    if (!row) { missing++; missingNames.push(name); continue; }
    update.run(m.image || null, m.description || null, m.retailPrice ?? null, row.id);
    matched++;
  }
});

run(Object.entries(media));

console.log(`✅ Đã cập nhật ${matched} sản phẩm.`);
if (missing > 0) {
  console.log(`⚠️  ${missing} tên sản phẩm trong products_media.json không khớp DB (bỏ qua):`);
  missingNames.slice(0, 20).forEach(n => console.log('   -', n));
  if (missingNames.length > 20) console.log(`   ... và ${missingNames.length - 20} tên khác`);
}
