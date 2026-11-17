// หน้าร้าน: ล็อกอิน > บอร์ดคิวเรียลไทม์ > รับออเดอร์เอง
const $ = s => document.querySelector(s);
const ACTIVE = ['pending', 'cooking', 'ready'];
let known = new Set(), firstLoad = true, channel = null, poller = null, debounce = null;
let menu = [], tables = [], newType = 'dine_in', newTable = null, submitting = false;
let audioCtx = null;

// ---------- เสียงแจ้งเตือนออเดอร์ใหม่ ----------
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
  } catch {}
}
document.addEventListener('click', unlockAudio);
function beep() {
  try {
    unlockAudio();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.frequency.value = 880; g.gain.value = 0.25;
    o.start(); o.stop(audioCtx.currentTime + 0.45);
  } catch {}
}

// ---------- ล็อกอิน ----------
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  const { error } = await sb.auth.signInWithPassword({ email: $('#email').value, password: $('#password').value });
  const err = $('#loginErr');
  err.hidden = !error;
  if (error) err.textContent = 'อีเมลหรือรหัสผ่านไม่ถูกต้อง';
};
$('#logout').onclick = () => sb.auth.signOut();

function showSession(session) {
  $('#loginView').hidden = !!session;
  $('#appView').hidden = !session;
  if (session) start(); else stop();
}
sb.auth.getSession().then(({ data }) => showSession(data.session));
sb.auth.onAuthStateChange((evt, session) => {
  if (evt === 'SIGNED_IN' || evt === 'SIGNED_OUT') showSession(session);
});

// ---------- บอร์ดคิว ----------
async function start() {
  $('#shop').textContent = CONFIG.SHOP_NAME;
  firstLoad = true; known = new Set();
  try {
    [menu, tables] = await Promise.all([
      loadMenu(),
      sb.from('tables').select('*').eq('active', true).order('id').then(r => r.data || [])
    ]);
  } catch (e) { console.error(e); }
  await refresh();
  channel = sb.channel('board')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, scheduleRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, scheduleRefresh)
    .subscribe();
  poller = setInterval(refresh, 15000); // สำรองเผื่อ realtime หลุด
}
function stop() {
  if (channel) sb.removeChannel(channel);
  channel = null; clearInterval(poller);
}
function scheduleRefresh() { clearTimeout(debounce); debounce = setTimeout(refresh, 300); }

async function refresh() {
  const { data, error } = await sb.from('orders')
    .select('*, tables(name), order_items(*)')
    .in('status', ACTIVE).order('created_at');
  if (error) { console.error(error); return; }
  renderBoard(data);
  const pendingIds = new Set(data.filter(o => o.status === 'pending').map(o => o.id));
  if (!firstLoad && [...pendingIds].some(id => !known.has(id))) beep();
  known = pendingIds; firstLoad = false;
}

function card(o) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(o.created_at)) / 60000));
  const late = mins >= 10 && o.status !== 'ready';
  const ago = mins < 1 ? 'เมื่อสักครู่' : mins + ' นาทีที่แล้ว';
  const takeaway = o.order_type === 'takeaway';
  const where = takeaway ? '🛍️ กลับบ้าน' : esc(o.tables?.name || '');
  const items = [...o.order_items].sort((a, b) => a.id - b.id).map(i => `
    <li><b>${i.qty}×</b> ${esc(i.name)}
      <div class="muted">${esc(optionsText(i.options))}${i.note ? ' · ' + esc(i.note) : ''}</div></li>`).join('');
  const total = o.order_items.reduce((s, i) => s + i.unit_price * i.qty, 0);
  const qtyAll = o.order_items.reduce((s, i) => s + i.qty, 0);
  const doneLabel = takeaway ? 'ลูกค้ารับแล้ว' : 'เสิร์ฟแล้ว';
  const acts = {
    pending: `<button class="btn danger" data-act="cancel" data-id="${o.id}">ปฏิเสธ</button>
              <button class="btn ok" data-act="cooking" data-id="${o.id}">ยืนยัน</button>`,
    cooking: `<button class="btn ok" data-act="ready" data-id="${o.id}">ทำเสร็จแล้ว</button>`,
    ready: `<button class="btn ok" data-act="served" data-id="${o.id}">${doneLabel}</button>`
  }[o.status];
  return `<div class="ocard ${o.status}">
    <div class="o-head">
      <span class="qn">${o.queue_no}</span>
      <div class="grow"><span class="where">${where}</span>
        <span class="muted"><span class="ago${late ? ' late' : ''}">${ago}</span> · ${o.source === 'customer' ? 'สั่งผ่าน QR' : 'พนักงานคีย์'}</span></div>
    </div>
    <ul>${items}</ul>
    ${o.note ? `<div class="muted">📝 ${esc(o.note)}</div>` : ''}
    <div class="o-foot"><span class="muted">${qtyAll} รายการ</span><b>${baht(total)}</b></div>
    <div class="acts">${acts}</div></div>`;
}

