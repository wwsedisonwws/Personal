// 试验站的 Supabase 连接 —— 必须填**第二个** Supabase 项目，不是生产那个。
// 填错的话，在这里删数据 = 删真数据，试验站就白建了。
//
// 怎么拿这两个值：
//   Supabase → 新建一个项目（比如叫 rental-lab）→ SQL Editor 跑一遍 supabase/schema.sql
//   → Project Settings → API → 复制 Project URL 和 anon public key
//
// anon key 公开没关系，数据由 RLS 保护，只有登录本人能读写。
window.SUPABASE_CONFIG = {
  url: '把第二个项目的 Project URL 贴这里',
  anonKey: '把第二个项目的 anon public key 贴这里',

  // 这一行是试验站的标记：顶栏会变橙色、标题带「试验站」，
  // 并且解锁「从备份恢复」（会清空数据，所以生产站没有这个功能）。
  isLab: true,
};
