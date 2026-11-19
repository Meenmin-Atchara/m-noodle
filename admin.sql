-- =====================================================================
-- เฟส 3: หลังบ้านแอดมิน
-- วางใน Supabase > SQL Editor แล้วกด Run (รันครั้งเดียว หลังจากรัน schema.sql แล้ว)
-- ต้องรันไฟล์นี้ "ก่อน" อัปโหลดโค้ดหน้าเว็บชุดใหม่ขึ้น GitHub
-- =====================================================================

-- 1) สมาชิกและบทบาท ---------------------------------------------------
-- admin = จัดการได้ทุกอย่าง, staff = รับออเดอร์/จัดการคิว/ปิด-เปิดเมนูหมด
-- คนที่ล็อกอินได้แต่ไม่มีแถวในตารางนี้ = ไม่มีสิทธิ์อะไรเลย
create table if not exists staff_members (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null check (role in ('admin','staff')),
  name       text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
alter table staff_members enable row level security;   -- ไม่มี policy: เข้าถึงผ่านฟังก์ชันด้านล่างเท่านั้น

create or replace function is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff_members where user_id = auth.uid() and active)
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff_members where user_id = auth.uid() and active and role = 'admin')
$$;

create or replace function my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from staff_members where user_id = auth.uid() and active
$$;

-- ตั้งบัญชีที่มีอยู่ตอนนี้เป็นแอดมิน (ทำเฉพาะตอนตารางยังว่าง จึงรันซ้ำก็ไม่ทำให้คนอื่นได้สิทธิ์เพิ่ม)
insert into staff_members (user_id, role, name)
select id, 'admin', email from auth.users
where not exists (select 1 from staff_members);

-- 2) สิทธิ์เข้าถึงตาราง (RLS) ใหม่ ------------------------------------
drop policy if exists "staff all menu"   on menu_items;
drop policy if exists "staff all tables" on tables;
drop policy if exists "staff all orders" on orders;
drop policy if exists "staff all items"  on order_items;
drop policy if exists "admin write menu"   on menu_items;
drop policy if exists "admin write tables" on tables;

-- เมนูและโต๊ะ: ทุกคนดูได้ (มีอยู่แล้ว) แต่แก้ได้เฉพาะแอดมิน
create policy "admin write menu"   on menu_items for all to authenticated using (is_admin()) with check (is_admin());
create policy "admin write tables" on tables     for all to authenticated using (is_admin()) with check (is_admin());
-- ออเดอร์: ต้องเป็นสมาชิกที่ใช้งานอยู่ (แอดมินหรือพนักงาน)
create policy "staff all orders"   on orders      for all to authenticated using (is_staff()) with check (is_staff());
create policy "staff all items"    on order_items for all to authenticated using (is_staff()) with check (is_staff());

-- ลบเมนูที่เคยขายแล้วได้ ประวัติออเดอร์ยังอยู่ (เก็บชื่อและราคาตอนขายไว้ในออเดอร์แล้ว)
alter table order_items drop constraint if exists order_items_menu_item_id_fkey;
alter table order_items add constraint order_items_menu_item_id_fkey
  foreign key (menu_item_id) references menu_items(id) on delete set null;

-- 3) ฟังก์ชัน -----------------------------------------------------------
-- สร้างออเดอร์ (ปรับให้เช็กว่าเป็นสมาชิกจริง ไม่ใช่แค่ล็อกอิน)
create or replace function create_order(
  p_table_id int, p_type text, p_source text, p_note text, p_items jsonb
) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_source text := p_source;
  v_date   date := (now() at time zone 'Asia/Bangkok')::date;
  v_queue  int;
  v_order  bigint;
  v_status text;
  it       jsonb;
  mi       menu_items%rowtype;
  extra    numeric;
