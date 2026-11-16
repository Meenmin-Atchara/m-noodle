// โค้ดที่ใช้ร่วมกันทั้งหน้าลูกค้าและหน้าร้าน
const sb = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

const baht = n => '฿' + Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const optionsText = opts => (opts || []).map(o => o.choice).join(', ');
const STATUS_TH = {
  pending: 'รอพนักงานยืนยัน', cooking: 'กำลังทำ 🍜', ready: 'พร้อมเสิร์ฟแล้ว ✅',
  served: 'เสิร์ฟแล้ว ขอบคุณครับ', cancelled: 'ออเดอร์ถูกยกเลิก'
};

function toast(msg, ms = 2500) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

async function loadMenu() {
  const { data, error } = await sb.from('menu_items').select('*').order('sort').order('id');
  if (error) throw error;
  return data;
}

// ---------- ตะกร้า ----------
class Cart {
  constructor(onChange) { this.lines = []; this.onChange = onChange || (() => {}); }
  add(line) {
    const key = JSON.stringify([line.menu_item_id, line.options, line.note]);
    const ex = this.lines.find(l => l.key === key);
    if (ex) ex.qty += line.qty; else this.lines.push({ ...line, key });
    this.onChange();
  }
  change(i, d) {
    this.lines[i].qty += d;
    if (this.lines[i].qty <= 0) this.lines.splice(i, 1);
    this.onChange();
  }
  clear() { this.lines = []; this.onChange(); }
  get count() { return this.lines.reduce((s, l) => s + l.qty, 0); }
  get total() { return this.lines.reduce((s, l) => s + l.unit_price * l.qty, 0); }
  // ส่งเฉพาะ id/จำนวน/ตัวเลือก ส่วนราคาฐานข้อมูลคิดเอง
  payload() {
    return this.lines.map(l => ({ menu_item_id: l.menu_item_id, qty: l.qty, note: l.note || null, options: l.options }));
  }
}

function renderCartLines(cart, el) {
  el.innerHTML = cart.lines.length
    ? cart.lines.map((l, i) => `
      <div class="line">
        <div class="grow"><b>${esc(l.name)}</b>
          <div class="muted">${esc(optionsText(l.options))}${l.note ? ' · ' + esc(l.note) : ''}</div></div>
        <div class="stepper">
          <button data-i="${i}" data-d="-1">−</button><span>${l.qty}</span><button data-i="${i}" data-d="1">+</button>
        </div>
        <div class="line-price">${baht(l.unit_price * l.qty)}</div>
      </div>`).join('')
    : '<p class="muted center">ยังไม่มีรายการ</p>';
  el.onclick = e => {
    const b = e.target.closest('button[data-i]');
    if (b) cart.change(+b.dataset.i, +b.dataset.d);
  };
}

// ---------- รายการเมนู ----------
function renderMenuList(menu, el, onPick) {
  const cats = [...new Set(menu.map(m => m.category))];
  el.innerHTML = cats.map(c => `
    <h2 class="cat">${esc(c)}</h2>
    <div class="grid">${menu.filter(m => m.category === c).map(m => `
      <button class="item" data-id="${m.id}" ${m.available ? '' : 'disabled'}>
        ${m.image_url ? `<img src="${esc(m.image_url)}" alt="" loading="lazy">` : '<div class="noimg">🍜</div>'}
        <div class="item-name">${esc(m.name)}</div>
        <div class="item-price">${m.available ? baht(m.price) : 'หมด'}</div>
      </button>`).join('')}</div>`).join('');
  el.onclick = e => {
    const b = e.target.closest('.item');
    if (!b || b.disabled) return;
    onPick(menu.find(m => m.id == b.dataset.id));
  };
}

// ---------- หน้าต่างเลือกตัวเลือกของเมนู ----------
function openItemDialog(item, onAdd) {
  const groups = item.options || [];
  const base = Number(item.price);
  let qty = 1;
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.innerHTML = `
    <div class="sheet-body">
      <h3>${esc(item.name)} <span class="muted">${baht(base)}</span></h3>
      ${groups.map((g, gi) => `
        <fieldset><legend>${esc(g.name)}${g.required ? ' <b class="req">*</b>' : ''}</legend>
          ${g.choices.map((c, ci) => `
            <label class="chip"><input type="${g.required ? 'radio' : 'checkbox'}" name="g${gi}" value="${ci}">
              <span>${esc(c.name)}${Number(c.price) ? ' +' + c.price : ''}</span></label>`).join('')}
        </fieldset>`).join('')}
      <input class="note" placeholder="หมายเหตุ เช่น ไม่ใส่ผัก" maxlength="200">
      <div class="qty-row"><button type="button" data-d="-1">−</button><b class="q">1</b><button type="button" data-d="1">+</button></div>
      <p class="err" hidden></p>
      <div class="row">
        <button type="button" class="btn ghost" data-close>ยกเลิก</button>
        <button type="button" class="btn grow" data-ok>เพิ่มลงตะกร้า <span class="t"></span></button>
      </div>
    </div>`;
  const selected = () => {
    const out = [];
    groups.forEach((g, gi) => dlg.querySelectorAll(`input[name=g${gi}]:checked`).forEach(i => {
      const c = g.choices[i.value];
      out.push({ group: g.name, choice: c.name, price: Number(c.price) || 0 });
    }));
    return out;
  };
  const update = () => {
    const extra = selected().reduce((s, o) => s + o.price, 0);
    dlg.querySelector('.t').textContent = baht((base + extra) * qty);
    dlg.querySelector('.q').textContent = qty;
  };
  dlg.addEventListener('change', update);
  dlg.addEventListener('click', e => {
    const d = e.target.closest('[data-d]');
    if (d) { qty = Math.max(1, Math.min(50, qty + +d.dataset.d)); update(); return; }
    if (e.target.closest('[data-close]')) { dlg.close(); return; }
    if (e.target.closest('[data-ok]')) {
      const sel = selected();
      const missing = groups.find((g, gi) => g.required && !dlg.querySelector(`input[name=g${gi}]:checked`));
      if (missing) {
        const err = dlg.querySelector('.err');
        err.hidden = false; err.textContent = 'กรุณาเลือก' + missing.name;
        return;
      }
      const extra = sel.reduce((s, o) => s + o.price, 0);
      onAdd({
        menu_item_id: item.id, name: item.name,
        options: sel.map(({ group, choice }) => ({ group, choice })),
        note: dlg.querySelector('.note').value.trim(), qty, unit_price: base + extra
      });
      dlg.close();
    }
  });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.appendChild(dlg);
  update();
  dlg.showModal();
}
