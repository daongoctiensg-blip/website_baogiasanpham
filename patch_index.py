#!/usr/bin/env python3
"""
Patch index.html:
1. Thay ORDER_submitOrder → gọi POST /api/orders
2. Thay adminRender → gọi GET /api/orders
3. Thay adminUpdateStatus → gọi PATCH /api/orders/:id
4. Thêm bell notification + poll 30s
"""

import re, sys

INPUT  = '/var/www/tiedohouse.com/baogiasanpham/index.html'
OUTPUT = '/var/www/tiedohouse.com/baogiasanpham/index.html'

with open(INPUT, 'r', encoding='utf-8') as f:
    html = f.read()

# ─────────────────────────────────────────────────────────────
# 1. Thay toàn bộ block _origSubmit / ORDER_submitOrder
# ─────────────────────────────────────────────────────────────
OLD_SUBMIT = r'// ── Wrap ORDER_submitOrder to save order.*?}\s*};'

NEW_SUBMIT = r"""// ── Submit đơn qua API ───────────────────────────────────────
const API_BASE = '/api';

const _origSubmit = ORDER_submitOrder;
ORDER_submitOrder = async function() {
  const name  = document.getElementById('custName').value.trim();
  const phone = document.getElementById('custPhone').value.trim();
  if (!name || !phone) { alert('Vui lòng điền đầy đủ họ tên và số điện thoại.'); return; }

  const address = document.getElementById('custAddress').value.trim();
  const note    = document.getElementById('orderNote').value.trim();
  const typeMap = {'ca-nhan':'Cá nhân','dai-ly':'Đại lý','nha-hang':'Nhà hàng','doanh-nghiep':'Doanh nghiệp'};
  const type    = document.getElementById('customerType').value;

  const items = [];
  let total = 0;
  document.querySelectorAll('#productRows tr').forEach(row => {
    const sel = row.querySelector('select');
    const qty = parseInt(row.querySelector('input')?.value) || 1;
    if (sel && sel.value) {
      const price = ORDER_getPriceByName(sel.value);
      items.push({ name: sel.value, price, qty, total: price * qty });
      total += price * qty;
    }
  });

  // Disable nút submit
  const submitBtn = document.getElementById('submitOrderBtn');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Đang gửi...'; }

  try {
    const res = await fetch(API_BASE + '/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer: { name, phone, address, type: typeMap[type] || type },
        items, total,
        contactMethod: ORDER_contactMethod,
        note
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi server');

    window.open('https://zalo.me/84768654627', '_blank');
    document.getElementById('orderIdDisplay').textContent = data.id;
    document.getElementById('orderForm').style.display  = 'none';
    document.getElementById('successMsg').style.display = 'block';
  } catch(e) {
    alert('Gửi đơn thất bại: ' + e.message);
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Gửi đơn hàng'; }
  }
};"""

html, n = re.subn(OLD_SUBMIT, NEW_SUBMIT, html, flags=re.DOTALL)
print(f'[1] Submit block replaced: {n}')

# ─────────────────────────────────────────────────────────────
# 2. Thay adminUpdateStatus
# ─────────────────────────────────────────────────────────────
OLD_UPDATE = r'(?<!async )function adminUpdateStatus\(id, status\) \{.*?adminRender\(\);\s*\}'

NEW_UPDATE = r"""async function adminUpdateStatus(id, status) {
  try {
    const res = await fetch(API_BASE + '/orders/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    if (!res.ok) throw new Error('Lỗi cập nhật');
    await adminRender();
  } catch(e) {
    alert('Lỗi: ' + e.message);
  }
}"""

html, n = re.subn(OLD_UPDATE, NEW_UPDATE, html, flags=re.DOTALL)
print(f'[2] adminUpdateStatus replaced: {n}')

# ─────────────────────────────────────────────────────────────
# 3. Thay adminRender — đầu hàm lấy orders từ API
# ─────────────────────────────────────────────────────────────
OLD_RENDER_START = r'function adminRender\(\) \{\s*const orders\s*=\s*OrderStorage\.getAll\(\);'

NEW_RENDER_START = r"""async function adminRender() {
  let orders = [];
  try {
    const search = (document.getElementById('adminSearch')?.value || '');
    const filter = document.getElementById('adminFilter')?.value || 'all';
    let url = API_BASE + '/orders?';
    if (filter !== 'all') url += 'status=' + filter + '&';
    if (search) url += 'search=' + encodeURIComponent(search);
    const res = await fetch(url);
    orders = await res.json();
  } catch(e) {
    console.error('Lỗi load đơn:', e);
  }"""

html, n = re.subn(OLD_RENDER_START, NEW_RENDER_START, html, flags=re.DOTALL)
print(f'[3] adminRender start replaced: {n}')

# ─────────────────────────────────────────────────────────────
# 4. Thay adminShowDetail — lấy từ API
# ─────────────────────────────────────────────────────────────
OLD_DETAIL = r'function adminShowDetail\(id\) \{\s*const o = OrderStorage\.getAll\(\)\.find\(x => x\.id === id\);\s*if \(!o\) return;'

