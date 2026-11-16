// ใส่ค่าจาก Supabase: Project Settings > API
// anon key เป็นกุญแจสาธารณะ วางในหน้าเว็บได้ ความปลอดภัยคุมด้วย RLS ใน schema.sql
const CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-ANON-KEY',
  SHOP_NAME: 'ร้านก๋วยเตี๋ยว'   // เปลี่ยนเป็นชื่อร้านจริง
};
