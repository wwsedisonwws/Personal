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

const DB = {
  properties: [], rooms: [], tenancies: [], payments: [],
  accounts: [], stays: [], settings: null,
};

const UI = { tab: 'dash', roomId: null, year: thisYear() };

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
  const tables = ['properties', 'rooms', 'tenancies', 'payments', 'accounts', 'short_stays', 'app_settings'];
  const results = await Promise.all(tables.map(t => sb.from(t).select('*')));

  const failed = results.find(r => r.error);
  if (failed) throw failed.error;

  const [props, rooms, ten, pay, acc, stays, settings] = results.map(r => r.data || []);
  DB.properties = props.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  DB.rooms = rooms.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  DB.tenancies = ten;
  DB.payments = pay;
  DB.accounts = acc.sort((a, b) => a.sort_order - b.sort_order);
  DB.stays = stays.sort((a, b) => b.check_in.localeCompare(a.check_in));
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

/* ================================================================ 计算 */

const roomsOf = pid => DB.rooms.filter(r => r.property_id === pid);
const activeTenancy = roomId => DB.tenancies.find(t => t.room_id === roomId && t.status === 'active');
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

const paidAmount = (t, ym) => {
  const p = paymentOf(t.id, ym);
  return p ? (p.amount == null ? num(t.monthly_rent) : num(p.amount)) : 0;
};

function arrearsOf(t) {
  const unpaid = dueMonths(t).filter(ym => !paymentOf(t.id, ym));
  return { months: unpaid, amount: unpaid.length * num(t.monthly_rent) };
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
  for (const t of DB.tenancies) {
    if (t.status !== 'active' || !isDue(t, ym)) continue;
    rooms++; due += num(t.monthly_rent);
    if (paymentOf(t.id, ym)) { done++; got += paidAmount(t, ym); }
  }
  return { due, got, rooms, done, outstanding: due - got };
}

const stayNights = s => Math.max(0, daysBetween(s.check_in, s.check_out));
const stayAmount = s => s.amount == null ? stayNights(s) * num(s.nightly_rate) : num(s.amount);

// 某月的日租收入（按入住日归属月份）
const stayIncomeOf = ym =>
  DB.stays.filter(s => s.paid && s.check_in.slice(0, 7) === ym)
          .reduce((sum, s) => sum + stayAmount(s), 0);

const totalDeposits = () =>
  DB.tenancies.filter(t => t.status === 'active').reduce((s, t) => s + num(t.deposit), 0);

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
    rmSum += p.amount == null ? num(t?.monthly_rent) : num(p.amount);
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
      if (t.status === 'active' && isDue(t, ym)) total += num(t.monthly_rent);
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
      rent += p.amount == null ? num(t?.monthly_rent) : num(p.amount);
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
    stays: viewStays, money: viewMoney,
  };
  $('#main').innerHTML = UI.roomId ? viewRoomDetail() : views[UI.tab]();
  window.scrollTo({ top: 0 });
}

