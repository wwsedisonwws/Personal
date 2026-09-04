// Supabase 连接设置
//
// 这两个值是公开的，写在这里、进公开仓库都没问题 —— anon key 本来就是设计成公开的，
// 任何人打开网页按 F12 都看得到。真正拦住外人的是数据库里的 RLS 策略
// （见 supabase/schema.sql），不是这把钥匙。
//
// 要换项目就改这两个值：Supabase 后台 → Project Settings → API
//   Project URL       → url
//   anon / public     → anonKey   ← 绝不能填 service_role / secret，那个能绕过所有 RLS
window.SUPABASE_CONFIG = {
  url: 'https://jqtirkwynqlwwwtktmat.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxdGlya3d5bnFsd3d3dGt0bWF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1MTM1MTMsImV4cCI6MjEwNDA4OTUxM30.0nYHdf3p7QVcOGtKiv7YNtnRYeFIHQ2NykQLxqcHUlg',
};
