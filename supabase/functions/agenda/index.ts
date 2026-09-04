// 出租房提醒 · Supabase Edge Function
//
// 两个入口，共用同一套规则（rules.ts）：
//   GET ?mode=ics&token=…      iPhone 日历订阅，返回 ICS
//   GET ?mode=notify&token=…   GitHub Actions 每天调一次，有事才发邮件
//
// 为什么要有这个函数，而不是把 .ics 放 GitHub Pages：
//   Pages 上的文件是公开的，日历里带房客姓名等于公开。这里用 URL 里的随机 token 挡住，
//   token 存在 Supabase 的 Secrets 里，不进仓库。
//
// 部署注意：**这个函数要关掉 Verify JWT** —— iPhone 日历发不了 Authorization 头。
// 鉴权改由下面的 token 比对负责。
//
// 需要的 Secrets（Supabase 后台 → Edge Functions → Secrets）：
//   FEED_TOKEN        自己定的随机串，出现在订阅网址里
//   RESEND_API_KEY    resend.com 的 key，只有发邮件用得上
//   NOTIFY_TO         收件邮箱
// SUPABASE_URL 与 SUPABASE_SERVICE_ROLE_KEY 由平台自动注入，不必自己加。

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { DB, digest, events, toEmail, toICS } from './rules.ts';

const TABLES = ['properties', 'rooms', 'tenancies', 'payments', 'aircon_charges', 'short_stays'];

async function loadDB(): Promise<DB> {
  // service_role 绕过 RLS。这个 key 只存在于 Supabase 内部，不进仓库也不进 GitHub。
  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const res = await Promise.all(TABLES.map(t => sb.from(t).select('*')));
  const bad = res.find(r => r.error);
  if (bad) throw new Error(bad.error!.message);
  const [properties, rooms, tenancies, payments, aircon, stays] = res.map(r => r.data ?? []);
  return { properties, rooms, tenancies, payments, aircon, stays };
}

// 用马来西亚时间判断「今天」。用 UTC 会让早上八点的提醒算成前一天。
function todayMY() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

Deno.serve(async req => {
  const url = new URL(req.url);
  const token = url.searchParams.get('token') ?? '';
  const expected = Deno.env.get('FEED_TOKEN') ?? '';
  // 长度相同才逐字比，避免把 token 长度也漏出去
  if (!expected || token.length !== expected.length || token !== expected) {
    return new Response('Not found', { status: 404 });
  }

  const today = todayMY();
  let db: DB;
  try {
    db = await loadDB();
  } catch (e) {
    return new Response(`读取数据失败：${e.message}`, { status: 500 });
  }

  if (url.searchParams.get('mode') === 'ics') {
    return new Response(toICS(events(db, today, 365)), {
      headers: {
        'content-type': 'text/calendar; charset=utf-8',
        'cache-control': 'max-age=3600',
      },
    });
  }

  // ---- notify ----
  const items = digest(db, today);
  // 没事就不发。每天一封「今天没事」会很快训练出无视邮件的习惯，
  // 到真有事那天也不会看。
  if (!items.length) return new Response(null, { status: 204 });

  const key = Deno.env.get('RESEND_API_KEY');
  const to = Deno.env.get('NOTIFY_TO');
  if (!key || !to) {
    return new Response(`有 ${items.length} 件事，但没设 RESEND_API_KEY / NOTIFY_TO`, { status: 500 });
  }

  const urgent = items.filter(i => i.tag === '逾期' || i.tag === '招租').length;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: 'onboarding@resend.dev',
      to: [to],
      subject: `出租房 · ${items.length} 件事${urgent ? `（${urgent} 件要紧）` : ''}`,
      html: toEmail(items, today),
    }),
  });
  if (!r.ok) return new Response(`发信失败：${await r.text()}`, { status: 502 });

  return new Response(JSON.stringify({ sent: items.length, today }), {
    headers: { 'content-type': 'application/json' },
  });
});
