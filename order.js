// หน้าลูกค้า: เปิดจาก QR เช่น order.html?t=3  (t = เลข id ของโต๊ะ)
const $ = s => document.querySelector(s);
const tableId = parseInt(new URLSearchParams(location.search).get('t'), 10);
const LS_KEY = 'lastOrder';
let pollTimer = null;
let submitting = false;
let tableLabel = '';
let acceptOrders = true, curOrderId = null, pollTick = null;

const cart = new Cart(() => {
  renderCartLines(cart, $('#lines'));
  $('#cnt').textContent = cart.count;
  $('#tot').textContent = baht(cart.total);
  $('#sum').textContent = baht(cart.total);
  $('#cartbar').hidden = cart.count === 0;
});

function fatal(msg) {
  const el = $('#fatal'); el.hidden = false; el.textContent = msg;
}

async function init() {
  const ps = await loadPublicSettings();   // ชื่อร้านและสถานะเปิดรับออเดอร์ที่แอดมินตั้งไว้
  acceptOrders = ps.accepting_orders;
  $('#closedNote').hidden = acceptOrders;
  $('#shop').textContent = CONFIG.SHOP_NAME;
  document.title = CONFIG.SHOP_NAME + ' · สั่งอาหาร';
  if (!tableId) return fatal('สแกน QR ที่โต๊ะอีกครั้งเพื่อสั่งอาหาร');
  try {
    const { data: t, error } = await sb.from('tables').select('name').eq('id', tableId).eq('active', true).maybeSingle();
    if (error) throw error;
    if (!t) return fatal('ไม่พบโต๊ะนี้ สแกน QR ที่โต๊ะอีกครั้ง');
    tableLabel = t.name;
    $('#tableName').textContent = t.name;
    const menu = await loadMenu();
    renderMenuList(menu, $('#menu'), item => {
      if (!acceptOrders) return toast('ร้านปิดรับออเดอร์ผ่าน QR ชั่วคราว กรุณาแจ้งพนักงาน', 3500);
      openItemDialog(item, line => { cart.add(line); toast('เพิ่ม ' + item.name + ' แล้ว'); });
    });
  } catch (e) {
    console.error(e);
    return fatal('โหลดเมนูไม่สำเร็จ ลองรีเฟรชหน้านี้อีกครั้ง');
  }
  resumeStatus();
}

// ---------- ใบคิวและสถานะออเดอร์ ----------
const STEPS = ['รอร้านยืนยัน', 'กำลังทำ', 'พร้อมเสิร์ฟ'];
// ปุ่มเรียกเก็บเงิน / สถานะบิล (bill.status มาจาก billing.sql ถ้ายังไม่ได้รันจะไม่แสดงอะไร)
function billAction(status, bill) {
  if (status === 'cancelled') return '';
  if (bill.bill_status === 'paid') return '<p class="t-req">ชำระเงินแล้ว ขอบคุณที่ใช้บริการครับ</p>';
  if (bill.bill_status !== 'open') return '';
  return bill.requested
    ? '<p class="t-req">แจ้งพนักงานแล้ว กำลังนำบิลมาให้ครับ</p>'
    : '<button class="btn ghost billreq" id="reqBill">เรียกเก็บเงิน</button>';
}
function showStatus(queueNo, status, bill = {}) {
  const c = $('#statusCard'); c.hidden = false;
  const cancelled = status === 'cancelled';
  const idx = { pending: 0, cooking: 1, ready: 2, served: 3 }[status] ?? 0;
  c.className = 'ticket-wrap' + (cancelled ? ' off' : '');
  c.innerHTML = `
    <div class="ticket">
      <div class="t-head"><span>คิวของคุณ</span><b>${esc(tableLabel)}</b></div>
      <div class="qn">${queueNo}</div>
      <div class="perf"></div>
      <ol class="steps">${STEPS.map((s, i) => `<li class="${cancelled ? '' : i < idx ? 'done' : i === idx ? 'on' : ''}"><i></i>${s}</li>`).join('')}</ol>
      <p class="t-msg">${STATUS_TH[status] || ''}</p>
      ${billAction(status, bill)}
    </div>`;
}

function resumeStatus() {
  let last = null;
  try { last = JSON.parse(localStorage.getItem(LS_KEY)); } catch {}
  if (!last || Date.now() - last.at > 12 * 3600 * 1000 || last.table !== tableId) return;
  showStatus(last.queue_no, last.status || 'pending');
  poll(last);
}

function poll(last) {
  clearInterval(pollTimer);
  const tick = async () => {
    const { data } = await sb.rpc('get_order_status', { p_order_id: last.id });
    if (!data) { $('#statusCard').hidden = true; clearInterval(pollTimer); return; }
    showStatus(data.queue_no, data.status, { bill_status: data.bill_status, requested: data.requested });
    // หยุดถามเมื่อออเดอร์จบแล้ว และบิลไม่ได้เปิดค้างอยู่ (จ่ายแล้ว/ยกเลิก/ไม่มีระบบบิล)
    const done = data.status === 'served' || data.status === 'cancelled';
    if (done && data.bill_status !== 'open') clearInterval(pollTimer);
  };
  curOrderId = last.id; pollTick = tick;
  tick();
  pollTimer = setInterval(tick, 8000);
}

$('#statusCard').addEventListener('click', async e => {
  const b = e.target.closest('#reqBill');
  if (!b || !curOrderId) return;
  b.disabled = true;
  const { data, error } = await sb.rpc('request_bill', { p_order_id: curOrderId });
  if (error || !data || !data.ok) { b.disabled = false; return toast('ส่งคำขอไม่สำเร็จ ลองอีกครั้งหรือเรียกพนักงาน', 3500); }
  toast('แจ้งพนักงานแล้ว');
  if (pollTick) pollTick();
});

// ---------- ตะกร้าและส่งออเดอร์ ----------
$('#openCart').onclick = () => $('#cartDlg').showModal();
$('#closeCart').onclick = () => $('#cartDlg').close();
$('#cartDlg').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

$('#submit').onclick = async () => {
  if (submitting || !cart.count) return;
  submitting = true;
  const btn = $('#submit'); btn.disabled = true; btn.textContent = 'กำลังส่ง...';
  $('#submitErr').hidden = true;
  const { data, error } = await sb.rpc('create_order', {
    p_table_id: tableId, p_type: 'dine_in', p_source: 'customer',
    p_note: $('#orderNote').value.trim() || null, p_items: cart.payload()
  });
  submitting = false; btn.disabled = false; btn.textContent = 'ยืนยันสั่งอาหาร';
  if (error) {
    console.error(error);
    const e = $('#submitErr'); e.hidden = false;
    // ข้อความภาษาไทยจากฐานข้อมูล (เช่น ร้านปิดรับออเดอร์) แสดงตรงๆ ได้ นอกนั้นใช้ข้อความทั่วไป
    e.textContent = /[ก-๙]/.test(error.message || '') ? error.message : 'สั่งไม่สำเร็จ อาจมีเมนูที่เพิ่งหมด ลองใหม่อีกครั้งหรือเรียกพนักงาน';
    return;
  }
  const last = { id: data.order_id, queue_no: data.queue_no, status: data.status, table: tableId, at: Date.now() };
  localStorage.setItem(LS_KEY, JSON.stringify(last));
  cart.clear(); $('#orderNote').value = '';
  $('#cartDlg').close();
  showStatus(last.queue_no, last.status);
  poll(last);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  toast('ส่งออเดอร์แล้ว รอร้านยืนยันสักครู่');
};

init();
