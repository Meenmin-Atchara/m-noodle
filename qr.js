// หน้าพิมพ์ QR: ลิงก์ของแต่ละโต๊ะคือ  <โดเมนของเว็บ>/order.html?t=<id โต๊ะ>
const $ = s => document.querySelector(s);

async function init() {
  if (/^(localhost|127\.|192\.168\.)/.test(location.hostname)) $('#warn').hidden = false;
  const { data, error } = await sb.from('tables').select('*').eq('active', true).order('id');
  if (error || !data) { const f = $('#fatal'); f.hidden = false; f.textContent = 'โหลดรายชื่อโต๊ะไม่สำเร็จ ลองรีเฟรชหน้านี้'; return; }
  if (!data.length) { const f = $('#fatal'); f.hidden = false; f.textContent = 'ยังไม่มีโต๊ะที่เปิดใช้งาน ไปเพิ่มที่หลังบ้านก่อน'; return; }
  $('#grid').innerHTML = data.map(t => `
    <article class="qrcard">
      <div class="qr-brand"><span class="logo" data-bowl></span><b>${esc(CONFIG.SHOP_NAME)}</b></div>
      <canvas data-t="${t.id}"></canvas>
      <div class="qr-table">${esc(t.name)}</div>
      <div class="qr-hint">สแกนเพื่อสั่งอาหาร</div>
      <div class="qr-sub">จ่ายเงินตอนเรียกเก็บ</div>
    </article>`).join('');
  document.querySelectorAll('[data-bowl]').forEach(el => { el.innerHTML = BOWL_SVG; });
  document.querySelectorAll('canvas[data-t]').forEach(c => {
    QRCode.toCanvas(c, `${location.origin}/order.html?t=${c.dataset.t}`, { width: 600, margin: 1, errorCorrectionLevel: 'M' });
  });
}
$('#printBtn').onclick = () => window.print();
init();
