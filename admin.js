// หลังบ้าน: จัดการเมนู โต๊ะ+QR สมาชิก  (แอดมินทำได้ทั้งหมด / พนักงานปิด-เปิดเมนูหมดได้อย่างเดียว)
const $ = s => document.querySelector(s);
const BUCKET = 'menu-images';
let role = null, menu = [], tables = [], started = false;

const errText = e => (e && e.message) ? e.message : 'ไม่สำเร็จ ลองอีกครั้ง';

// ---------- ล็อกอิน ----------
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  const { error } = await sb.auth.signInWithPassword({ email: $('#email').value, password: $('#password').value });
  const err = $('#loginErr');
  err.hidden = !error;
  if (error) err.textContent = 'อีเมลหรือรหัสผ่านไม่ถูกต้อง';
};
$('#logout').onclick = () => sb.auth.signOut();

async function showSession(session) {
  if (!session) {
    started = false;
    $('#loginView').hidden = false; $('#appView').hidden = true;
    return;
  }
  if (started) return;
  const { data, error } = await sb.rpc('my_role');
  if (error || !data) {
    const err = $('#loginErr'); err.hidden = false;
    err.textContent = error ? 'ตรวจสอบสิทธิ์ไม่สำเร็จ (ลองรัน admin.sql ใน Supabase แล้วหรือยัง)' : 'บัญชีนี้ยังไม่ได้รับสิทธิ์ ให้แอดมินกำหนดสิทธิ์ก่อน';
    await sb.auth.signOut();
    return;
  }
  started = true; role = data;
  document.body.classList.toggle('is-staff', role !== 'admin');
  $('#roleLabel').textContent = role === 'admin' ? 'แอดมิน' : 'พนักงาน (ปิด/เปิดเมนูหมดได้)';
  $('#shop').textContent = CONFIG.SHOP_NAME + ' · หลังบ้าน';
  $('#loginView').hidden = true; $('#appView').hidden = false;
  await loadAll();
}
sb.auth.getSession().then(({ data }) => showSession(data.session));
sb.auth.onAuthStateChange((evt, session) => {
  if (evt === 'SIGNED_IN' || evt === 'SIGNED_OUT') showSession(session);
});

// ---------- แท็บ ----------
$('#tabs').onclick = e => {
  const b = e.target.closest('.tab'); if (!b) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t === b));
  document.querySelectorAll('.panel').forEach(p => p.hidden = p.id !== 'panel-' + b.dataset.tab);
  if (b.dataset.tab === 'members') loadMembers();
  if (b.dataset.tab === 'settings') loadSettings();
};

async function loadAll() {
  const [m, t] = await Promise.all([
    sb.from('menu_items').select('*').order('sort').order('id'),
    sb.from('tables').select('*').order('id')
  ]);
  menu = m.data || []; tables = t.data || [];
  renderMenu(); renderTables();
}

// =====================================================================
// เมนู
// =====================================================================
function renderMenu() {
  const cats = [...new Set(menu.map(m => m.category))];
  $('#menuHint').textContent = menu.length
    ? (role === 'admin' ? `${menu.length} เมนู · เปิดสวิตช์เมื่อพร้อมขาย ปิดเมื่อของหมด` : 'เปิดสวิตช์เมื่อพร้อมขาย ปิดเมื่อของหมด')
    : '';
  $('#menuList').innerHTML = menu.length ? cats.map((c, ci) => `
    <h2 class="cat">${catIcon(c)} ${esc(c)}</h2>
    <div class="rows">${menu.filter(m => m.category === c).map(m => `
      <div class="mrow t${ci % 4} ${m.available ? '' : 'off'}" data-id="${m.id}">
        <div class="thumb">${thumbInner(m)}</div>
        <div class="info">
          <div class="item-name">${esc(m.name)}</div>
          <div class="item-price">${baht(m.price)}<span class="tag">${(m.options || []).length ? (m.options || []).length + ' กลุ่มตัวเลือก' : ''}</span></div>
        </div>
        <label class="switch"><input type="checkbox" data-avail ${m.available ? 'checked' : ''}><span></span><em>${m.available ? 'พร้อมขาย' : 'หมด'}</em></label>
        <button class="btn ghost sm admin-only" data-edit>แก้ไข</button>
      </div>`).join('')}</div>`).join('')
    : '<p class="empty">ยังไม่มีเมนู กด "+ เพิ่มเมนู" เพื่อเริ่มต้น</p>';
}

