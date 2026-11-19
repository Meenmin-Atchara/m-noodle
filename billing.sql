-- =====================================================================
-- เก็บเงิน (บิล) + ตั้งค่าร้าน + รายงานยอดขาย
-- วางใน Supabase > SQL Editor แล้วกด Run
-- ลำดับที่ต้องรัน: schema.sql → admin.sql → billing.sql (ไฟล์นี้)  รันซ้ำได้ปลอดภัย
-- ต้องรันไฟล์นี้ "ก่อน" อัปโหลดโค้ดหน้าเว็บชุดใหม่ขึ้น GitHub
-- =====================================================================

do $$ begin
  if to_regprocedure('public.is_staff()') is null then
    raise exception 'ต้องรัน admin.sql ก่อน แล้วค่อยรันไฟล์นี้';
  end if;
end $$;

-- 1) ตั้งค่าร้าน (มีแถวเดียว) -----------------------------------------
create table if not exists shop_settings (
  id               int primary key default 1 check (id = 1),
  shop_name        text,
  promptpay_id     text,                         -- เบอร์โทร 10 หลัก / เลขบัตรประชาชนหรือภาษี 13 หลัก / e-wallet 15 หลัก
  promptpay_name   text,                         -- ชื่อบัญชีที่แสดงตอนเก็บเงิน (ไม่บังคับ)
  accepting_orders boolean not null default true, -- false = ปิดรับออเดอร์จาก QR ชั่วคราว (พนักงานยังคีย์เองได้)
  receipt_note     text
);
insert into shop_settings (id) values (1) on conflict do nothing;
alter table shop_settings enable row level security;
drop policy if exists "staff read settings"   on shop_settings;
drop policy if exists "admin update settings" on shop_settings;
create policy "staff read settings"   on shop_settings for select to authenticated using (is_staff());
create policy "admin update settings" on shop_settings for update to authenticated using (is_admin()) with check (is_admin());

-- ข้อมูลที่ลูกค้า (ยังไม่ล็อกอิน) เห็นได้ มีแค่ชื่อร้านกับสถานะเปิดรับออเดอร์
create or replace function get_public_settings() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('shop_name', nullif(trim(shop_name), ''), 'accepting_orders', accepting_orders)
  from shop_settings where id = 1
$$;

-- 2) บิล ---------------------------------------------------------------
-- โต๊ะหนึ่งมีบิลที่ "เปิดค้าง" ได้บิลเดียว ลูกค้าสั่งกี่รอบก็รวมในบิลเดียวจนกว่าจะเก็บเงิน
create table if not exists bills (
  id                    bigserial primary key,
  table_id              int references tables(id),
  bill_type             text not null check (bill_type in ('dine_in','takeaway')),
  status                text not null default 'open' check (status in ('open','paid','void')),
  subtotal              numeric(10,2),
  discount              numeric(10,2) not null default 0,
  total                 numeric(10,2),
  payment_method        text check (payment_method in ('promptpay','cash')),
  cash_received         numeric(10,2),
  checkout_requested_at timestamptz,
  created_at            timestamptz not null default now(),
  paid_at               timestamptz,
  paid_by               uuid references auth.users(id) on delete set null
);
create unique index if not exists bills_one_open_per_table on bills(table_id) where status = 'open' and table_id is not null;
create index if not exists bills_status_idx on bills(status);
create index if not exists bills_paid_at_idx on bills(paid_at);

alter table orders add column if not exists bill_id bigint references bills(id);
create index if not exists orders_bill_idx on orders(bill_id);

alter table bills enable row level security;
drop policy if exists "staff read bills" on bills;
create policy "staff read bills" on bills for select to authenticated using (is_staff());
-- การเขียนบิลทำผ่านฟังก์ชันด้านล่างเท่านั้น (คิดเงินที่ฐานข้อมูล ไม่เชื่อตัวเลขจากหน้าเว็บ)

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bills') then
    alter publication supabase_realtime add table bills;
  end if;
end $$;

-- 3) สร้างออเดอร์ (เพิ่ม: ผูกกับบิล และเคารพสวิตช์ปิดรับออเดอร์) -------------
create or replace function create_order(
  p_table_id int, p_type text, p_source text, p_note text, p_items jsonb
) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_source text := p_source;
  v_date   date := (now() at time zone 'Asia/Bangkok')::date;
  v_queue  int;
  v_order  bigint;
  v_bill   bigint;
  v_status text;
  it       jsonb;
  mi       menu_items%rowtype;
  extra    numeric;
