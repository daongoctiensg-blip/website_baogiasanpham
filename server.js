const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = 3003;

// ── Upload dir ────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, 'uploads', 'products');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
      const safeExt = /^\.(jpg|jpeg|png|webp|gif)$/.test(ext) ? ext : '.jpg';
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Chỉ chấp nhận file ảnh (jpg, png, webp, gif)'));
  }
});

// ── Config ────────────────────────────────────────────────
const TELEGRAM_TOKEN = '8967147178:AAE9OkD_eG7haz7L1Fhr3KkT-kyk-IjaGqg';
const TELEGRAM_CHAT_IDS = ['5754177904', '8092297295']; // Tiedo & Vu Pham

// ── DB ───────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'orders.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id          TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'new',
    customer_name  TEXT,
    customer_phone TEXT,
    customer_address TEXT,
    customer_type TEXT,
    items       TEXT,
    total       INTEGER,
    contact_method TEXT,
    note        TEXT
  )
`);

// ── Middleware ────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Telegram helper ───────────────────────────────────────
async function sendTelegram(text) {
  try {
    // Gửi cho tất cả chat IDs
    const promises = TELEGRAM_CHAT_IDS.map(chat_id =>
      fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chat_id,
          text,
          parse_mode: 'HTML'
        })
      })
    );
    await Promise.allSettled(promises);
  } catch (e) {
    console.error('Telegram error:', e.message);
  }
}

function formatMoney(n) {
  return Number(n).toLocaleString('vi-VN') + '₫';
}

function genOrderId() {
  const d = new Date();
  const date = d.toISOString().slice(0, 10).replace(/-/g, '');
  const count = db.prepare('SELECT COUNT(*) as c FROM orders WHERE id LIKE ?').get(`ORD-${date}-%`).c;
  const seq = String(count + 1).padStart(3, '0');
  return `ORD-${date}-${seq}`;
}

// ── Routes ────────────────────────────────────────────────

// POST /api/orders — tạo đơn mới
app.post('/api/orders', async (req, res) => {
  try {
    const { customer, items, total, contactMethod, note } = req.body;

    if (!customer?.name || !customer?.phone) {
      return res.status(400).json({ error: 'Thiếu thông tin khách hàng' });
    }

    const id = genOrderId();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO orders (id, created_at, updated_at, status, customer_name, customer_phone,
        customer_address, customer_type, items, total, contact_method, note)
      VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, now, now,
      customer.name, customer.phone,
      customer.address || '',
      customer.type || 'Cá nhân',
      JSON.stringify(items || []),
      total || 0,
      contactMethod || 'zalo',
      note || ''
    );

    // Notify Telegram
    const itemLines = (items || []).map(i =>
      `  • ${i.name} x${i.qty} — ${formatMoney(i.total)}`
    ).join('\n');

    const msg = `🛒 <b>ĐƠN HÀNG MỚI</b>\n\n` +
      `📋 Mã đơn: <code>${id}</code>\n` +
      `👤 Khách: <b>${customer.name}</b>\n` +
      `📞 SĐT: <b>${customer.phone}</b>\n` +
      `🏠 Địa chỉ: ${customer.address || '—'}\n` +
      `👥 Loại: ${customer.type || 'Cá nhân'}\n\n` +
      `📦 Sản phẩm:\n${itemLines}\n\n` +
      `💰 Tổng: <b>${formatMoney(total)}</b>\n` +
      `📝 Ghi chú: ${note || '—'}`;

    await sendTelegram(msg);

    res.json({ success: true, id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/orders — lấy danh sách đơn
app.get('/api/orders', (req, res) => {
  try {
    const { status, search } = req.query;
    let sql = 'SELECT * FROM orders WHERE 1=1';
    const params = [];

    if (status && status !== 'all') {
      sql += ' AND status = ?';
      params.push(status);
    }

    if (search) {
      sql += ' AND (customer_name LIKE ? OR customer_phone LIKE ? OR id LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }

    sql += ' ORDER BY created_at DESC';

    const rows = db.prepare(sql).all(...params);
    const orders = rows.map(r => ({
      id: r.id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      status: r.status,
      customer: {
        name: r.customer_name,
        phone: r.customer_phone,
        address: r.customer_address,
        type: r.customer_type
      },
      items: JSON.parse(r.items || '[]'),
      total: r.total,
      contactMethod: r.contact_method,
      note: r.note
    }));

    res.json(orders);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/orders/:id — cập nhật trạng thái
app.patch('/api/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowed = ['new', 'processing', 'done', 'cancelled'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
    }

    const now = new Date().toISOString();
    const result = db.prepare(
      'UPDATE orders SET status = ?, updated_at = ? WHERE id = ?'
    ).run(status, now, id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Không tìm thấy đơn' });
    }

    // Notify Telegram khi đơn hoàn thành
    const statusLabel = { new: 'Mới', processing: 'Đang xử lý', done: '✅ Hoàn thành', cancelled: '❌ Đã huỷ' };
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (order) {
      await sendTelegram(
        `🔄 <b>CẬP NHẬT ĐƠN HÀNG</b>\n\n` +
        `📋 Mã đơn: <code>${id}</code>\n` +
        `👤 Khách: ${order.customer_name}\n` +
        `📞 SĐT: ${order.customer_phone}\n` +
        `💰 Tổng: ${formatMoney(order.total)}\n` +
        `🏷 Trạng thái mới: <b>${statusLabel[status]}</b>`
      );
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Products Table ────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    category    TEXT NOT NULL,
    category_label TEXT NOT NULL,
    grp         TEXT,
    price       INTEGER NOT NULL,
    volume      TEXT,
    pack        TEXT,
    note        TEXT,
    rating      REAL DEFAULT 3,
    hidden      INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migration: thêm cột image / description / retail_price nếu chưa có (an toàn khi chạy lại)
{
  const existingCols = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
  if (!existingCols.includes('image')) {
    db.exec('ALTER TABLE products ADD COLUMN image TEXT');
  }
  if (!existingCols.includes('description')) {
    db.exec('ALTER TABLE products ADD COLUMN description TEXT');
  }
  if (!existingCols.includes('retail_price')) {
    db.exec('ALTER TABLE products ADD COLUMN retail_price INTEGER');
  }
}

// Seed products nếu bảng rỗng
const productCount = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
if (productCount === 0) {
  const PRODUCTS_SEED = [{"category":"mo","categoryLabel":"Rượu Mơ","group":"Rượu Mơ OYAMA","name":"Umeshu Oyama 500ml (12%)","volume":"500ml","pack":"12 chai/thùng","price":360000},{"category":"mo","categoryLabel":"Rượu Mơ","group":"Rượu Mơ OYAMA","name":"Umeshu Oyama 300ml (12%)","volume":"300ml","pack":"12 chai/thùng","price":260000},{"category":"mo","categoryLabel":"Rượu Mơ","group":"Rượu Mơ Nakano BC","name":"Nakano Umeshu 14% (mơ ly có trái)","volume":"160ml","pack":"20 chai/thùng","price":100000},{"category":"mo","categoryLabel":"Rượu Mơ","group":"Rượu Mơ Nakano BC","name":"Nakano Kishu 10% (vị truyền thống)","volume":"720ml","pack":"6 chai/thùng","price":383000},{"category":"mo","categoryLabel":"Rượu Mơ","group":"Rượu Mơ Nakano BC","name":"Nakano Miiri 14% (mơ trái)","volume":"720ml","pack":"6 chai/thùng","price":478000},{"category":"mo","categoryLabel":"Rượu Mơ","group":"Rượu Mơ Nakano BC","name":"Nakano Yuzu 12% (vị chanh Nhật)","volume":"720ml","pack":"6 chai/thùng","price":520000},{"category":"mo","categoryLabel":"Rượu Mơ","group":"Rượu Mơ Nakano BC","name":"Nakano Mitsu 12% (vị mật ong)","volume":"720ml","pack":"6 chai/thùng","price":520000},{"category":"mo","categoryLabel":"Rượu Mơ","group":"Rượu Mơ Nakano BC","name":"Nakano Green Tea 12% (vị trà xanh)","volume":"720ml","pack":"6 chai/thùng","price":520000},{"category":"sake","categoryLabel":"Sake Nhật","group":"Sake Nishinoseki","name":"Nishinoseki Hana 300ml (15%)","volume":"300ml","pack":"12 chai/thùng","price":221000},{"category":"sake","categoryLabel":"Sake Nhật","group":"Sake Nishinoseki","name":"Nishinoseki Hana 720ml (15%)","volume":"720ml","pack":"12 chai/thùng","price":441000},{"category":"sake","categoryLabel":"Sake Nhật","group":"Sake Nishinoseki","name":"Nishinoseki Hana 1800ml (15%)","volume":"1800ml","pack":"6 chai/thùng","price":924000},{"category":"sake","categoryLabel":"Sake Nhật","group":"Sake Nishinoseki","name":"Nishinoseki Nigori Zake 300ml (15%)","volume":"300ml","pack":"12 chai/thùng","price":273000},{"category":"sake","categoryLabel":"Sake Nhật","group":"Sake Nishinoseki","name":"Nishinoseki Nigori Zake 720ml (15%)","volume":"720ml","pack":"12 chai/thùng","price":462000},{"category":"sake","categoryLabel":"Sake Nhật","group":"Sake Nishinoseki","name":"Nishinoseki Hiya 300ml (17.4%)","volume":"300ml","pack":"12 chai/thùng","price":273000},{"category":"sake","categoryLabel":"Sake Nhật","group":"Sake Nishinoseki","name":"Nishinoseki Hiya 720ml (17.4%)","volume":"720ml","pack":"12 chai/thùng","price":578000},{"category":"sake","categoryLabel":"Sake Nhật","group":"Sake Nishinoseki","name":"Nishinoseki Junmaishu 300ml (15%)","volume":"300ml","pack":"12 chai/thùng","price":305000},{"category":"sake","categoryLabel":"Sake Nhật","group":"Sake Nishinoseki","name":"Nishinoseki Junmaishu 720ml (15%)","volume":"720ml","pack":"12 chai/thùng","price":557000},{"category":"sake","categoryLabel":"Sake Nhật","group":"Sake Nishinoseki","name":"Nishinoseki Junmaishu 1800ml (15%)","volume":"1800ml","pack":"6 chai/thùng","price":1344000},{"category":"sake","categoryLabel":"Sake Nhật","group":"Sake Nishinoseki","name":"Nishinoseki Kunisaki 720ml (15%)","volume":"720ml","pack":"12 chai/thùng","price":620000},{"category":"sake","categoryLabel":"Sake Nhật","group":"Sake Nishinoseki","name":"Nishinoseki Fuku 720ml (14%)","volume":"720ml","pack":"6 chai/thùng","price":788000},{"category":"sake","categoryLabel":"Sake Nhật","group":"Sake Nishinoseki","name":"Nishinoseki Gold Leaf 720ml (15%)","volume":"720ml","pack":"12 chai/thùng","price":830000},{"category":"sake","categoryLabel":"Sake Nhật","group":"Sake Nishinoseki","name":"Nishinoseki Gold Leaf 1800ml (15%)","volume":"1800ml","pack":"6 chai/thùng","price":1659000},{"category":"sake","categoryLabel":"Sake Nhật","group":"Sake Nishinoseki","name":"Nishinoseki HANA Barrel 1800ml (15%)","volume":"1800ml","pack":"6 hộp/thùng","price":2205000},{"category":"sake","categoryLabel":"Sake Nhật","group":"Daishichi (Cao cấp)","name":"Daishichi Junmai Kimoto 720ml (15%)","volume":"720ml","pack":"12 chai/thùng","price":768000,"note":"Junmai"},{"category":"sake","categoryLabel":"Sake Nhật","group":"Daishichi (Cao cấp)","name":"Daishichi Junmai Kimoto 1800ml (15%)","volume":"1800ml","pack":"6 chai/thùng","price":1368000,"note":"Junmai"},{"category":"sake","categoryLabel":"Sake Nhật","group":"Daishichi (Cao cấp)","name":"Daishichi Masakura 300ml (15%)","volume":"300ml","pack":"12 chai/thùng","price":668000,"note":"Junmai Ginjo"},{"category":"sake","categoryLabel":"Sake Nhật","group":"Daishichi (Cao cấp)","name":"Daishichi Masakura 720ml (15%)","volume":"720ml","pack":"12 chai/thùng","price":1668000,"note":"Junmai Ginjo"},{"category":"sake","categoryLabel":"Sake Nhật","group":"Daishichi (Cao cấp)","name":"Daishichi Kaiden 1800ml (15%)","volume":"1800ml","pack":"4 chai/thùng","price":2868000,"note":"Junmai Ginjo"},{"category":"sake","categoryLabel":"Sake Nhật","group":"Daishichi (Cao cấp)","name":"Daishichi Minowamon 300ml (15%)","volume":"300ml","pack":"12 chai/thùng","price":768000,"note":"Junmai Daiginjo"},{"category":"sake","categoryLabel":"Sake Nhật","group":"Daishichi (Cao cấp)","name":"Daishichi Minowamon 720ml (15%)","volume":"720ml","pack":"6 chai/thùng","price":1968000,"note":"Junmai Daiginjo"},{"category":"sake","categoryLabel":"Sake Nhật","group":"Daishichi (Cao cấp)","name":"Daishichi Minowamon 1800ml (15%)","volume":"1800ml","pack":"4 chai/thùng","price":4568000,"note":"Junmai Daiginjo"},{"category":"sake","categoryLabel":"Sake Nhật","group":"Daishichi (Cao cấp)","name":"Daishichi Shoka 720ml (16%)","volume":"720ml","pack":"6 chai/thùng","price":2768000,"note":"Junmai Daiginjo"},{"category":"sake","categoryLabel":"Sake Nhật","group":"Daishichi (Cao cấp)","name":"Daishichi Shoka 1800ml (16%)","volume":"1800ml","pack":"4 chai/thùng","price":5568000,"note":"Junmai Daiginjo"},{"category":"sake","categoryLabel":"Sake Nhật","group":"Daishichi (Cao cấp)","name":"Horeki Daishichi 720ml (16%)","volume":"720ml","pack":"4 chai/thùng","price":4868000,"note":"Junmai Daiginjo"},{"category":"sake","categoryLabel":"Sake Nhật","group":"Daishichi (Cao cấp)","name":"Daishichi Myoka Rangyoku 720ml (16%)","volume":"720ml","pack":"4 chai/thùng","price":9868000,"note":"Junmai Daiginjo"},{"category":"sake","categoryLabel":"Sake Nhật","group":"Daishichi (Cao cấp)","name":"Daishichi Myoka Rangyoku Omega 720ml (16%)","volume":"720ml","pack":"4 chai/thùng","price":25000000,"note":"Junmai Daiginjo"},{"category":"sparkling","categoryLabel":"Sparkling","group":"Sparkling Không Cồn (Tây Ban Nha)","name":"Sparkling Rose Esencia 750ml","volume":"750ml","pack":"6 chai/thùng","price":171000},{"category":"sparkling","categoryLabel":"Sparkling","group":"Sparkling Không Cồn (Tây Ban Nha)","name":"Sparkling White Esencia 750ml","volume":"750ml","pack":"6 chai/thùng","price":171000},{"category":"sparkling","categoryLabel":"Sparkling","group":"Sparkling Không Cồn (Tây Ban Nha)","name":"Sparkling Ladoma Rose 750ml","volume":"750ml","pack":"6 chai/thùng","price":171000},{"category":"sparkling","categoryLabel":"Sparkling","group":"Sparkling Không Cồn (Tây Ban Nha)","name":"Sparkling Ladoma White 750ml","volume":"750ml","pack":"6 chai/thùng","price":171000},{"category":"sparkling","categoryLabel":"Sparkling","group":"Fogoso & Lamboom (Tây Ban Nha)","name":"FOGOSO ORO 750ml (5.5%)","volume":"750ml","pack":"6 chai/thùng","price":370000},{"category":"sparkling","categoryLabel":"Sparkling","group":"Fogoso & Lamboom (Tây Ban Nha)","name":"FOGOSO BRONCE 750ml (5.5%)","volume":"750ml","pack":"6 chai/thùng","price":370000},{"category":"sparkling","categoryLabel":"Sparkling","group":"Fogoso & Lamboom (Tây Ban Nha)","name":"FOGOSO PLATA 750ml (5.5%)","volume":"750ml","pack":"6 chai/thùng","price":370000},{"category":"sparkling","categoryLabel":"Sparkling","group":"Fogoso & Lamboom (Tây Ban Nha)","name":"FOGOSO ROSA 750ml (5.5%)","volume":"750ml","pack":"6 chai/thùng","price":370000},{"category":"sparkling","categoryLabel":"Sparkling","group":"Fogoso & Lamboom (Tây Ban Nha)","name":"FOGOSO AZUL 750ml (5.5%)","volume":"750ml","pack":"6 chai/thùng","price":370000},{"category":"sparkling","categoryLabel":"Sparkling","group":"Fogoso & Lamboom (Tây Ban Nha)","name":"FOGOSO ORO 1.5L (5.5%)","volume":"1.5L","pack":"4 chai/thùng","price":700000},{"category":"sparkling","categoryLabel":"Sparkling","group":"Fogoso & Lamboom (Tây Ban Nha)","name":"FOGOSO BRONCE 1.5L (5.5%)","volume":"1.5L","pack":"4 chai/thùng","price":700000},{"category":"sparkling","categoryLabel":"Sparkling","group":"Fogoso & Lamboom (Tây Ban Nha)","name":"LAMBOOM ROSE 750ml (11%)","volume":"750ml","pack":"6 chai/thùng","price":230000},{"category":"sparkling","categoryLabel":"Sparkling","group":"Fogoso & Lamboom (Tây Ban Nha)","name":"LAMBOOM WHITE 750ml (11%)","volume":"750ml","pack":"6 chai/thùng","price":230000},{"category":"sangria","categoryLabel":"Sangria","group":"Sangria Tây Ban Nha","name":"White Sangria 250ml (6.5%)","volume":"250ml","pack":"24 lon/thùng","price":75000},{"category":"sangria","categoryLabel":"Sangria","group":"Sangria Tây Ban Nha","name":"White Sangria 750ml (6.5%)","volume":"750ml","pack":"6 chai/thùng","price":270000},{"category":"sangria","categoryLabel":"Sangria","group":"Sangria Tây Ban Nha","name":"Red Sangria 250ml (6.5%)","volume":"250ml","pack":"24 lon/thùng","price":75000},{"category":"sangria","categoryLabel":"Sangria","group":"Sangria Tây Ban Nha","name":"Red Sangria 750ml (6.5%)","volume":"750ml","pack":"6 chai/thùng","price":270000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Tây Ban Nha","name":"LA DOMA Tempranillo 750ml (13%)","volume":"750ml","pack":"6 chai/thùng","price":241000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Pháp","name":"Citran Bordeaux Limited Edition 750ml","volume":"750ml","pack":"6 chai/thùng","price":795000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Úc — River Retreat","name":"River Retreat Merlot 750ml (13.5%)","volume":"750ml","pack":"12 chai/thùng","price":273000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Úc — River Retreat","name":"River Retreat Shiraz 750ml (14%)","volume":"750ml","pack":"12 chai/thùng","price":273000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Úc — River Retreat","name":"River Retreat Cabernet Sauvignon 750ml (14%)","volume":"750ml","pack":"12 chai/thùng","price":273000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Úc — River Retreat","name":"River Retreat Sauvignon Blanc 750ml (11.5%)","volume":"750ml","pack":"12 chai/thùng","price":273000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Úc — River Retreat","name":"River Retreat Chardonnay 750ml (13%)","volume":"750ml","pack":"12 chai/thùng","price":273000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Úc — Estate","name":"Estate Shiraz 750ml (14.5%)","volume":"750ml","pack":"12 chai/thùng","price":425000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Úc — Estate","name":"Estate Merlot 750ml (13.5%)","volume":"750ml","pack":"12 chai/thùng","price":425000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Úc — Estate","name":"Estate Chardonnay 750ml (13.5%)","volume":"750ml","pack":"12 chai/thùng","price":425000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Úc — Estate","name":"Estate Sauvignon Blanc 750ml (12%)","volume":"750ml","pack":"12 chai/thùng","price":425000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Chile — Aromo","name":"Aromo Winemakers Cab. Sauvignon & Syrah 750ml (14%)","volume":"750ml","pack":"6 chai/thùng","price":590000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Chile — Aromo","name":"Aromo Winemakers Marselan & Carmenere 750ml (13.5%)","volume":"750ml","pack":"6 chai/thùng","price":590000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Chile — Aromo","name":"Aromo Sauvignon Blanc 750ml (13%)","volume":"750ml","pack":"12 chai/thùng","price":330000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Chile — Dogma","name":"Dogma Gran Reserva Cab. Sauvignon & Syrah 750ml (14%)","volume":"750ml","pack":"6 chai/thùng","price":580000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Chile — Dogma","name":"Dogma Marselan & Carmenere 750ml (14%)","volume":"750ml","pack":"6 chai/thùng","price":580000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Chile — Dogma","name":"Dogma Gran Reserva Tempranillo & Cab. Sauvignon 750ml (14%)","volume":"750ml","pack":"6 chai/thùng","price":580000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Chile — Dogma","name":"Dogma Reserva Cab. Sauvignon 750ml (13.5%)","volume":"750ml","pack":"12 chai/thùng","price":390000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Chile — Dogma","name":"Dogma Cabernet Sauvignon 750ml (13.5%)","volume":"750ml","pack":"6 chai/thùng","price":314000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Chile — Dogma","name":"Dogma Merlot (13%/Vol)","volume":"750ml","pack":"6 chai/thùng","price":580000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Chile — Dogma","name":"Dogma Chardonnay (12.5%/Vol)","volume":"750ml","pack":"6 chai/thùng","price":580000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Chile — Dogma","name":"Dogma Rose Syrah (12.5%/Vol)","volume":"750ml","pack":"6 chai/thùng","price":580000},{"category":"vang","categoryLabel":"Rượu Vang","group":"Rượu Vang Chile — Dogma","name":"Dogma Reservado Cabernet Sauvignon (13%/Vol)","volume":"750ml","pack":"6 chai/thùng","price":390000},{"category":"ham-deraza","categoryLabel":"Ham Deraza","group":"Ham Deraza — CEBO (ủ muối 24 tháng)","name":"Deraza Iberico Cebo Jamon bonein","volume":"8-10kg","pack":"Kg","price":1585000},{"category":"ham-deraza","categoryLabel":"Ham Deraza","group":"Ham Deraza — CEBO (ủ muối 24 tháng)","name":"Deraza Iberico Cebo Jamon boneless","volume":"4-6kg","pack":"Kg","price":2404000},{"category":"ham-deraza","categoryLabel":"Ham Deraza","group":"Ham Deraza — CEBO (ủ muối 24 tháng)","name":"Deraza Iberico Cebo Paleta bonein","volume":"4-6kg","pack":"Kg","price":1259000},{"category":"ham-deraza","categoryLabel":"Ham Deraza","group":"Ham Deraza — CEBO (ủ muối 24 tháng)","name":"Thịt lưng Iberico Cebo muối nguyên cây DeRaza","volume":"0.6-1kg","pack":"Kg","price":1881000},{"category":"ham-deraza","categoryLabel":"Ham Deraza","group":"Ham Deraza — BELLOTA (ủ muối 36-48 tháng)","name":"Deraza Shoulder Bellota pure Iberico 100%","volume":"4-6kg","pack":"Kg","price":2205000},{"category":"ham-deraza","categoryLabel":"Ham Deraza","group":"Ham Deraza — BELLOTA (ủ muối 36-48 tháng)","name":"Deraza Iberico Bellota Jamon bonein","volume":"7.5-10kg","pack":"Kg","price":2800000},{"category":"ham-deraza","categoryLabel":"Ham Deraza","group":"Ham Deraza — BELLOTA (ủ muối 36-48 tháng)","name":"Deraza Iberico Bellota Jamon boneless","volume":"4-6kg","pack":"Kg","price":4671000},{"category":"ham-deraza","categoryLabel":"Ham Deraza","group":"Ham Deraza — BELLOTA (ủ muối 36-48 tháng)","name":"Deraza Iberico Bellota Paleta bonein","volume":"4-6kg","pack":"Kg","price":2000000},{"category":"ham-montesano","categoryLabel":"Ham Montesano","group":"Montesano — BELLOTA (ủ muối 36-48 tháng)","name":"Montesano Iberico Bellota Jamon boneless pure 100%","volume":"3.5-5.5kg","pack":"Kg","price":6422000},{"category":"ham-montesano","categoryLabel":"Ham Montesano","group":"Montesano — BELLOTA (ủ muối 36-48 tháng)","name":"Montesano Jamon Bellota pure Iberico 100%","volume":"7-9kg","pack":"Kg","price":3570000},{"category":"ham-montesano","categoryLabel":"Ham Montesano","group":"Montesano — BELLOTA (ủ muối 36-48 tháng)","name":"Montesano Iberico Bellota Paleta bonein","volume":"4-6kg","pack":"Kg","price":2106000},{"category":"ham-montesano","categoryLabel":"Ham Montesano","group":"Montesano — CEBO (ủ muối 24 tháng)","name":"Montesano Iberico Cebo Jamon bonein","volume":"7-9kg","pack":"Kg","price":1727000},{"category":"ham-montesano","categoryLabel":"Ham Montesano","group":"Montesano — CEBO (ủ muối 24 tháng)","name":"Montesano Iberico CEBO Jamon","volume":"2.5-3.5kg","pack":"Kg","price":2892000},{"category":"ham-montesano","categoryLabel":"Ham Montesano","group":"Montesano — CEBO (ủ muối 24 tháng)","name":"Monte Roble Iberico Cebo Paleta bonein","volume":"4-6kg","pack":"Kg","price":1392000},{"category":"ham-montesano","categoryLabel":"Ham Montesano","group":"Montesano — SERRANO (ủ muối 15 tháng)","name":"Montesano Serrano Jamon bonein","volume":"7.5-8.8kg","pack":"Kg","price":880000},{"category":"ham-montesano","categoryLabel":"Ham Montesano","group":"Montesano — SERRANO (ủ muối 15 tháng)","name":"Monte Roble Jamon Serrano Gran Reserva","volume":"3-4kg","pack":"Kg","price":1537000},{"category":"iberico-1kg","categoryLabel":"Iberico 1KG","group":"Đùi 1KG Không Xương — Có hộp","name":"IBERICO BELLOTA 100% SAU KHÔNG XƯƠNG 1KG 48 tháng","volume":"1kg","pack":"Hộp","price":7700000},{"category":"iberico-1kg","categoryLabel":"Iberico 1KG","group":"Đùi 1KG Không Xương — Có hộp","name":"IBERICO BELLOTA SAU KHÔNG XƯƠNG 1KG 36 tháng","volume":"1kg","pack":"Hộp","price":5281000},{"category":"iberico-1kg","categoryLabel":"Iberico 1KG","group":"Đùi 1KG Không Xương — Có hộp","name":"IBERICO CEBO SAU KHÔNG XƯƠNG 1KG 24 tháng","volume":"1kg","pack":"Hộp","price":2838000},{"category":"iberico-1kg","categoryLabel":"Iberico 1KG","group":"Đùi 1KG Không Xương — Có hộp","name":"SERRANO SAU KHÔNG XƯƠNG 1KG 16 tháng","volume":"1kg","pack":"Hộp","price":1847000},{"category":"iberico-1kg","categoryLabel":"Iberico 1KG","group":"Đùi 1KG Không Xương — Có hộp","name":"ĐÙI HEO MUỐI MINI GRAND RESERVA VỚI NẤM TRUFFLE","volume":"1kg","pack":"Hộp","price":2380000},{"category":"iberico-1kg","categoryLabel":"Iberico 1KG","group":"Đùi 1KG Không Xương — Không hộp","name":"IBERICO BELLOTA SAU KHÔNG XƯƠNG 1KG không hộp 36 tháng","volume":"1kg","pack":"Kg","price":4472000},{"category":"iberico-1kg","categoryLabel":"Iberico 1KG","group":"Đùi 1KG Không Xương — Không hộp","name":"IBERICO CEBO SAU KHÔNG XƯƠNG 1KG không hộp 24 tháng","volume":"1kg","pack":"Kg","price":4919000},{"category":"iberico-1kg","categoryLabel":"Iberico 1KG","group":"Đùi 1KG Không Xương — Không hộp","name":"SERRANO SAU KHÔNG XƯƠNG 1KG không hộp 16 tháng","volume":"1kg","pack":"Kg","price":2530000},{"category":"iberico-1kg","categoryLabel":"Iberico 1KG","group":"Đùi 1KG Không Xương — Không hộp","name":"IBERICO CEBO SAU KHÔNG XƯƠNG 500G không hộp","volume":"500g","pack":"Kg","price":1270000},{"category":"iberico-1kg","categoryLabel":"Iberico 1KG","group":"Đùi 1KG Không Xương — Không hộp","name":"SERRANO SAU KHÔNG XƯƠNG 500G không hộp","volume":"500g","pack":"Kg","price":820000},{"category":"slice-xucxich","categoryLabel":"Cắt lát & Xúc xích","group":"Cắt lát Montesano","name":"Thịt lợn ướp muối đùi sau cắt lát bằng tay Iberico Bellota","volume":"100g/gói","pack":"20 gói/thùng","price":1080000},{"category":"slice-xucxich","categoryLabel":"Cắt lát & Xúc xích","group":"Cắt lát Montesano","name":"Bellota hand sliced","volume":"100g/gói","pack":"20 gói/thùng","price":936000},{"category":"slice-xucxich","categoryLabel":"Cắt lát & Xúc xích","group":"Cắt lát Montesano","name":"CEBO hand sliced","volume":"100g/gói","pack":"20 gói/thùng","price":653000},{"category":"slice-xucxich","categoryLabel":"Cắt lát & Xúc xích","group":"Xúc xích Montesano nguyên cây","name":"Montesano Iberico Lomo Bellota 100%","volume":"450-550g","pack":"12 cây/thùng","price":3428000},{"category":"slice-xucxich","categoryLabel":"Cắt lát & Xúc xích","group":"Xúc xích Montesano nguyên cây","name":"LOIN LOMO Iberian CEBO","volume":"600-800g","pack":"6 cây/thùng","price":2592000},{"category":"slice-xucxich","categoryLabel":"Cắt lát & Xúc xích","group":"Xúc xích Montesano nguyên cây","name":"Montesano Iberico Lomito Bellota","volume":"340-400g","pack":"6 cây/thùng","price":4610000},{"category":"slice-xucxich","categoryLabel":"Cắt lát & Xúc xích","group":"Xúc xích Montesano nguyên cây","name":"Chorizo Iberian Cular CEBO","volume":"520-650g","pack":"12 cây/thùng","price":1395000},{"category":"slice-xucxich","categoryLabel":"Cắt lát & Xúc xích","group":"Xúc xích Montesano nguyên cây","name":"Chorizo Iberian Vela CEBO","volume":"275g/cây","pack":"20 cây/thùng","price":390000},{"category":"slice-xucxich","categoryLabel":"Cắt lát & Xúc xích","group":"Xúc xích Montesano nguyên cây","name":"Salchichon Iberian Vela CEBO","volume":"275g/cây","pack":"20 cây/thùng","price":390000},{"category":"slice-xucxich","categoryLabel":"Cắt lát & Xúc xích","group":"Xúc xích Montesano cắt lát","name":"Chorizo Iberian CEBO cắt lát","volume":"100g/gói","pack":"30 gói/thùng","price":216000},{"category":"slice-xucxich","categoryLabel":"Cắt lát & Xúc xích","group":"Xúc xích Montesano cắt lát","name":"Salchichon Iberian CEBO cắt lát","volume":"100g/gói","pack":"30 gói/thùng","price":216000},{"category":"slice-xucxich","categoryLabel":"Cắt lát & Xúc xích","group":"Xúc xích Montesano cắt lát","name":"Ham sliced Gran Reserva","volume":"120g/gói","pack":"40 gói/thùng","price":278000},{"category":"slice-xucxich","categoryLabel":"Cắt lát & Xúc xích","group":"Xúc xích Montesano cắt lát","name":"Ham sliced Reserva","volume":"100g/gói","pack":"30 gói/thùng","price":216000},{"category":"ham-sliced","categoryLabel":"Ham Sliced VN","group":"Ham Sliced — Bellota (ủ muối 36 tháng)","name":"Bellota ham sliced 100g","volume":"100g","pack":"Gói","price":563000},{"category":"ham-sliced","categoryLabel":"Ham Sliced VN","group":"Ham Sliced — Bellota (ủ muối 36 tháng)","name":"Bellota ham sliced 50g","volume":"50g","pack":"Gói","price":310000},{"category":"ham-sliced","categoryLabel":"Ham Sliced VN","group":"Ham Sliced — Cebo (ủ muối 24 tháng)","name":"Cebo ham sliced 100g","volume":"100g","pack":"Gói","price":336000},{"category":"ham-sliced","categoryLabel":"Ham Sliced VN","group":"Ham Sliced — Cebo (ủ muối 24 tháng)","name":"Cebo ham sliced 50g","volume":"50g","pack":"Gói","price":169000},{"category":"ham-sliced","categoryLabel":"Ham Sliced VN","group":"Ham Sliced — Cebo (ủ muối 24 tháng)","name":"Cebo ham sliced 30g","volume":"30g","pack":"Gói","price":89000},{"category":"ham-sliced","categoryLabel":"Ham Sliced VN","group":"Ham Sliced — Serrano (ủ muối 16 tháng)","name":"Serrano ham sliced 100g","volume":"100g","pack":"Gói","price":184000},{"category":"ham-sliced","categoryLabel":"Ham Sliced VN","group":"Ham Sliced — Serrano (ủ muối 16 tháng)","name":"Serrano ham sliced 50g","volume":"50g","pack":"Gói","price":101000},{"category":"ham-sliced","categoryLabel":"Ham Sliced VN","group":"Ham Sliced — Serrano (ủ muối 16 tháng)","name":"Serrano Gran ham Sliced 30g","volume":"30g","pack":"Gói","price":57000},{"category":"ham-sliced","categoryLabel":"Ham Sliced VN","group":"Ham Sliced — Duroc & Truffle","name":"Thịt lợn ướp muối Grand Reserva hương nấm Truffle 100g","volume":"100g","pack":"Gói","price":295000},{"category":"ham-sliced","categoryLabel":"Ham Sliced VN","group":"Ham Sliced — Duroc & Truffle","name":"Thịt lợn ướp muối Grand Reserva hương nấm Truffle 50g","volume":"50g","pack":"Gói","price":155000},{"category":"ham-sliced","categoryLabel":"Ham Sliced VN","group":"Ham Sliced — Xúc xích Sliced","name":"Lomo ham sliced 50g","volume":"50g","pack":"Gói","price":182000},{"category":"ham-sliced","categoryLabel":"Ham Sliced VN","group":"Ham Sliced — Xúc xích Sliced","name":"Chorizo ham sliced 50g","volume":"50g","pack":"Gói","price":111000},{"category":"ham-sliced","categoryLabel":"Ham Sliced VN","group":"Ham Sliced — Xúc xích Sliced","name":"Salchichon ham silced 50g","volume":"50g","pack":"Gói","price":111000},{"category":"ham-sliced","categoryLabel":"Ham Sliced VN","group":"Ham Sliced — Xúc xích Sliced","name":"Chorizo ham silced 30g","volume":"30g","pack":"Gói","price":70000},{"category":"ham-sliced","categoryLabel":"Ham Sliced VN","group":"Ham Sliced — Xúc xích Sliced","name":"Salchichon ham silced 30g","volume":"30g","pack":"Gói","price":70000},{"category":"xuc-xich","categoryLabel":"Xúc xích nhỏ","group":"Xúc xích Fuet & Chorizo (55g)","name":"Xúc xích Fuet vị nấm Truffle 55 gram","volume":"55g","pack":"18 gói/thùng","price":110000},{"category":"xuc-xich","categoryLabel":"Xúc xích nhỏ","group":"Xúc xích Fuet & Chorizo (55g)","name":"Xúc xích Fuet 55 gram (1)","volume":"55g","pack":"18 gói/thùng","price":85000},{"category":"xuc-xich","categoryLabel":"Xúc xích nhỏ","group":"Xúc xích Fuet & Chorizo (55g)","name":"Xúc xích Chorizo 55 gram (1)","volume":"55g","pack":"18 gói/thùng","price":85000},{"category":"xuc-xich","categoryLabel":"Xúc xích nhỏ","group":"Xúc xích Fuet & Chorizo (55g)","name":"Xúc xích Fuet 55 gram (2)","volume":"55g","pack":"18 gói/thùng","price":85000},{"category":"xuc-xich","categoryLabel":"Xúc xích nhỏ","group":"Xúc xích Fuet & Chorizo (55g)","name":"Xúc xích Chorizo 55 gram (2)","volume":"55g","pack":"18 gói/thùng","price":85000},{"category":"phomai","categoryLabel":"Phô Mai","group":"Phô Mai Cừu Trufado (nấm Truffle)","name":"Phô mai cừu dạng kem nấm Trufado 125 gram","volume":"125g/hũ","pack":"8 hũ/thùng","price":109000},{"category":"phomai","categoryLabel":"Phô Mai","group":"Phô Mai Cừu Trufado (nấm Truffle)","name":"Phô mai cừu nấm Trufado đen 150 gram","volume":"150g/gói","pack":"24 gói/thùng","price":225000},{"category":"phomai","categoryLabel":"Phô Mai","group":"Phô Mai Cừu Trufado (nấm Truffle)","name":"Phô mai cừu nấm Trufado đen 200 gram","volume":"200g/gói","pack":"16 gói/thùng","price":270000},{"category":"phomai","categoryLabel":"Phô Mai","group":"Phô Mai Cừu Trufado (nấm Truffle)","name":"Phô mai cừu nấm Trufado đen 3000 gram","volume":"3-3.5kg","pack":"2 khối/thùng","price":1188000},{"category":"phomai","categoryLabel":"Phô Mai","group":"Phô Mai Cừu Mật Ong","name":"Phô mai cừu dạng kem mật ong lá kinh giới 125 gram","volume":"125g/hũ","pack":"8 hũ/thùng","price":99000},{"category":"phomai","categoryLabel":"Phô Mai","group":"Phô Mai Cừu Mật Ong","name":"Phô mai cừu mật ong lá kinh giới 200 gram","volume":"200g/gói","pack":"16 gói/thùng","price":259000},{"category":"phomai","categoryLabel":"Phô Mai","group":"Phô Mai Cừu Mật Ong","name":"Phô mai cừu mật ong lá kinh giới 1500 gram","volume":"1.5-2kg","pack":"2 khối/thùng","price":1100000},{"category":"phomai","categoryLabel":"Phô Mai","group":"Phô Mai Cừu Xông Khói","name":"Phô mai cừu dạng kem xông khói 125 gram","volume":"125g/hũ","pack":"8 hũ/thùng","price":99000},{"category":"phomai","categoryLabel":"Phô Mai","group":"Phô Mai Cừu Xông Khói","name":"Phô mai cừu xông khói 3000 gram","volume":"3-3.5kg","pack":"2 khối/thùng","price":1032000},{"category":"phomai","categoryLabel":"Phô Mai","group":"Phô Mai Dê","name":"Phô mai dê rượu vang đỏ 350 gram","volume":"350g/gói","pack":"12 gói/thùng","price":385000},{"category":"pate","categoryLabel":"Pate","group":"Pate COREN Iberico","name":"Pate Iberico Green Pepper 2x78g","volume":"156g","pack":"22 hộp/thùng","price":145000},{"category":"pate","categoryLabel":"Pate","group":"Pate COREN Iberico","name":"Pate Iberico Nấm Truffle 2x78g","volume":"156g","pack":"22 hộp/thùng","price":145000},{"category":"pate","categoryLabel":"Pate","group":"Pate COREN Iberico","name":"Pate Iberico 2x78g","volume":"156g","pack":"22 hộp/thùng","price":145000},{"category":"pate","categoryLabel":"Pate","group":"Pate COREN Iberico","name":"Magro Iberico Luncheon Meat 200g","volume":"200g","pack":"24 hộp/thùng","price":173000},{"category":"oliu","categoryLabel":"Oliu","group":"Oliu Frutto D'Italia — Lọ thủy tinh 170g","name":"Oliu xanh có hạt Green Cerignola 170g","volume":"290g/170g","pack":"6 hũ/pack","price":109000},{"category":"oliu","categoryLabel":"Oliu","group":"Oliu Frutto D'Italia — Lọ thủy tinh 170g","name":"Oliu xanh có hạt Green Castelvetrano 170g","volume":"290g/170g","pack":"6 hũ/pack","price":102000},{"category":"oliu","categoryLabel":"Oliu","group":"Oliu Frutto D'Italia — Lọ thủy tinh 170g","name":"Oliu đen có hạt Black Leccino 170g","volume":"290g/170g","pack":"6 hũ/pack","price":102000},{"category":"oliu","categoryLabel":"Oliu","group":"Oliu Frutto D'Italia — Doypack 30g","name":"Oliu xanh tách hạt Castelvetrano 30g","volume":"30g","pack":"20 túi/hộp","price":30000},{"category":"oliu","categoryLabel":"Oliu","group":"Oliu Frutto D'Italia — Doypack 30g","name":"Oliu hỗn hợp tách hạt Italian Olive Mix 30g","volume":"30g","pack":"20 túi/hộp","price":30000},{"category":"oliu","categoryLabel":"Oliu","group":"Oliu Frutto D'Italia — Doypack 30g","name":"Oliu xanh tách hạt có gia vị Castelvetrano 30g","volume":"30g","pack":"20 túi/hộp","price":30000}];

  const insertProduct = db.prepare(`
    INSERT OR IGNORE INTO products (name, category, category_label, grp, price, volume, pack, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((products) => {
    for (const p of products) {
      insertProduct.run(
        p.name, p.category, p.categoryLabel, p.group || '',
        p.price, p.volume || '', p.pack || '', p.note || ''
      );
    }
  });

  insertMany(PRODUCTS_SEED);
  console.log(`✅ Seeded ${PRODUCTS_SEED.length} products`);
}

