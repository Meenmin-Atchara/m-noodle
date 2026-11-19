// เก็บเงิน: บิลค้างชำระ / ส่วนลด / PromptPay QR / เงินสด / ใบเสร็จ
// (โหลดก่อน staff.js และไม่ใช้ตัวช่วย $ ของ staff.js เพื่อไม่ให้ลำดับโหลดมีผล)
const qs = s => document.querySelector(s);
let MY_ROLE = null;                 // staff.js กำหนดค่านี้หลังล็อกอิน
let shopSettings = {};
let billsReady = true;              // false = ยังไม่ได้รัน billing.sql ซ่อนปุ่มเก็บเงิน
let billsOpen = [], billsPaid = [];
let billTab = 'open', selBillId = null, selPaid = null;
let billMethod = 'promptpay', billDiscount = '', billCash = '';
let knownReq = null;                // บิลที่ขอเช็คบิลแล้ว (null = ยังไม่โหลดครั้งแรก จะได้ไม่ส่งเสียงตอนเปิดหน้า)
let payBusy = false;

const BILL_SELECT = '*, tables(name), orders(id, queue_no, status, created_at, note, order_items(*))';
const ORDER_STATUS_TH = { pending: 'รอยืนยัน', cooking: 'กำลังทำ', ready: 'พร้อมเสิร์ฟ', served: 'เสิร์ฟแล้ว' };
const whereOf = b => b.bill_type === 'takeaway' ? '🛍️ กลับบ้าน' : (b.tables?.name || 'โต๊ะ');
const r2 = n => Math.round(Number(n) * 100) / 100;

function billTotals(b) {
  const orders = (b.orders || []).filter(o => o.status !== 'cancelled').sort((x, y) => x.id - y.id);
  const sub = r2(orders.reduce((s, o) => s + o.order_items.reduce((t, i) => t + i.unit_price * i.qty, 0), 0));
  return { orders, sub, pending: orders.filter(o => o.status === 'pending') };
}
const minsSince = ts => Math.max(0, Math.round((Date.now() - new Date(ts)) / 60000));
const agoText = ts => { const m = minsSince(ts); return m < 1 ? 'เมื่อสักครู่' : m < 60 ? m + ' นาที' : Math.floor(m / 60) + ' ชม. ' + (m % 60) + ' นาที'; };

async function loadShopSettings() {
  const { data } = await sb.from('shop_settings').select('*').eq('id', 1).maybeSingle();
  shopSettings = data || {};
}

async function refreshBills() {
  if (!billsReady) return;
  const { data, error } = await sb.from('bills').select(BILL_SELECT).eq('status', 'open').order('created_at');
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') { billsReady = false; qs('#billBtn').hidden = true; }
    else console.error(error);
    return;
  }
  billsOpen = data;
  const live = billsOpen.filter(b => billTotals(b).orders.length);
  const req = live.filter(b => b.checkout_requested_at);
  const badge = qs('#billCount'); badge.textContent = live.length; badge.hidden = !live.length;
  qs('#billBtn').classList.toggle('alert', req.length > 0);
  const ids = new Set(req.map(b => b.id));
  if (knownReq) {
    const fresh = req.filter(b => !knownReq.has(b.id));
    if (fresh.length) { try { beep(); } catch {} toast(whereOf(fresh[0]) + ' ขอเช็คบิล', 4000); }
  }
  knownReq = ids;
  if (!qs('#billView').hidden && billTab === 'open') renderBills();
}

// ---------- เปิด/ปิดหน้าจอเก็บเงิน ----------
qs('#billBtn').onclick = async () => {
  billTab = 'open'; selBillId = null; selPaid = null; resetPayState();
  qs('#billTabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.tab === 'open'));
  qs('#billView').hidden = false;
  await refreshBills();
  const live = billsOpen.filter(b => billTotals(b).orders.length);
  const first = live.find(b => b.checkout_requested_at) || (live.length === 1 ? live[0] : null);
  if (first) selBillId = first.id;
  renderBills();
};
qs('#billClose').onclick = () => { qs('#billView').hidden = true; };
qs('#billTabs').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  billTab = b.dataset.tab; selBillId = null; selPaid = null; resetPayState();
  qs('#billTabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  if (billTab === 'paid') await loadPaidToday();
  renderBills();
};

async function loadPaidToday() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const { data, error } = await sb.from('bills').select('*, tables(name)')
    .eq('status', 'paid').gte('paid_at', start.toISOString()).order('paid_at', { ascending: false });
  if (error) { console.error(error); toast('โหลดรายการไม่สำเร็จ'); return; }
  billsPaid = data;
}