begin
  if not is_staff() then v_source := 'customer'; end if;

  if v_source = 'customer' and not coalesce((select accepting_orders from shop_settings where id = 1), true) then
    raise exception 'ร้านปิดรับออเดอร์ผ่าน QR ชั่วคราว กรุณาแจ้งพนักงาน';
  end if;
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

  -- บิล: นั่งในร้าน = ใช้บิลที่เปิดค้างของโต๊ะนั้น (ไม่มีก็เปิดใหม่) / กลับบ้าน = บิลใหม่ทุกครั้ง
  if p_type = 'dine_in' then
    select id into v_bill from bills where table_id = p_table_id and status = 'open';
    if v_bill is null then
      insert into bills (table_id, bill_type) values (p_table_id, 'dine_in')
        on conflict (table_id) where status = 'open' and table_id is not null do nothing
        returning id into v_bill;
      if v_bill is null then
        select id into v_bill from bills where table_id = p_table_id and status = 'open';
      end if;
    end if;
  else
    insert into bills (bill_type) values ('takeaway') returning id into v_bill;
  end if;

  insert into queue_counter(queue_date, last_no) values (v_date, 1)
    on conflict (queue_date) do update set last_no = queue_counter.last_no + 1
    returning last_no into v_queue;

  v_status := case when v_source = 'staff' then 'cooking' else 'pending' end;

  insert into orders(table_id, order_type, source, queue_no, queue_date, status, note, bill_id)
  values (case when p_type = 'dine_in' then p_table_id end, p_type, v_source,
          v_queue, v_date, v_status, left(p_note, 300), v_bill)
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

  return json_build_object('order_id', v_order, 'queue_no', v_queue, 'status', v_status, 'bill_id', v_bill);
end $$;

-- 4) ลูกค้าเช็กสถานะ (เพิ่มสถานะบิล) และกด "เรียกเก็บเงิน" ----------------------
create or replace function get_order_status(p_order_id bigint) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('queue_no', o.queue_no, 'status', o.status,
                           'bill_status', b.status, 'requested', b.checkout_requested_at is not null)
  from orders o left join bills b on b.id = o.bill_id
  where o.id = p_order_id and o.created_at > now() - interval '12 hours'
$$;

create or replace function request_bill(p_order_id bigint) returns json
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update bills set checkout_requested_at = coalesce(checkout_requested_at, now())
  where status = 'open'
    and id = (select bill_id from orders where id = p_order_id and created_at > now() - interval '12 hours');
  get diagnostics n = row_count;
  return json_build_object('ok', n > 0);
end $$;

grant execute on function get_public_settings(), get_order_status(bigint), request_bill(bigint) to anon, authenticated;

-- 5) เก็บเงิน / ยกเลิกบิล ----------------------------------------------------
create or replace function close_bill(
  p_bill_id bigint, p_method text, p_discount numeric default 0, p_cash numeric default null
) returns json
language plpgsql security definer set search_path = public as $$
declare
  b bills%rowtype;
  v_sub numeric; v_disc numeric; v_total numeric;
begin
  if not is_staff() then raise exception 'ไม่มีสิทธิ์เก็บเงิน'; end if;
  if p_method not in ('promptpay','cash') then raise exception 'วิธีชำระเงินไม่ถูกต้อง'; end if;
  select * into b from bills where id = p_bill_id for update;
  if not found then raise exception 'ไม่พบบิลนี้'; end if;
  if b.status <> 'open' then raise exception 'บิลนี้ปิดไปแล้ว'; end if;
  if exists (select 1 from orders where bill_id = b.id and status = 'pending') then
    raise exception 'ยังมีออเดอร์ที่รอยืนยัน กรุณายืนยันหรือปฏิเสธก่อนเก็บเงิน';
  end if;
  select coalesce(sum(i.unit_price * i.qty), 0) into v_sub
  from orders o join order_items i on i.order_id = o.id
  where o.bill_id = b.id and o.status <> 'cancelled';
  if v_sub <= 0 then raise exception 'บิลนี้ยังไม่มีรายการ'; end if;
  v_disc  := greatest(0, least(coalesce(p_discount, 0), v_sub));
  v_total := v_sub - v_disc;
  if p_method = 'cash' and (p_cash is null or p_cash < v_total) then raise exception 'รับเงินสดไม่พอ'; end if;
  update bills set status = 'paid', subtotal = v_sub, discount = v_disc, total = v_total,
         payment_method = p_method, cash_received = case when p_method = 'cash' then p_cash end,
         paid_at = now(), paid_by = auth.uid()
  where id = b.id;
  return json_build_object('bill_id', b.id, 'subtotal', v_sub, 'discount', v_disc, 'total', v_total);
end $$;

-- ยกเลิกบิล: พนักงานลบได้เฉพาะบิลว่าง / แอดมินยกเลิกบิลที่มีรายการหรือชำระแล้วได้ (ไม่นับในรายงาน)
create or replace function void_bill(p_bill_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare b bills%rowtype;
begin
  if not is_staff() then raise exception 'ไม่มีสิทธิ์'; end if;
  select * into b from bills where id = p_bill_id for update;
  if not found then raise exception 'ไม่พบบิลนี้'; end if;
  if b.status = 'void' then return; end if;
  if b.status = 'paid' then
    if not is_admin() then raise exception 'เฉพาะแอดมินที่ยกเลิกบิลที่ชำระแล้วได้'; end if;
  elsif exists (select 1 from orders o join order_items i on i.order_id = o.id
                where o.bill_id = b.id and o.status <> 'cancelled') then
    if not is_admin() then raise exception 'บิลที่มีรายการ ให้แอดมินเป็นผู้ยกเลิก'; end if;
    update orders set status = 'cancelled' where bill_id = b.id and status <> 'cancelled';
  end if;
  update bills set status = 'void' where id = b.id;
end $$;

revoke execute on function close_bill(bigint, text, numeric, numeric), void_bill(bigint) from public, anon;
grant  execute on function close_bill(bigint, text, numeric, numeric), void_bill(bigint) to authenticated;

-- 6) รายงานยอดขาย (เฉพาะแอดมิน) --------------------------------------------
-- นับเฉพาะบิลที่ชำระแล้ว ตามเวลาไทย  p_group = 'day' | 'month' | 'year'
create or replace function report_summary(p_from date, p_to date, p_group text default 'month') returns json
language plpgsql stable security definer set search_path = public as $$
declare
  v_from timestamptz; v_to timestamptz; r json;