/* ---------------------------------------------------------------- 总览 */

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
    .filter(t => t.status === 'active')
    .map(t => ({ t, ...arrearsOf(t) }))
    .filter(x => x.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const arrearsTotal = arrears.reduce((s, x) => s + x.amount, 0);

  const fullRent = DB.tenancies.filter(t => t.status === 'active')
    .reduce((s, t) => s + num(t.monthly_rent), 0);

  return `
  <div class="card">
    <div class="hero-label">${ymLabel(thisYM())} 收租</div>
    <div class="hero-figure">${rm(mp.got)} <span class="muted" style="font-size:20px">/ ${rm(mp.due)}</span></div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="hero-sub">${mp.done} / ${mp.rooms} 间已收${mp.outstanding > 0 ? ` · 还差 <b>${rm(mp.outstanding)}</b>` : ' · 本月已收齐 🎉'}</div>
  </div>

  <div class="card">
    <h2>关键数字</h2>
    <div class="stat-grid">
      <div class="stat"><div class="k">满租月收入</div><div class="v">${rm(fullRent)}</div>
        <div class="n">${DB.tenancies.filter(t => t.status === 'active').length} 份生效合约</div></div>
      <div class="stat"><div class="k">押金在手</div><div class="v">${rm(totalDeposits())}</div>
        <div class="n">要能随时退</div></div>
      <div class="stat"><div class="k">累计欠收</div><div class="v" style="color:${arrearsTotal > 0 ? 'var(--bad)' : 'inherit'}">${rm(arrearsTotal)}</div>
        <div class="n">${arrears.length} 间有欠款</div></div>
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

  ${expiring.length ? `
  <div class="card">
    <h2>合约快到期 <span class="sub">60 天内</span></h2>
    ${expiring.map(({ room, st }) => {
      const p = DB.properties.find(x => x.id === room.property_id);
      return `<div class="collect-row">
        <div class="left">
          <div class="who">${esc(p?.name || '')} · ${esc(room.name)}</div>
          <div class="sub">${esc(st.tenancy.tenant_name)} · ${st.tenancy.contract_end} · ${rm(st.tenancy.monthly_rent)}/月</div>
        </div>
        <span class="pill ${st.cls}">${esc(st.label)}</span>
      </div>`;
    }).join('')}
    <div class="hero-sub" style="margin-top:12px">
      涉及月租合计 <b>${rm(expiring.reduce((s, x) => s + num(x.st.tenancy.monthly_rent), 0))}</b>，
      押金合计 <b>${rm(expiring.reduce((s, x) => s + num(x.st.tenancy.deposit), 0))}</b>
    </div>
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

  const groups = DB.properties.map(p => {
    const rows = roomsOf(p.id).map(room => {
      const t = activeTenancy(room.id);
      if (!t || !isDue(t, ym)) return '';
      const pay = paymentOf(t.id, ym);
      const on = !!pay;
      const extra = pay && num(pay.cny_amount) > 0 ? ` · 支付宝 ${cny(pay.cny_amount)}` : '';
      return `<div class="collect-row">
        <div class="left">
          <div class="who">${esc(room.name)} · ${esc(t.tenant_name)}</div>
          <div class="sub">${rm(t.monthly_rent)}${extra}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex:0 0 auto">
          ${on ? `<button class="linkish" data-editpay="${t.id}">改</button>` : ''}
          <button class="tick ${on ? 'on' : 'off'}" data-tick="${t.id}">${on ? '✓ 已收' : '✕ 未收'}</button>
        </div>
      </div>`;
    }).filter(Boolean).join('');
    return rows ? `<div class="card"><h2>${esc(p.name)}</h2>${rows}</div>` : '';
  }).join('');

  return `
  <div class="card">
    <div class="hero-label">${ymLabel(ym)}</div>
    <div class="hero-figure">${rm(mp.got)} <span class="muted" style="font-size:20px">/ ${rm(mp.due)}</span></div>
    <div class="bar"><i style="width:${mp.due ? Math.round(mp.got / mp.due * 100) : 0}%"></i></div>
    <div class="hero-sub">点右边的按钮直接打勾。收人民币的按「改」补填金额。</div>
  </div>
  ${groups || '<div class="card"><div class="empty">本月没有需要收租的房间。</div></div>'}
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
        <input type="number" id="p-amount" step="10" value="${pay.amount ?? num(t.monthly_rent)}">
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
        <button type="button" class="ghost" data-close>取消</button>
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
  const ar = t ? arrearsOf(t) : { months: [], amount: 0 };

  const history = DB.tenancies
    .filter(x => x.room_id === room.id && x.status === 'ended')
    .sort((a, b) => b.contract_end.localeCompare(a.contract_end));

  return `
  <div style="margin:6px 0 12px"><button class="linkish" data-back>← 返回</button></div>

  <div class="card">
    <h2>${esc(p?.name || '')} · ${esc(room.name)}
      <span class="pill ${st.cls}">${esc(st.label)}</span></h2>
    ${(room.tags || []).map(g => `<span class="tag">${esc(g)}</span>`).join(' ')}
    ${ar.amount > 0 ? `<div class="banner bad" style="margin-top:12px">
      欠租 <b>${rm(ar.amount)}</b>（${ar.months.length} 个月，${ymLabel(ar.months[0])} 起）</div>` : ''}
  </div>

  ${t ? tenancyFormHTML(t, room) : newTenantFormHTML(room)}
  ${t ? calendarHTML(t) : ''}
  ${t ? backfillHTML(t) : ''}

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

function tenancyFormHTML(t, room) {
  const wa = t.phone ? waLink(t.phone, t, room) : null;
  return `
  <div class="card">
    <h2>房客资料 ${wa ? `<a class="linkish" href="${wa}" target="_blank" rel="noopener">WhatsApp 催租</a>` : ''}</h2>
    <form id="tenancy-form" class="form" data-id="${t.id}">
      <div class="field"><label for="t-name">姓名</label><input type="text" id="t-name" value="${esc(t.tenant_name)}" required></div>
      <div class="field"><label for="t-phone">电话</label><input type="tel" id="t-phone" value="${esc(t.phone)}" placeholder="0123456789"></div>
      <div class="field"><label for="t-rent">月租 (RM)</label><input type="number" id="t-rent" step="50" value="${num(t.monthly_rent)}" required></div>
      <div class="field"><label for="t-dep">押金 (RM)</label><input type="number" id="t-dep" step="50" value="${num(t.deposit)}"></div>
      <div class="field"><label for="t-start">合约开始</label><input type="date" id="t-start" value="${t.contract_start}" required></div>
      <div class="field"><label for="t-end">合约结束</label><input type="date" id="t-end" value="${t.contract_end}" required></div>
      <div class="field wide"><label for="t-notes">备注</label><textarea id="t-notes">${esc(t.notes)}</textarea></div>
      <div class="actions wide"><button type="submit" class="primary">保存</button></div>
    </form>
  </div>`;
}

function newTenantFormHTML(room) {
  return `
  <div class="card">
    <h2>登记新房客</h2>
    <form id="new-tenancy-form" class="form" data-room="${room.id}">
      <div class="field"><label for="t-name">姓名</label><input type="text" id="t-name" required></div>
      <div class="field"><label for="t-phone">电话</label><input type="tel" id="t-phone" placeholder="0123456789"></div>
      <div class="field"><label for="t-rent">月租 (RM)</label><input type="number" id="t-rent" step="50" value="${num(room.reference_rent) || ''}" required></div>
      <div class="field"><label for="t-dep">押金 (RM)</label><input type="number" id="t-dep" step="50"></div>
      <div class="field"><label for="t-start">合约开始</label><input type="date" id="t-start" value="${todayISO()}" required></div>
      <div class="field"><label for="t-end">合约结束</label><input type="date" id="t-end" required></div>
      <div class="actions wide"><button type="submit" class="primary">登记</button></div>
    </form>
  </div>`;
}

function calendarHTML(t) {
  const startY = Number(t.contract_start.slice(0, 4));
  const maxY = thisYear();
  const y = UI.year;
  const cells = [];
  for (let m = 1; m <= 12; m++) {
    const ym = `${y}-${pad2(m)}`;
    if (!isDue(t, ym) || ym > thisYM()) {
      cells.push(`<button class="mo na" disabled>${m}月<br>—</button>`);
    } else {
      const paid = !!paymentOf(t.id, ym);
      cells.push(`<button class="mo ${paid ? 'paid' : 'due'}" data-mo="${ym}" data-tenancy="${t.id}">${m}月<br>${paid ? '✓ 已收' : '✕ 未收'}</button>`);
    }
  }
  return `
  <div class="card">
    <h2>收租记录</h2>
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
      <div class="actions"><button type="button" class="danger" data-backfill>补记</button></div>
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
    : `${ymLabel(thisYM())} 租金 RM${num(t.monthly_rent)}。`;
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
    ${DB.accounts.length ? DB.accounts.map(a => `
      <form class="collect-row acct-form" data-id="${a.id}">
        <div class="left">
          <div class="who">${esc(a.name)}</div>
          <div class="sub">${a.currency}${a.balance_updated_at ? ` · 更新于 ${a.balance_updated_at.slice(0, 10)}` : ' · 从未更新'}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex:0 0 auto">
          <input type="number" step="0.01" value="${num(a.balance)}" style="width:120px;font-size:16px;padding:7px 9px;border-radius:8px;border:1px solid var(--border);background:var(--surface-2);color:var(--text)">
          <button type="submit" class="ghost">存</button>
        </div>
      </form>`).join('') : '<div class="empty">还没有账户，用下面的表单加两个支付宝。</div>'}

    <form id="acct-new" class="form" style="margin-top:14px;border-top:1px solid var(--border);padding-top:14px">
      <div class="field"><label for="a-name">新增账户名</label><input type="text" id="a-name" placeholder="支付宝 A" required></div>
      <div class="field"><label for="a-cur">币种</label><select id="a-cur"><option>CNY</option><option>MYR</option></select></div>
      <div class="actions wide"><button type="submit" class="ghost">新增账户</button></div>
    </form>
  </div>

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
      return `<div class="fbar">
        <span class="mo-label">${f.ym.slice(2)}</span>
        <span class="track"><i class="${dip ? 'dip' : ''}" style="width:${Math.round(f.total / maxF * 100)}%"></i></span>
        <span class="amt" ${dip ? 'style="color:var(--warn)"' : ''}>${rm(f.total)}</span>
      </div>`;
    }).join('')}
    <div class="hero-sub" style="margin-top:10px">
      橙色 = 比上个月少，因为有合约到期。提前找租客补上，别等空了才发现。
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

document.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-tab],[data-room],[data-back],[data-tick],[data-editpay],[data-close],[data-mo],[data-year],[data-backfill],[data-moveout],[data-delroom],[data-staypaid],[data-delstay]');
  if (!el) return;
  const d = el.dataset;

  if (d.tab)   { UI.tab = d.tab; UI.roomId = null; render(); return; }
  if (d.back)  { UI.roomId = null; render(); return; }
  if (d.room)  { UI.roomId = d.room; UI.tab = 'rooms'; UI.year = thisYear(); render(); return; }
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
        tenancy_id: t.id, ym, amount: num(t.monthly_rent), paid_on: todayISO(),
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
      tenancy_id: t.id, ym: d.mo, amount: num(t.monthly_rent),
    }), `已标记 ${ymLabel(d.mo)}`);
    return;
  }

  if (d.backfill !== undefined) {
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
        targets.map(ym => ({ tenancy_id: t.id, ym, amount: num(t.monthly_rent), note: '批量补记' }))
      ), `补记了 ${targets.length} 个月`);
    });
    if (el.dataset.armed === '1') toast(`将补记 ${targets.length} 个月，再点一次确认`);
    return;
  }

  if (d.moveout) {
    armDanger(el, () => write(() => sb.from('tenancies')
      .update({ status: 'ended', move_out_date: todayISO() }).eq('id', d.moveout), '已标记搬走'));
    return;
  }

  if (d.delroom) {
    armDanger(el, async () => {
      const ok = await write(() => sb.from('rooms').delete().eq('id', d.delroom), '房间已删除');
      if (ok) { UI.roomId = null; render(); }
    });
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

  if (f.id === 'tenancy-form') {
    await write(() => sb.from('tenancies').update({
      tenant_name: $('#t-name').value.trim(),
      phone: $('#t-phone').value.trim(),
      monthly_rent: Number($('#t-rent').value) || 0,
      deposit: Number($('#t-dep').value) || 0,
      contract_start: $('#t-start').value,
      contract_end: $('#t-end').value,
      notes: $('#t-notes').value.trim(),
    }).eq('id', f.dataset.id), '已保存');
    return;
  }

  if (f.id === 'new-tenancy-form') {
    await write(() => sb.from('tenancies').insert({
      room_id: f.dataset.room,
      tenant_name: $('#t-name').value.trim(),
      phone: $('#t-phone').value.trim(),
      monthly_rent: Number($('#t-rent').value) || 0,
      deposit: Number($('#t-dep').value) || 0,
      contract_start: $('#t-start').value,
      contract_end: $('#t-end').value,
    }), '已登记');
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

  if (f.classList.contains('acct-form')) {
    const val = Number($('input', f).value) || 0;
    await write(() => sb.from('accounts')
      .update({ balance: val, balance_updated_at: new Date().toISOString() })
      .eq('id', f.dataset.id), '余额已更新');
    return;
  }

  if (f.id === 'acct-new') {
    await write(() => sb.from('accounts').insert({
      name: $('#a-name').value.trim(),
      currency: $('#a-cur').value,
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
  if (!cfg.url || !cfg.anonKey || cfg.url.includes('你的')) {
    document.body.innerHTML = `<div id="login">
      <h1>还没接上 Supabase</h1>
      <p>请编辑仓库里的 <code>config.js</code>，填入 Supabase 的 Project URL 和 anon key。
      步骤见 <code>README.md</code>。</p></div>`;
    return;
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

$('#logout').addEventListener('click', async () => {
  await sb.auth.signOut();
  session = null;
  start();
});

boot();