function resetPayState() { billMethod = 'promptpay'; billDiscount = ''; billCash = ''; payBusy = false; }

// ---------- รายการทางซ้าย ----------
function renderBills() {
  const list = qs('#billList');
  if (billTab === 'open') {
    list.innerHTML = billsOpen.length ? billsOpen.map(b => {
      const t = billTotals(b);
      return `<button class="bcard${b.id === selBillId ? ' on' : ''}${b.checkout_requested_at ? ' req' : ''}" data-id="${b.id}">
        <div class="grow"><b class="where">${esc(whereOf(b))}</b>
          <span class="muted">${t.orders.length ? t.orders.length + ' ออเดอร์' : 'ไม่มีรายการ'} · เปิดมา ${agoText(b.created_at)}</span></div>
        <div class="bflags">${t.pending.length ? '<span class="flag w">รอยืนยัน</span>' : ''}${b.checkout_requested_at ? '<span class="flag">ขอเช็คบิล</span>' : ''}</div>
        <b class="btotal">${baht(t.sub)}</b></button>`;
    }).join('') : '<p class="empty">ไม่มีบิลค้างชำระ</p>';
  } else {
    const sum = billsPaid.reduce((s, b) => s + Number(b.total), 0);
    list.innerHTML = billsPaid.length
      ? `<p class="muted" style="margin:4px 2px 10px">วันนี้ ${billsPaid.length} บิล · รวม <b>${baht(sum)}</b></p>` + billsPaid.map(b => `
        <button class="bcard${b.id === selPaid?.id ? ' on' : ''}" data-id="${b.id}">
          <div class="grow"><b class="where">${esc(whereOf(b))}</b><span class="muted">${fmtTime(b.paid_at)} · ${b.payment_method === 'cash' ? '💵 เงินสด' : '📱 PromptPay'}</span></div>
          <b class="btotal">${baht(b.total)}</b></button>`).join('')
      : '<p class="empty">วันนี้ยังไม่มีบิลที่ชำระ</p>';
  }
  renderBillDetail();
}

qs('#billList').onclick = async e => {
  const c = e.target.closest('.bcard'); if (!c) return;
  const id = +c.dataset.id;
  if (billTab === 'open') { if (selBillId !== id) { selBillId = id; resetPayState(); } renderBills(); }
  else {
    const { data, error } = await sb.from('bills').select(BILL_SELECT).eq('id', id).single();
    if (error) return toast('เปิดบิลไม่สำเร็จ');
    selPaid = data; renderBills();
  }
};

// ---------- รายละเอียดบิลค้างชำระ ----------
const selBill = () => billsOpen.find(x => x.id === selBillId);
function discountVal() { const t = billTotals(selBill()); return r2(Math.min(Math.max(Number(billDiscount) || 0, 0), t.sub)); }
function netTotal() { return r2(billTotals(selBill()).sub - discountVal()); }