begin
  if not is_admin() then raise exception 'เฉพาะแอดมิน'; end if;
  if p_group not in ('day','month','year') then raise exception 'invalid group'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3700 then raise exception 'ช่วงวันที่ไม่ถูกต้อง'; end if;
  v_from := p_from::timestamp at time zone 'Asia/Bangkok';
  v_to   := (p_to + 1)::timestamp at time zone 'Asia/Bangkok';

  select json_build_object(
    'totals', (select json_build_object('bills', count(*), 'sales', coalesce(sum(total), 0), 'discount', coalesce(sum(discount), 0))
               from bills where status = 'paid' and paid_at >= v_from and paid_at < v_to),
    'items_sold', (select coalesce(sum(i.qty), 0)
                   from bills b join orders o on o.bill_id = b.id and o.status <> 'cancelled'
                   join order_items i on i.order_id = o.id
                   where b.status = 'paid' and b.paid_at >= v_from and b.paid_at < v_to),
    'series', (select coalesce(json_agg(x order by x.period), '[]'::json) from (
                 select date_trunc(p_group, paid_at at time zone 'Asia/Bangkok')::date as period,
                        count(*)::int as bills, sum(total) as sales, sum(discount) as discount
                 from bills where status = 'paid' and paid_at >= v_from and paid_at < v_to group by 1) x),
    'top_items', (select coalesce(json_agg(x order by x.qty desc, x.revenue desc), '[]'::json) from (
                 select i.name, sum(i.qty)::int as qty, sum(i.qty * i.unit_price) as revenue
                 from bills b join orders o on o.bill_id = b.id and o.status <> 'cancelled'
                 join order_items i on i.order_id = o.id
                 where b.status = 'paid' and b.paid_at >= v_from and b.paid_at < v_to
                 group by i.name order by sum(i.qty) desc, sum(i.qty * i.unit_price) desc limit 15) x),
    'by_hour', (select coalesce(json_agg(x order by x.hour), '[]'::json) from (
                 select extract(hour from created_at at time zone 'Asia/Bangkok')::int as hour,
                        count(*)::int as bills, sum(total) as sales
                 from bills where status = 'paid' and paid_at >= v_from and paid_at < v_to group by 1) x),
    'by_weekday', (select coalesce(json_agg(x order by x.dow), '[]'::json) from (
                 select extract(isodow from paid_at at time zone 'Asia/Bangkok')::int as dow,
                        count(*)::int as bills, sum(total) as sales
                 from bills where status = 'paid' and paid_at >= v_from and paid_at < v_to group by 1) x),
    'by_type', (select coalesce(json_agg(x), '[]'::json) from (
                 select bill_type as type, count(*)::int as bills, sum(total) as sales
                 from bills where status = 'paid' and paid_at >= v_from and paid_at < v_to group by 1) x),
    'by_method', (select coalesce(json_agg(x), '[]'::json) from (
                 select payment_method as method, count(*)::int as bills, sum(total) as sales
                 from bills where status = 'paid' and paid_at >= v_from and paid_at < v_to group by 1) x)
  ) into r;
  return r;
end $$;

-- รายการบิลที่ชำระแล้วในช่วงวันที่ (สำหรับส่งออก CSV)
create or replace function report_bills(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public as $$
declare v_from timestamptz; v_to timestamptz;
begin
  if not is_admin() then raise exception 'เฉพาะแอดมิน'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3700 then raise exception 'ช่วงวันที่ไม่ถูกต้อง'; end if;
  v_from := p_from::timestamp at time zone 'Asia/Bangkok';
  v_to   := (p_to + 1)::timestamp at time zone 'Asia/Bangkok';
  return (select coalesce(json_agg(x order by x.paid_at), '[]'::json) from (
    select b.id, b.paid_at, coalesce(t.name, 'กลับบ้าน') as table_name, b.bill_type, b.payment_method,
           b.subtotal, b.discount, b.total
    from bills b left join tables t on t.id = b.table_id
    where b.status = 'paid' and b.paid_at >= v_from and b.paid_at < v_to
    order by b.paid_at limit 20000) x);
end $$;

revoke execute on function report_summary(date, date, text), report_bills(date, date) from public, anon;
grant  execute on function report_summary(date, date, text), report_bills(date, date) to authenticated;
