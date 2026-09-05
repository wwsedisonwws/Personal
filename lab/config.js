// 试验站的 Supabase 连接 —— 这里必须是**第二个** Supabase 项目，不是生产那个。
// 填成生产项目的话，界面上看不出任何区别（顶栏照样橙、恢复按钮照样在），
// 但按下「清空并恢复」删的就是真数据。test.js 里有一条断言专门挡这个。
//
// anon key 公开没关系，数据由 RLS 保护，只有登录本人能读写。
// 项目 ref 就写在 key 的载荷里，所以 url 和 key 对不对得上是能验的。
window.SUPABASE_CONFIG = {
  url: 'https://jufpoofvpwwiqxkqlpyu.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp1ZnBvb2Z2cHd3aXF4a3FscHl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1MzQxMzMsImV4cCI6MjEwNDExMDEzM30.OCbLYPpOkP7YSZW0_al9S5lyOTDQUc2oFsLKmG_yhww',

  // 这一行是试验站的标记：顶栏变橙、标题带「试验站」，
  // 并且解锁「从备份恢复」（会清空数据，所以生产站没有这个功能）。
  isLab: true,
};
