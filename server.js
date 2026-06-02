const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = 3003;

// ── Config ────────────────────────────────────────────────
const TELEGRAM_TOKEN = '8967147178:AAE9OkD_eG7haz7L1Fhr3KkT-kyk-IjaGqg';
const TELEGRAM_CHAT_ID = '5754177904';

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

// ── Telegram helper ───────────────────────────────────────
async function sendTelegram(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML'
      })
    });
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

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Devi Orders API running on port ${PORT}`);
});
