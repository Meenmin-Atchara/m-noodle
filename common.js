// โค้ดที่ใช้ร่วมกันทั้งหน้าลูกค้าและหน้าร้าน
const sb = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

const baht = n => '฿' + Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const optionsText = opts => (opts || []).map(o => o.choice).join(', ');
const STATUS_TH = {
  pending: 'ส่งออเดอร์แล้ว รอร้านยืนยันสักครู่',
  cooking: 'ร้านกำลังทำให้ครับ',
  ready: 'อาหารพร้อมแล้ว พนักงานกำลังนำไปเสิร์ฟ',
  served: 'เสิร์ฟแล้ว ทานให้อร่อยนะครับ',
  cancelled: 'ร้านรับออเดอร์นี้ไม่ได้ กรุณาเรียกพนักงาน'
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

// ---------- ตั้งค่าร้านที่ลูกค้าเห็นได้ (ชื่อร้าน / สถานะเปิดรับออเดอร์) ----------
// ถ้ายังไม่ได้รัน billing.sql หรืออ่านไม่ได้ จะใช้ชื่อร้านจาก config.js แทน
async function loadPublicSettings() {
  try {
    const { data, error } = await sb.rpc('get_public_settings');
    if (!error && data) {
      if (data.shop_name) CONFIG.SHOP_NAME = data.shop_name;
      return { accepting_orders: data.accepting_orders !== false };
    }
  } catch (e) { console.error(e); }
  return { accepting_orders: true };
}

// ---------- พิมพ์เนื้อหาที่กำหนดเอง (ใบเสร็จ ฯลฯ) ----------
function printHtml(html) {
  let area = document.getElementById('printArea');
  if (!area) { area = document.createElement('div'); area.id = 'printArea'; document.body.appendChild(area); }
  area.innerHTML = html;
  document.body.classList.add('print-on');
  const done = () => { document.body.classList.remove('print-on'); area.innerHTML = ''; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}

const fmtDateTime = d => new Date(d).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
const fmtTime = d => new Date(d).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

// ---------- ไอคอนตามหมวด (ใช้เมื่อยังไม่มีรูปอาหาร) ----------
const CAT_ICON = [
  [/ก๋วยเตี๋ยว|เส้น|บะหมี่|เกาเหลา/, '🍜'],
  [/ทานเล่น|ทอด|ของว่าง/, '🍢'],
  [/เครื่องดื่ม|น้ำ|ชา|กาแฟ/, '🧋'],
  [/ข้าว/, '🍚'],
  [/หวาน|ไอศกรีม|ไอติม/, '🍧']
];
const catIcon = c => (CAT_ICON.find(([re]) => re.test(c)) || [null, '🍽️'])[1];
const thumbInner = m => m.image_url ? `<img src="${esc(m.image_url)}" alt="" loading="lazy">` : catIcon(m.category);

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
          <button type="button" data-i="${i}" data-d="-1" aria-label="ลดจำนวน">−</button><span>${l.qty}</span><button type="button" data-i="${i}" data-d="1" aria-label="เพิ่มจำนวน">+</button>
        </div>
        <div class="line-price">${baht(l.unit_price * l.qty)}</div>
      </div>`).join('')
    : '<p class="muted center" style="margin:24px 0">ยังไม่มีรายการ เลือกเมนูได้เลย</p>';
  el.onclick = e => {
    const b = e.target.closest('button[data-i]');
    if (b) cart.change(+b.dataset.i, +b.dataset.d);
  };
}

// ---------- รายการเมนู ----------
// layout: 'list' = แถวละรายการ (มือถือลูกค้า), 'grid' = การ์ด (แท็บเล็ตหน้าร้าน)
function itemHtml(m, tone, layout) {
  const hint = (m.options || []).length ? '<span class="tag">เลือกเพิ่มได้</span>' : '';
  const price = m.available ? baht(m.price) : 'หมดแล้ว';
  return `<button type="button" class="item ${layout === 'grid' ? 'card' : 'li'} t${tone % 4}" data-id="${m.id}" ${m.available ? '' : 'disabled'}>
    <div class="thumb">${thumbInner(m)}</div>
    <div class="info"><div class="item-name">${esc(m.name)}</div><div class="item-price">${price}${m.available ? hint : ''}</div></div>
    ${layout === 'grid' ? '' : '<span class="add" aria-hidden="true">+</span>'}
  </button>`;
}

function renderMenuList(menu, el, onPick, layout = 'list') {
  const cats = [...new Set(menu.map(m => m.category))];
  const nav = cats.length > 1
    ? `<nav class="catnav">${cats.map((c, i) => `<button type="button" class="catchip${i === 0 ? ' on' : ''}" data-cat="${i}">${catIcon(c)} ${esc(c)}</button>`).join('')}</nav>`
    : '';
  const sections = cats.map((c, i) => `
    <section class="catsec" data-sec="${i}">
      <h2 class="cat">${esc(c)}</h2>
      <div class="${layout === 'grid' ? 'grid' : 'rows'}">${menu.filter(m => m.category === c).map(m => itemHtml(m, i, layout)).join('')}</div>
    </section>`).join('');
  el.innerHTML = nav + sections;
  el.onclick = e => {
    const chip = e.target.closest('.catchip');
    if (chip) {
      el.querySelectorAll('.catchip').forEach(c => c.classList.toggle('on', c === chip));
      el.querySelector(`[data-sec="${chip.dataset.cat}"]`).scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
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
      <div class="sheet-head">
        <div class="thumb">${thumbInner(item)}</div>
        <div class="info"><h3>${esc(item.name)}</h3><div class="item-price">${baht(base)}</div></div>
      </div>
      ${groups.map((g, gi) => `
        <fieldset><legend>${esc(g.name)}${g.required ? ' <b class="req">*</b>' : ''}</legend>
          ${g.choices.map((c, ci) => `
            <label class="chip"><input type="${g.required ? 'radio' : 'checkbox'}" name="g${gi}" value="${ci}">
              <span>${esc(c.name)}${Number(c.price) ? ' +' + c.price : ''}</span></label>`).join('')}
        </fieldset>`).join('')}
      <input class="note" placeholder="หมายเหตุ เช่น ไม่ใส่ผัก" maxlength="200">
      <div class="qty-row"><button type="button" data-d="-1" aria-label="ลดจำนวน">−</button><b class="q">1</b><button type="button" data-d="1" aria-label="เพิ่มจำนวน">+</button></div>
      <p class="err" hidden></p>
      <div class="row sheet-foot">
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
    if (e.target === dlg) { dlg.close(); return; }
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
