# 出租房管理

Bayan + Perling 两处房产、11 间房的租务管理网站。
纯静态页面托管在 GitHub Pages，数据存在 Supabase，手机上打开就能用。

没有构建步骤 —— 改完代码 `git push` 就上线，日后想改一行字直接在 GitHub 网页上编辑即可。

## 能做什么

| | |
|---|---|
| **总览** | 本月收租进度、满租月收入、押金在手、累计欠收、空房数 |
| **收租** | 一屏打勾收租，不用逐间点进去；收人民币可补录金额与账户 |
| **房间** | 房客资料、押金、合约起止、WhatsApp 一键催租、收租月历、批量补记 |
| **日租** | RM90/晚，哪间空用哪间，自动检查跟月租合约撞期 |
| **账户** | 两个支付宝余额、押金能不能兑付、未来 12 个月收入推算、过去实收 |

几个刻意的设计：

- **「待入住」不等于「出租中」**。合约还没开始的房间，房子现在是空的，会算进空房，
  不会像旧系统那样显示「合约正常」，让人以为有人住着。
- **押金是马币负债，钱在人民币账户**。账户卡会直接告诉你汇率跌到多少就不够退押金了。
- **保存失败一定会弹提示**。不会出现界面变了、其实没存进去的情况。

## 第一次设置

### 1. 建 Supabase 项目

1. 上 [supabase.com](https://supabase.com) 注册，**New project**（免费）
2. 地区选 **Southeast Asia (Singapore)**，离马来西亚最近
3. 数据库密码随便设一个，记下来（平时用不到）

### 2. 建表

后台左边 **SQL Editor** → **New query** → 把 `supabase/schema.sql` 整个贴进去 → **Run**。

看到 Success 就好了。这个脚本可以重复跑，不会弄坏已有数据。

### 3. 拿钥匙填进 config.js

后台 **Settings → API**，复制两个值填进仓库根目录的 `config.js`：

| 后台叫什么 | 填到哪 |
|---|---|
| Project URL | `url` |
| `anon` `public` | `anonKey` |

> ⚠️ 千万别填 `service_role` 那个。那是万能钥匙，填进公开仓库等于把数据库钥匙挂到大门上。
> `anon` key 是设计成公开的，配合 RLS 才安全。

### 4. 开 GitHub Pages

仓库 **Settings → Pages** → Source 选 **Deploy from a branch** → 分支 `main`、目录 `/ (root)` → Save。

一两分钟后网站在：`https://wwsedisonwws.github.io/Personal/`

### 5. 告诉 Supabase 登录后跳回哪里 ← 最容易漏

后台 **Authentication → URL Configuration**：

- **Site URL**：`https://wwsedisonwws.github.io/Personal/`
- **Redirect URLs** 加一条：`https://wwsedisonwws.github.io/Personal/`

**不做这步，邮件里的登录链接点了会跳到错误页面。**

### 6. 登录一次，再导入数据

先打开网站，用 `wwsedisonwws@gmail.com` 收登录链接登进去（这时候还是空的，正常）。

登录过之后，Supabase 才有你的帐号记录，这时才能跑 `supabase/seed.sql`
（SQL Editor 贴进去 Run），把 11 间房和现有租约导进来。刷新网站就看到了。

> `seed.sql` 含房客真实姓名，已经写进 `.gitignore`，**不会**进这个公开仓库。
> 它只存在你本地。导完可以删掉。

### 7. 防止项目自动暂停（可选但建议）

Supabase 免费版**闲置 7 天会暂停项目**。收租是月度动作，很容易撞上。

仓库 **Settings → Secrets and variables → Actions** 加两个 secret：

- `SUPABASE_URL` — 跟 config.js 里的一样
- `SUPABASE_ANON_KEY` — 跟 config.js 里的一样

加好后 `.github/workflows/keepalive.yml` 会每周一自动 ping 一次，项目就不会睡着。

## 怎么确认外人真的看不到

网站是公开的、anon key 也在源码里，所以**一定要亲自验证 RLS 生效**。两个测试：

**① 不登录直接打接口** —— 应该返回空数组 `[]`，不是数据：

```bash
curl "https://你的项目.supabase.co/rest/v1/tenancies?select=*" \
     -H "apikey: 你的-anon-key"
```

**② 换个帐号登录** —— 用另一个邮箱登录网站，应该**一间房都看不到**。
这是 RLS 真正生效的唯一可靠证明。

两个测试有任何一个漏了数据，就是 `schema.sql` 没跑完整，回去重跑一遍。

## 待办

- [ ] 核对三处租金。现有数据是从旧系统搬过来的，跟你说过的对不上：
      Bayan 一楼小房 RM900（你说 1,400）、三楼小房 RM1,400（你说 900）—— 这两个刚好对调，
      八成当初录反了；Perling 一楼大房 RM1,600（你说 2,000）。在「房间」页直接改。
- [ ] 补房客电话。现在全是空的，填了才能用 WhatsApp 催租。
- [ ] 更新两个支付宝的余额，押金覆盖率才准。
- [ ] 处理历史欠租。旧系统只勾了 2026 年 8 月，所以之前的月份都算「未收」（合计 RM61,500）。
      如果那些其实收过了，进房间详情用**批量补记**一次清掉。

## 文件

```
index.html                      页面骨架 + 登录
app.js                          全部逻辑
styles.css                      样式（手机优先）
config.js                       Supabase 连接（公开值）
supabase/schema.sql             建表 + RLS，可重复跑
supabase/seed.sql               初始数据（gitignore，不进仓库）
.github/workflows/keepalive.yml 每周保活
```
