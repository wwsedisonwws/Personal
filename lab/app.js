/* 出租房管理 · 前端逻辑
   纯静态站点，数据全在 Supabase。安全靠 RLS，不靠这里的代码。 */
'use strict';

/* ================================================================ 工具 */

const $ = (sel, root = document) => root.querySelector(sel);
const pad2 = n => String(n).padStart(2, '0');

// 一律用本地时区取日期。马来西亚是 UTC+8，早上用 toISOString() 会拿到前一天。
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
const thisYM = () => todayISO().slice(0, 7);
const thisYear = () => new Date().getFullYear();

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const num = n => Number(n) || 0;
const rm = n => 'RM' + Math.round(num(n)).toLocaleString('en-US');
const cny = n => '¥' + Math.round(num(n)).toLocaleString('en-US');

// 日期只做字符串比较，避开时区陷阱
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00') - Date.parse(a + 'T00:00:00')) / 86400000);
const daysUntil = iso => iso ? daysBetween(todayISO(), iso) : Infinity;
function addDaysISO(iso, n) {
  const d = new Date(Date.parse(iso + 'T00:00:00') + n * 86400000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addMonthsYM(ym, k) {
  const [y, m] = ym.split('-').map(Number);
  const t = (y * 12 + (m - 1)) + k;
  return `${Math.floor(t / 12)}-${pad2((t % 12) + 1)}`;
}
function ymRange(fromYM, toYM) {
  const out = [];
  for (let ym = fromYM; ym <= toYM; ym = addMonthsYM(ym, 1)) {
    out.push(ym);
    if (out.length > 600) break; // 防御：数据异常时不要死循环
  }
  return out;
}
const ymLabel = ym => { const [y, m] = ym.split('-'); return `${y}年${Number(m)}月`; };

/* ================================================================ 状态 */

let sb = null;
let session = null;

// 试验站：同一份代码，另一个 Supabase 项目。由 lab/config.js 里的 isLab 打开，
// 除了顶栏挂个醒目标记，还决定「从备份恢复」这种会清空数据的功能露不露出来。
const IS_LAB = !!(window.SUPABASE_CONFIG || {}).isLab;

const DB = {
  properties: [], rooms: [], tenancies: [], payments: [],
  accounts: [], stays: [], aircon: [], viewings: [], settings: null,
};

const UI = {
  tab: 'dash', roomId: null, year: thisYear(),
  openMonth: null,      // 租金推算图展开的月份
  openAcMonth: null,    // 空调费历史展开的月份（跟上面分开，否则两张图会互相收起）
  acYM: null,           // 收租页正在录入的空调费月份，null = 当前该处理的账单月
};

// 空调费次月收：9 月收的是 8 月的电费。
// aircon_charges.ym 一律指「电费所属月份」，收款时间看 paid_on，两者分开。
// 所以这个月要处理的永远是上个月那张单。
const billYM = () => addMonthsYM(thisYM(), -1);
const acYM = () => UI.acYM || billYM();

function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = kind;
  el.classList.remove('hide');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hide'), 3200);
}

/* ================================================================ 数据读写 */

async function loadAll() {
  const tables = ['properties', 'rooms', 'tenancies', 'payments', 'accounts',
                  'short_stays', 'aircon_charges', 'viewings', 'app_settings'];
  const results = await Promise.all(tables.map(t => sb.from(t).select('*')));

  // viewings 是后加的表。若这个 Supabase 项目还没跑建表 SQL，只让看房那页停摆，
  // 不能让收租、房间、账户跟着打不开 —— 一个刚加的可选功能不该有本事弄停整个应用。
  const vIdx = tables.indexOf('viewings');
  DB.viewingsMissing = !!results[vIdx].error;
  const failed = results.find((r, i) => r.error && i !== vIdx);
  if (failed) throw failed.error;

  const [props, rooms, ten, pay, acc, stays, aircon, viewings, settings] = results.map(r => r.data || []);
  DB.properties = props.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  DB.rooms = rooms.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  DB.tenancies = ten;
  DB.payments = pay;
  DB.accounts = acc.sort((a, b) => a.sort_order - b.sort_order);
  DB.stays = stays.sort((a, b) => b.check_in.localeCompare(a.check_in));
  DB.aircon = aircon;
  DB.viewings = (viewings || []).sort((a, b) =>
    (a.viewing_on + a.viewing_time).localeCompare(b.viewing_on + b.viewing_time));
  DB.settings = settings[0] || null;

  if (!DB.settings) {
    const { data, error } = await sb.from('app_settings').insert({}).select().single();
    if (!error) DB.settings = data;
  }
}

// 所有写操作都走这里：失败一定要让用户看见，绝不静默吞掉。
async function write(fn, okMsg) {
  try {
    const { error } = await fn();
    if (error) throw error;
    await loadAll();
    render();
    if (okMsg) toast(okMsg, 'good');
    return true;
  } catch (e) {
    console.error(e);
    toast('保存失败：' + (e.message || e), 'bad');
    return false;
  }
}

/* ================================================================ 备份 */

// Supabase 免费版没有自动备份 —— 误删一行就是永久没了。所以导出这件事必须自己做。
//
// 表的先后顺序就是外键顺序：先有房子才有房间，先有账户才有收款记录（payments /
// aircon_charges / short_stays 都带 account_id）。恢复时正着插，清空时倒着删。
const BACKUP_TABLES = [
  ['properties',     'properties'],
  ['rooms',          'rooms'],
  ['accounts',       'accounts'],
  ['tenancies',      'tenancies'],
  ['payments',       'payments'],
  ['aircon_charges', 'aircon'],
  ['short_stays',    'stays'],
  ['viewings',       'viewings'],
];

// 只导出 DB 里已经加载好的那份，不必再查一次库。
function backupData() {
  const out = { format: 'rental-backup', version: 1, exported_at: new Date().toISOString() };
  for (const [table, key] of BACKUP_TABLES) out[table] = DB[key] || [];
  out.app_settings = DB.settings ? [DB.settings] : [];
  return out;
}

const lastBackup = () => { try { return localStorage.getItem('lastBackup'); } catch { return null; } };

function downloadBackup() {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(backupData(), null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  // 文件名只用 ASCII：中文名会被浏览器整个丢掉，存成没有扩展名的 "download"，
  // 过半年再想打开就认不出那是什么了。
  a.download = `rental-backup-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  try { localStorage.setItem('lastBackup', todayISO()); } catch { /* 无痕模式会抛错，不影响下载 */ }
  render();
  toast('备份已下载，记得存到 iCloud 或 Google Drive', 'good');
}

// 从备份文件恢复。只在试验站开放 —— 它会先清空再灌，在生产站就是一键毁数据。
async function restoreBackup(file) {
  const raw = JSON.parse(await file.text());
  if (raw.format !== 'rental-backup') throw new Error('这不是本系统导出的备份文件');

  // owner_id 必须换成当前账号：换个 Supabase 项目，同一个邮箱也会拿到不同的 uid，
  // 照搬备份里的 owner_id 会被 RLS 挡下来（写进去的行连自己都看不见）。
  const uid = session.user.id;

  // 先清空。不清的话「一间房只能有一份 active 租约」那个唯一索引会跟现有数据撞车。
  for (const [table] of [...BACKUP_TABLES].reverse()) {
    const { error } = await sb.from(table).delete().eq('owner_id', uid);
    if (error) throw new Error(`清空 ${table} 失败：${error.message}`);
  }
  for (const [table] of BACKUP_TABLES) {
    const rows = (raw[table] || []).map(r => ({ ...r, owner_id: uid }));
    if (!rows.length) continue;
    const { error } = await sb.from(table).insert(rows);
    if (error) throw new Error(`写入 ${table} 失败：${error.message}`);
  }
  const s = (raw.app_settings || [])[0];
  if (s) await sb.from('app_settings').upsert({ ...s, owner_id: uid });
}

/* ================================================================ 计算 */

const roomsOf = pid => DB.rooms.filter(r => r.property_id === pid);
const activeTenancy = roomId => DB.tenancies.find(t => t.room_id === roomId && t.status === 'active');
// 已预订：合约还没开始，房间可能还住着上一位。押金已经收在手上，未来收入也算数。
const bookedTenancy = roomId => DB.tenancies.find(t => t.room_id === roomId && t.status === 'booked');
// 「还没结束的租约」—— 在住 + 已预订。凡是算钱的地方都用它，
// 具体哪个月算不算由 isDue 按合约日期决定。
const LIVE = t => t.status === 'active' || t.status === 'booked';
const propertyOf = roomId => {
  const room = DB.rooms.find(r => r.id === roomId);
  return room ? DB.properties.find(p => p.id === room.property_id) : null;
};

function paymentOf(tenancyId, ym) {
  return DB.payments.find(p => p.tenancy_id === tenancyId && p.ym === ym);
}

const fxRate = () => num(DB.settings?.cny_to_myr) || 0.62;
const dailyRate = () => num(DB.settings?.daily_rate) || 90;

// 一份租约在 [合约开始, min(合约结束, 本月)] 之间的所有应收月份
function dueMonths(t, uptoYM = thisYM()) {
  const from = t.contract_start.slice(0, 7);
  const to = [t.contract_end.slice(0, 7), uptoYM].sort()[0];
  return from > to ? [] : ymRange(from, to);
}

// 某月这份租约是否应收
const isDue = (t, ym) =>
  ym >= t.contract_start.slice(0, 7) && ym <= t.contract_end.slice(0, 7);

// 某个月应收多少。首月若谈好按比例少收（如月中入住），用 first_month_rent。
function rentFor(t, ym) {
  const isFirst = ym === t.contract_start.slice(0, 7);
  return isFirst && t.first_month_rent != null ? num(t.first_month_rent) : num(t.monthly_rent);
}

const paidAmount = (t, ym) => {
  const p = paymentOf(t.id, ym);
  return p ? (p.amount == null ? rentFor(t, ym) : num(p.amount)) : 0;
};

// 这份租约某个月的实际收租日。有人 1 号交，有人 19 号、25 号。
const dueDay = t => Math.min(Math.max(num(t.rent_due_day) || 1, 1), 28);
// 首月按入住日算，之后才按固定收租日。
// 否则会出现「收租日早于入住日」——租客C 7/20 入住却是 19 号收租，
// 那 7 月的应收日会落在他搬进来之前。
const dueDateOf = (t, ym) => {
  const d = `${ym}-${pad2(dueDay(t))}`;
  return ym === t.contract_start.slice(0, 7) && d < t.contract_start ? t.contract_start : d;
};
// 是否已经过了收租日。没到日子就不算欠 —— 25 号才交租的人，4 号催他是冤枉的。
const isPastDue = (t, ym) => todayISO() >= dueDateOf(t, ym);

// 某个月的收租状态
function rentState(t, ym) {
  if (paymentOf(t.id, ym)) return { key: 'paid', label: '✓ 已收', cls: 'on' };
  if (!isPastDue(t, ym)) {
    const d = daysUntil(dueDateOf(t, ym));
    return { key: 'waiting', label: `${dueDay(t)} 号收`, cls: '', note: `还有 ${d} 天` };
  }
  const late = daysBetween(dueDateOf(t, ym), todayISO());
  return {
    key: late === 0 ? 'today' : 'late',
    label: late === 0 ? '今天该收' : `逾期 ${late} 天`,
    cls: 'off',
  };
}

function arrearsOf(t) {
  // 只算已经过了收租日的月份
  const unpaid = dueMonths(t).filter(ym => !paymentOf(t.id, ym) && isPastDue(t, ym));
  return { months: unpaid, amount: unpaid.reduce((sum, ym) => sum + rentFor(t, ym), 0) };
}

/* -------- 空调费：每月一行，金额随电单变动，跟租金分开打勾 -------- */
const airconOf = (tenancyId, ym) => DB.aircon.find(a => a.tenancy_id === tenancyId && a.ym === ym);

// 本月需要交空调费的租约（所有在住的租客都要交）
const airconTenancies = (ym = thisYM()) =>
  DB.tenancies.filter(t => LIVE(t) && isDue(t, ym));

function airconStats(ym = thisYM()) {
  const list = airconTenancies(ym);
  let recorded = 0, billed = 0, collected = 0, paidCount = 0;
  for (const t of list) {
    const a = airconOf(t.id, ym);
    if (!a) continue;
    recorded++; billed += num(a.amount);
    if (a.paid) { paidCount++; collected += num(a.amount); }
  }
  return { total: list.length, recorded, billed, collected, paidCount,
           missing: list.length - recorded, outstanding: billed - collected };
}

const daysInMonth = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };

// 这间房这个月哪几天空着。合约中途起讫时算部分空置 ——
// 租客C 11/19 到期，十一月是空 11 天而不是整月，两者差很多钱。
//
// 逐日标记而不是把各租约天数相加：两份租约重叠时（租客A 和 租客B 十月就重叠）
// 相加会重复计数，把月内别处真实的空档抵消掉。顺便也才能得出具体是哪几天。
function vacancyOf(room, ym) {
  if (room.self_occupied) return null;
  const total = daysInMonth(ym);
  const mStart = `${ym}-01`, mEnd = `${ym}-${pad2(total)}`;
  const busy = new Array(total + 2).fill(false);
  for (const t of DB.tenancies) {
    if (t.room_id !== room.id || !LIVE(t)) continue;
    const a = t.contract_start > mStart ? t.contract_start : mStart;
    const b = t.contract_end   < mEnd   ? t.contract_end   : mEnd;
    if (a > b) continue;
    for (let d = Number(a.slice(8)); d <= Number(b.slice(8)); d++) busy[d] = true;
  }
  // 合并成连续区间，一个月里可能空好几段
  const gaps = [];
  let from = null;
  for (let d = 1; d <= total + 1; d++) {
    if (d <= total && !busy[d]) { if (from === null) from = d; }
    else if (from !== null) { gaps.push({ from, to: d - 1 }); from = null; }
  }
  const vacant = gaps.reduce((s, g) => s + (g.to - g.from + 1), 0);
  return vacant > 0 ? { vacant, total, gaps } : null;
}

// 「整月」或「10/26–10/31」。月内多段就用顿号连起来。
function vacancySpan(ym, v) {
  if (!v.gaps || v.vacant === v.total) return '整月';
  const m = Number(ym.slice(5));
  return v.gaps.map(g => g.from === g.to
    ? `${m}/${g.from}`
    : `${m}/${g.from}–${m}/${g.to}`).join('、');
}

// 这间房该按多少钱估算损失：在住 → 已预订 → 最近一位住过的 → 参考租金
// 这间房「出租能值多少」。只用在一处：算空置期少收多少 ——
// 也就是问的永远是「空着的时候本该收多少」。
//
// 招租价排第一：那是房东明确写下的答案，其余两个都是从租约推断的。
// 原来的顺序把它排在最后，只要房间有过租客就永远轮不到 —— 涨了价，
// 系统还按老价算空置损失。这间房上一任 1800、现在开价 2000，
// 空一个月就少报 200。
function roomRent(room) {
  if (num(room.reference_rent)) return num(room.reference_rent);
  const t = activeTenancy(room.id) || bookedTenancy(room.id);
  if (t) return num(t.monthly_rent);
  const past = DB.tenancies.filter(x => x.room_id === room.id)
    .sort((a, b) => b.contract_end.localeCompare(a.contract_end))[0];
  return num(past?.monthly_rent);
}

// 某间房还没谈成的看房预约（pending/done 都算「还在谈」）
const openViewings = roomId => DB.viewings.filter(v =>
  v.room_id === roomId && (v.status === 'pending' || v.status === 'done'));

// 这间房在这个月之后还有没有租客要来。
// 比的是月初而不是月末 —— 租客B 10/15 入住，十月前半空着同样算「后面有人」，
// 拿月末去比会把这种月内到来的漏掉。
const nextTenancyAfter = (roomId, ym) => DB.tenancies
  .filter(t => t.room_id === roomId && LIVE(t) && t.contract_start > `${ym}-01`)
  .sort((a, b) => a.contract_start.localeCompare(b.contract_start))[0];

// 某个月每间房的状态：谁在住、哪间空、空几天
function monthBreakdown(ym) {
  const let_ = [], vacant = [], self = [];
  for (const prop of DB.properties) {
    for (const room of roomsOf(prop.id)) {
      const where = `${prop.name} · ${room.name}`;
      if (room.self_occupied) { self.push({ where, room }); continue; }
      const occupants = DB.tenancies.filter(t => t.room_id === room.id && LIVE(t) && isDue(t, ym));
      const v = vacancyOf(room, ym);
      if (occupants.length) {
        let_.push({
          where, room, occupants,
          rent: occupants.reduce((s, t) => s + rentFor(t, ym), 0),
          partial: v,   // 当月有人住但没住满，带上是哪几天空的
        });
      }
      if (v && !occupants.length) {
        // 后面有没有人已经定了 —— 有的话这个月只能短租，不能签长约
        vacant.push({
          where, room, ...v,
          next: nextTenancyAfter(room.id, ym),
          money: roomRent(room) * v.vacant / v.total,
        });
      }
    }
  }
  return { let_, vacant, self };
}

// 未来 N 个月的空房。分两种，因为该采取的行动完全不同：
//   空档   —— 后面已经有租客了，中间这段断了，是实打实在漏钱
//   到期未续 —— 后面还没人，这是「该找租客了」，跟未来收入推算讲的是同一件事
function vacancyCalendar(months = 12) {
  const out = [];
  for (let i = 0; i < months; i++) {
    const ym = addMonthsYM(thisYM(), i);
    for (const room of DB.rooms) {
      const v = vacancyOf(room, ym);
      if (!v) continue;
      // 后面还有没有租客要来？有就是空档，没有就是到期未续。
      const next = nextTenancyAfter(room.id, ym);
      out.push({
        ym, room, ...v, gap: !!next, next,
        money: roomRent(room) * v.vacant / v.total,
      });
    }
  }
  return out;
}

// 房间当下的真实状态。关键：合约还没开始 = 房子现在是空的，
// 上一版只看 contract_end，把「10月才入住」显示成「出租中」，白白空了六周没人发现。
function roomStatus(room) {
  if (room.self_occupied) return { key: 'self', label: '自住', cls: 'flat' };
  const t = activeTenancy(room.id);
  if (!t) return { key: 'vacant', label: '空房', cls: 'bad' };
  if (t.contract_start > todayISO()) {
    return { key: 'pending', label: `待入住 ${t.contract_start.slice(5)}`, cls: 'warn', tenancy: t };
  }
  const d = daysUntil(t.contract_end);
  if (d < 0) return { key: 'expired', label: '已过期', cls: 'bad', tenancy: t };
  if (d <= 30) return { key: 'urgent', label: `${d} 天后到期`, cls: 'bad', tenancy: t };
  if (d <= 60) return { key: 'soon', label: `${d} 天后到期`, cls: 'warn', tenancy: t };
  return { key: 'ok', label: '出租中', cls: 'good', tenancy: t };
}

// 本月收租进度（不含自住房，不含合约未开始的房间）
function monthProgress(ym = thisYM()) {
  let due = 0, got = 0, rooms = 0, done = 0;
  let overdue = 0, overdueAmt = 0, waiting = 0, waitingAmt = 0;
  for (const t of DB.tenancies) {
    if (!LIVE(t) || !isDue(t, ym)) continue;
    rooms++; due += rentFor(t, ym);
    if (paymentOf(t.id, ym)) { done++; got += paidAmount(t, ym); }
    else if (isPastDue(t, ym)) { overdue++; overdueAmt += rentFor(t, ym); }
    else { waiting++; waitingAmt += rentFor(t, ym); }   // 还没到收租日，不算欠
  }
  return { due, got, rooms, done, overdue, overdueAmt, waiting, waitingAmt,
           outstanding: due - got };
}

const stayNights = s => Math.max(0, daysBetween(s.check_in, s.check_out));
const stayAmount = s => s.amount == null ? stayNights(s) * num(s.nightly_rate) : num(s.amount);

// 某月的日租收入（按入住日归属月份）
const stayIncomeOf = ym =>
  DB.stays.filter(s => s.paid && s.check_in.slice(0, 7) === ym)
          .reduce((sum, s) => sum + stayAmount(s), 0);

const totalDeposits = () =>
  DB.tenancies.filter(LIVE).reduce((s, t) => s + num(t.deposit), 0);

// 账户余额折成马币。两个支付宝都是人民币，所以这里必然经过汇率。
function accountsInRM() {
  const rate = fxRate();
  let rmTotal = 0, cnyTotal = 0;
  for (const a of DB.accounts) {
    if (a.currency === 'CNY') { cnyTotal += num(a.balance); rmTotal += num(a.balance) * rate; }
    else rmTotal += num(a.balance);
  }
  return { rmTotal, cnyTotal };
}

// 最近几笔支付宝收款算出的隐含汇率，用来提示设置里的汇率是不是过时了
function impliedRate() {
  const rows = DB.payments
    .filter(p => num(p.cny_amount) > 0)
    .sort((a, b) => (b.paid_on || b.ym).localeCompare(a.paid_on || a.ym))
    .slice(0, 5);
  if (!rows.length) return null;
  let rmSum = 0, cnySum = 0;
  for (const p of rows) {
    const t = DB.tenancies.find(x => x.id === p.tenancy_id);
    rmSum += p.amount == null ? (t ? rentFor(t, p.ym) : 0) : num(p.amount);
    cnySum += num(p.cny_amount);
  }
  return cnySum > 0 ? { rate: rmSum / cnySum, n: rows.length } : null;
}

// 未来 12 个月按现有合约能收到多少（不含日租，日租不可预测）
function futureIncome(months = 12) {
  const out = [];
  for (let i = 0; i < months; i++) {
    const ym = addMonthsYM(thisYM(), i);
    let total = 0;
    for (const t of DB.tenancies) {
      if (LIVE(t) && isDue(t, ym)) total += rentFor(t, ym);
    }
    out.push({ ym, total });
  }
  return out;
}

// 过去 N 个月实收（月租 + 日租）
function pastIncome(months = 12) {
  const out = [];
  for (let i = months; i >= 1; i--) {
    const ym = addMonthsYM(thisYM(), -i);
    let rent = 0;
    for (const p of DB.payments.filter(p => p.ym === ym)) {
      const t = DB.tenancies.find(x => x.id === p.tenancy_id);
      rent += p.amount == null ? (t ? rentFor(t, p.ym) : 0) : num(p.amount);
    }
    out.push({ ym, rent, stay: stayIncomeOf(ym) });
  }
  return out;
}

/* ================================================================ 渲染 */

function render() {
  $('#topbar .who span').textContent = session?.user?.email || '';
  document.querySelectorAll('#tabs button').forEach(b =>
    b.setAttribute('aria-selected', String(b.dataset.tab === UI.tab)));

  const views = {
    dash: viewDashboard, collect: viewCollect, rooms: viewRooms,
    viewings: viewViewings, stays: viewStays, money: viewMoney,
  };
  const keep = UI.keepScroll ? window.scrollY : 0;
  $('#main').innerHTML = UI.roomId ? viewRoomDetail() : views[UI.tab]();
  window.scrollTo({ top: keep });
  UI.keepScroll = false;
  // 换页后内容可能变短，浏览器会把 scrollY 夹回去，而那不一定触发 scroll 事件 ——
  // 所以这里显式刷新一次，不能只靠监听。
  syncToTop();
}

/* ---------------------------------------------------------------- 回到顶部 */

// 滚过一屏才出现。用 innerHeight 而不是写死像素：小屏该早点出现，大屏该晚点。
function syncToTop() {
  const btn = $('#totop');
  if (btn) btn.classList.toggle('hide', window.scrollY <= window.innerHeight);
}

/* ---------------------------------------------------------------- 总览 */

/* ---------------------------------------------------------------- 接待日程
   所有日期库里都有，但从来没按日子排过 —— 合约到期卡只说「还有 51 天」，
   不会告诉你那天还有别人同时退房。约人看房、签合同、退押金要的是日程，不是清单。 */
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
const weekdayOf = iso => '周' + WEEKDAY[new Date(iso + 'T00:00:00').getDay()];

function schedule(days = 90) {
  const until = addDaysISO(todayISO(), days);
  const ev = [];
  const where = roomId => {
    const room = DB.rooms.find(r => r.id === roomId);
    const p = propertyOf(roomId);
    return `${p?.name || ''} · ${room?.name || '（已删除）'}`;
  };

  for (const t of DB.tenancies.filter(LIVE)) {
    if (t.contract_start >= todayISO() && t.contract_start <= until) {
      const firstYM = t.contract_start.slice(0, 7);
      const paid = !!paymentOf(t.id, firstYM);
      ev.push({ date: t.contract_start, kind: '入住', who: t.tenant_name, where: where(t.room_id),
        todo: `签合同、交钥匙 · 押金 ${rm(t.deposit)}` +
              (paid ? ' · 首月租金已收' : ` · 首月租金 ${rm(rentFor(t, firstYM))} 待收`),
        room: t.room_id });
    }
    if (t.contract_end >= todayISO() && t.contract_end <= until) {
      // 关键是「他走后第二天这间房有没有人」，不是「有没有人在他之后开始」。
      // 不能用 nextTenancyAfter（那是按月的，给空档算用）：租客A 住到 10-31，
      // 而 租客B 10-15 就住进同一间了 —— 房间早有人接，根本不用招租。
      const after = addDaysISO(t.contract_end, 1);
      const others = DB.tenancies.filter(x =>
        x.room_id === t.room_id && LIVE(x) && x.id !== t.id);
      const covering = others.find(x => x.contract_start <= after && x.contract_end >= after);
      const upcoming = others.filter(x => x.contract_start > after)
        .sort((a, b) => a.contract_start.localeCompare(b.contract_start))[0];
      const looking = openViewings(t.room_id).length;
      const succ = covering ? ` · 房间由 ${esc(covering.tenant_name)} 接着住`
        : upcoming ? ` · 下一位 ${esc(upcoming.tenant_name)} ${upcoming.contract_start} 才来`
        : looking ? ` · 后面没人接，已有 ${looking} 组约看`
        : ' · 后面没人接，要招租';
      ev.push({ date: t.contract_end, kind: '退房', who: t.tenant_name, where: where(t.room_id),
        todo: `验房、退押金 ${rm(t.deposit)}` + succ,
        money: num(t.deposit), room: t.room_id });
    }
  }

  for (const s of DB.stays) {
    const n = stayNights(s);
    if (s.check_in >= todayISO() && s.check_in <= until) {
      ev.push({ date: s.check_in, kind: '日租入住', who: s.guest_name || '（未填姓名）', where: where(s.room_id),
        todo: `${n} 晚 · ${rm(stayAmount(s))}` + (s.paid ? ' 已收' : ' 待收'), room: s.room_id });
    }
    if (s.check_out >= todayISO() && s.check_out <= until) {
      ev.push({ date: s.check_out, kind: '日租退房', who: s.guest_name || '（未填姓名）', where: where(s.room_id),
        todo: '收钥匙、验房', room: s.room_id });
    }
  }

  for (const v of DB.viewings) {
    if (v.status !== 'pending') continue;          // 看过了就不用再提醒去接待
    if (v.viewing_on < todayISO() || v.viewing_on > until) continue;
    const room = DB.rooms.find(r => r.id === v.room_id);
    const ask = room ? roomRent(room) : 0;
    ev.push({
      date: v.viewing_on, kind: '看房', who: v.name || '（未留名）', where: where(v.room_id),
      todo: [v.viewing_time && `${v.viewing_time} 到`, ask && `开价 ${rm(ask)}`,
             v.want_from && `想 ${Number(v.want_from.slice(5, 7))} 月入住`,
             v.phone && `电话 ${v.phone}`].filter(Boolean).join(' · '),
      room: v.room_id, time: v.viewing_time,
    });
  }

  // 按日期分组 —— 同一天有好几件事正是最该看见的（9/9 两拨人、10/31 三人同退）
  const byDate = {};
  for (const e of ev.sort((a, b) => a.date.localeCompare(b.date))) (byDate[e.date] ||= []).push(e);
  return Object.entries(byDate).map(([date, items]) => ({
    date, items, days: daysUntil(date),
    deposit: items.reduce((s, x) => s + (x.kind === '退房' ? x.money : 0), 0),
  }));
}

// 看房预约卡。录入表单就放在卡里 —— 电话里约完随手记，多点两下就懒得记了，
// 而没记下来的约等于没约。
const VIEW_STATUS = { pending: '约了', done: '看过了', rented: '租了', passed: '不租了' };

function viewViewings() {
  if (DB.viewingsMissing) return `
  <div class="card">
    <h2>看房预约</h2>
    <div class="banner warn">这个 Supabase 项目还没建 <code>viewings</code> 表。</div>
    <p class="hero-sub">去 Supabase 后台 → SQL Editor，把 <code>supabase/schema.sql</code>
      里「看房预约」那一段跑一次就好。其余功能不受影响，照常用。</p>
  </div>`;

  const open = DB.viewings.filter(v => v.status === 'pending' || v.status === 'done')
    .sort((a, b) => (a.viewing_on + a.viewing_time).localeCompare(b.viewing_on + b.viewing_time));
  const done = DB.viewings.filter(v => v.status === 'rented' || v.status === 'passed')
    .sort((a, b) => b.viewing_on.localeCompare(a.viewing_on));
  const rentable = DB.rooms.filter(r => !r.self_occupied);
  const today = todayISO();

  return `
  <div class="card">
    <h2>看房预约 <span class="sub">${open.length ? `${open.length} 组在谈` : '暂时没有'}</span></h2>
    ${open.length ? open.map(v => {
      const room = DB.rooms.find(r => r.id === v.room_id);
      const p = propertyOf(v.room_id);
      const d = daysUntil(v.viewing_on);
      const late = v.status === 'pending' && v.viewing_on < today;
      return `<div class="collect-row">
        <div class="left">
          <div class="who">${esc(v.name || '（未留名）')}
            <span class="pill ${late ? 'bad' : d <= 3 ? 'warn' : 'flat'} plain" style="margin-left:6px">
              ${v.viewing_on.slice(5)} ${weekdayOf(v.viewing_on)}${v.viewing_time ? ' ' + v.viewing_time : ''}</span></div>
          <div class="sub">${esc(p?.name || '')} · ${esc(room?.name || '（已删除）')}
            ${room ? ' · 开价 ' + rm(roomRent(room)) : ''}
            ${v.want_from ? ` · 想 ${Number(v.want_from.slice(5, 7))} 月入住` : ''}
            ${v.phone ? ` · ${esc(v.phone)}` : ''}
            ${late ? ' · <b>日子过了，还没记结果</b>' : ''}</div>
          ${v.note ? `<div class="sub">${esc(v.note)}</div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
          ${v.status === 'pending'
            ? `<button class="tick" data-vstatus="${v.id}:done">看过了</button>`
            : `<button class="tick on" data-vstatus="${v.id}:rented">租了</button>`}
          <button class="ghost" data-vstatus="${v.id}:passed" style="font-size:12px;padding:6px 11px">不租了</button>
          <button class="linkish" data-delviewing="${v.id}" style="font-size:11px;color:var(--muted)">删除</button>
        </div>
      </div>`;
    }).join('') : '<div class="empty">还没有人约看房。电话里约好了就记在这里 —— 会进总览的接待日程，也会进 iPhone 日历。</div>'}

    <form id="viewing-form" class="form" style="margin-top:16px;border-top:2px dotted var(--border);padding-top:16px">
      <div class="field wide"><label for="v-room">新增预约 · 哪间房</label>
        <select id="v-room" required>${rentable.map(r =>
          `<option value="${r.id}">${esc(propertyOf(r.id)?.name || '')} · ${esc(r.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="v-on">看房日期</label>
        <input type="date" id="v-on" required value="${today}"></div>
      <div class="field"><label for="v-time">时间</label>
        <input type="time" id="v-time" value="14:00"></div>
      <div class="field"><label for="v-name">姓名（可留空）</label>
        <input type="text" id="v-name" placeholder="没问到就空着"></div>
      <div class="field"><label for="v-phone">电话</label>
        <input type="tel" id="v-phone" inputmode="tel"></div>
      <div class="field"><label for="v-from">想几时入住</label>
        <input type="date" id="v-from"></div>
      <div class="field"><label for="v-note">备注</label>
        <input type="text" id="v-note" placeholder="谈的价钱、特别要求…"></div>
      <div class="actions wide"><button type="submit" class="primary">记下来</button></div>
    </form>
  </div>

  ${done.length ? `<div class="card">
    <h2>已结束 <span class="sub">${done.length} 条</span></h2>
    ${done.map(v => {
      const room = DB.rooms.find(r => r.id === v.room_id);
      return `<div class="row-meta" style="margin:0 0 10px">
        <span class="pill ${v.status === 'rented' ? 'good' : 'flat'} plain">${VIEW_STATUS[v.status]}</span>
        <span>${v.viewing_on}</span>
        <span><b>${esc(v.name || '（未留名）')}</b></span>
        <span class="muted">${esc(room?.name || '（已删除）')}</span>
        ${v.note ? `<span class="muted">${esc(v.note)}</span>` : ''}
        <button class="linkish" data-delviewing="${v.id}"
          style="font-size:11px;color:var(--muted)">删除</button>
      </div>`;
    }).join('')}
    <div class="hint muted" style="font-size:12px;margin-top:6px">
      留着当记录：同一间房被看过几次、都是什么理由没成，下次定价时有用。
    </div>
  </div>` : ''}`;
}

function scheduleHTML() {
  const groups = schedule(90);
  if (!groups.length) {
    return `<div class="card"><h2>接待日程</h2>
      <div class="empty">未来 90 天没有要接待的人。</div></div>`;
  }
  const tone = { '入住': 'good', '退房': 'warn', '日租入住': 'flat', '日租退房': 'flat' };
  return `<div class="card">
    <h2>接待日程 <span class="sub">未来 90 天</span></h2>
    ${groups.map(g => `
      <div class="collect-row" style="display:block">
        <div class="who" style="${g.days <= 14 ? 'color:var(--accent)' : ''}">
          ${g.date.slice(5)} ${weekdayOf(g.date)}
          <span class="muted" style="font-weight:400">· ${
            g.days === 0 ? '就是今天' : `还有 ${g.days} 天`}</span>
          ${g.items.length > 1 ? `<span class="tag">${g.items.length} 件事</span>` : ''}
        </div>
        ${g.items.map(it => `<div class="sub" style="margin-top:6px">
          <span class="pill ${tone[it.kind]}">${it.kind}</span>
          <b>${esc(it.who)}</b> · ${esc(it.where)}<br>${it.todo}
          <button class="go" data-room="${it.room}">看这间</button>
        </div>`).join('')}
        ${g.deposit > 0 ? `<div class="sub" style="margin-top:6px;color:var(--warn)">
          这天要退押金合计 <b>${rm(g.deposit)}</b>，提前备好钱</div>` : ''}
      </div>`).join('')}
  </div>`;
}

/* ---------------------------------------------------------------- 本月要做的事
   全部从现有数据推导，不做估计也不编 —— 每一条都指名道姓、带金额和日期，
   照着做就行。刻意不接 LLM：数字系统里都有，直接算是精确的，
   而且 API key 在纯静态站点里藏不住（anon key 有 RLS 兜底，AI 的 key 没有）。 */
function briefing() {
  const out = [];
  // pin=1 的排在同类最后（例如「另有 N 位欠租」这种汇总行，
  // 金额最大但不该盖过具名的那几条）
  // level 决定排序和限额，tag 决定标签上写什么，tone 决定金额用什么颜色。
  // 这三件事以前挤在 level 一个字段里，结果「带看」被标成「催收」、
  // 开价 RM2,000 显示成跟欠款一样的红色 —— 一个是你能赚的，一个是收不回来的。
  const add = (level, tag, tone, title, detail, money, action, pin) =>
    out.push({ level, tag, tone, title, detail, money: money || 0, action, pin: pin || 0 });
  const monthOnly = ym => ymLabel(ym).replace(/^\d+年/, '');

  // ---- 该催的钱 ----
  const arrears = DB.tenancies.filter(LIVE)
    .map(t => ({ t, ...arrearsOf(t) })).filter(x => x.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  for (const x of arrears.slice(0, 3)) {
    const room = DB.rooms.find(r => r.id === x.t.room_id);
    const last = x.months[x.months.length - 1];
    const late = daysBetween(dueDateOf(x.t, last), todayISO());
    add('urgent', '催收', 'owed', `催 ${x.t.tenant_name} 收租`,
      `${room?.name || ''} · 欠 ${x.months.length} 个月（${ymLabel(x.months[0])} 起）` +
      (late > 0 ? ` · 最近一笔逾期 ${late} 天` : ''),
      x.amount, { room: x.t.room_id, label: '看这间' });
  }
  if (arrears.length > 3) {
    const rest = arrears.slice(3);
    add('urgent', '催收', 'owed', `另有 ${rest.length} 位欠租`,
      rest.map(x => esc(x.t.tenant_name)).join('、'),
      rest.reduce((s, x) => s + x.amount, 0), null, 1);
  }

  // ---- 看房预约 ----
  // 放在催收之后但同为 urgent：约错过了这个人就走了，租金晚几天还能追。
  for (const v of DB.viewings.filter(x => x.status === 'pending')) {
    const d = daysUntil(v.viewing_on);
    if (d < 0 || d > 3) continue;
    const room = DB.rooms.find(r => r.id === v.room_id);
    // 标题只放「做什么」，时间和人放到副行 —— 原来把日期、钟点、房名全塞进标题，
    // 手机上换行断在莫名其妙的地方，而且旁边条目都写「还有 56 天」，
    // 只有它写整年，看着更乱。日期去掉年份，跟接待日程那张卡对齐。
    const when = d === 0 ? '今天' : d === 1 ? '明天'
      : `${v.viewing_on.slice(5)} ${weekdayOf(v.viewing_on)}`;
    // 标题不再重复「带看」—— 药丸上已经写了。补上房产名：
    // 两处房产都有名字相近的房间（三楼中房独卫B/S、三楼中房），只写房名认不准。
    add('urgent', '带看', 'chance',
      `${propertyOf(v.room_id)?.name || ''} · ${room?.name || ''}`,
      `${when}${v.viewing_time ? ' ' + v.viewing_time : ''}` +
      ` · ${v.name || '（未留名）'}${v.phone ? ' · ' + v.phone : ''}` +
      (v.want_from ? ` · 想 ${Number(v.want_from.slice(5, 7))} 月入住` : ''),
      room ? roomRent(room) : 0, { room: v.room_id, label: '看这间' });
  }

  // ---- 电费 ----
  const ac = airconStats(billYM());
  if (ac.missing > 0) {
    add('todo', '电费', 'none', `录 ${ymLabel(billYM())} 的电费`,
      `${ac.missing} 位租客还没填金额，${monthOnly(thisYM())}收`,
      0, { tab: 'collect', label: '去填' });
  } else if (ac.outstanding > 0) {
    add('urgent', '电费', 'owed', `收 ${ymLabel(billYM())} 电费`,
      `${ac.total - ac.paidCount} 位还没交`,
      ac.outstanding, { tab: 'collect', label: '去打勾' });
  }

  // ---- 合约快到期又没有下一位 ----
  for (const room of DB.rooms) {
    const st = roomStatus(room);
    if (!['soon', 'urgent'].includes(st.key)) continue;
    if (nextTenancyAfter(room.id, st.tenancy.contract_end.slice(0, 7))) continue;
    const d = daysUntil(st.tenancy.contract_end);
    const looking = openViewings(room.id).length;
    add('todo', '招租', 'chance', `${room.name} 要找下一位`,
      `${st.tenancy.tenant_name} ${st.tenancy.contract_end} 到期（还有 ${d} 天）` +
      (looking ? `，已有 ${looking} 组约看` : '，后面没人接'),
      roomRent(room), { room: room.id, label: '看这间' });
  }

  // ---- 空档拿来做日租 ----
  const vac = vacancyCalendar(12);
  for (const g of vac.filter(v => v.gap).sort((a, b) => b.money - a.money).slice(0, 3)) {
    const income = g.vacant * dailyRate();
    add('idea', '可优化', 'chance', `${g.room.name} ${ymLabel(g.ym)}空着可做日租`,
      `空 ${vacancySpan(g.ym, g)}（${g.vacant} 天），${esc(g.next.tenant_name)} ${g.next.contract_start} 才来。` +
      `按 ${rm(dailyRate())}/晚约收 ${rm(income)}` +
      (income > g.money ? `，比空着少收的 ${rm(g.money)} 还多` : ''),
      income, { tab: 'stays', label: '记日租' });
  }

  // 刻意不做「连续 N 个月空置」那类建议：合约到期后还没登记下一位，
  // 不等于那几个月真的会空。按未续约去推，每间房都会算出十来个月的天文数字，
  // 既不准又会把真正要紧的事淹掉。真正可行的提醒是下面那条「60 天内到期没人接」。

  // ---- 押金兑付 ----
  const dep = totalDeposits();
  const { rmTotal } = accountsInRM();
  if (dep > 0 && rmTotal < dep) {
    add('todo', '要办', 'owed', '押金不够退',
      `押金负债 ${rm(dep)}，账户折马币只有 ${rm(rmTotal)}`,
      dep - rmTotal, { tab: 'money', label: '看账户' });
  }

  // ---- 汇率 ----
  const imp = impliedRate();
  if (imp && (fxRate() - imp.rate) / fxRate() > 0.03) {
    add('todo', '要办', 'none', '设定汇率该更新了',
      `最近 ${imp.n} 笔实际换到 ${imp.rate.toFixed(4)}，设定值还是 ${fxRate()}`,
      0, { tab: 'money', label: '去改' });
  }

  const rank = { urgent: 0, todo: 1, idea: 2 };
  return out.sort((a, b) =>
    rank[a.level] - rank[b.level] || a.pin - b.pin || b.money - a.money);
}

// 各类分别限额，而不是取总数的前 N 条 —— 否则催收条目一多，
// 「空档能做日租」这种真能多赚钱的建议就永远排不进来。
const BRIEF_CAP = { urgent: 4, todo: 3, idea: 2 };

function briefingHTML() {
  const all = briefing();
  const left = { ...BRIEF_CAP };
  const items = all.filter(it => left[it.level]-- > 0);
  const hidden = all.length - items.length;
  const mp = monthProgress();
  if (!items.length) {
    return `<div class="card"><h2>本月要做的事</h2>
      <div class="empty">没有待办 —— 租金收齐、电费录好、也没有空房 🎉</div></div>`;
  }
  // 标签的颜色仍按紧急程度（一眼分轻重），但文字按事情种类 —— 两者不是一回事。
  // 药丸颜色不能只看紧急程度：带看是**紧急但好事**，跟催收同样标红，
  // 一眼扫过去会误以为又是一笔烂账。红色只留给「钱收不回来」那一类。
  const pillOf = it => it.level === 'idea' ? 'flat'
    : it.tone === 'owed' ? 'bad' : 'warn';
  return `<div class="card">
    <h2>本月要做的事 <span class="sub">${all.length} 项${hidden ? `，列出前 ${items.length}` : ''}</span></h2>
    ${items.map(it => {
      const cls = pillOf(it);
      // 小药丸按钮而不是带下划线的文字链接 —— 界面里其他能点的都是药丸，
      // 只有这里是「网页链接」的样子，格格不入。
      const btn = it.action
        ? (it.action.room
            ? `<button class="go" data-room="${it.action.room}">${it.action.label}</button>`
            : `<button class="go" data-tab="${it.action.tab}">${it.action.label}</button>`)
        : '';
      return `<div class="collect-row">
        <div class="left">
          <div class="who"><span class="pill ${cls}">${esc(it.tag)}</span> ${esc(it.title)}</div>
          ${it.detail ? `<div class="sub">${it.detail}</div>` : ''}
          ${btn ? `<div style="margin-top:6px">${btn}</div>` : ''}
        </div>
        ${it.money ? `<span class="row-rent" style="color:var(--${
          it.tone === 'owed' ? 'bad' : 'accent'})">${rm(it.money)}</span>` : ''}
      </div>`;
    }).join('')}
    ${hidden ? `<div class="hero-sub" style="margin-top:10px">
      另有 ${hidden} 项较次要的没列出来。</div>` : ''}
    <div class="hero-sub" style="margin-top:12px">
      按紧急程度和金额排的。<b style="color:var(--bad)">红色</b>是收不回来的钱，
      <b style="color:var(--accent)">绿色</b>是还能赚的。${mp.overdue > 0
        ? `本月还有 <b style="color:var(--bad)">${rm(mp.overdueAmt)}</b> 逾期没收。`
        : ''}
    </div>
  </div>`;
}

function viewDashboard() {
  const mp = monthProgress();
  const pct = mp.due > 0 ? Math.round(mp.got / mp.due * 100) : 0;

  // 空房 / 待入住
  const vacant = DB.rooms.filter(r => {
    const st = roomStatus(r);
    return st.key === 'vacant' || st.key === 'pending';
  });

  // 60 天内到期
  const expiring = DB.rooms
    .map(r => ({ room: r, st: roomStatus(r) }))
    .filter(x => ['soon', 'urgent', 'expired'].includes(x.st.key))
    .sort((a, b) => daysUntil(a.st.tenancy.contract_end) - daysUntil(b.st.tenancy.contract_end));

  // 欠租
  const arrears = DB.tenancies
    .filter(LIVE)
    .map(t => ({ t, ...arrearsOf(t) }))
    .filter(x => x.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const arrearsTotal = arrears.reduce((s, x) => s + x.amount, 0);

  const fullRent = DB.tenancies.filter(t => t.status === 'active')
    .reduce((s, t) => s + num(t.monthly_rent), 0);
  const vac = vacancyCalendar(12);
  const gaps = vac.filter(v => v.gap);
  const horizon = addMonthsYM(thisYM(), 2);
  const soon = vac.filter(v => !v.gap && v.ym <= horizon);
  // 3 个月之后还没续约的房间数（按房间去重，不然同一间会数很多次）
  const later = new Set(vac.filter(v => !v.gap && v.ym > horizon).map(v => v.room.id)).size;
  const booked = DB.tenancies.filter(t => t.status === 'booked')
    .sort((a, b) => a.contract_start.localeCompare(b.contract_start));

  return `
  <div class="card">
    <div class="hero-label">${ymLabel(thisYM())} 收租</div>
    <div class="hero-figure">${rm(mp.got)} <span class="muted" style="font-size:20px">/ ${rm(mp.due)}</span></div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="hero-sub">${mp.done} / ${mp.rooms} 间已收${
      mp.overdue > 0 ? ` · <b style="color:var(--bad)">${mp.overdue} 间逾期 ${rm(mp.overdueAmt)}</b>` : ''}${
      mp.waiting > 0 ? ` · ${mp.waiting} 间还没到收租日 ${rm(mp.waitingAmt)}` : ''}${
      mp.outstanding === 0 ? ' · 本月已收齐 🎉' : ''}
      ${mp.outstanding > 0 ? '<button class="go" data-tab="collect" style="margin-left:6px">看是哪几间</button>' : ''}
    </div>
  </div>

  ${briefingHTML()}

  ${scheduleHTML()}

  <div class="card">
    <h2>关键数字</h2>
    <div class="stat-grid">
      <div class="stat"><div class="k">满租月收入</div><div class="v">${rm(fullRent)}</div>
        <div class="n">${DB.tenancies.filter(t => t.status === 'active').length} 份生效合约</div></div>
      <div class="stat"><div class="k">押金在手</div><div class="v">${rm(totalDeposits())}</div>
        <div class="n">要能随时退</div></div>
      <div class="stat"><div class="k">累计欠收</div><div class="v" style="color:${arrearsTotal > 0 ? 'var(--bad)' : 'inherit'}">${rm(arrearsTotal)}</div>
        <div class="n">${arrears.length} 间有欠款（已过收租日）</div></div>
      <div class="stat"><div class="k">空置 / 待入住</div><div class="v">${vacant.length}</div>
        <div class="n">共 ${DB.rooms.length} 间房</div></div>
    </div>
  </div>

  ${vacant.length ? `
  <div class="card">
    <h2>空房 <span class="sub">现在没人住的</span></h2>
    ${vacant.map(r => {
      const st = roomStatus(r);
      const p = DB.properties.find(x => x.id === r.property_id);
      const lost = st.key === 'pending'
        ? `空到 ${st.tenancy.contract_start}（还有 ${daysUntil(st.tenancy.contract_start)} 天）`
        : '目前无租约';
      return `<div class="collect-row">
        <div class="left">
          <div class="who">${esc(p?.name || '')} · ${esc(r.name)}</div>
          <div class="sub">${lost}</div>
        </div>
        <span class="pill ${st.cls}">${esc(st.label)}</span>
      </div>`;
    }).join('')}
  </div>` : ''}

  ${gaps.length ? `
  <div class="card" style="border-color:var(--bad)">
    <h2>空档 <span class="sub">下一位已经定了，中间断了</span></h2>
    ${gaps.map(g => {
      const p = DB.properties.find(x => x.id === g.room.property_id);
      return `<button class="row" data-room="${g.room.id}">
        <div class="row-top">
          <span class="row-name">${ymLabel(g.ym)} · ${esc(g.room.name)}</span>
          <span class="row-rent" style="color:var(--bad)">约 ${rm(g.money)}</span>
        </div>
        <div class="row-meta">
          <span>${esc(p?.name || '')}</span>
          <span class="pill bad">空 ${vacancySpan(g.ym, g)}${g.vacant === g.total ? '' : `（${g.vacant} 天）`}</span>
          <span class="muted">${esc(g.next.tenant_name)} ${g.next.contract_start} 才来</span>
        </div>
      </button>`;
    }).join('')}
    <div class="hero-sub" style="margin-top:12px">
      合计少收约 <b style="color:var(--bad)">${rm(gaps.reduce((s, g) => s + g.money, 0))}</b>。
      这几段前后都有租客，中间才是真的空 —— 谈提前入住、延后退租，或拿来做日租。
    </div>
  </div>` : ''}

  ${soon.length ? `
  <div class="card">
    <h2>近 3 个月待出租 <span class="sub">合约到期还没有下一位</span></h2>
    ${soon.map(g => {
      const p = DB.properties.find(x => x.id === g.room.property_id);
      return `<button class="row" data-room="${g.room.id}">
        <div class="row-top">
          <span class="row-name">${ymLabel(g.ym)} · ${esc(g.room.name)}</span>
          <span class="row-rent" style="color:var(--warn)">约 ${rm(g.money)}</span>
        </div>
        <div class="row-meta">
          <span>${esc(p?.name || '')}</span>
          <span class="pill warn">空 ${vacancySpan(g.ym, g)}${g.vacant === g.total ? '' : `（${g.vacant} 天）`}</span>
        </div>
      </button>`;
    }).join('')}
    ${later > 0 ? `<div class="hero-sub" style="margin-top:12px">
      3 个月之后还有 <b>${later}</b> 间的合约陆续到期且尚未续约。
      那属于长期规划，看下面「未来 12 个月」的收入曲线更清楚。
    </div>` : ''}
  </div>` : (gaps.length ? '' : `<div class="card"><h2>空房</h2>
    <div class="empty">近 3 个月没有空档，全部排满了 🎉</div></div>`)}

  ${expiring.length ? `
  <div class="card">
    <h2>合约快到期 <span class="sub">60 天内</span></h2>
    ${expiring.map(({ room, st }) => {
      const p = DB.properties.find(x => x.id === room.property_id);
      return `<div class="collect-row">
        <div class="left">
          <div class="who">${esc(p?.name || '')} · ${esc(room.name)}</div>
          <div class="sub">${esc(st.tenancy.tenant_name)} · ${st.tenancy.contract_end} · ${rm(st.tenancy.monthly_rent)}/月${
            bookedTenancy(room.id)
              ? ` · <span style="color:var(--good)">已有下一位 ${bookedTenancy(room.id).contract_start.slice(5)}</span>`
              : ' · <span style="color:var(--bad)">还没找到下一位</span>'}</div>
        </div>
        <span class="pill ${st.cls}">${esc(st.label)}</span>
      </div>`;
    }).join('')}
    <div class="hero-sub" style="margin-top:12px">
      涉及月租合计 <b>${rm(expiring.reduce((s, x) => s + num(x.st.tenancy.monthly_rent), 0))}</b>，
      押金合计 <b>${rm(expiring.reduce((s, x) => s + num(x.st.tenancy.deposit), 0))}</b>
    </div>
  </div>` : ''}

  ${booked.length ? `
  <div class="card">
    <h2>已预订 <span class="sub">合约还没开始</span></h2>
    ${booked.map(b => {
      const room = DB.rooms.find(r => r.id === b.room_id);
      const prop = propertyOf(b.room_id);
      const prev = activeTenancy(b.room_id);
      // 上一位走了到下一位来之间空几天
      const gap = prev ? daysBetween(prev.contract_end, b.contract_start) - 1 : null;
      return `<button class="row" data-room="${b.room_id}">
        <div class="row-top">
          <span class="row-name">${esc(b.tenant_name)}</span>
          <span class="row-rent">${rm(b.monthly_rent)}</span>
        </div>
        <div class="row-meta">
          <span>${esc(prop?.name || '')} · ${esc(room?.name || '')}</span>
          <span class="muted">${b.contract_start} ~ ${b.contract_end}</span>
          <span class="pill warn plain">押金 ${rm(b.deposit)} 已收</span>
          ${gap > 0 ? `<span class="pill bad">中间空 ${gap} 天 · 少收 ${rm(num(b.monthly_rent) * gap / 30)}</span>` : ''}
        </div>
      </button>`;
    }).join('')}
  </div>` : ''}

  ${arrears.length ? `
  <div class="card">
    <h2>欠租 <span class="sub">按金额排序</span></h2>
    ${arrears.map(({ t, months, amount }) => {
      const room = DB.rooms.find(r => r.id === t.room_id);
      const p = propertyOf(t.room_id);
      return `<button class="row" data-room="${t.room_id}">
        <div class="row-top">
          <span class="row-name">${esc(t.tenant_name)}</span>
          <span class="row-rent" style="color:var(--bad)">${rm(amount)}</span>
        </div>
        <div class="row-meta">
          <span>${esc(p?.name || '')} · ${esc(room?.name || '')}</span>
          <span class="tag">欠 ${months.length} 个月</span>
          <span class="muted">${ymLabel(months[0])} 起</span>
        </div>
      </button>`;
    }).join('')}
    <div class="banner warn" style="margin:14px 0 0">
      刚开始用系统的话，这些多半是「以前收了但没记录」。
      进房间详情 → 收租记录 → <b>批量补记</b>，一次把某个日期前的月份标掉。
    </div>
  </div>` : ''}
  `;
}

/* ---------------------------------------------------------------- 收租 */

function viewCollect() {
  const ym = thisYM();
  const mp = monthProgress(ym);

  const rentGroups = DB.properties.map(p => {
    const rows = roomsOf(p.id).map(room => {
      const t = activeTenancy(room.id);
      if (!t || !isDue(t, ym)) return '';
      const rs = rentState(t, ym);
      const pay = paymentOf(t.id, ym);
      const extra = pay && num(pay.cny_amount) > 0 ? ` · 支付宝 ${cny(pay.cny_amount)}` : '';
      const owed = rentFor(t, ym);
      const partial = owed !== num(t.monthly_rent) ? ' <span class="tag">首月按比例</span>' : '';
      const sub = rs.key === 'waiting'
        ? `${rm(owed)}${partial} · <span class="muted">${dueDay(t)} 号收，${rs.note}</span>`
        : rs.key === 'late'
          ? `${rm(owed)}${partial} · <span style="color:var(--bad)">${rs.label}</span>`
          : `${rm(owed)}${partial}${extra}`;
      return `<div class="collect-row">
        <div class="left">
          <div class="who">${esc(room.name)} · ${esc(t.tenant_name)}</div>
          <div class="sub">${sub}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex:0 0 auto">
          ${pay ? `<button class="icon-btn" data-editpay="${t.id}"
            aria-label="改这笔收款" title="改这笔收款">✏️</button>` : ''}
          <button class="tick ${rs.cls}" data-tick="${t.id}">${rs.key === 'paid' ? '✓ 已收' : '✕ 未收'}</button>
        </div>
      </div>`;
    }).filter(Boolean).join('');
    return rows ? `<div class="card"><h2>${esc(p.name)}</h2>${rows}</div>` : '';
  }).join('');

  // 空调费：每月 1 号看完电单逐个填金额，再各自打勾。
  // 月份可以往回切 —— 上个月忘了录得补得回来，这是最常见的情况。
  const aym = acYM();
  const ac = airconStats(aym);
  const prevYM = addMonthsYM(aym, -1);
  const airRows = DB.properties.map(p => {
    const rows = roomsOf(p.id).map(room => {
      const t = activeTenancy(room.id);
      if (!t || !isDue(t, aym)) return '';
      const a = airconOf(t.id, aym);
      const prev = airconOf(t.id, prevYM);
      const hint = prev ? `上月 ${rm(prev.amount)}` : '<span class="muted">上月无记录</span>';
      return `<form class="collect-row aircon-row" data-tenancy="${t.id}">
        <div class="left">
          <div class="who">${esc(room.name)} · ${esc(t.tenant_name)}</div>
          <div class="sub">${hint}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex:0 0 auto">
          <input type="number" step="1" min="0" value="${a ? num(a.amount) : ''}" placeholder="RM"
            style="width:76px;font-size:16px;padding:7px 8px;border-radius:8px;border:1px solid var(--border);background:var(--surface-2);color:var(--text)">
          <button type="submit" class="ghost">存</button>
          <button type="button" class="tick ${a ? (a.paid ? 'on' : 'off') : ''}"
            data-airtick="${t.id}" ${a ? '' : 'disabled'}>${a && a.paid ? '✓' : '✕'}</button>
        </div>
      </form>`;
    }).filter(Boolean).join('');
    return rows ? `<div style="margin-top:6px"><div class="hero-label" style="margin:10px 0 2px">${esc(p.name)}</div>${rows}</div>` : '';
  }).join('');

  return `
  <div class="card">
    <div class="hero-label">${ymLabel(ym)} 租金</div>
    <div class="hero-figure">${rm(mp.got)} <span class="muted" style="font-size:20px">/ ${rm(mp.due)}</span></div>
    <div class="bar"><i style="width:${mp.due ? Math.round(mp.got / mp.due * 100) : 0}%"></i></div>
    <div class="hero-sub">
      ${mp.done} / ${mp.rooms} 间已收${
        mp.overdue > 0 ? ` · <b style="color:var(--bad)">${mp.overdue} 间逾期 ${rm(mp.overdueAmt)}</b>` : ''}${
        mp.waiting > 0 ? ` · ${mp.waiting} 间还没到收租日 ${rm(mp.waitingAmt)}` : ''}${
        mp.outstanding === 0 ? ' · 收齐了 🎉' : ''}
    </div>
  </div>
  ${rentGroups || '<div class="card"><div class="empty">本月没有需要收租的房间。</div></div>'}

  <div class="card">
    <h2>${ymLabel(aym)} 电费
      <span class="sub">${ymLabel(addMonthsYM(aym, 1)).replace(/^\d+年/, '')}收 · ${ac.paidCount} / ${ac.total} 已收</span></h2>
    <div class="yearnav">
      <button type="button" data-acym="-1">← 上个月</button>
      <span class="num" style="font-weight:600">${ymLabel(aym)} 的电</span>
      <button type="button" data-acym="1" ${aym >= billYM() ? 'disabled' : ''}>下个月 →</button>
    </div>
    ${ac.missing > 0
      ? `<div class="banner warn" style="margin:0 0 12px">还有 <b>${ac.missing}</b> 个租客的空调费没填金额。看完电单逐个填，再打勾收款。</div>`
      : `<div class="banner warn" style="margin:0 0 12px;background:var(--good-soft);color:var(--good)">
           这个月电费已全部录入，合计 <b>${rm(ac.billed)}</b>，已收 <b>${rm(ac.collected)}</b>${
             ac.outstanding > 0 ? `，还差 <b>${rm(ac.outstanding)}</b>` : ''}。</div>`}
    ${airRows || '<div class="empty">这个月没有在住租客。</div>'}
    <div class="hint muted" style="margin-top:12px;font-size:12px">
      金额每月按实际电费填，跟租金分开打勾 —— 可以出现「租金收了、空调费还欠着」。
    </div>
  </div>
  `;
}

// 收人民币时补录明细
function payDialogHTML(t) {
  const ym = thisYM();
  const pay = paymentOf(t.id, ym) || {};
  const accOpts = DB.accounts.map(a =>
    `<option value="${a.id}" ${pay.account_id === a.id ? 'selected' : ''}>${esc(a.name)}（${a.currency}）</option>`).join('');
  return `
  <div class="card">
    <h2>${esc(t.tenant_name)} · ${ymLabel(ym)}</h2>
    <form id="pay-form" class="form" data-tenancy="${t.id}">
      <div class="field">
        <label for="p-amount">应收马币</label>
        <input type="number" id="p-amount" step="10" value="${pay.amount ?? rentFor(t, ym)}">
        <div class="hint">默认就是月租，通常不用改</div>
      </div>
      <div class="field">
        <label for="p-cny">支付宝实收人民币</label>
        <input type="number" id="p-cny" step="1" value="${pay.cny_amount ?? ''}" placeholder="没收人民币就留空">
        <div class="hint">填了会自动算出这笔的隐含汇率</div>
      </div>
      <div class="field">
        <label for="p-account">进哪个账户</label>
        <select id="p-account"><option value="">—</option>${accOpts}</select>
      </div>
      <div class="field">
        <label for="p-date">收款日期</label>
        <input type="date" id="p-date" value="${pay.paid_on || todayISO()}">
      </div>
      <div class="field wide">
        <label for="p-note">备注</label>
        <input type="text" id="p-note" value="${esc(pay.note || '')}">
      </div>
      <div class="actions wide">
        <button type="submit" class="primary">保存</button>
        <button type="button" class="ghost" data-close="1">取消</button>
      </div>
    </form>
  </div>`;
}

/* ---------------------------------------------------------------- 房间 */

function viewRooms() {
  const groups = DB.properties.map(p => {
    const rows = roomsOf(p.id).map(room => {
      const st = roomStatus(room);
      const t = st.tenancy;
      const rent = room.self_occupied
        ? `<span class="muted">${rm(room.reference_rent)} <span style="font-size:11px">参考</span></span>`
        : (t ? rm(t.monthly_rent) : '—');
      return `<button class="row" data-room="${room.id}">
        <div class="row-top">
          <span class="row-name">${esc(room.name)}</span>
          <span class="row-rent">${rent}</span>
        </div>
        <div class="row-meta">
          <span>${t ? esc(t.tenant_name) : '<span class="muted">无租客</span>'}</span>
          ${t ? `<span class="muted">到期 ${t.contract_end}</span>` : ''}
          <span class="pill ${st.cls}">${esc(st.label)}</span>
          ${bookedTenancy(room.id) ? `<span class="pill warn plain">已排期 ${bookedTenancy(room.id).contract_start.slice(5)}</span>` : ''}
          ${(room.tags || []).map(g => `<span class="tag">${esc(g)}</span>`).join('')}
        </div>
      </button>`;
    }).join('');
    return `<div class="card"><h2>${esc(p.name)} <span class="sub">${roomsOf(p.id).length} 间</span></h2>${rows || '<div class="empty">还没有房间</div>'}</div>`;
  }).join('');

  return groups + `
  <div class="card">
    <h2>新增房间</h2>
    <form id="room-form" class="form">
      <div class="field">
        <label for="r-prop">房产</label>
        <select id="r-prop" required>${DB.properties.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
      </div>
      <div class="field"><label for="r-name">房间名</label><input type="text" id="r-name" required placeholder="三楼中房"></div>
      <div class="field"><label for="r-tags">标签（逗号分隔）</label><input type="text" id="r-tags" placeholder="中房,独卫"></div>
      <div class="field">
        <label for="r-self">用途</label>
        <select id="r-self"><option value="0">出租</option><option value="1">自住</option></select>
      </div>
      <div class="actions wide"><button type="submit" class="primary">新增</button></div>
    </form>
  </div>`;
}

function viewRoomDetail() {
  const room = DB.rooms.find(r => r.id === UI.roomId);
  if (!room) { UI.roomId = null; return viewRooms(); }

  const p = DB.properties.find(x => x.id === room.property_id);
  const st = roomStatus(room);
  const t = st.tenancy;
  const bk = bookedTenancy(room.id);
  const ar = t ? arrearsOf(t) : { months: [], amount: 0 };

  const history = DB.tenancies
    .filter(x => x.room_id === room.id && x.status === 'ended')
    .sort((a, b) => b.contract_end.localeCompare(a.contract_end));

  const vs = DB.viewings.filter(v => v.room_id === room.id)
    .sort((a, b) => (b.viewing_on + b.viewing_time).localeCompare(a.viewing_on + a.viewing_time));

  return `
  <div style="margin:6px 0 12px"><button class="linkish" data-back="1">← 返回</button></div>

  <div class="card">
    <h2>招租价 <span class="sub">这间房现在开价多少</span></h2>
    <form id="ref-rent-form" class="form">
      <div class="field">
        <label for="rr">月租 (RM)</label>
        <input type="number" id="rr" step="50" value="${room.reference_rent ?? ''}"
               placeholder="${roomRent(room) || '还没定'}">
        <div class="hint">空着时按这个价算「少收多少」。留空就沿用上一任的租金。</div>
      </div>
      <div class="actions wide"><button type="submit" class="primary">保存</button></div>
    </form>
    ${vs.length ? `<div style="border-top:2px dotted var(--border);margin-top:16px;padding-top:14px">
      <h2 style="font-size:14px;margin:0 0 8px">看房记录 <span class="sub">${vs.length} 条</span></h2>
      ${vs.map(v => `<div class="row-meta" style="margin-top:6px">
        <span class="pill ${v.status === 'rented' ? 'good' : v.status === 'passed' ? 'flat' : 'warn'} plain">
          ${VIEW_STATUS[v.status]}</span>
        <span>${v.viewing_on} ${esc(v.viewing_time)}</span>
        <span>${esc(v.name || '（未留名）')}</span>
        ${v.note ? `<span class="muted">${esc(v.note)}</span>` : ''}
      </div>`).join('')}
    </div>` : ''}
  </div>

  <div class="card">
    <h2>${esc(p?.name || '')} · ${esc(room.name)}
      <span class="pill ${st.cls}">${esc(st.label)}</span></h2>
    ${(room.tags || []).map(g => `<span class="tag">${esc(g)}</span>`).join(' ')}
    ${ar.amount > 0 ? `<div class="banner bad" style="margin-top:12px">
      欠租 <b>${rm(ar.amount)}</b>（${ar.months.length} 个月，${ymLabel(ar.months[0])} 起）</div>` : ''}
  </div>

  ${t ? tenancyFormHTML(t, room) : newTenantFormHTML(room, 'active')}
  ${t ? calendarHTML(t) : ''}
  ${t ? backfillHTML(t) : ''}
  ${bk ? bookedCardHTML(bk, room) + calendarHTML(bk, '预付租金记录') : ''}
  ${t && !bk ? newTenantFormHTML(room, 'booked') : ''}

  ${history.length ? `<div class="card"><h2>历史房客 <span class="sub">${history.length} 位</span></h2>
    ${history.map(h => `<div class="collect-row"><div class="left">
      <div class="who">${esc(h.tenant_name)}</div>
      <div class="sub">${h.contract_start} ~ ${h.contract_end}${h.move_out_date ? ` · 搬走 ${h.move_out_date}` : ''}</div>
    </div></div>`).join('')}</div>` : ''}

  <div class="card">
    <h2>危险操作</h2>
    <div class="actions">
      ${t ? `<button class="danger" data-moveout="${t.id}">标记房客已搬走</button>` : ''}
      <button class="danger" data-delroom="${room.id}">删除这间房</button>
    </div>
    <div class="hint muted" style="margin-top:10px;font-size:12px">
      删除房间会连同它的租约和收租记录一起消失，无法复原。两个按钮都要点两次才生效。
    </div>
  </div>`;
}

function tenancyFields(v) {
  v = v || {};
  return `
    <div class="field"><label>房客姓名</label>
      <input name="tname" type="text" value="${esc(v.tenant_name || '')}" required></div>
    <div class="field"><label>电话</label>
      <input name="phone" type="tel" value="${esc(v.phone || '')}" placeholder="0123456789"></div>
    <div class="field"><label>月租 (RM)</label>
      <input name="rent" type="number" step="50" value="${v.monthly_rent ?? ''}" required></div>
    <div class="field"><label>押金 (RM)</label>
      <input name="dep" type="number" step="50" value="${v.deposit ?? ''}"></div>
    <div class="field"><label>押金实收人民币</label>
      <input name="depcny" type="number" step="0.01" value="${v.deposit_cny ?? ''}" placeholder="收马币就留空">
      <div class="hint">押金若用支付宝收，填这里才算得出汇兑盈亏</div></div>
    <div class="field"><label>合约开始</label>
      <input name="start" type="date" value="${v.contract_start || ''}" required></div>
    <div class="field"><label>合约结束</label>
      <input name="end" type="date" value="${v.contract_end || ''}" required></div>
    <div class="field"><label>每月几号收租</label>
      <input name="due" type="number" min="1" max="28" value="${v.rent_due_day || 1}"></div>
    <div class="field"><label>首月租金 (RM)</label>
      <input name="first" type="number" step="50" value="${v.first_month_rent ?? ''}" placeholder="留空 = 全额">
      <div class="hint">月中入住只收部分时填，只影响入住那个月</div></div>
    <div class="field wide"><label>备注</label>
      <input name="notes" type="text" value="${esc(v.notes || '')}"></div>`;
}

function readTenancy(f) {
  const e = f.elements;
  return {
    tenant_name: e.tname.value.trim(),
    phone: e.phone.value.trim(),
    monthly_rent: Number(e.rent.value) || 0,
    deposit: Number(e.dep.value) || 0,
    deposit_cny: e.depcny.value === '' ? null : Number(e.depcny.value),
    contract_start: e.start.value,
    contract_end: e.end.value,
    rent_due_day: Math.min(Math.max(Number(e.due.value) || 1, 1), 28),
    first_month_rent: e.first.value === '' ? null : Number(e.first.value),
    notes: e.notes.value.trim(),
  };
}

function tenancyFormHTML(t, room) {
  const wa = t.phone ? waLink(t.phone, t, room) : null;
  return `
  <div class="card">
    <h2>房客资料 ${wa ? `<a class="linkish" href="${wa}" target="_blank" rel="noopener">WhatsApp 催租</a>` : ''}</h2>
    <form class="form tenancy-edit" data-id="${t.id}">
      ${tenancyFields(t)}
      <div class="actions wide"><button type="submit" class="primary">保存</button></div>
    </form>
  </div>`;
}

// 登记新房客。room 还有人住时只能登记为「已预订」。
function newTenantFormHTML(room, mode) {
  const booking = mode === 'booked';
  return `
  <div class="card">
    <h2>${booking ? '登记下一位房客（预订）' : '登记新房客'}</h2>
    ${booking ? `<p class="muted" style="margin:0 0 12px;font-size:13.5px">
      这间房现在还有人住。合约开始前它算「已预订」：押金计入你手上的钱、
      未来收入推算也算数，但不影响本月收租。上一位标记搬走时会自动转为在住。
    </p>` : ''}
    <form class="form tenancy-new" data-status="${booking ? 'booked' : 'active'}">
      ${tenancyFields({ contract_start: booking ? '' : todayISO(),
                        monthly_rent: num(room.reference_rent) || '' })}
      <div class="actions wide"><button type="submit" class="primary">${booking ? '登记预订' : '登记'}</button></div>
    </form>
  </div>`;
}

// 已预订的下一位房客：可编辑、可记预付租金、可转为在住、可取消
function bookedCardHTML(t, room) {
  const days = daysUntil(t.contract_start);
  const prepaid = DB.payments.filter(p => p.tenancy_id === t.id);
  const prepaidRM = prepaid.reduce((s, p) => s + (p.amount == null ? rentFor(t, p.ym) : num(p.amount)), 0);
  const prepaidCNY = prepaid.reduce((s, p) => s + num(p.cny_amount), 0);
  // 押金和预付租金常常是一笔钱付的，要合起来才算得出真实汇率
  const totalRM = num(t.deposit) + prepaidRM;
  const totalCNY = num(t.deposit_cny) + prepaidCNY;
  return `
  <div class="card" style="border-color:var(--warn)">
    <h2>下一位房客 <span class="pill warn">${t.contract_start} 起 · 还有 ${days} 天</span></h2>
    <div class="stat-grid" style="margin-bottom:14px">
      <div class="stat"><div class="k">押金已收</div><div class="v">${rm(t.deposit)}</div>
        ${num(t.deposit_cny) > 0 ? `<div class="n">${cny(t.deposit_cny)}</div>` : ''}</div>
      <div class="stat"><div class="k">预付租金</div><div class="v">${rm(prepaidRM)}</div>
        ${prepaidCNY > 0 ? `<div class="n">${cny(prepaidCNY)}</div>` : ''}</div>
    </div>
    ${totalCNY > 0 ? `<div class="banner warn" style="margin:0 0 14px">
      合计已收 <b>${rm(totalRM)}</b> = ${cny(totalCNY)}，实际汇率 <b>${(totalRM / totalCNY).toFixed(4)}</b>${
        (totalRM / totalCNY) < fxRate()
          ? `，比你设定的 ${fxRate()} 低，这笔少换了约 ${rm(totalCNY * (fxRate() - totalRM / totalCNY))}。`
          : '。'}
    </div>` : ''}
    <form class="form tenancy-edit" data-id="${t.id}">
      ${tenancyFields(t)}
      <div class="actions wide">
        <button type="submit" class="primary">保存</button>
        <button type="button" class="ghost" data-promote="${t.id}">转为在住</button>
        <button type="button" class="danger" data-cancelbook="${t.id}">取消预订</button>
      </div>
    </form>
  </div>`;
}

function calendarHTML(t, title) {
  const booked = t.status === 'booked';
  const startY = Number(t.contract_start.slice(0, 4));
  const maxY = booked ? Number(t.contract_end.slice(0, 4)) : thisYear();
  const y = UI.year;
  const cells = [];
  for (let m = 1; m <= 12; m++) {
    const ym = `${y}-${pad2(m)}`;
    // 预订租约允许提前打勾（房客常常预付首月租金）
    if (!isDue(t, ym) || (!booked && ym > thisYM())) {
      cells.push(`<button class="mo na" disabled>${m}月<br>—</button>`);
    } else {
      const paid = !!paymentOf(t.id, ym);
      cells.push(`<button class="mo ${paid ? 'paid' : (booked ? '' : 'due')}" data-mo="${ym}" data-tenancy="${t.id}">${m}月<br>${paid ? '✓ 已收' : (booked ? '未收' : '✕ 未收')}</button>`);
    }
  }
  return `
  <div class="card">
    <h2>${esc(title || '收租记录')}</h2>
    <div class="yearnav">
      <button ${y <= startY ? 'disabled' : ''} data-year="-1">←</button>
      <span class="num" style="font-weight:600">${y}</span>
      <button ${y >= maxY ? 'disabled' : ''} data-year="1">→</button>
    </div>
    <div class="legend">
      <span><i style="background:var(--good)"></i>已收</span>
      <span><i style="background:var(--bad)"></i>未收</span>
      <span><i style="background:var(--muted);opacity:.5"></i>合约期外 / 未到期</span>
    </div>
    <div class="months">${cells.join('')}</div>
  </div>`;
}

function backfillHTML(t) {
  return `
  <div class="card">
    <h2>批量补记</h2>
    <p class="muted" style="font-size:13.5px;margin:0 0 12px">
      以前收了但没记录的月份，选一个日期，把这天之前的应收月份一次标为已收。
      只会新增记录，不会覆盖已有的。
    </p>
    <form id="backfill-form" class="form" data-id="${t.id}">
      <div class="field">
        <label for="bf-date">把这个日期之前的都标为已收</label>
        <input type="date" id="bf-date" value="${todayISO()}" required>
      </div>
      <div class="actions"><button type="button" class="danger" data-backfill="1">补记</button></div>
    </form>
  </div>`;
}

// 马来西亚号码：01x-xxxxxxx → 601xxxxxxxx
function waLink(phone, t, room) {
  let n = String(phone).replace(/\D/g, '');
  if (n.startsWith('0')) n = '60' + n.slice(1);
  else if (!n.startsWith('60')) n = '60' + n;
  const ar = arrearsOf(t);
  const owed = ar.amount > 0
    ? `目前未收 ${ar.months.map(ymLabel).join('、')}，共 RM${ar.amount}。`
    : `${ymLabel(thisYM())} 租金 RM${rentFor(t, thisYM())}。`;
  const msg = `你好 ${t.tenant_name}，${room.name} 的租金提醒：${owed}麻烦安排一下，谢谢！`;
  return `https://wa.me/${n}?text=${encodeURIComponent(msg)}`;
}

/* ---------------------------------------------------------------- 日租 */

function viewStays() {
  const ym = thisYM();
  const thisMonthTotal = stayIncomeOf(ym);
  const unpaid = DB.stays.filter(s => !s.paid);

  const roomOpts = DB.properties.map(p =>
    `<optgroup label="${esc(p.name)}">${roomsOf(p.id).map(r =>
      `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</optgroup>`).join('');

  return `
  <div class="card">
    <div class="hero-label">${ymLabel(ym)} 日租收入</div>
    <div class="hero-figure">${rm(thisMonthTotal)}</div>
    <div class="hero-sub">单价 ${rm(dailyRate())}/晚${unpaid.length ? ` · <span style="color:var(--bad)">${unpaid.length} 笔未收款</span>` : ''}</div>
  </div>

  <div class="card">
    <h2>新增日租</h2>
    <form id="stay-form" class="form">
      <div class="field"><label for="s-room">房间</label><select id="s-room" required>${roomOpts}</select></div>
      <div class="field"><label for="s-guest">客人姓名</label><input type="text" id="s-guest"></div>
      <div class="field"><label for="s-in">入住</label><input type="date" id="s-in" value="${todayISO()}" required></div>
      <div class="field"><label for="s-out">退房</label><input type="date" id="s-out" required></div>
      <div class="field"><label for="s-rate">每晚 (RM)</label><input type="number" id="s-rate" step="10" value="${dailyRate()}"></div>
      <div class="field"><label for="s-cny">支付宝人民币</label><input type="number" id="s-cny" step="1" placeholder="没收人民币就留空"></div>
      <div class="field">
        <label for="s-paid">收款状态</label>
        <select id="s-paid"><option value="1">已收款</option><option value="0">未收款</option></select>
      </div>
      <div class="field"><label for="s-note">备注</label><input type="text" id="s-note"></div>
      <div class="actions wide"><button type="submit" class="primary">新增</button></div>
    </form>
    <div class="hint muted" style="margin-top:10px;font-size:12px">
      退房当天不算钱。系统会检查这间房在这段期间有没有月租合约，撞期会提醒。
    </div>
  </div>

  <div class="card">
    <h2>日租记录 <span class="sub">${DB.stays.length} 笔</span></h2>
    ${DB.stays.length ? DB.stays.map(s => {
      const room = DB.rooms.find(r => r.id === s.room_id);
      const p = propertyOf(s.room_id);
      const n = stayNights(s);
      return `<div class="collect-row">
        <div class="left">
          <div class="who">${esc(s.guest_name || '（未填姓名）')}</div>
          <div class="sub">${esc(p?.name || '')} · ${esc(room?.name || '已删除')} · ${s.check_in} → ${s.check_out}（${n} 晚）${
            num(s.cny_amount) > 0 ? ` · ${cny(s.cny_amount)}` : ''}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex:0 0 auto">
          <span class="row-rent">${rm(stayAmount(s))}</span>
          <button class="tick ${s.paid ? 'on' : 'off'}" data-staypaid="${s.id}">${s.paid ? '✓' : '✕'}</button>
          <button class="danger" data-delstay="${s.id}">删</button>
        </div>
      </div>`;
    }).join('') : '<div class="empty">还没有日租记录</div>'}
  </div>`;
}

/* ---------------------------------------------------------------- 账户与报表 */

function backupCardHTML() {
  const last = lastBackup();
  const stale = !last || daysBetween(last, todayISO()) > 45;
  const rows = BACKUP_TABLES.reduce((n, [, k]) => n + (DB[k] || []).length, 0);
  return `
  <div class="card">
    <h2>备份 <span class="sub">${last ? `上次 ${last}` : '从未备份'}</span></h2>
    <p class="hero-sub">
      Supabase 免费版<b>没有自动备份</b>，误删就是永久删除。
      改过资料后点一下，把文件存进 iCloud 或 Google Drive。
    </p>
    ${stale ? `<div class="banner warn" style="margin:12px 0">
      ${last ? `距上次备份已经 ${daysBetween(last, todayISO())} 天了。` : '还没备份过。'}
    </div>` : ''}
    <div class="actions wide">
      <button type="button" class="primary" data-backup="1">下载备份（${rows} 条记录）</button>
    </div>
    <div class="hint muted" style="margin-top:10px;font-size:12px">
      文件里有房客姓名和电话 —— 别放进 GitHub 仓库，那是公开的。
    </div>
    ${IS_LAB ? `
    <div style="border-top:1px solid var(--border);margin-top:18px;padding-top:16px">
      <h2 style="font-size:15px;margin:0 0 8px">从备份恢复 <span class="sub">只有试验站能用</span></h2>
      <p class="hero-sub">
        会先<b>清空试验站现有数据</b>再灌进去。生产站是另一个 Supabase 项目，不受影响。
      </p>
      <input type="file" id="restore-file" accept="application/json,.json" style="margin-top:10px">
      <div class="actions wide" style="margin-top:10px">
        <button type="button" class="danger" data-restore="1">清空并恢复</button>
      </div>
    </div>` : ''}
  </div>`;
}

function viewMoney() {
  const dep = totalDeposits();
  const { rmTotal, cnyTotal } = accountsInRM();
  const gap = rmTotal - dep;
  const rate = fxRate();
  // 汇率跌到这个数就不够退押金了
  const breakeven = cnyTotal > 0 ? dep / cnyTotal : null;
  const imp = impliedRate();

  const future = futureIncome(12);
  const maxF = Math.max(...future.map(f => f.total), 1);
  const past = pastIncome(6);
  const maxP = Math.max(...past.map(p => p.rent + p.stay), 1);
  const acHist = airconHistory(12);
  const maxAc = Math.max(...acHist.map(h => h.billed), 1);

  return `
  <div class="card">
    <h2>押金能不能兑付</h2>
    <div class="stat-grid">
      <div class="stat"><div class="k">押金总额（负债）</div><div class="v">${rm(dep)}</div>
        <div class="n">马币计价</div></div>
      <div class="stat"><div class="k">账户余额折马币</div><div class="v">${rm(rmTotal)}</div>
        <div class="n">${cny(cnyTotal)} × ${rate}</div></div>
    </div>
    <div class="banner ${gap >= 0 ? 'warn' : 'bad'}" style="margin:14px 0 0;${gap >= 0 ? 'background:var(--good-soft);color:var(--good)' : ''}">
      ${gap >= 0
        ? `够退，还多 <b>${rm(gap)}</b>（覆盖率 ${Math.round(rmTotal / (dep || 1) * 100)}%）`
        : `<b>不够退，缺 ${rm(-gap)}</b>（覆盖率 ${Math.round(rmTotal / (dep || 1) * 100)}%）`}
    </div>
    ${breakeven ? `<div class="hero-sub" style="margin-top:10px">
      ⚠️ 押金是<b>马币负债</b>，钱在<b>人民币账户</b>，中间隔着汇率。
      ${rate >= breakeven
        ? `汇率跌到 <b>${breakeven.toFixed(4)}</b> 以下就不够退了（现在 ${rate}，还有 ${Math.round((rate / breakeven - 1) * 100)}% 缓冲）。`
        : `要退得起全部押金，汇率得涨到 <b>${breakeven.toFixed(4)}</b>（现在 ${rate}），或者账户再多 ${cny((dep - rmTotal) / rate)}。`}
    </div>` : ''}
    ${imp ? `<div class="hero-sub" style="margin-top:6px">
      最近 ${imp.n} 笔支付宝收款的实际汇率是 <b>${imp.rate.toFixed(4)}</b>${
        Math.abs(imp.rate - rate) / rate > 0.03 ? '，跟设置里的差得有点多，建议更新。' : '。'}
    </div>` : ''}
  </div>

  <div class="card">
    <h2>账户余额 <span class="sub">手动更新</span></h2>
    ${DB.accounts.length ? DB.accounts.map((a, i) => `
      <form class="form acct-form" data-id="${a.id}"
        style="${i ? 'border-top:1px solid var(--border);padding-top:16px;margin-top:16px' : ''}">
        <div class="field"><label>账户名称</label>
          <input name="name" type="text" value="${esc(a.name)}" required></div>
        <div class="field"><label>余额（${a.currency}）</label>
          <input name="balance" type="number" step="0.01" value="${num(a.balance)}"></div>
        <div class="actions wide">
          <button type="submit" class="primary">保存</button>
          <button type="button" class="danger" data-delacct="${a.id}">删除</button>
          <span class="muted" style="font-size:12px">${
            a.balance_updated_at ? `余额更新于 ${a.balance_updated_at.slice(0, 10)}` : '余额从未更新'}</span>
        </div>
      </form>`).join('') : '<div class="empty">还没有账户，用下面的表单加一个。</div>'}

    <div class="hint muted" style="margin-top:14px;font-size:12px">
      删除账户不会动到收租记录 —— 那些记录只会变成「没有指定账户」，金额和日期都还在。
    </div>

    <form id="acct-new" class="form" style="margin-top:16px;border-top:1px solid var(--border);padding-top:16px">
      <div class="field wide"><label for="a-name">新增账户</label>
        <input type="text" id="a-name" placeholder="账户名称" required></div>
      <div class="actions wide"><button type="submit" class="ghost">新增</button></div>
    </form>
  </div>

  ${backupCardHTML()}

  <div class="card">
    <h2>设置</h2>
    <form id="settings-form" class="form">
      <div class="field">
        <label for="s-fx">人民币兑马币汇率</label>
        <input type="number" id="s-fx" step="0.0001" value="${rate}">
        <div class="hint">1 CNY = ? RM${imp ? ` · 最近实际 ${imp.rate.toFixed(4)}` : ''}</div>
      </div>
      <div class="field">
        <label for="s-daily">日租默认单价 (RM)</label>
        <input type="number" id="s-daily" step="10" value="${dailyRate()}">
      </div>
      <div class="actions wide"><button type="submit" class="primary">保存设置</button></div>
    </form>
  </div>

  <div class="card">
    <h2>未来 12 个月 <span class="sub">按现有合约推算</span></h2>
    ${future.map((f, i) => {
      const prev = i > 0 ? future[i - 1].total : f.total;
      const dip = f.total < prev;
      const open = UI.openMonth === f.ym;
      return `<button class="fbar" data-fmonth="${f.ym}" aria-expanded="${open}">
        <span class="mo-label">${f.ym.slice(2)}</span>
        <span class="track"><i class="${dip ? 'dip' : ''}" style="width:${Math.round(f.total / maxF * 100)}%"></i></span>
        <span class="amt" ${dip ? 'style="color:var(--warn)"' : ''}>${rm(f.total)}</span>
      </button>${open ? monthDetailHTML(f.ym) : ''}`;
    }).join('')}
    <div class="hero-sub" style="margin-top:10px">
      点任一个月，看那个月哪些房出租、哪些房空着。
      橙色 = 比上个月少，因为有合约到期。
    </div>
  </div>

  <div class="card">
    <h2>过去 6 个月实收 <span class="sub">月租 + 日租</span></h2>
    ${past.map(p => `<div class="fbar">
      <span class="mo-label">${p.ym.slice(2)}</span>
      <span class="track"><i style="width:${Math.round((p.rent + p.stay) / maxP * 100)}%"></i></span>
      <span class="amt">${rm(p.rent + p.stay)}</span>
    </div>`).join('')}
    <div class="hero-sub" style="margin-top:10px">只统计已经打勾的收租记录。</div>
  </div>

  <div class="card">
    <h2>电费历史 <span class="sub">按电费所属月份</span></h2>
    ${acHist.some(h => h.billed > 0) ? acHist.map(h => {
      const open = UI.openAcMonth === h.ym;
      const owed = h.billed - h.collected;
      return `<button class="fbar" data-acmonth="${h.ym}" aria-expanded="${open}">
        <span class="mo-label">${h.ym.slice(2)}</span>
        <span class="track"><i style="width:${Math.round(h.collected / maxAc * 100)}%"></i>
          ${owed > 0 ? `<i class="dip" style="width:${Math.round(owed / maxAc * 100)}%"></i>` : ''}</span>
        <span class="amt" ${owed > 0 ? 'style="color:var(--warn)"' : ''}>${rm(h.billed)}</span>
      </button>${open ? airconDetailHTML(h.ym) : ''}`;
    }).join('') : '<div class="empty">还没有空调费记录。去「收租」页逐个填金额。</div>'}
    ${acHist.some(h => h.billed > 0) ? `<div class="hero-sub" style="margin-top:10px">
      深色 = 已收，橙色 = 已录入但还没收。合计已收
      <b>${rm(acHist.reduce((s, h) => s + h.collected, 0))}</b>，还差
      <b style="color:var(--warn)">${rm(acHist.reduce((s, h) => s + (h.billed - h.collected), 0))}</b>。
      点任一个月看是哪几间。<b>月份指的是哪个月的电，次月才收</b> ——
      8 月那格是 8 月的电费、9 月收的。跟上面按收租月份排的租金图不是一回事。
      电费按实际账单收，所以不做未来推算。
    </div>` : ''}
  </div>`;
}

// 空调费历史：直接按已录的记录统计。
// 不能走 airconStats —— 那个只算在住/预订的租约，房客一搬走（status 变 ended），
// 他过去交过的钱就会从历史里凭空消失。历史要照实记账，跟人现在还在不在无关。
function airconHistory(months = 12) {
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const ym = addMonthsYM(thisYM(), -i);
    const rows = DB.aircon.filter(a => a.ym === ym);
    out.push({
      ym,
      count: rows.length,
      billed: rows.reduce((s, a) => s + num(a.amount), 0),
      collected: rows.filter(a => a.paid).reduce((s, a) => s + num(a.amount), 0),
    });
  }
  return out;
}

// 某月空调费的逐间明细。
// 以已录的记录为准（含已搬走的房客），再补上「当月在住但没录金额」的那些。
function airconDetailHTML(ym) {
  const seen = new Set();
  const rowOf = (t, a) => {
    const room = DB.rooms.find(r => r.id === t?.room_id);
    const p = t ? propertyOf(t.room_id) : null;
    return {
      where: `${p?.name || ''} · ${room?.name || '（房间已删除）'}`,
      name: t?.tenant_name || '（租约已删除）',
      ended: t?.status === 'ended',
      a,
    };
  };
  const rows = DB.aircon.filter(a => a.ym === ym).map(a => {
    seen.add(a.tenancy_id);
    return rowOf(DB.tenancies.find(t => t.id === a.tenancy_id), a);
  });
  for (const t of airconTenancies(ym)) {
    if (!seen.has(t.id)) rows.push(rowOf(t, null));
  }
  if (!rows.length) return '<div class="mdetail"><div class="empty">这个月没有在住租客。</div></div>';
  const done = rows.filter(r => r.a && r.a.paid);
  const unpaid = rows.filter(r => r.a && !r.a.paid);
  const missing = rows.filter(r => !r.a);
  const line = r => `<li><span>${esc(r.where)} <span class="muted">${esc(r.name)}</span>${
    r.ended ? ' <span class="tag">已搬走</span>' : ''}</span>
    <b>${r.a ? rm(r.a.amount) : '—'}</b></li>`;
  return `<div class="mdetail">
    ${done.length ? `<h4>已收 · ${done.length} 间 · ${rm(done.reduce((s, r) => s + num(r.a.amount), 0))}</h4>
      <ul>${done.map(line).join('')}</ul>` : ''}
    ${unpaid.length ? `<h4 style="color:var(--bad)">未收 · ${unpaid.length} 间 · ${rm(unpaid.reduce((s, r) => s + num(r.a.amount), 0))}</h4>
      <ul>${unpaid.map(line).join('')}</ul>` : ''}
    ${missing.length ? `<h4 class="muted">没录金额 · ${missing.length} 间</h4>
      <ul>${missing.map(line).join('')}</ul>` : ''}
  </div>`;
}

// 点开某个月后展开的明细：那个月哪些房出租、哪些房空着
function monthDetailHTML(ym) {
  const { let_, vacant, self } = monthBreakdown(ym);
  const income = let_.reduce((s, x) => s + x.rent, 0);
  const lost = vacant.reduce((s, x) => s + x.money, 0);
  return `<div class="mdetail">
    <h4>出租中 · ${let_.length} 间 · ${rm(income)}</h4>
    ${let_.length ? `<ul>${let_.map(x => `<li>
      <span>${esc(x.where)} <span class="muted">${x.occupants.map(t => esc(t.tenant_name)).join('、')}</span>${
        x.partial ? ` <span class="tag">当月空 ${vacancySpan(ym, x.partial)}（${x.partial.vacant} 天）</span>` : ''}</span>
      <b>${rm(x.rent)}</b></li>`).join('')}</ul>` : '<div class="empty">无</div>'}

    ${vacant.length ? `<h4 style="color:var(--bad)">空置 · ${vacant.length} 间 · 少收约 ${rm(lost)}</h4>
    <ul>${vacant.map(x => `<li>
      <span>${esc(x.where)} <span class="muted">空 ${vacancySpan(ym, x)}${
        x.vacant === x.total ? '' : `（${x.vacant} 天）`}</span><br>${
        x.next
          ? `<span class="pill warn">${x.next.contract_start} ${esc(x.next.tenant_name)} 已定 · 只能短租</span>`
          : '<span class="tag">可长租</span>'}</span>
      <b style="color:var(--bad)">${rm(x.money)}</b></li>`).join('')}</ul>` : ''}

    ${self.length ? `<h4>自住 · ${self.length} 间</h4>
    <ul>${self.map(x => `<li><span>${esc(x.where)}</span></li>`).join('')}</ul>` : ''}
  </div>`;
}

/* ================================================================ 交互 */

function armDanger(btn, onConfirm) {
  if (btn.dataset.armed === '1') { onConfirm(); return; }
  btn.dataset.armed = '1';
  const orig = btn.textContent;
  btn.textContent = '再点一次确认';
  btn.classList.add('armed');
  setTimeout(() => {
    btn.dataset.armed = '0';
    btn.textContent = orig;
    btn.classList.remove('armed');
  }, 4000);
}

// ⚠️ 这些 data-* 属性**必须带值**。写成 `data-back`（没有值）时，
// el.dataset.back 是空字符串，而下面全是 `if (d.back)` 这样判真假的 ——
// 空字符串是假的，分支永远不进，按钮点了毫无反应也不报错。
// 「返回」和对话框的「取消」就这么死了很久。要么带值，要么用 `!== undefined` 判。
document.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-tab],[data-room],[data-back],[data-tick],[data-editpay],[data-close],[data-mo],[data-year],[data-backfill],[data-moveout],[data-delroom],[data-staypaid],[data-delstay],[data-airtick],[data-promote],[data-cancelbook],[data-delacct],[data-fmonth],[data-acmonth],[data-acym],[data-backup],[data-restore],[data-vstatus],[data-delviewing]');
  if (!el) return;
  const d = el.dataset;

  if (d.vstatus) {
    const [id, status] = d.vstatus.split(':');
    // 标成「租了」不自动建租约：签没签、押金多少、几号起租都得他自己填。
    // 凭一条看房记录猜出一份合约，比不建危险得多。
    await write(() => sb.from('viewings').update({ status }).eq('id', id),
      status === 'rented' ? '已标记租了 —— 记得去那间房建租约' : '已更新');
    return;
  }
  if (d.delviewing) {
    armDanger(el, () => write(() => sb.from('viewings').delete().eq('id', d.delviewing), '预约已删除'));
    return;
  }
  if (d.backup) { downloadBackup(); return; }
  if (d.restore) {
    const file = $('#restore-file')?.files?.[0];
    if (!file) { toast('先选一个备份文件', 'bad'); return; }
    armDanger(el, async () => {
      try {
        await restoreBackup(file);
        await loadAll();
        render();
        toast('已从备份恢复', 'good');
      } catch (e) {
        console.error(e);
        toast('恢复失败：' + (e.message || e), 'bad');
      }
    });
    return;
  }
  if (d.fmonth) {
    UI.openMonth = UI.openMonth === d.fmonth ? null : d.fmonth;
    UI.keepScroll = true;   // 展开明细后别把页面弹回顶部
    render();
    return;
  }
  if (d.acmonth) {
    UI.openAcMonth = UI.openAcMonth === d.acmonth ? null : d.acmonth;
    UI.keepScroll = true;
    render();
    return;
  }
  if (d.tab)   { UI.tab = d.tab; UI.roomId = null; render(); return; }
  if (d.back)  { UI.roomId = null; render(); return; }
  if (d.room)  { UI.roomId = d.room; UI.tab = 'rooms'; UI.year = thisYear(); render(); return; }
  if (d.promote) {
    armDanger(el, () => write(() => sb.from('tenancies')
      .update({ status: 'active' }).eq('id', d.promote), '已转为在住'));
    return;
  }
  if (d.cancelbook) {
    armDanger(el, () => write(() => sb.from('tenancies').delete().eq('id', d.cancelbook), '预订已取消'));
    return;
  }
  if (d.close) { render(); return; }
  if (d.year)  { UI.year += Number(d.year); render(); return; }

  if (d.editpay) {
    const t = DB.tenancies.find(x => x.id === d.editpay);
    $('#main').insertAdjacentHTML('afterbegin', payDialogHTML(t));
    window.scrollTo({ top: 0 });
    return;
  }

  // 本月收租开关
  if (d.tick) {
    const t = DB.tenancies.find(x => x.id === d.tick);
    const ym = thisYM();
    const existing = paymentOf(t.id, ym);
    if (existing) {
      await write(() => sb.from('payments').delete().eq('id', existing.id), '已取消');
    } else {
      await write(() => sb.from('payments').insert({
        tenancy_id: t.id, ym, amount: rentFor(t, ym), paid_on: todayISO(),
      }), `已收 ${t.tenant_name}`);
    }
    return;
  }

  // 月历格子
  if (d.mo) {
    const t = DB.tenancies.find(x => x.id === d.tenancy);
    const existing = paymentOf(t.id, d.mo);
    if (existing) await write(() => sb.from('payments').delete().eq('id', existing.id), '已取消');
    else await write(() => sb.from('payments').insert({
      tenancy_id: t.id, ym: d.mo, amount: rentFor(t, d.mo),
    }), `已标记 ${ymLabel(d.mo)}`);
    return;
  }

  if (d.backfill) {
    const form = el.closest('form');
    const t = DB.tenancies.find(x => x.id === form.dataset.id);
    const cutoff = $('#bf-date', form).value;
    if (!cutoff) return;
    const targets = dueMonths(t, cutoff.slice(0, 7))
      .filter(ym => ym < cutoff.slice(0, 7) || cutoff.slice(8) === '31')
      .filter(ym => !paymentOf(t.id, ym));
    if (!targets.length) { toast('没有需要补记的月份'); return; }
    armDanger(el, async () => {
      await write(() => sb.from('payments').insert(
        targets.map(ym => ({ tenancy_id: t.id, ym, amount: rentFor(t, ym), note: '批量补记' }))
      ), `补记了 ${targets.length} 个月`);
    });
    if (el.dataset.armed === '1') toast(`将补记 ${targets.length} 个月，再点一次确认`);
    return;
  }

  if (d.moveout) {
    armDanger(el, async () => {
      const gone = DB.tenancies.find(x => x.id === d.moveout);
      const next = gone && bookedTenancy(gone.room_id);
      const ok = await write(() => sb.from('tenancies')
        .update({ status: 'ended', move_out_date: todayISO() }).eq('id', d.moveout), '已标记搬走');
      // 有预订的下一位就自动接上，免得房间显示成空的
      if (ok && next) {
        await write(() => sb.from('tenancies').update({ status: 'active' }).eq('id', next.id),
          `${next.tenant_name} 已转为在住`);
      }
    });
    return;
  }

  if (d.delroom) {
    armDanger(el, async () => {
      const ok = await write(() => sb.from('rooms').delete().eq('id', d.delroom), '房间已删除');
      if (ok) { UI.roomId = null; render(); }
    });
    return;
  }

  if (d.acym) {
    const next = addMonthsYM(acYM(), Number(d.acym));
    if (next > billYM()) return;   // 账单还没出，录不了
    UI.acYM = next;
    UI.keepScroll = true;
    render();
    return;
  }

  if (d.airtick) {
    const a = airconOf(d.airtick, acYM());
    if (!a) { toast('先填金额再打勾'); return; }
    await write(() => sb.from('aircon_charges')
      .update({ paid: !a.paid, paid_on: a.paid ? null : todayISO() }).eq('id', a.id));
    return;
  }

  if (d.delacct) {
    armDanger(el, () => write(() => sb.from('accounts').delete().eq('id', d.delacct), '账户已删除'));
    return;
  }

  if (d.staypaid) {
    const s = DB.stays.find(x => x.id === d.staypaid);
    await write(() => sb.from('short_stays').update({ paid: !s.paid }).eq('id', s.id));
    return;
  }

  if (d.delstay) {
    armDanger(el, () => write(() => sb.from('short_stays').delete().eq('id', d.delstay), '已删除'));
    return;
  }
});

document.addEventListener('submit', async ev => {
  const f = ev.target;
  ev.preventDefault();

  if (f.id === 'login-form') {
    const email = $('#login-email').value.trim();
    const btn = $('button', f);
    btn.disabled = true;
    const { error } = await sb.auth.signInWithOtp({
      email, options: { emailRedirectTo: window.location.href.split('#')[0] },
    });
    btn.disabled = false;
    if (error) toast('寄信失败：' + error.message, 'bad');
    else { $('#login-sent').classList.remove('hide'); f.classList.add('hide'); }
    return;
  }

  if (f.classList.contains('tenancy-edit')) {
    await write(() => sb.from('tenancies').update(readTenancy(f)).eq('id', f.dataset.id), '已保存');
    return;
  }

  if (f.classList.contains('tenancy-new')) {
    // room_id 取自 UI.roomId，不挂 data-room：那是点击委托里的导航命令，
    // 挂上去点提交会先跳转重渲染，表单没提交就被换掉 ——
    // 「登记新租客」因此一直是死的，从没人发现，因为它不报错。
    await write(() => sb.from('tenancies').insert({
      room_id: UI.roomId,
      status: f.dataset.status,
      ...readTenancy(f),
    }), f.dataset.status === 'booked' ? '预订已登记' : '已登记');
    return;
  }

  if (f.id === 'pay-form') {
    const t = DB.tenancies.find(x => x.id === f.dataset.tenancy);
    const ym = thisYM();
    const row = {
      tenancy_id: t.id, ym,
      amount: Number($('#p-amount').value) || null,
      cny_amount: Number($('#p-cny').value) || null,
      account_id: $('#p-account').value || null,
      method: $('#p-cny').value ? 'alipay' : '',
      paid_on: $('#p-date').value || null,
      note: $('#p-note').value.trim(),
    };
    await write(() => sb.from('payments').upsert(row, { onConflict: 'tenancy_id,ym' }), '已保存');
    return;
  }

  if (f.id === 'ref-rent-form') {
    // 用 UI.roomId，不在表单上挂 data-room —— data-room 是点击委托里的**导航命令**
    // （「打开这间房」）。当数据挂上去，点保存会先触发跳转重渲染，
    // 表单在提交前就被换掉，浏览器报 "form is not connected"，按钮看起来是死的。
    const raw = $('#rr').value.trim();
    await write(() => sb.from('rooms')
      .update({ reference_rent: raw === '' ? null : Number(raw) })
      .eq('id', UI.roomId), raw === '' ? '已清空，回到按上一任租金算' : '招租价已保存');
    return;
  }

  if (f.id === 'viewing-form') {
    await write(() => sb.from('viewings').insert({
      room_id: $('#v-room').value,
      viewing_on: $('#v-on').value,
      viewing_time: $('#v-time').value || '',
      name: $('#v-name').value.trim(),
      phone: $('#v-phone').value.trim(),
      want_from: $('#v-from').value || null,
      note: $('#v-note').value.trim(),
    }), '预约已记下');
    return;
  }

  if (f.id === 'room-form') {
    const tags = $('#r-tags').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    await write(() => sb.from('rooms').insert({
      property_id: $('#r-prop').value,
      name: $('#r-name').value.trim(),
      tags,
      self_occupied: $('#r-self').value === '1',
      sort_order: DB.rooms.length,
    }), '房间已新增');
    return;
  }

  if (f.id === 'stay-form') {
    const roomId = $('#s-room').value;
    const ci = $('#s-in').value, co = $('#s-out').value;
    if (co <= ci) { toast('退房日期要晚于入住日期', 'bad'); return; }

    // 撞期检查：这间房这段时间有没有月租合约
    const clash = DB.tenancies.find(t =>
      t.room_id === roomId && t.status === 'active' &&
      t.contract_start < co && t.contract_end > ci);
    if (clash && !confirm(`这间房 ${clash.contract_start} ~ ${clash.contract_end} 有 ${clash.tenant_name} 的月租合约，确定还要加日租吗？`)) return;

    await write(() => sb.from('short_stays').insert({
      room_id: roomId,
      guest_name: $('#s-guest').value.trim(),
      check_in: ci, check_out: co,
      nightly_rate: Number($('#s-rate').value) || dailyRate(),
      cny_amount: Number($('#s-cny').value) || null,
      method: $('#s-cny').value ? 'alipay' : '',
      paid: $('#s-paid').value === '1',
      note: $('#s-note').value.trim(),
    }), '日租已新增');
    return;
  }

  if (f.classList.contains('aircon-row')) {
    const raw = $('input', f).value.trim();
    const tid = f.dataset.tenancy;
    const existing = airconOf(tid, acYM());
    if (raw === '') {
      if (existing) await write(() => sb.from('aircon_charges').delete().eq('id', existing.id), '已清除');
      return;
    }
    await write(() => sb.from('aircon_charges').upsert(
      { tenancy_id: tid, ym: acYM(), amount: Number(raw) || 0 },
      { onConflict: 'tenancy_id,ym' }), `${ymLabel(acYM())} 空调费已存`);
    return;
  }

  if (f.classList.contains('acct-form')) {
    const e = f.elements;
    const a = DB.accounts.find(x => x.id === f.dataset.id);
    const bal = Number(e.balance.value) || 0;
    const patch = { name: e.name.value.trim(), balance: bal };
    // 只有余额真的变了才刷新时间戳。否则改个名字也把「更新于」刷新，
    // 就看不出余额到底多久没对过了。
    if (a && bal !== num(a.balance)) patch.balance_updated_at = new Date().toISOString();
    await write(() => sb.from('accounts').update(patch).eq('id', f.dataset.id), '已保存');
    return;
  }

  if (f.id === 'acct-new') {
    // 币种不在界面上暴露 —— 账户都是人民币。栏位仍留在数据库里（默认 CNY），
    // 日后真开了马币户口，把选单加回来即可，不必改表。
    await write(() => sb.from('accounts').insert({
      name: $('#a-name').value.trim(),
      sort_order: DB.accounts.length,
    }), '账户已新增');
    return;
  }

  if (f.id === 'settings-form') {
    await write(() => sb.from('app_settings').update({
      cny_to_myr: Number($('#s-fx').value) || 0.62,
      daily_rate: Number($('#s-daily').value) || 90,
      updated_at: new Date().toISOString(),
    }).eq('owner_id', session.user.id), '设置已保存');
    return;
  }
});

/* ================================================================ 启动 */

async function boot() {
  const cfg = window.SUPABASE_CONFIG || {};
  // 验网址长得对不对，而不是找某句占位符：占位符换个写法就漏过去了，
  // 而 createClient 拿到不是网址的字符串会直接抛错 —— 结果是白屏，连提示都看不到。
  const ready = /^https:\/\/[a-z0-9-]+\.supabase\.co/i.test(String(cfg.url || '').trim())
                && String(cfg.anonKey || '').length > 20;
  if (!ready) {
    const file = IS_LAB ? 'lab/config.js' : 'config.js';
    document.body.innerHTML = `<div id="login">
      <h1>${IS_LAB ? '试验站' : '还没'}接上 Supabase</h1>
      <p>请编辑仓库里的 <code>${file}</code>，填入${IS_LAB ? '<b>第二个</b>' : ''}
      Supabase 项目的 Project URL 和 anon key。步骤见 <code>README.md</code>。</p>
      ${IS_LAB ? '<p class="muted">填成生产站那个项目的话，在这里改数据就会动到真资料。</p>' : ''}
      </div>`;
    return;
  }

  if (IS_LAB) {
    // 两个站长得一模一样，误把试验站当生产站改数据是迟早的事。顶栏染色 + 改标题，
    // 让它在手机上扫一眼就分得出来。
    document.body.classList.add('lab');
    document.title = '试验站 · 出租房管理';
    const t = $('#topbar .title');
    if (t) t.textContent = '出租房管理 · 试验站';
  }

  sb = window.supabase.createClient(cfg.url, cfg.anonKey);

  const { data } = await sb.auth.getSession();
  session = data.session;

  sb.auth.onAuthStateChange((_e, s) => {
    const was = !!session;
    session = s;
    if (!!s !== was) start();
  });

  await start();
}

async function start() {
  if (!session) {
    $('#login').classList.remove('hide');
    $('#app').classList.add('hide');
    return;
  }
  $('#login').classList.add('hide');
  $('#app').classList.remove('hide');
  try {
    await loadAll();
    render();
  } catch (e) {
    console.error(e);
    $('#main').innerHTML = `<div class="card"><div class="banner bad">
      读取数据失败：${esc(e.message || e)}<br><br>
      多半是 <code>schema.sql</code> 还没在 Supabase 里跑过。</div></div>`;
  }
}

// passive：告诉浏览器这个监听不会 preventDefault，滚动就不用等它，手机上更跟手
window.addEventListener('scroll', syncToTop, { passive: true });

// 用 ?. 而不是直接绑：index.html 自己没法用 ?v= 破缓存（它就是那个入口地址），
// 所以手机上有可能拿到旧的 index.html 配新的 app.js。那时 #totop 还不存在，
// 直接绑会抛错、整个页面起不来 —— 为一个锦上添花的按钮赔掉整个应用不划算。
$('#totop')?.addEventListener('click', () => {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' });
});

$('#logout').addEventListener('click', async () => {
  await sb.auth.signOut();
  session = null;
  start();
});

boot();
