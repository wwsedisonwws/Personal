// Supabase 连接设置
//
// 这两个值是公开的，写在这里、进公开仓库都没问题 —— anon key 本来就是设计成公开的。
// 真正拦住外人的是数据库里的 RLS 策略（见 supabase/schema.sql）。
//
// 填法：Supabase 后台 → Settings → API
//   Project URL          → url
//   anon / public key    → anonKey   ← 千万不要填 service_role key，那个是万能钥匙
window.SUPABASE_CONFIG = {
  url: 'https://你的项目.supabase.co',
  anonKey: '你的-anon-key',
};