// ── Product Routes ────────────────────────────────────────

function rowToProduct(r) {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    categoryLabel: r.category_label,
    group: r.grp,
    price: r.price,
    retailPrice: r.retail_price,
    volume: r.volume,
    pack: r.pack,
    note: r.note,
    rating: r.rating,
    hidden: !!r.hidden,
    image: r.image,
    description: r.description,
    createdAt: r.created_at
  };
}

// Rating: 0 -> 5, mỗi nấc 0.5
function validateRating(rating) {
  if (rating === undefined || rating === null || rating === '') return { ok: true, value: 3 };
  const n = Number(rating);
  if (Number.isNaN(n) || n < 0 || n > 5) {
    return { ok: false, error: 'Rating phải từ 0 đến 5' };
  }
  // cho phép sai số float nhỏ
  const doubled = Math.round(n * 2);
  if (Math.abs(doubled - n * 2) > 1e-6) {
    return { ok: false, error: 'Rating chỉ được đi theo nấc 0.5 (0, 0.5, 1, ..., 5)' };
  }
  return { ok: true, value: doubled / 2 };
}

// POST /api/upload — upload ảnh sản phẩm, trả về URL để lưu vào field image
app.post('/api/upload', (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Không có file ảnh' });
    res.json({ url: `/uploads/products/${req.file.filename}` });
  });
});

