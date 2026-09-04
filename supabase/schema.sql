-- 出租房管理 · 数据库结构
-- 在 Supabase 后台 SQL Editor 里完整跑一次即可。可重复执行。
--
-- 安全模型：网站是纯静态的，anon key 一定会出现在网页源码里（这是 Supabase 的正常设计）。
-- 真正拦住外人的是每张表的 RLS 策略：每行都带 owner_id，只有 auth.uid() 对得上才读得到。
-- 少一条策略，那张表就等于公开。

-- ---------------------------------------------------------------- 房产
create table if not exists public.properties (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- 房间
create table if not exists public.rooms (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  property_id    uuid not null references public.properties(id) on delete cascade,
  name           text not null,
  tags           text[] not null default '{}',
  sort_order     int  not null default 0,
  -- 自住房：仍然列出以反映满租潜力，但不计入「本月应收」
  self_occupied  boolean not null default false,
  -- 自住房 / 空房的参考租金（若出租大约值多少）
  reference_rent numeric(10,2),
  notes          text not null default '',
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------- 租约（月租）
-- 一间房可以有多份租约：status='active' 的最多一份，其余是搬走后留档的历史房客。
create table if not exists public.tenancies (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  room_id        uuid not null references public.rooms(id) on delete cascade,
  tenant_name    text not null,
  phone          text not null default '',
  deposit        numeric(10,2) not null default 0,   -- 马币计价
  -- 押金实收人民币。押金是马币负债、钱进的是人民币账户，
  -- 不记下当初按什么汇率收的，就算不出这笔押金真实的汇兑盈亏。
  deposit_cny    numeric(12,2),
  monthly_rent   numeric(10,2) not null,             -- 马币计价
  contract_start date not null,
  contract_end   date not null,
  -- active 在住 / booked 已预订（合约还没开始，房间可能还有人住）/ ended 已搬走
  status         text not null default 'active' check (status in ('active','booked','ended')),
  move_out_date  date,
  -- 每月几号交租。不是所有房客都 1 号交 —— 有人 19 号、有人 25 号。
  -- 上限 28，避免 2 月没有 29/30/31 号。
  rent_due_day   int  not null default 1 check (rent_due_day between 1 and 28),
  -- 首月租金。月中入住时首月通常按比例少收（租客B 10/15 入住，十月只收半个月）。
  -- 留空 = 首月照 monthly_rent 全额收。金额是谈好的，不是按天数算出来的，所以直接存。
  first_month_rent numeric(10,2),
  notes          text not null default '',
  created_at     timestamptz not null default now(),
  constraint tenancy_dates_ordered check (contract_end >= contract_start)
);

-- 给已经建过表的库补上这一列（重复跑 schema.sql 时用）
alter table public.tenancies add column if not exists rent_due_day int not null default 1;
alter table public.tenancies add column if not exists first_month_rent numeric(10,2);
alter table public.tenancies add column if not exists deposit_cny numeric(12,2);

-- 已建库升级：放宽 status 允许 'booked'
do $$ begin
  alter table public.tenancies drop constraint if exists tenancies_status_check;
  alter table public.tenancies add constraint tenancies_status_check
    check (status in ('active','booked','ended'));
end $$;

-- 同一间房只允许一份在住租约、一份预订租约（防止误建两份导致重复计租）
create unique index if not exists tenancies_one_active_per_room
  on public.tenancies (room_id) where status = 'active';
create unique index if not exists tenancies_one_booked_per_room
  on public.tenancies (room_id) where status = 'booked';

-- ---------------------------------------------------------------- 收款账户
-- 两个支付宝各一行。余额靠手动更新（支付宝没有开放接口可以自动拉）。
create table if not exists public.accounts (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name         text not null,
  currency     text not null default 'CNY' check (currency in ('CNY','MYR')),
  balance      numeric(12,2) not null default 0,
  balance_updated_at timestamptz,
  sort_order   int not null default 0,
  note         text not null default '',
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------- 全局设置（每个 owner 一行）
create table if not exists public.app_settings (
  owner_id     uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  -- 人民币换马币的参考汇率。押金覆盖率要拿它把 CNY 余额折成 RM 来比。
  -- 界面会用最近几笔收款的隐含汇率给出建议值。
  cny_to_myr   numeric(10,4) not null default 0.62,
  daily_rate   numeric(10,2) not null default 90,   -- 日租房默认单价
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------- 收租记录
-- 一行 = 某份租约的某个月已收。没有行 = 未收。
--
-- 币种约定（按 Eason 的实际做法）：租金永远以 RM 计价，amount 就是该月应收的马币。
-- 若租客用支付宝付人民币，把实际到账的人民币填进 cny_amount。
-- 两者相除即得这笔的隐含汇率，界面会显示出来，方便看出哪几笔换亏了。
create table if not exists public.payments (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tenancy_id  uuid not null references public.tenancies(id) on delete cascade,
  ym          text not null check (ym ~ '^\d{4}-(0[1-9]|1[0-2])$'),  -- 'YYYY-MM'
  amount      numeric(10,2),          -- 马币金额，留空 = 按租约月租全额
  cny_amount  numeric(12,2),          -- 支付宝实收人民币，非支付宝收款留空
  account_id  uuid references public.accounts(id) on delete set null,
  method      text not null default '' check (method in ('','cash','bank','alipay')),
  paid_on     date,
  note        text not null default '',
  created_at  timestamptz not null default now(),
  unique (tenancy_id, ym)
);

-- ---------------------------------------------------------------- 空调费（电费）
-- 每月看完电单，逐个租客填金额，再各自打勾收款。
-- 金额每月不同（按实际电费），所以不能存在租约上，必须一个月一行。
-- 跟租金分开记：可以出现「租金收了，电费还欠着」。
--
-- ⚠️ ym 一律指「电费所属月份」，也就是用电的那个月，不是收款的月份。
--    电费次月收：ym='2026-08' 的那批是 8 月的电，9 月才收。
--    钱什么时候到手看 paid_on，两者分开，不要混为一谈。
create table if not exists public.aircon_charges (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tenancy_id  uuid not null references public.tenancies(id) on delete cascade,
  ym          text not null check (ym ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  amount      numeric(10,2) not null default 0,   -- 马币
  paid        boolean not null default false,
  paid_on     date,
  cny_amount  numeric(12,2),
  account_id  uuid references public.accounts(id) on delete set null,
  note        text not null default '',
  created_at  timestamptz not null default now(),
  unique (tenancy_id, ym)
);

-- ---------------------------------------------------------------- 日租
-- 「哪间空就用哪间」，所以带 room_id，应用层会检查是否跟月租合约撞期。
create table if not exists public.short_stays (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  room_id      uuid not null references public.rooms(id) on delete cascade,
  guest_name   text not null default '',
  phone        text not null default '',
  check_in     date not null,
  check_out    date not null,          -- 退房当天不算钱，天数 = check_out - check_in
  nightly_rate numeric(10,2) not null default 90,
  amount       numeric(10,2),          -- 马币总额，留空 = 天数 × 单价
  cny_amount   numeric(12,2),
  account_id   uuid references public.accounts(id) on delete set null,
  method       text not null default '' check (method in ('','cash','bank','alipay')),
  paid         boolean not null default false,
  note         text not null default '',
  created_at   timestamptz not null default now(),
  constraint stay_dates_ordered check (check_out > check_in)
);

-- ---------------------------------------------------------------- 索引
create index if not exists rooms_property_idx      on public.rooms(property_id);
create index if not exists tenancies_room_idx      on public.tenancies(room_id);
create index if not exists payments_tenancy_idx    on public.payments(tenancy_id);
create index if not exists payments_ym_idx         on public.payments(ym);
create index if not exists aircon_tenancy_idx      on public.aircon_charges(tenancy_id);
create index if not exists aircon_ym_idx            on public.aircon_charges(ym);
create index if not exists short_stays_room_idx    on public.short_stays(room_id);
create index if not exists short_stays_dates_idx   on public.short_stays(check_in, check_out);
create index if not exists properties_owner_idx    on public.properties(owner_id);

-- ---------------------------------------------------------------- RLS
alter table public.properties   enable row level security;
alter table public.rooms        enable row level security;
alter table public.tenancies    enable row level security;
alter table public.payments     enable row level security;
alter table public.accounts     enable row level security;
alter table public.app_settings enable row level security;
alter table public.short_stays  enable row level security;
alter table public.aircon_charges enable row level security;

-- 所有表策略相同：只能碰自己的行。
-- using 管读取/更新前的可见性，with check 管写入后的值 —— 两个都要，
-- 否则能把别人的行改成自己的、或插入 owner_id 是别人的行。
do $$
declare t text;
begin
  foreach t in array array[
    'properties','rooms','tenancies','payments','accounts','app_settings',
    'short_stays','aircon_charges'
  ] loop
    execute format('drop policy if exists own_rows_select on public.%I', t);
    execute format('drop policy if exists own_rows_insert on public.%I', t);
    execute format('drop policy if exists own_rows_update on public.%I', t);
    execute format('drop policy if exists own_rows_delete on public.%I', t);

    execute format(
      'create policy own_rows_select on public.%I for select to authenticated using (auth.uid() = owner_id)', t);
    execute format(
      'create policy own_rows_insert on public.%I for insert to authenticated with check (auth.uid() = owner_id)', t);
    execute format(
      'create policy own_rows_update on public.%I for update to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id)', t);
    execute format(
      'create policy own_rows_delete on public.%I for delete to authenticated using (auth.uid() = owner_id)', t);
  end loop;
end $$;

-- 策略限定 to authenticated，未登录的 anon 角色一行都读不到。
-- 验证方法见 README「怎么确认外人真的看不到」。