function renderBillDetail() {
  const box = qs('#billDetail');
  if (billTab === 'paid') {
    if (!selPaid) { box.innerHTML = '<p class="empty">เลือกบิลทางซ้ายเพื่อดูใบเสร็จ</p>'; return; }
    box.innerHTML = `<div class="receipt-view">${receiptInner(selPaid)}</div>
      <div class="row"><button class="btn grow" data-print>พิมพ์ใบเสร็จ</button>
      ${MY_ROLE === 'admin' ? '<button class="btn danger" data-voidpaid>ยกเลิกบิลนี้</button>' : ''}</div>`;
    return;
  }
  const b = selBill();
  if (!b) { box.innerHTML = '<p class="empty">เลือกบิลทางซ้ายเพื่อเก็บเงิน</p>'; return; }
  const t = billTotals(b);
  const canVoid = !t.orders.length || MY_ROLE === 'admin';
  box.innerHTML = `
    <div class="bd-head">
      <div class="grow"><h2>${esc(whereOf(b))}</h2><span class="muted">บิล #${b.id} · เปิดเมื่อ ${fmtTime(b.created_at)}</span></div>
      ${canVoid ? `<button class="btn danger sm" data-void>${t.orders.length ? 'ยกเลิกทั้งบิล' : 'ลบบิลว่าง'}</button>` : ''}
    </div>
    <div class="bd-orders">${t.orders.map(o => `
      <div class="bd-order">
        <div class="bd-oh"><b>คิว #${o.queue_no}</b><span class="stat ${o.status}">${ORDER_STATUS_TH[o.status] || o.status}</span><span class="grow"></span>
          <button class="link" data-cancel-order="${o.id}">ยกเลิกออเดอร์</button></div>
        ${[...o.order_items].sort((x, y) => x.id - y.id).map(i => `
          <div class="bd-line"><span class="grow"><b>${i.qty}×</b> ${esc(i.name)}<span class="muted"> ${esc(optionsText(i.options))}${i.note ? ' · ' + esc(i.note) : ''}</span></span><span>${baht(i.unit_price * i.qty)}</span></div>`).join('')}
      </div>`).join('') || '<p class="empty">ไม่มีรายการในบิลนี้</p>'}</div>
    ${t.pending.length ? `<div class="help warn">มีออเดอร์ที่ยังไม่ยืนยัน (คิว ${t.pending.map(o => '#' + o.queue_no).join(', ')}) กลับไปกดยืนยันหรือปฏิเสธที่หน้าหลักก่อน จึงจะเก็บเงินได้</div>` : ''}
    <div class="bd-sum">
      <div class="sum-row"><span class="grow">ยอดรวม</span><b>${baht(t.sub)}</b></div>
      <div class="disc-row"><label for="dDisc" class="grow">ส่วนลด (บาท)</label><input id="dDisc" class="input" type="number" min="0" step="1" inputmode="decimal" placeholder="0" value="${esc(billDiscount)}"></div>
      <div class="sum-row grand"><span class="grow">ยอดสุทธิ</span><b id="dTotal"></b></div>
    </div>
    <div class="seg" id="payMethod">
      <button data-m="promptpay" class="${billMethod === 'promptpay' ? 'on' : ''}">📱 PromptPay</button>
      <button data-m="cash" class="${billMethod === 'cash' ? 'on' : ''}">💵 เงินสด</button>
    </div>
    <div id="payBox"></div>
    <p class="err" id="payErr" hidden></p>
    <button class="btn big ok" id="payConfirm"></button>`;
  renderPayBox();
}

function renderPayBox() {
  const box = qs('#payBox'); if (!box) return;
  if (billMethod === 'promptpay') {
    if (!parsePromptPayId(shopSettings.promptpay_id)) {
      box.innerHTML = '<div class="help warn">ยังไม่ได้ตั้งเลข PromptPay ของร้าน ให้แอดมินไปที่ หลังบ้าน → ตั้งค่าร้าน หรือเลือกรับเงินสดแทน</div>';
    } else {
      box.innerHTML = `<div class="qrbox"><canvas id="payQr" width="240" height="240"></canvas>
        <div class="qr-amt" id="qrAmt"></div>
        <div class="muted">${esc(shopSettings.promptpay_name || '')}</div>
        <div class="muted">ให้ลูกค้าสแกนด้วยแอปธนาคาร เห็นเงินเข้าแล้วกดยืนยันด้านล่าง</div></div>`;
      drawQr();
    }
  } else {
    box.innerHTML = `<div class="cash-box"><label for="cashIn">รับเงินมา (บาท)</label>
      <input id="cashIn" class="input" type="number" min="0" step="1" inputmode="decimal" value="${esc(billCash)}">
      <div class="quick"><button type="button" data-cash="exact">พอดี</button><button type="button" data-cash="100">100</button><button type="button" data-cash="500">500</button><button type="button" data-cash="1000">1,000</button></div>
      <div class="change" id="changeTxt"></div></div>`;
  }
  updatePayUi();
}

