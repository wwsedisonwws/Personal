// 提醒用的业务规则。
//
// ⚠️ 这是 app.js 里那套规则的第二份实现 —— Deno 跑不了浏览器那份。
//    改规则时两处都要改。为了少一点漂移的机会，这里只放提醒真正需要的最窄一组：
//    入住/退房、收租日、电费所属月份、到期招租。
//    空档、汇率、押金覆盖那些留在网页上，不进提醒。
//
// 本文件不碰网络、不读环境变量，纯函数 —— 好让本地拿 mock 数据跑断言，
// 逐条比对网页那张「接待日程」卡的输出。

export type Row = Record<string, any>;
export interface DB {
  properties: Row[]; rooms: Row[]; tenancies: Row[];
  payments: Row[]; aircon: Row[]; stays: Row[];
}

/* ---------------------------------------------------------------- 日期 */
const pad2 = (n: number) => String(n).padStart(2, '0');
export const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
export function addDays(iso: string, n: number) {
  const d = new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000);
  return d.toISOString().slice(0, 10);
}
export function addMonthsYM(ym: string, k: number) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + k;
  return `${Math.floor(t / 12)}-${pad2((t % 12) + 1)}`;
}
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
export const weekday = (iso: string) => '周' + WEEK[new Date(iso + 'T00:00:00Z').getUTCDay()];
export const rm = (n: any) => 'RM' + Math.round(Number(n) || 0).toLocaleString('en-US');
const ymOf = (iso: string) => iso.slice(0, 7);
const LIVE = (t: Row) => t.status === 'active' || t.status === 'booked';

/* ---------------------------------------------------------------- 规则 */

// 电费次月收：今天该处理的是上个月那张单
export const billYM = (today: string) => addMonthsYM(ymOf(today), -1);

// 某月该收多少。首月若谈好按比例少收，用 first_month_rent
export function rentFor(t: Row, ym: string) {
  const first = ym === ymOf(t.contract_start);
  return Number(first && t.first_month_rent != null ? t.first_month_rent : t.monthly_rent) || 0;
}

// 某月的收租日。首月按入住日算 —— 否则会出现「收租日早于入住日」
export function dueDateOf(t: Row, ym: string) {
  const day = Math.min(Math.max(Number(t.rent_due_day) || 1, 1), 28);
  const d = `${ym}-${pad2(day)}`;
  return ym === ymOf(t.contract_start) && d < t.contract_start ? t.contract_start : d;
}

const isDue = (t: Row, ym: string) =>
  ym >= ymOf(t.contract_start) && ym <= ymOf(t.contract_end);

const paidFor = (db: DB, tenancyId: string, ym: string) =>
  db.payments.some(p => p.tenancy_id === tenancyId && p.ym === ym);

// 他走后第二天这间房还有没有人。
// 不能只看「有没有人在他之后开始」—— zhengyu 住到 10-31 而 Hansen 10-15 就进同一间，
// 那是重叠不是接替；也不能按月粒度判断。
export function successorOf(db: DB, t: Row) {
  const after = addDays(t.contract_end, 1);
  const others = db.tenancies.filter(x => x.room_id === t.room_id && LIVE(x) && x.id !== t.id);
  const covering = others.find(x => x.contract_start <= after && x.contract_end >= after);
  if (covering) return { who: covering, kind: 'covering' as const };
  const upcoming = others.filter(x => x.contract_start > after)
    .sort((a, b) => a.contract_start.localeCompare(b.contract_start))[0];
  return upcoming ? { who: upcoming, kind: 'upcoming' as const } : null;
}

/* ---------------------------------------------------------------- 事件 */

export interface Ev {
  date: string; kind: string; who: string; where: string; todo: string; uid: string;
}

