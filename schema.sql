-- =====================================================================
-- ระบบร้านก๋วยเตี๋ยว เฟส 1: ฐานข้อมูล (วางใน Supabase > SQL Editor แล้วกด Run)
-- =====================================================================

-- 1) โต๊ะ -------------------------------------------------------------
create table if not exists tables (
  id     serial primary key,
  name   text not null,            -- เช่น "โต๊ะ 1"
  active boolean not null default true
);

-- 2) เมนู -------------------------------------------------------------
-- options เก็บเป็น JSON เพื่อให้ยืดหยุ่น เช่น
-- [{"name":"เส้น","required":true,"choices":[{"name":"เส้นเล็ก","price":0},{"name":"บะหมี่","price":0}]},
--  {"name":"เพิ่มเติม","required":false,"multi":true,"choices":[{"name":"เพิ่มเนื้อ","price":20}]}]
create table if not exists menu_items (
  id        serial primary key,
  name      text not null,
  category  text not null default 'ก๋วยเตี๋ยว',
  price     numeric(10,2) not null check (price >= 0),
  image_url text,
  options   jsonb not null default '[]'::jsonb,
  available boolean not null default true,   -- false = หมด
  sort      int not null default 0
);

-- 3) ออเดอร์ ----------------------------------------------------------
create table if not exists orders (
  id         bigserial primary key,
  table_id   int references tables(id),       -- ว่าง = ซื้อกลับบ้าน
  order_type text not null check (order_type in ('dine_in','takeaway')),
  source     text not null check (source in ('customer','staff')),
  queue_no   int not null,                    -- เลขคิวของวัน เริ่มที่ 1 ทุกวัน
  queue_date date not null default (now() at time zone 'Asia/Bangkok')::date,
  status     text not null default 'pending'
             check (status in ('pending','cooking','ready','served','cancelled')),
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists orders_status_idx on orders(status);
create index if not exists orders_created_idx on orders(created_at);

create table if not exists order_items (
  id           bigserial primary key,
  order_id     bigint not null references orders(id) on delete cascade,
  menu_item_id int references menu_items(id),
  name         text not null,                 -- เก็บชื่อ/ราคา ณ ตอนสั่งไว้ เผื่อแก้เมนูภายหลัง
  unit_price   numeric(10,2) not null,        -- รวมราคาตัวเลือกเพิ่มแล้ว
  qty          int not null check (qty > 0),
  options      jsonb not null default '[]'::jsonb,  -- [{"group":"เส้น","choice":"เส้นเล็ก"}]
  note         text
);
create index if not exists order_items_order_idx on order_items(order_id);

-- 4) ตัวนับคิวรายวัน (กันเลขคิวซ้ำเมื่อสั่งพร้อมกัน) ---------------------
create table if not exists queue_counter (
  queue_date date primary key,
  last_no    int not null default 0
);

-- 5) ฟังก์ชันสร้างออเดอร์ ---------------------------------------------
-- ราคาคำนวณที่ฝั่งฐานข้อมูลเสมอ ลูกค้าแก้ราคาจากมือถือไม่ได้
-- p_items = [{"menu_item_id":1,"qty":2,"note":"ไม่ใส่ผัก","options":[{"group":"เส้น","choice":"เส้นเล็ก"}]}]
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
  -- คนที่ไม่ได้ล็อกอินสั่งในนามพนักงานไม่ได้
  if auth.uid() is null then v_source := 'customer'; end if;

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

  -- ออเดอร์จากลูกค้า รอพนักงานกดยืนยันก่อน (กันคนแกล้งสั่ง) / พนักงานคีย์เองเข้าครัวเลย
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

-- ให้ลูกค้าเช็กสถานะออเดอร์ตัวเองได้ (ต้องรู้เลข id) โดยไม่เห็นออเดอร์คนอื่น
create or replace function get_order_status(p_order_id bigint) returns json
language sql security definer set search_path = public as $$
  select json_build_object('queue_no', queue_no, 'status', status)
  from orders where id = p_order_id and created_at > now() - interval '12 hours';
$$;

-- 6) ความปลอดภัย (Row Level Security) ----------------------------------
alter table tables        enable row level security;
alter table menu_items    enable row level security;
alter table orders        enable row level security;
alter table order_items   enable row level security;
alter table queue_counter enable row level security;

-- ทุกคน (ลูกค้า) ดูเมนูกับโต๊ะได้อย่างเดียว
create policy "public read menu"   on menu_items for select using (true);
create policy "public read tables" on tables     for select using (true);

-- พนักงานที่ล็อกอินแล้วทำได้ทุกอย่าง
create policy "staff all menu"    on menu_items  for all to authenticated using (true) with check (true);
create policy "staff all tables"  on tables      for all to authenticated using (true) with check (true);
create policy "staff all orders"  on orders      for all to authenticated using (true) with check (true);
create policy "staff all items"   on order_items for all to authenticated using (true) with check (true);

-- ลูกค้าเรียกใช้ได้เฉพาะ 2 ฟังก์ชันนี้
revoke all on function create_order(int,text,text,text,jsonb) from public;
revoke all on function get_order_status(bigint) from public;
grant execute on function create_order(int,text,text,text,jsonb) to anon, authenticated;
grant execute on function get_order_status(bigint) to anon, authenticated;

-- เปิด Realtime ให้หน้าร้านเห็นออเดอร์ใหม่ทันที
alter publication supabase_realtime add table orders;
alter publication supabase_realtime add table order_items;

-- 7) ข้อมูลตัวอย่าง (ลบหรือแก้ได้) -------------------------------------
insert into tables(name) select 'โต๊ะ ' || g from generate_series(1,6) g
  where not exists (select 1 from tables);

insert into menu_items(name, category, price, sort, options)
select * from (values
  ('ก๋วยเตี๋ยวหมูน้ำใส','ก๋วยเตี๋ยว',50,1,
   '[{"name":"เส้น","required":true,"choices":[{"name":"เส้นเล็ก","price":0},{"name":"เส้นใหญ่","price":0},{"name":"บะหมี่","price":0},{"name":"วุ้นเส้น","price":0}]},
     {"name":"ขนาด","required":true,"choices":[{"name":"ธรรมดา","price":0},{"name":"พิเศษ","price":10}]},
     {"name":"เพิ่มเติม","required":false,"multi":true,"choices":[{"name":"เพิ่มลูกชิ้น","price":10},{"name":"เพิ่มเนื้อ","price":20}]}]'::jsonb),
  ('ก๋วยเตี๋ยวเรือ','ก๋วยเตี๋ยว',50,2,
   '[{"name":"เส้น","required":true,"choices":[{"name":"เส้นเล็ก","price":0},{"name":"เส้นใหญ่","price":0},{"name":"บะหมี่","price":0}]},
     {"name":"ขนาด","required":true,"choices":[{"name":"ธรรมดา","price":0},{"name":"พิเศษ","price":10}]}]'::jsonb),
  ('เกาเหลา','ก๋วยเตี๋ยว',60,3,'[]'::jsonb),
  ('ลูกชิ้นทอด','ของทานเล่น',30,4,'[]'::jsonb),
  ('น้ำเปล่า','เครื่องดื่ม',10,5,'[]'::jsonb),
  ('ชาเย็น','เครื่องดื่ม',25,6,'[]'::jsonb)
) as v(name,category,price,sort,options)
where not exists (select 1 from menu_items);