function drawQr() {
  const c = qs('#payQr'); const total = netTotal();
  if (!c || total <= 0) return;
  QRCode.toCanvas(c, promptPayPayload(shopSettings.promptpay_id, total), { width: 480, margin: 2, errorCorrectionLevel: 'M' });
}

// อัปเดตเฉพาะตัวเลข/ปุ่ม ไม่วาดช่องกรอกใหม่ (ไม่งั้นพิมพ์ไม่ได้ต่อเนื่อง)
function updatePayUi() {
  const b = selBill(); if (!b || !qs('#payConfirm')) return;
  const t = billTotals(b), total = netTotal();
  qs('#dTotal').textContent = baht(total);
  const amt = qs('#qrAmt'); if (amt) amt.textContent = baht(total);
  const cash = Number(billCash) || 0, change = r2(cash - total);
  const ct = qs('#changeTxt'); if (ct) ct.innerHTML = billCash === '' ? '' : change >= 0 ? `เงินทอน <b>${baht(change)}</b>` : `<span class="short">ยังขาด ${baht(-change)}</span>`;
  let ok = t.orders.length > 0 && !t.pending.length && total > 0;
  if (billMethod === 'cash') ok = ok && cash >= total;
  else ok = ok && !!parsePromptPayId(shopSettings.promptpay_id);
  const btn = qs('#payConfirm');
  btn.disabled = !ok || payBusy;
  btn.textContent = payBusy ? 'กำลังบันทึก...' : billMethod === 'promptpay' ? `ได้รับเงินแล้ว ${baht(total)}` : `รับเงินสด ${baht(total)}`;
}

qs('#billDetail').addEventListener('input', e => {
  if (e.target.id === 'dDisc') { billDiscount = e.target.value; if (billMethod === 'promptpay') drawQr(); updatePayUi(); }
  if (e.target.id === 'cashIn') { billCash = e.target.value; updatePayUi(); }
});

qs('#billDetail').addEventListener('click', async e => {
  const m = e.target.closest('#payMethod button');
  if (m) { billMethod = m.dataset.m; qs('#payMethod').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === m)); renderPayBox(); return; }
  const q = e.target.closest('[data-cash]');
  if (q) { billCash = q.dataset.cash === 'exact' ? String(netTotal()) : q.dataset.cash; qs('#cashIn').value = billCash; updatePayUi(); return; }
  if (e.target.closest('#payConfirm')) return payBill();
  if (e.target.closest('[data-print]')) return printHtml(`<div class="receipt print">${receiptInner(selPaid)}</div>`);
  const co = e.target.closest('[data-cancel-order]');
  if (co) {
    if (!confirm('ยกเลิกออเดอร์นี้? รายการจะไม่ถูกนับในบิล')) return;
    const { error } = await sb.from('orders').update({ status: 'cancelled' }).eq('id', co.dataset.cancelOrder);
    if (error) return toast('ยกเลิกไม่สำเร็จ ลองอีกครั้ง');
    await refreshBills(); renderBills(); if (typeof refresh === 'function') refresh(); return;
  }
  if (e.target.closest('[data-void]')) {
    const b = selBill(); const has = billTotals(b).orders.length;
    if (!confirm(has ? 'ยกเลิกทั้งบิล? ออเดอร์ในบิลจะถูกยกเลิกทั้งหมด' : 'ลบบิลว่างนี้?')) return;
    const { error } = await sb.rpc('void_bill', { p_bill_id: b.id });
    if (error) return toast(error.message, 4000);
    selBillId = null; await refreshBills(); renderBills(); if (typeof refresh === 'function') refresh(); return;
  }
  if (e.target.closest('[data-voidpaid]')) {
    if (!confirm(`ยกเลิกบิล #${selPaid.id}? ยอดนี้จะไม่ถูกนับในรายงาน (ใช้เมื่อบันทึกผิดเท่านั้น)`)) return;
    const { error } = await sb.rpc('void_bill', { p_bill_id: selPaid.id });
    if (error) return toast(error.message, 4000);
    selPaid = null; await loadPaidToday(); renderBills(); toast('ยกเลิกบิลแล้ว');
  }
});