export function events(db: DB, today: string, days = 180): Ev[] {
  const until = addDays(today, days);
  const out: Ev[] = [];
  const where = (roomId: string) => {
    const room = db.rooms.find(r => r.id === roomId);
    const prop = room && db.properties.find(p => p.id === room.property_id);
    return `${prop?.name ?? ''} · ${room?.name ?? '（已删除）'}`;
  };

  for (const t of db.tenancies.filter(LIVE)) {
    if (t.contract_start >= today && t.contract_start <= until) {
      const ym = ymOf(t.contract_start);
      const paid = paidFor(db, t.id, ym);
      out.push({
        date: t.contract_start, kind: '入住', who: t.tenant_name, where: where(t.room_id),
        todo: `签合同、交钥匙 · 押金 ${rm(t.deposit)}` +
          (paid ? ' · 首月租金已收' : ` · 首月租金 ${rm(rentFor(t, ym))} 待收`),
        uid: `in-${t.id}-${t.contract_start}`,
      });
    }
    if (t.contract_end >= today && t.contract_end <= until) {
      const s = successorOf(db, t);
      const tail = !s ? ' · 后面没人接，要招租'
        : s.kind === 'covering' ? ` · 房间由 ${s.who.tenant_name} 接着住`
        : ` · 下一位 ${s.who.tenant_name} ${s.who.contract_start} 才来`;
      out.push({
        date: t.contract_end, kind: '退房', who: t.tenant_name, where: where(t.room_id),
        todo: `验房、退押金 ${rm(t.deposit)}` + tail,
        uid: `out-${t.id}-${t.contract_end}`,
      });
    }
  }

  for (const s of db.stays) {
    const nights = Math.max(0, daysBetween(s.check_in, s.check_out));
    const amt = s.amount == null ? nights * (Number(s.nightly_rate) || 0) : Number(s.amount);
    if (s.check_in >= today && s.check_in <= until) {
      out.push({
        date: s.check_in, kind: '日租入住', who: s.guest_name || '（未填姓名）',
        where: where(s.room_id), todo: `${nights} 晚 · ${rm(amt)}${s.paid ? ' 已收' : ' 待收'}`,
        uid: `sin-${s.id}`,
      });
    }
    if (s.check_out >= today && s.check_out <= until) {
      out.push({
        date: s.check_out, kind: '日租退房', who: s.guest_name || '（未填姓名）',
        where: where(s.room_id), todo: '收钥匙、验房', uid: `sout-${s.id}`,
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.uid.localeCompare(b.uid));
}

/* ---------------------------------------------------------------- 每日摘要 */

export interface Item { tag: string; text: string; }

export function digest(db: DB, today: string): Item[] {
  const out: Item[] = [];
  const ym = ymOf(today);
  const roomName = (id: string) => db.rooms.find(r => r.id === id)?.name ?? '';

  // ① 三天内要接待的人
  const soon = events(db, today, 3);
  const byDate: Record<string, Ev[]> = {};
  for (const e of soon) (byDate[e.date] ||= []).push(e);
  for (const [date, list] of Object.entries(byDate)) {
    const n = daysBetween(today, date);
    const when = n === 0 ? '就是今天' : n === 1 ? '明天' : `${n} 天后`;
    out.push({
      tag: '接待',
      text: `${date} ${weekday(date)}（${when}）\n` +
        list.map(e => `　${e.kind} ${e.who} · ${e.where}\n　${e.todo}`).join('\n'),
    });
  }

  // ② 今天该收的租 + 已逾期的
  for (const t of db.tenancies.filter(LIVE)) {
    if (!isDue(t, ym) || paidFor(db, t.id, ym)) continue;
    const due = dueDateOf(t, ym);
    if (due > today) continue;                       // 还没到日子，不催
    const late = daysBetween(due, today);
    out.push({
      tag: late === 0 ? '今天收租' : '逾期',
      text: `${t.tenant_name} · ${roomName(t.room_id)} · ${rm(rentFor(t, ym))}` +
        (late === 0 ? '（今天是收租日）' : `（逾期 ${late} 天）`),
    });
  }

  // ③ 上个月的电费还没录齐。只在 1–5 号提醒，账单刚出那几天。
  const day = Number(today.slice(8));
  if (day <= 5) {
    const bym = billYM(today);
    const owe = db.tenancies.filter(t => LIVE(t) && isDue(t, bym))
      .filter(t => !db.aircon.some(a => a.tenancy_id === t.id && a.ym === bym));
    if (owe.length) {
      out.push({
        tag: '电费',
        text: `${bym} 的电费还有 ${owe.length} 位没填金额（${ym} 收）。看完电单去「收租」页逐个填。`,
      });
    }
  }

  // ④ 到期要招租 —— 只在跨阈值当天发。天天念等于没念。
  const MARKS = [60, 30, 14, 7];
  for (const t of db.tenancies.filter(LIVE)) {
    const left = daysBetween(today, t.contract_end);
    if (!MARKS.includes(left)) continue;
    if (successorOf(db, t)) continue;
    out.push({
      tag: '招租',
      text: `${roomName(t.room_id)} 还有 ${left} 天到期（${t.contract_end}，${t.tenant_name}），` +
        `后面没人接。空一个月少收 ${rm(t.monthly_rent)}。`,
    });
  }

  return out;
}

/* ---------------------------------------------------------------- 输出 */

const esc = (s: string) => String(s ?? '')
  .replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, '\\n');

// 日历订阅。UID 稳定 —— 刷新时是更新而不是堆出重复事件；
// 合约改期后旧事件会自动消失。
export function toICS(evs: Ev[], now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//出租房管理//ZH',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:出租房日程', 'X-WR-TIMEZONE:Asia/Kuala_Lumpur',
  ];
  for (const e of evs) {
    const d = e.date.replace(/-/g, '');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}@rental.local`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${d}`,
      `DTEND;VALUE=DATE:${addDays(e.date, 1).replace(/-/g, '')}`,
      `SUMMARY:${esc(`${e.kind} ${e.who} · ${e.where}`)}`,
      `DESCRIPTION:${esc(e.todo)}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-P1D',
      `DESCRIPTION:${esc(`明天：${e.kind} ${e.who}`)}`, 'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  // RFC 5545 要求 CRLF
  return lines.join('\r\n') + '\r\n';
}

const H = (s: string) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function toEmail(items: Item[], today: string) {
  const color: Record<string, string> = {
    '逾期': '#B23A3A', '今天收租': '#C97A2B', '接待': '#1F6F5C',
    '电费': '#C97A2B', '招租': '#B23A3A',
  };
  return `<div style="font-family:-apple-system,'PingFang SC',sans-serif;max-width:560px;
    margin:0 auto;padding:20px;color:#1A1F1B">
    <h2 style="font-size:17px;margin:0 0 4px">出租房 · ${today} ${weekday(today)}</h2>
    <p style="font-size:13px;color:#8A958D;margin:0 0 18px">${items.length} 件事</p>
    ${items.map(it => `<div style="border-left:3px solid ${color[it.tag] ?? '#8A958D'};
      padding:8px 0 8px 12px;margin-bottom:14px">
      <div style="font-size:12px;font-weight:600;color:${color[it.tag] ?? '#8A958D'}">${H(it.tag)}</div>
      <div style="font-size:14px;white-space:pre-wrap;margin-top:3px">${H(it.text)}</div>
    </div>`).join('')}
    <p style="font-size:12px;color:#8A958D;border-top:1px solid #DBDFD7;padding-top:12px">
      没事的日子不会发这封信。<br>
      <a href="https://wwsedisonwws.github.io/Personal/">打开出租房管理</a>
    </p>
  </div>`;
}