$('#menuList').addEventListener('change', async e => {
  const cb = e.target.closest('[data-avail]'); if (!cb) return;
  const row = cb.closest('.mrow'); const id = +row.dataset.id;
  const { error } = await sb.rpc('set_menu_available', { p_id: id, p_available: cb.checked });
  if (error) { cb.checked = !cb.checked; toast('บันทึกไม่สำเร็จ: ' + errText(error)); return; }
  const m = menu.find(x => x.id === id); m.available = cb.checked;
  row.classList.toggle('off', !cb.checked);
  row.querySelector('em').textContent = cb.checked ? 'พร้อมขาย' : 'หมด';
});
$('#menuList').addEventListener('click', e => {
  const b = e.target.closest('[data-edit]'); if (!b) return;
  openEditor(menu.find(m => m.id === +b.closest('.mrow').dataset.id));
});
$('#addMenu').onclick = () => openEditor(null);

// ย่อรูปในเครื่องก่อนอัปโหลด (รูปจากมือถือใหญ่หลาย MB)
async function resizeImage(file, max = 900) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.82));
}
const pathFromUrl = url => (url && url.includes('/' + BUCKET + '/')) ? decodeURIComponent(url.split('/' + BUCKET + '/')[1].split('?')[0]) : null;

function openEditor(item) {
  const isNew = !item;
  const cats = [...new Set(menu.map(m => m.category))];
  const draft = item ? JSON.parse(JSON.stringify(item)) : {
    name: '', category: cats[0] || 'ก๋วยเตี๋ยว', price: '', sort: Math.max(0, ...menu.map(m => m.sort || 0)) + 1,
    image_url: null, options: [], available: true
  };
  draft.options = (draft.options || []).map(g => ({
    name: g.name || '', required: !!g.required,
    choices: (g.choices || []).map(c => ({ name: c.name || '', price: Number(c.price) || 0 }))
  }));
  let pendingBlob = null, removeImage = false, previewUrl = null, saving = false;

  const dlg = document.createElement('dialog');
  dlg.className = 'sheet wide';

  const imgHtml = () => {
    if (previewUrl) return `<img src="${esc(previewUrl)}" alt="">`;
    if (draft.image_url && !removeImage) return `<img src="${esc(draft.image_url)}" alt="">`;
    return catIcon(draft.category);
  };

  function render() {
    dlg.innerHTML = `
    <form class="sheet-body" novalidate>
      <h3>${isNew ? 'เพิ่มเมนูใหม่' : 'แก้ไขเมนู'}</h3>
      <div class="imgbox">
        <div class="thumb">${imgHtml()}</div>
        <div>
          <input type="file" id="mfile" accept="image/jpeg,image/png,image/webp" hidden>
          <div class="row"><button type="button" class="btn ghost sm" data-pick>เลือกรูป</button>
          <button type="button" class="btn danger sm" data-delimg>ลบรูป</button></div>
          <div class="muted" style="margin-top:6px">ระบบย่อรูปให้อัตโนมัติ ใช้รูปแนวนอนจะสวยที่สุด</div>
        </div>
      </div>
      <div class="field"><label>ชื่อเมนู</label><input class="input" id="f-name" value="${esc(draft.name)}" maxlength="80"></div>
      <div class="grid2">
        <div class="field"><label>หมวด</label><input class="input" id="f-cat" list="catlist" value="${esc(draft.category)}" maxlength="40">
          <datalist id="catlist">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
        <div class="field"><label>ราคา (บาท)</label><input class="input" id="f-price" type="number" min="0" step="1" inputmode="decimal" value="${esc(draft.price)}"></div>
      </div>
      <div class="field"><label>ลำดับที่แสดง (เลขน้อยขึ้นก่อน)</label><input class="input" id="f-sort" type="number" step="1" value="${esc(draft.sort)}"></div>
      <div class="lbl">ตัวเลือกเพิ่มเติม <span class="muted">เช่น เส้น ขนาด ท็อปปิ้ง</span></div>
      ${draft.options.map((g, gi) => `
        <div class="og" data-g="${gi}">
          <div class="crow"><input class="input" data-f="gname" placeholder="ชื่อกลุ่ม เช่น เส้น" value="${esc(g.name)}" maxlength="40">
            <button type="button" class="btn danger sm" data-delg>ลบกลุ่ม</button></div>
          <label class="switch"><input type="checkbox" data-f="req" ${g.required ? 'checked' : ''}><span></span><em>ลูกค้าต้องเลือก 1 อย่าง</em></label>
          ${g.choices.map((c, ci) => `
            <div class="crow" data-c="${ci}"><input class="input" data-f="cname" placeholder="ชื่อตัวเลือก เช่น เส้นเล็ก" value="${esc(c.name)}" maxlength="40">
              <input class="input price" data-f="cprice" type="number" min="0" step="1" inputmode="decimal" placeholder="+บาท" value="${c.price || ''}">
              <button type="button" class="xbtn" data-delc aria-label="ลบตัวเลือก">✕</button></div>`).join('')}
          <div><button type="button" class="btn ghost sm" data-addc>+ เพิ่มตัวเลือก</button></div>
        </div>`).join('')}
      <div><button type="button" class="btn ghost sm" data-addg>+ เพิ่มกลุ่มตัวเลือก</button></div>
      <p class="err" id="merr" hidden></p>
      <div class="row sheet-foot">
        ${isNew ? '' : '<button type="button" class="btn danger" data-delete>ลบเมนู</button>'}
        <span class="grow"></span>
        <button type="button" class="btn ghost" data-cancel>ยกเลิก</button>
        <button type="button" class="btn" data-save>บันทึก</button>
      </div>
    </form>`;
  }

  function readForm() {
    draft.name = dlg.querySelector('#f-name').value.trim();
    draft.category = dlg.querySelector('#f-cat').value.trim();
    draft.price = dlg.querySelector('#f-price').value;
    draft.sort = dlg.querySelector('#f-sort').value;
    draft.options = [...dlg.querySelectorAll('.og')].map(og => ({
      name: og.querySelector('[data-f=gname]').value.trim(),
      required: og.querySelector('[data-f=req]').checked,
      choices: [...og.querySelectorAll('.crow[data-c]')].map(r => ({
        name: r.querySelector('[data-f=cname]').value.trim(), price: r.querySelector('[data-f=cprice]').value
      }))
    }));
  }
  const showErr = msg => { const e = dlg.querySelector('#merr'); e.hidden = false; e.textContent = msg; e.scrollIntoView({ block: 'nearest' }); };

  async function save() {
    if (saving) return;
    readForm();
    const price = Number(draft.price);
    if (!draft.name) return showErr('ใส่ชื่อเมนูก่อน');
    if (!draft.category) return showErr('ใส่หมวดเมนูก่อน (เช่น ก๋วยเตี๋ยว)');
    if (draft.price === '' || !(price >= 0)) return showErr('ใส่ราคาเป็นตัวเลข');
    const options = [];
    for (const g of draft.options) {
      const choices = g.choices.filter(c => c.name).map(c => ({ name: c.name, price: Number(c.price) || 0 }));
      if (!g.name && !choices.length) continue;
      if (!g.name) return showErr('ใส่ชื่อกลุ่มตัวเลือกด้วย (เช่น เส้น)');
      if (!choices.length) return showErr(`กลุ่ม "${g.name}" ยังไม่มีตัวเลือก`);
      options.push({ name: g.name, required: g.required, choices });
    }
    saving = true;
    const saveBtn = dlg.querySelector('[data-save]'); saveBtn.disabled = true; saveBtn.textContent = 'กำลังบันทึก...';
    let image_url = removeImage ? null : draft.image_url;
    let uploaded = null;
    try {
      if (pendingBlob) {
        uploaded = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.jpg`;
        const up = await sb.storage.from(BUCKET).upload(uploaded, pendingBlob, { contentType: 'image/jpeg', cacheControl: '31536000' });
        if (up.error) throw up.error;
        image_url = sb.storage.from(BUCKET).getPublicUrl(uploaded).data.publicUrl;
      }
      const row = { name: draft.name, category: draft.category, price, sort: Number(draft.sort) || 0, image_url, options };
      const res = isNew ? await sb.from('menu_items').insert(row) : await sb.from('menu_items').update(row).eq('id', item.id);
      if (res.error) throw res.error;
      if ((pendingBlob || removeImage) && !isNew) {
        const old = pathFromUrl(item.image_url);
        if (old) sb.storage.from(BUCKET).remove([old]);
      }
    } catch (e) {
      console.error(e);
      if (uploaded) sb.storage.from(BUCKET).remove([uploaded]);
      saving = false; saveBtn.disabled = false; saveBtn.textContent = 'บันทึก';
      return showErr('บันทึกไม่สำเร็จ: ' + errText(e));
    }
    dlg.close(); toast(isNew ? 'เพิ่มเมนูแล้ว' : 'บันทึกแล้ว'); loadAll();
  }

  async function del() {
    if (!confirm(`ลบ "${item.name}" ถาวร?\nประวัติออเดอร์เก่ายังอยู่ ถ้าแค่ของหมดให้ปิดสวิตช์พร้อมขายแทน`)) return;
    const { error } = await sb.from('menu_items').delete().eq('id', item.id);
    if (error) return showErr('ลบไม่สำเร็จ: ' + errText(error));
    const old = pathFromUrl(item.image_url);
    if (old) sb.storage.from(BUCKET).remove([old]);
    dlg.close(); toast('ลบเมนูแล้ว'); loadAll();
  }

  dlg.addEventListener('click', async e => {
    const t = e.target;
    if (t === dlg) return dlg.close();
    if (t.closest('[data-cancel]')) return dlg.close();
    if (t.closest('[data-save]')) return save();
    if (t.closest('[data-delete]')) return del();
    if (t.closest('[data-pick]')) return dlg.querySelector('#mfile').click();
    if (t.closest('[data-delimg]')) { readForm(); pendingBlob = null; previewUrl = null; removeImage = true; return render(); }
    if (t.closest('[data-addg]')) { readForm(); draft.options.push({ name: '', required: false, choices: [{ name: '', price: '' }] }); return render(); }
    const og = t.closest('.og');
    if (og && t.closest('[data-delg]')) { readForm(); draft.options.splice(+og.dataset.g, 1); return render(); }
    if (og && t.closest('[data-addc]')) { readForm(); draft.options[+og.dataset.g].choices.push({ name: '', price: '' }); return render(); }
    const cr = t.closest('.crow[data-c]');
    if (og && cr && t.closest('[data-delc]')) { readForm(); draft.options[+og.dataset.g].choices.splice(+cr.dataset.c, 1); return render(); }
  });
  dlg.addEventListener('change', async e => {
    if (e.target.id !== 'mfile' || !e.target.files[0]) return;
    try {
      readForm();
      pendingBlob = await resizeImage(e.target.files[0]);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(pendingBlob); removeImage = false;
      render();
    } catch (err) { console.error(err); showErr('อ่านรูปนี้ไม่ได้ ลองรูปอื่น (JPG/PNG/WebP)'); }
  });
  dlg.addEventListener('close', () => { if (previewUrl) URL.revokeObjectURL(previewUrl); dlg.remove(); });
  document.body.appendChild(dlg);
  render();
  dlg.showModal();
}

// =====================================================================
// โต๊ะและ QR
// =====================================================================
function renderTables() {
  $('#tableList').innerHTML = tables.length ? `<div class="rows">${tables.map(t => `
    <div class="mrow ${t.active ? '' : 'off'}" data-id="${t.id}">
      <div class="thumb" style="width:48px;height:48px;font-size:1.4rem">🪑</div>
      <div class="info"><input class="input" data-name value="${esc(t.name)}" maxlength="30" aria-label="ชื่อโต๊ะ"></div>
      <label class="switch"><input type="checkbox" data-active ${t.active ? 'checked' : ''}><span></span><em>${t.active ? 'เปิดใช้' : 'ปิด'}</em></label>
      <button class="btn ghost sm" data-qr>ดู QR</button>
    </div>`).join('')}</div>` : '<p class="empty">ยังไม่มีโต๊ะ กด "+ เพิ่มโต๊ะ"</p>';
}

$('#addTable').onclick = async () => {
  const { error } = await sb.from('tables').insert({ name: 'โต๊ะ ' + (tables.length + 1) });
  if (error) return toast('เพิ่มไม่สำเร็จ: ' + errText(error));
  toast('เพิ่มโต๊ะแล้ว แก้ชื่อได้ในช่องได้เลย'); loadAll();
};
$('#tableList').addEventListener('change', async e => {
  const row = e.target.closest('.mrow'); if (!row) return;
  const id = +row.dataset.id;
  let patch;
  if (e.target.matches('[data-name]')) {
    const name = e.target.value.trim();
    if (!name) { e.target.value = tables.find(t => t.id === id).name; return; }
    patch = { name };
  } else if (e.target.matches('[data-active]')) patch = { active: e.target.checked };
  else return;
  const { error } = await sb.from('tables').update(patch).eq('id', id);
  if (error) { toast('บันทึกไม่สำเร็จ: ' + errText(error)); return loadAll(); }
  Object.assign(tables.find(t => t.id === id), patch);
  if ('active' in patch) { row.classList.toggle('off', !patch.active); row.querySelector('em').textContent = patch.active ? 'เปิดใช้' : 'ปิด'; }
  toast('บันทึกแล้ว');
});
$('#tableList').addEventListener('click', e => {
  const b = e.target.closest('[data-qr]'); if (!b) return;
  openQr(tables.find(t => t.id === +b.closest('.mrow').dataset.id));
});

function openQr(t) {
  const url = `${location.origin}/order.html?t=${t.id}`;
  const dlg = document.createElement('dialog'); dlg.className = 'sheet';
  dlg.innerHTML = `<div class="sheet-body center">
    <h3>${esc(t.name)}</h3>
    <canvas id="qrc" style="width:260px;height:260px;margin:0 auto"></canvas>
    <p class="muted" style="word-break:break-all;margin:0">${esc(url)}</p>
    ${/^(localhost|127\.|192\.168\.)/.test(location.hostname) ? '<p class="err">เปิดจากเครื่องตัวเอง QR นี้ใช้สแกนด้วยมือถือไม่ได้ ให้เปิดจากเว็บจริง</p>' : ''}
    <div class="row sheet-foot"><button class="btn ghost grow" data-copy>คัดลอกลิงก์</button><button class="btn grow" data-dl>ดาวน์โหลดรูป</button><button class="btn ghost" data-close>ปิด</button></div></div>`;
  document.body.appendChild(dlg);
  const canvas = dlg.querySelector('#qrc');
  QRCode.toCanvas(canvas, url, { width: 520, margin: 2, errorCorrectionLevel: 'M' });
  dlg.addEventListener('click', async e => {
    if (e.target === dlg || e.target.closest('[data-close]')) return dlg.close();
    if (e.target.closest('[data-copy]')) { try { await navigator.clipboard.writeText(url); toast('คัดลอกแล้ว'); } catch { toast('คัดลอกไม่ได้ ลองกดค้างที่ลิงก์'); } }
    if (e.target.closest('[data-dl]')) { const a = document.createElement('a'); a.href = canvas.toDataURL('image/png'); a.download = `qr-${t.name}.png`; a.click(); }
  });
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}

// =====================================================================
// สมาชิก
// =====================================================================
const ROLE_TH = { none: 'ไม่มีสิทธิ์', staff: 'พนักงาน', admin: 'แอดมิน' };
async function loadMembers() {
  const box = $('#memberList');
  box.innerHTML = '<p class="empty">กำลังโหลด...</p>';
  const { data, error } = await sb.rpc('list_members');
  if (error) { box.innerHTML = `<p class="err">โหลดรายชื่อไม่สำเร็จ: ${esc(errText(error))}</p>`; return; }
  const fmt = d => d ? new Date(d).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : 'ยังไม่เคยเข้า';
  box.innerHTML = `<div class="rows">${data.map(m => `
    <div class="mem" data-user="${m.user_id}">
      <div><b>${esc(m.email)}</b><div class="muted">เข้าล่าสุด ${fmt(m.last_sign_in_at)}</div></div>
      <input class="input" data-mname placeholder="ชื่อเรียก (ไม่บังคับ)" value="${esc(m.name || '')}" maxlength="40">
      <select class="input" data-role>${['none', 'staff', 'admin'].map(r => `<option value="${r}" ${(m.role || 'none') === r ? 'selected' : ''}>${ROLE_TH[r]}</option>`).join('')}</select>
      <label class="switch"><input type="checkbox" data-mactive ${m.role ? (m.active ? 'checked' : '') : 'checked'}><span></span><em>ใช้งาน</em></label>
      <button class="btn sm" data-msave disabled>บันทึก</button>
    </div>`).join('')}</div>`;
}
$('#reloadMembers').onclick = loadMembers;
$('#memberList').addEventListener('input', e => { const r = e.target.closest('.mem'); if (r) r.querySelector('[data-msave]').disabled = false; });
$('#memberList').addEventListener('change', e => { const r = e.target.closest('.mem'); if (r) r.querySelector('[data-msave]').disabled = false; });
$('#memberList').addEventListener('click', async e => {
  const b = e.target.closest('[data-msave]'); if (!b) return;
  const r = b.closest('.mem');
  const roleVal = r.querySelector('[data-role]').value;
  b.disabled = true;
  const { error } = await sb.rpc('set_member', {
    p_user: r.dataset.user, p_role: roleVal, p_name: r.querySelector('[data-mname]').value, p_active: r.querySelector('[data-mactive]').checked
  });
  if (error) { toast(errText(error), 4000); b.disabled = false; return; }
  toast('บันทึกแล้ว'); loadMembers();
});

// =====================================================================
// ตั้งค่าร้าน (ชื่อร้าน / PromptPay / ปิดรับออเดอร์ผ่าน QR)
// =====================================================================
async function loadSettings() {
  const err = $('#sErr'); err.hidden = true;
  const { data, error } = await sb.from('shop_settings').select('*').eq('id', 1).maybeSingle();
  if (error) { err.hidden = false; err.textContent = 'โหลดไม่สำเร็จ ลองรัน billing.sql ใน Supabase แล้วหรือยัง'; return; }
  const s = data || {};
  $('#sShop').value = s.shop_name || CONFIG.SHOP_NAME || '';
  $('#sPP').value = s.promptpay_id || '';
  $('#sPPName').value = s.promptpay_name || '';
  $('#sNote').value = s.receipt_note || '';
  $('#sAccept').checked = s.accepting_orders !== false;
  checkPP();
}
function checkPP() {
  const v = $('#sPP').value.trim(), hint = $('#sPPHint');
  if (!v) { hint.textContent = 'ยังไม่ได้ตั้ง จะเก็บเงินด้วย PromptPay ไม่ได้ (รับเงินสดได้)'; return true; }
  const t = parsePromptPayId(v);
  hint.textContent = t ? '✓ รูปแบบถูกต้อง: ' + t.kind : 'รูปแบบไม่ถูกต้อง ต้องเป็นเบอร์ 10 หลักขึ้นต้นด้วย 0, เลข 13 หลัก หรือเลข 15 หลัก';
  return !!t;
}
$('#sPP').addEventListener('input', checkPP);
$('#sSave').onclick = async () => {
  const err = $('#sErr'); err.hidden = true;
  if (!checkPP()) { err.hidden = false; err.textContent = 'เลข PromptPay ไม่ถูกต้อง'; return; }
  const pp = $('#sPP').value.replace(/[\s-]/g, '');
  const b = $('#sSave'); b.disabled = true;
  const { error } = await sb.from('shop_settings').update({
    shop_name: $('#sShop').value.trim() || null, promptpay_id: pp || null,
    promptpay_name: $('#sPPName').value.trim() || null, receipt_note: $('#sNote').value.trim() || null,
    accepting_orders: $('#sAccept').checked
  }).eq('id', 1);
  b.disabled = false;
  if (error) { err.hidden = false; err.textContent = 'บันทึกไม่สำเร็จ: ' + errText(error); return; }
  toast('บันทึกการตั้งค่าแล้ว');
};
$('#sPreview').onclick = () => {
  const err = $('#sErr'); err.hidden = true;
  const v = $('#sPP').value.trim();
  if (!v || !parsePromptPayId(v)) { err.hidden = false; err.textContent = 'ใส่เลข PromptPay ที่ถูกต้องก่อน'; return; }
  const dlg = document.createElement('dialog'); dlg.className = 'sheet';
  dlg.innerHTML = `<div class="sheet-body"><h3>QR ตัวอย่าง (ไม่ระบุยอด)</h3>
    <div class="qrbox"><canvas width="240" height="240"></canvas><div class="muted">${esc($('#sPPName').value)}</div></div>
    <p class="muted center" style="margin:0">ลองสแกนด้วยแอปธนาคาร ชื่อบัญชีที่ขึ้นต้องเป็นของร้าน</p>
    <div class="row sheet-foot"><button class="btn grow" data-close>ปิด</button></div></div>`;
  dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.appendChild(dlg); dlg.showModal();
  QRCode.toCanvas(dlg.querySelector('canvas'), promptPayPayload(v), { width: 480, margin: 2, errorCorrectionLevel: 'M' });
};