NEW_DETAIL = r"""async function adminShowDetail(id) {
  let orders = [];
  try {
    const res = await fetch(API_BASE + '/orders');
    orders = await res.json();
  } catch(e) {}
  const o = orders.find(x => x.id === id);
  if (!o) return;"""

html, n = re.subn(OLD_DETAIL, NEW_DETAIL, html, flags=re.DOTALL)
print(f'[4] adminShowDetail replaced: {n}')

# ─────────────────────────────────────────────────────────────
# 5. Thêm bell notification + poll trước </script> cuối cùng
# ─────────────────────────────────────────────────────────────
BELL_CODE = r"""
// ════════════════════════════════════════════════
//  BELL NOTIFICATION — poll API mỗi 30s
// ════════════════════════════════════════════════
let _lastOrderCount = null;
let _bellInterval = null;

async function bellCheck() {
  try {
    const res = await fetch(API_BASE + '/orders');
    const orders = await res.json();
    const newCount = orders.filter(o => o.status === 'new').length;

    if (_lastOrderCount === null) {
      _lastOrderCount = newCount;
      bellUpdateUI(newCount);
      return;
    }

    if (newCount > _lastOrderCount) {
      const diff = newCount - _lastOrderCount;
      bellUpdateUI(newCount);
      _lastOrderCount = newCount;

      // Sound
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        [880, 1100, 1320].forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain); gain.connect(ctx.destination);
          osc.frequency.value = freq;
          osc.type = 'sine';
          gain.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.15);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.3);
          osc.start(ctx.currentTime + i * 0.15);
          osc.stop(ctx.currentTime + i * 0.15 + 0.3);
        });
      } catch(e) {}

      // Toast
      bellToast(`🛒 Có ${diff} đơn hàng mới!`);

      // Nếu đang ở trang admin thì reload danh sách
      const adminPage = document.getElementById('page-admin');
      if (adminPage && adminPage.style.display !== 'none') {
        adminRender();
      }
    } else {
      _lastOrderCount = newCount;
      bellUpdateUI(newCount);
    }
  } catch(e) {}
}

function bellUpdateUI(count) {
  const btn = document.getElementById('bellBtn');
  const badge = document.getElementById('bellBadge');
  if (!btn || !badge) return;
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'flex';
    btn.style.color = '#c0392b';
  } else {
    badge.style.display = 'none';
    btn.style.color = '#c8b090';
  }
}

function bellToast(msg) {
  let toast = document.getElementById('bellToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'bellToast';
    toast.style.cssText = `position:fixed;bottom:24px;right:24px;background:#1c1612;color:#e8d5b0;
      padding:12px 20px;border-radius:10px;font-family:'Montserrat',sans-serif;font-size:13px;
      font-weight:600;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,.3);
      transform:translateY(80px);transition:transform .3s ease;`;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.transform = 'translateY(0)';
  setTimeout(() => { toast.style.transform = 'translateY(80px)'; }, 4000);
}

// Khởi động bell khi trang load
window.addEventListener('DOMContentLoaded', () => {
  bellCheck();
  _bellInterval = setInterval(bellCheck, 30000);
});
"""

# Thêm trước thẻ </script> cuối cùng trong file
html = html.replace('</script>\n\n</div>\n<!-- ===== ORDER PAGE END ===== -->', 
                    BELL_CODE + '\n</script>\n\n</div>\n<!-- ===== ORDER PAGE END ===== -->')
print(f'[5] Bell notification added')

# ─────────────────────────────────────────────────────────────
# 6. Thêm bell button vào header (sau adminBtn)
# ─────────────────────────────────────────────────────────────
OLD_ADMIN_BTN = r'(<button id="adminBtn"[^>]+>📋 Quản lý đơn</button>)'

NEW_ADMIN_BTN = r'''\1
  <div style="position:relative;display:inline-block;">
    <button id="bellBtn" onclick="showPage(\'admin\');adminRender()"
      style="padding:6px 10px;border-radius:20px;border:1px solid #c8b89a;background:none;
      font-size:16px;cursor:pointer;color:#c8b090;line-height:1;">🔔</button>
    <span id="bellBadge" style="display:none;position:absolute;top:-4px;right:-4px;
      background:#c0392b;color:#fff;border-radius:50%;width:16px;height:16px;
      font-size:9px;font-weight:700;align-items:center;justify-content:center;
      font-family:'Montserrat',sans-serif;"></span>
  </div>'''

html, n = re.subn(OLD_ADMIN_BTN, NEW_ADMIN_BTN, html)
print(f'[6] Bell button added: {n}')

# ─────────────────────────────────────────────────────────────
# Write output
# ─────────────────────────────────────────────────────────────
with open(OUTPUT, 'w', encoding='utf-8') as f:
    f.write(html)

print(f'\n✅ Done! Patched {OUTPUT}')
