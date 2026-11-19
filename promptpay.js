// สร้างข้อความสำหรับ QR PromptPay (มาตรฐาน Thai QR Payment / EMVCo) ในเบราว์เซอร์ ไม่ต้องใช้บริการภายนอก
// รองรับ: เบอร์มือถือ 10 หลัก, เลขบัตรประชาชน/เลขผู้เสียภาษี 13 หลัก, e-wallet ID 15 หลัก

function ppField(id, value) { return id + String(value.length).padStart(2, '0') + value; }

// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) คำนวณจากข้อความทั้งหมดรวม "6304"
function ppCrc16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// คืน { kind, tag, value } หรือ null ถ้ารูปแบบไม่ถูกต้อง
function parsePromptPayId(raw) {
  const d = String(raw || '').replace(/[\s-]/g, '');
  if (!/^\d+$/.test(d)) return null;
  if (d.length === 10 && d[0] === '0') return { kind: 'เบอร์มือถือ', tag: '01', value: '0066' + d.slice(1) };
  if (d.length === 13) return { kind: 'เลขบัตรประชาชน/เลขผู้เสียภาษี', tag: '02', value: d };
  if (d.length === 15) return { kind: 'e-Wallet ID', tag: '03', value: d };
  return null;
}

// amount เป็นบาท (ทศนิยม 2 ตำแหน่ง) ถ้าไม่ใส่จะเป็น QR แบบไม่ระบุยอด
function promptPayPayload(id, amount) {
  const t = parsePromptPayId(id);
  if (!t) throw new Error('เลข PromptPay ไม่ถูกต้อง');
  const withAmount = amount != null && Number(amount) > 0;
  let s = ppField('00', '01')
        + ppField('01', withAmount ? '12' : '11')
        + ppField('29', ppField('00', 'A000000677010111') + ppField(t.tag, t.value))
        + ppField('53', '764')
        + (withAmount ? ppField('54', Number(amount).toFixed(2)) : '')
        + ppField('58', 'TH')
        + '6304';
  return s + ppCrc16(s);
}