// GET /api/products — lấy danh sách sản phẩm
app.get('/api/products', (req, res) => {
  try {
    const { category, hidden, minRating } = req.query;
    let sql = 'SELECT * FROM products WHERE 1=1';
    const params = [];

    // Admin có thể xem hidden; mặc định chỉ trả sản phẩm visible
    if (hidden !== 'all') {
      sql += ' AND hidden = 0';
    }

    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }

    if (minRating) {
      sql += ' AND rating >= ?';
      params.push(parseFloat(minRating));
    }

    sql += ' ORDER BY category, grp, id';

    const rows = db.prepare(sql).all(...params);
    res.json(rows.map(rowToProduct));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/products — thêm sản phẩm mới
app.post('/api/products', (req, res) => {
  try {
    const { name, category, categoryLabel, group, price, retailPrice, volume, pack, note, rating, image, description } = req.body;

    if (!name || !category || !price) {
      return res.status(400).json({ error: 'Thiếu name, category hoặc price' });
    }

    const ratingCheck = validateRating(rating);
    if (!ratingCheck.ok) return res.status(400).json({ error: ratingCheck.error });

    const result = db.prepare(`
      INSERT INTO products (name, category, category_label, grp, price, retail_price, volume, pack, note, rating, image, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name, category, categoryLabel || category,
      group || '', price, retailPrice || null, volume || '', pack || '', note || '',
      ratingCheck.value, image || null, description || null
    );

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Tên sản phẩm đã tồn tại' });
    }
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/products/:id — cập nhật sản phẩm
app.patch('/api/products/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, category, categoryLabel, group, price, retailPrice, volume, pack, note, rating, hidden, image, description } = req.body;

    if (rating !== undefined) {
      const ratingCheck = validateRating(rating);
      if (!ratingCheck.ok) return res.status(400).json({ error: ratingCheck.error });
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!product) return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });

    const updates = [];
    const vals = [];

    if (name !== undefined) { updates.push('name = ?'); vals.push(name); }
    if (category !== undefined) { updates.push('category = ?'); vals.push(category); }
    if (categoryLabel !== undefined) { updates.push('category_label = ?'); vals.push(categoryLabel); }
    if (group !== undefined) { updates.push('grp = ?'); vals.push(group); }
    if (price !== undefined) { updates.push('price = ?'); vals.push(price); }
    if (retailPrice !== undefined) { updates.push('retail_price = ?'); vals.push(retailPrice || null); }
    if (volume !== undefined) { updates.push('volume = ?'); vals.push(volume); }
    if (pack !== undefined) { updates.push('pack = ?'); vals.push(pack); }
    if (note !== undefined) { updates.push('note = ?'); vals.push(note); }
    if (rating !== undefined) { updates.push('rating = ?'); vals.push(validateRating(rating).value); }
    if (hidden !== undefined) { updates.push('hidden = ?'); vals.push(hidden ? 1 : 0); }
    if (image !== undefined) { updates.push('image = ?'); vals.push(image || null); }
    if (description !== undefined) { updates.push('description = ?'); vals.push(description || null); }

    if (updates.length === 0) return res.status(400).json({ error: 'Không có gì để cập nhật' });

    vals.push(id);
    db.prepare(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`).run(...vals);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/products/:id — xoá sản phẩm (chỉ khi không có đơn hàng)
app.delete('/api/products/:id', (req, res) => {
  try {
    const { id } = req.params;
    const product = db.prepare('SELECT name FROM products WHERE id = ?').get(id);
    if (!product) return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });

    // Kiểm tra có đơn hàng nào chứa sản phẩm này không
    const hasOrders = db.prepare(
      "SELECT COUNT(*) as c FROM orders WHERE items LIKE ?"
    ).get(`%${product.name.replace(/'/g, "''")}%`).c;

    if (hasOrders > 0) {
      return res.status(400).json({
        error: 'Sản phẩm đã có đơn hàng, không thể xoá. Hãy ẩn sản phẩm thay vì xoá.',
        hasOrders: true
      });
    }

    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Devi Orders API running on port ${PORT}`);
});