async function payBill() {
  const b = selBill(); if (!b || payBusy) return;
  payBusy = true; updatePayUi();
  const err = qs('#payErr'); err.hidden = true;
  const { data, error } = await sb.rpc('close_bill', {
    p_bill_id: b.id, p_method: billMethod, p_discount: discountVal(), p_cash: billMethod === 'cash' ? Number(billCash) : null
  });
  payBusy = false;
  if (error) { err.hidden = false; err.textContent = error.message || 'เก็บเงินไม่สำเร็จ ลองอีกครั้ง'; updatePayUi(); return; }
  toast('รับเงินแล้ว ' + baht(data.total));
  selBillId = null; resetPayState();
  await refreshBills(); renderBills();
  const { data: full } = await sb.from('bills').select(BILL_SELECT).eq('id', b.id).single();
  if (full) showReceipt(full);
}

// ---------- ใบเสร็จ ----------
function receiptInner(b) {
  const lines = new Map();
  billTotals(b).orders.forEach(o => o.order_items.forEach(i => {
    const key = [i.name, optionsText(i.options), i.note || '', i.unit_price].join('|');
    const l = lines.get(key) || { name: i.name, opt: optionsText(i.options), note: i.note, price: i.unit_price, qty: 0 };
    l.qty += i.qty; lines.set(key, l);
  }));
  const paid = b.status === 'paid';
  const sub = paid ? Number(b.subtotal) : billTotals(b).sub;
  return `
    <div class="r-head"><b class="r-shop">${esc(CONFIG.SHOP_NAME)}</b><div>ใบเสร็จรับเงิน</div>
      <div class="muted">บิล #${b.id} · ${esc(whereOf(b))}</div><div class="muted">${fmtDateTime(b.paid_at || b.created_at)}</div></div>
    <div class="r-lines">${[...lines.values()].map(l => `
      <div class="r-row"><span class="grow">${l.qty}× ${esc(l.name)}${l.opt ? `<small> ${esc(l.opt)}</small>` : ''}${l.note ? `<small> · ${esc(l.note)}</small>` : ''}</span><span>${baht(l.price * l.qty)}</span></div>`).join('')}</div>
    <div class="r-tot">
      <div class="r-row"><span class="grow">รวม</span><span>${baht(sub)}</span></div>
      ${paid && Number(b.discount) > 0 ? `<div class="r-row"><span class="grow">ส่วนลด</span><span>−${baht(b.discount)}</span></div>` : ''}
      <div class="r-row grand"><span class="grow">ยอดสุทธิ</span><span>${baht(paid ? b.total : sub)}</span></div>
      ${paid ? `<div class="r-row"><span class="grow">ชำระด้วย ${b.payment_method === 'cash' ? 'เงินสด' : 'PromptPay'}</span><span>${b.payment_method === 'cash' ? 'รับ ' + baht(b.cash_received) : ''}</span></div>
        ${b.payment_method === 'cash' ? `<div class="r-row"><span class="grow">เงินทอน</span><span>${baht(r2(b.cash_received - b.total))}</span></div>` : ''}` : ''}
    </div>
    <div class="r-foot">${esc(shopSettings.receipt_note || 'ขอบคุณที่ใช้บริการ')}</div>`;
}

function showReceipt(b) {
  const dlg = document.createElement('dialog'); dlg.className = 'sheet';
  dlg.innerHTML = `<div class="sheet-body"><div class="receipt-view">${receiptInner(b)}</div>
    <div class="row sheet-foot"><button class="btn ghost grow" data-print>พิมพ์ใบเสร็จ</button><button class="btn grow" data-close>เสร็จสิ้น</button></div></div>`;
  dlg.addEventListener('click', e => {
    if (e.target === dlg || e.target.closest('[data-close]')) return dlg.close();
    if (e.target.closest('[data-print]')) printHtml(`<div class="receipt print">${receiptInner(b)}</div>`);
  });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.appendChild(dlg); dlg.showModal();
}