function renderBoard(orders) {
  for (const s of ACTIVE) {
    const list = orders.filter(o => o.status === s);
    $('#col-' + s).innerHTML = list.map(card).join('') || '<p class="empty">ไม่มีออเดอร์</p>';
    $('#c-' + s).textContent = list.length;
  }
}

$('#appView').onclick = async e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  if (b.dataset.act === 'cancel' && !confirm('ปฏิเสธออเดอร์นี้?')) return;
  const status = b.dataset.act === 'cancel' ? 'cancelled' : b.dataset.act;
  b.disabled = true;
  const { error } = await sb.from('orders').update({ status }).eq('id', b.dataset.id);
  if (error) { toast('อัปเดตไม่สำเร็จ ลองอีกครั้ง'); b.disabled = false; }
  refresh();
};

// ---------- พนักงานรับออเดอร์เอง ----------
const staffCart = new Cart(() => {
  renderCartLines(staffCart, $('#staffLines'));
  $('#staffSum').textContent = baht(staffCart.total);
});

function renderTableSeg() {
  $('#tableSeg').hidden = newType !== 'dine_in';
  $('#tableSeg').innerHTML = tables.map(t =>
    `<button data-table="${t.id}" class="${newTable === t.id ? 'on' : ''}">${esc(t.name)}</button>`).join('');
}

$('#newBtn').onclick = () => {
  newType = 'dine_in'; newTable = null; staffCart.clear();
  document.querySelectorAll('#typeSeg button').forEach(b => b.classList.toggle('on', b.dataset.type === 'dine_in'));
  renderTableSeg();
  renderMenuList(menu, $('#staffMenu'), item => openItemDialog(item, line => staffCart.add(line)), 'grid');
  $('#staffNote').value = ''; $('#staffErr').hidden = true;
  $('#newView').hidden = false;
};
$('#newClose').onclick = () => {
  if (staffCart.count && !confirm('ทิ้งรายการที่ยังไม่ส่ง?')) return;
  $('#newView').hidden = true;
};
$('#typeSeg').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  newType = b.dataset.type;
  document.querySelectorAll('#typeSeg button').forEach(x => x.classList.toggle('on', x === b));
  renderTableSeg();
};
$('#tableSeg').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  newTable = +b.dataset.table; renderTableSeg();
};

$('#staffSubmit').onclick = async () => {
  const err = $('#staffErr');
  if (submitting) return;
  if (!staffCart.count) { err.hidden = false; err.textContent = 'ยังไม่ได้เลือกเมนู'; return; }
  if (newType === 'dine_in' && !newTable) { err.hidden = false; err.textContent = 'เลือกโต๊ะก่อนส่ง'; return; }
  submitting = true; err.hidden = true;
  const { data, error } = await sb.rpc('create_order', {
    p_table_id: newType === 'dine_in' ? newTable : null, p_type: newType, p_source: 'staff',
    p_note: $('#staffNote').value.trim() || null, p_items: staffCart.payload()
  });
  submitting = false;
  if (error) { console.error(error); err.hidden = false; err.textContent = 'ส่งไม่สำเร็จ: ' + (error.message || ''); return; }
  staffCart.clear(); $('#newView').hidden = true;
  toast('ส่งเข้าครัวแล้ว คิว #' + data.queue_no);
  refresh();
};