begin
  if not is_staff() then v_source := 'customer'; end if;

  if p_type not in ('dine_in','takeaway') then raise exception 'invalid order type'; end if;
  if p_type = 'dine_in' and p_table_id is null then raise exception 'table required'; end if;
  if p_type = 'dine_in' and not exists (select 1 from tables where id = p_table_id and active) then
    raise exception 'invalid table';
  end if;
  if p_type = 'takeaway' and v_source = 'customer' then
    raise exception 'takeaway must be created by staff';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'empty order';
  end if;
  if jsonb_array_length(p_items) > 50 then raise exception 'too many items'; end if;

  insert into queue_counter(queue_date, last_no) values (v_date, 1)
    on conflict (queue_date) do update set last_no = queue_counter.last_no + 1
    returning last_no into v_queue;

  v_status := case when v_source = 'staff' then 'cooking' else 'pending' end;

  insert into orders(table_id, order_type, source, queue_no, queue_date, status, note)
  values (case when p_type = 'dine_in' then p_table_id end, p_type, v_source,
          v_queue, v_date, v_status, left(p_note, 300))
  returning id into v_order;

  for it in select * from jsonb_array_elements(p_items) loop
    select * into mi from menu_items
      where id = (it->>'menu_item_id')::int and available;
    if not found then raise exception 'menu item unavailable'; end if;
    if (it->>'qty')::int < 1 or (it->>'qty')::int > 50 then raise exception 'bad qty'; end if;

    select coalesce(sum((ch->>'price')::numeric), 0) into extra
    from jsonb_array_elements(mi.options) grp,
         jsonb_array_elements(grp->'choices') ch,
         jsonb_array_elements(coalesce(it->'options','[]'::jsonb)) sel
    where grp->>'name' = sel->>'group' and ch->>'name' = sel->>'choice';

    insert into order_items(order_id, menu_item_id, name, unit_price, qty, options, note)
    values (v_order, mi.id, mi.name, mi.price + extra, (it->>'qty')::int,
            coalesce(it->'options','[]'::jsonb), left(it->>'note', 200));
  end loop;

  return json_build_object('order_id', v_order, 'queue_no', v_queue, 'status', v_status);
end $$;

-- พนักงานทุกคนปิด/เปิดเมนู "หมด" ได้ โดยแก้ราคาหรือชื่อไม่ได้
create or replace function set_menu_available(p_id int, p_available boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'not allowed'; end if;
  update menu_items set available = p_available where id = p_id;
end $$;

-- รายชื่อผู้ใช้ทั้งหมด (รวมคนที่เพิ่งสร้างและยังไม่ได้ให้สิทธิ์) เฉพาะแอดมิน
create or replace function list_members() returns table (
  user_id uuid, email text, name text, role text, active boolean,
  last_sign_in_at timestamptz, created_at timestamptz
)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  return query
    select u.id, u.email::text, m.name, m.role, coalesce(m.active, false), u.last_sign_in_at, u.created_at
    from auth.users u left join staff_members m on m.user_id = u.id
    order by u.created_at;
end $$;

-- กำหนดบทบาท: p_role = 'admin' | 'staff' | 'none' (ถอนสิทธิ์)
create or replace function set_member(p_user uuid, p_role text, p_name text, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  if p_role is null or p_role = 'none' then
    delete from staff_members where user_id = p_user;
  elsif p_role in ('admin','staff') then
    insert into staff_members(user_id, role, name, active)
    values (p_user, p_role, nullif(trim(p_name), ''), coalesce(p_active, true))
    on conflict (user_id) do update set role = excluded.role, name = excluded.name, active = excluded.active;
  else
    raise exception 'invalid role';
  end if;
  -- กันล็อกตัวเองออกจนไม่เหลือแอดมิน (ถ้าไม่ผ่าน การเปลี่ยนแปลงทั้งหมดจะถูกย้อนกลับ)
  if not exists (select 1 from staff_members where role = 'admin' and active) then
    raise exception 'ต้องมีแอดมินที่ใช้งานอยู่อย่างน้อย 1 คน';
  end if;
end $$;

-- ฟังก์ชันเหล่านี้ให้เฉพาะคนที่ล็อกอินเรียกได้
revoke execute on function is_staff(), is_admin(), my_role(), set_menu_available(int, boolean),
  list_members(), set_member(uuid, text, text, boolean) from public, anon;
grant execute on function is_staff(), is_admin(), my_role(), set_menu_available(int, boolean),
  list_members(), set_member(uuid, text, text, boolean) to authenticated;

-- 4) ที่เก็บรูปเมนู -------------------------------------------------------
-- ทุกคนดูรูปได้ เฉพาะแอดมินอัปโหลด/แก้/ลบ จำกัดไม่เกิน 2 MB และเฉพาะไฟล์รูป
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu-images', 'menu-images', true, 2097152, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "menu images read"   on storage.objects;
drop policy if exists "menu images insert" on storage.objects;
drop policy if exists "menu images update" on storage.objects;
drop policy if exists "menu images delete" on storage.objects;
create policy "menu images read"   on storage.objects for select using (bucket_id = 'menu-images');
create policy "menu images insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'menu-images' and public.is_admin());
create policy "menu images update" on storage.objects for update to authenticated
  using (bucket_id = 'menu-images' and public.is_admin()) with check (bucket_id = 'menu-images' and public.is_admin());
create policy "menu images delete" on storage.objects for delete to authenticated
  using (bucket_id = 'menu-images' and public.is_admin());
