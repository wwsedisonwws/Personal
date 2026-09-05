# 出租房管理

Bayan + Perling 两处房产、11 间房的租务管理网站。
纯静态页面托管在 GitHub Pages，数据存在 Supabase，手机上打开就能用。

没有构建步骤 —— 改完代码 `git push` 就上线，日后想改一行字直接在 GitHub 网页上编辑即可。

> **改完 `app.js` 或 `styles.css` 记得同时改 `index.html` 里的 `?v=` 版本号。**
> GitHub Pages 会缓存静态文件，手机浏览器（尤其 iOS Safari，没有强制刷新）
> 会一直用旧的。换个版本号等于换了网址，浏览器就非重新下载不可。

## 能做什么

| | |
|---|---|
| **总览** | 本月要做的事、接待日程（几号签合同/退押金）、收租进度、满租月收入、押金在手、空档与待出租、到期预警 |
| **收租** | 一屏打勾收租；按各自的收租日区分「没到日子」和「逾期」；空调费逐个填金额单独打勾，可往回补录以前的月份 |
| **房间** | 房客资料、押金、合约起止、每月几号收租、招租价、WhatsApp 一键催租、收租月历、批量补记 |
| **看房** | 谁几号几点来看哪间房、想几时入住；看过了/租了/不租了三个状态；已结束的留档 |
| **日租** | RM90/晚，哪间空用哪间，自动检查跟月租合约撞期 |
| **账户** | 支付宝余额（可增删改名）、押金能不能兑付、未来 12 个月收入推算（可点开看逐间明细）、过去实收、空调费历史 |

几个刻意的设计：

- **「本月要做的事」是算出来的，不是 AI 生成的**。所有数字系统里都有，直接算才精确；
  交给 LLM 反而可能把金额讲错，而报表最怕这个。何况纯静态站点藏不住 API key ——
  anon key 有 RLS 兜底，AI 的 key 没有，谁捡到都能用你的额度。真要接 LLM
  得另写 Supabase Edge Function 中转。
  条目按催收 / 要办 / 可优化**各自限额**，不是取总数前 N 条 ——
  否则催收一多，「空档能做日租」这种真能多赚钱的建议就永远排不进来。

- **提醒的规则是第二份实现，必须跟网页那份对得上**。Edge Function 跑在 Deno 上，
  用不了 `app.js`，所以 `supabase/functions/agenda/rules.ts` 重写了一份。
  为压低漂移风险：函数里只放提醒真正要用的最窄一组规则（入住退房、收租日、
  电费月份、到期招租），空档/汇率/押金覆盖一概不搬；且测试会把两边的事件
  **逐条双向比对**，对不上就算失败。改规则时两处都要改。
- **只有看房是定时日历事件，其余都是全天**。入住、退房、合约到期本来就按天算，
  全天正确。但看房是「下午两点到 Perling」—— 做成全天会堆在 iPhone 日历当天顶部，
  界面上根本看不到钟点，提醒也只在系统默认时刻响。定时事件用 UTC 写
  （马来西亚固定 UTC+8、从不用夏令时，减 8 小时永远准确），
  省掉 TZID 要配的那段 VTIMEZONE —— 少了它有些客户端会解错。
- **接待日程按日子排，同一天的并在一起**。其他卡都是按房间或按月组织的，
  合约到期卡只说「还有 51 天」，不会告诉你那天还有别人同时退房。
  10/31 三人同退、一次要备 RM12,000 押金，只有按日子排才看得出来。
- **「待入住」不等于「出租中」**。合约还没开始的房间，房子现在是空的，会算进空房，
  不会像旧系统那样显示「合约正常」，让人以为有人住着。
- **空房分两种，因为该做的事完全不同**。「空档」是后面已经定了下一位、中间断了那几天，
  实打实在漏钱，能谈提前入住或拿来做日租；「待出租」是合约到期还没有下一位，
  那是该找租客了。按天算钱并标出具体日期（「空 11/20–11/30（11 天）」），
  月中起讫算部分空置，不会把空 11 天说成空一个月。
- **押金是马币负债，钱在人民币账户**。账户卡会直接告诉你汇率跌到多少就不够退押金了。
- **保存失败一定会弹提示**。不会出现界面变了、其实没存进去的情况。
- **收租日按人算**。有人 1 号交、有人 19 号、有人 25 号。没到日子的不算逾期，
  也不计入欠租 —— 25 号才交租的人，4 号催他是冤枉的。
- **首月可按比例收**。月中入住时首月常常只收部分（租客B 10/15 入住，十月收 RM1,400
  而非 2,800）。填在租约的「首月租金」，只影响入住那个月，之后自动恢复全额。
- **可以提前锁下一位房客**。租约有「已预订」状态：合约还没开始、房间还住着上一位时
  照样能登记。押金计入你手上的钱、未来收入推算也算数，但不影响本月收租；
  上一位标记搬走时自动转为在住。总览会算出中间空几天、少收多少。
- **押金的人民币也要记**。押金是马币负债、钱进的是人民币账户。租约上填「押金实收人民币」，
  系统会连预付租金一起算出这笔的实际汇率，以及比你设定汇率少换了多少。
- **电费次月收，月份指的是「哪个月的电」**。9 月收的是 8 月的电费，
  所以 `aircon_charges.ym` 一律存电费所属月份，钱几时到手看 `paid_on`。
  收租页默认停在上个月那张单，总览的提醒也照这个月份判断 ——
  否则会去催一个还没出账单的月份。
- **电费跟租金分开记**。金额每月按实际账单填，各自打勾，
  所以能看出「租金收了、电费还欠着」。月份可以往回切，忘了录补得回来。
  账户页有历史走势，点任一个月看是哪几间。
  **不做未来推算** —— 电费取决于实际账单，给个估算数字只会让人误以为准。
  历史按已录记录统计，房客搬走后他交过的钱照样留在账上。

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

仓库 **Settings → Pages** → Source 选 **Deploy from a branch** →
分支选**默认分支**（本仓库是 `claude/who-am-i-y860pz`，没有 `main`）、目录 `/ (root)` → Save。

一两分钟后网站在：`https://wwsedisonwws.github.io/Personal/`

> Pages 可以从任何分支部署，不限于 `main`。定时任务（保活）则只在**默认分支**上运行。

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

### 7. 防止项目自动暂停（不用做，已自动）

Supabase 免费版**闲置 7 天会暂停项目**。收租是月度动作，中间二十几天没人访问，
必然撞上 —— 到时候月初打开网站全是报错，得自己登后台点 Restore。

`.github/workflows/keepalive.yml` 每周一自动访问一次，项目就不会睡着。
连接参数直接从 `config.js` 读，**不需要任何设置**。

想确认它能跑：仓库 **Actions** → 左边选 **keepalive** → **Run workflow** 手动触发一次，
绿勾就是正常。

### 8. 提醒：iPhone 日历 + 每日邮件 ✅ 已设好并验证过

`supabase/functions/agenda/` 是一个 Edge Function，两个入口共用同一套规则：

| 入口 | 谁来调 | 作用 |
|---|---|---|
| `?mode=ics&token=…` | iPhone 日历（订阅后自动拉） | 入住/退房/日租进出 → 全天事件，提前一天响；**看房 → 定时事件**（落在当天那个钟点上），提前一天 + 出门前一小时各响一次 |
| `?mode=notify&token=…` | GitHub Actions 每天一次 | **有事才**发邮件；没事返回 204 不发信 |

> **为什么不把 .ics 直接放 GitHub Pages**：Pages 上的文件是公开的，
> 日历里带房客姓名等于公开。所以必须由带 token 的接口来发，token 不进仓库。

设置步骤：

1. **注册 [resend.com](https://resend.com)**（免费）。寄给自己 Gmail 用
   `onboarding@resend.dev` 当寄件人即可，不必验证域名。拿到 API key。
2. Supabase 后台 → **Edge Functions** → 新建函数 `agenda`，
   把 **`supabase/functions/agenda/bundled.ts`** 的内容整个贴进 `index.ts` → Deploy。
   只贴这一个文件，函数里不要留别的文件。

   > `bundled.ts` 是 `rules.ts + index.ts` 拼出来的，**没有 import**。
   > 原来分两个文件贴，网页编辑器里少一个就报
   > `Module not found ".../rules.ts"` —— 这个坑踩过一次。
   > 改完逻辑要跑 `node tools/build-fn.js` 重新生成；
   > 忘了的话 `sync-lab.sh` / `publish.sh` 会拦下来。
3. **关掉这个函数的 Verify JWT** —— iPhone 日历发不了 Authorization 头，
   鉴权改由 URL 里的 token 负责。**不关的话日历订阅会一直失败。**
4. Edge Functions → **Secrets** 加三个：
   `FEED_TOKEN`（自己定一串随机字符）、`RESEND_API_KEY`、`NOTIFY_TO`（收件邮箱）。
   `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY` 平台自动注入，不用自己加。
5. GitHub 仓库 → Settings → Secrets → Actions 加两个：
   `SUPABASE_FN_URL`（`https://<项目>.supabase.co/functions/v1/agenda`）、
   `FEED_TOKEN`（跟第 4 步同一个值）。
6. **iPhone 订阅日历**：设置 → 日历 → 帐户 → 添加帐户 → 其他 →
   **添加已订阅的日历** → 贴 `https://<项目>.supabase.co/functions/v1/agenda?mode=ics&token=<你的token>`

先在浏览器打开 `?mode=notify&token=…` 试一次，该收到邮件（或看到 `204`，表示今天没事）。

> 2026-09-05 首次跑通：返回 `{"sent":1}`，邮件收到；iPhone 日历订阅后能看到
> 9/9 的两条事件（租客A 入住 + 父母日租）。
>
> 2026-09-05 加看房预约后再验一次：生产站录入一条 09-07 14:00 的带看，
> 同一条网址返回 `{"sent":2}` —— 多出来的那条正是它。
> 说明整条链路通的：网页录入 → 生产库 → Edge Function → 邮件与日历。

**日历那条网址等于钥匙**，别转发给别人 —— 谁拿到都能看你的租客名单。
真的外泄了就换 `FEED_TOKEN`（Supabase 和 GitHub 两边都要改），旧网址立即失效。

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

## 备份

**Supabase 免费版没有自动备份。** 误删一间房，连带的租约、收租记录、电费全都跟着没了，
数据库那边没有「撤销」。所以备份得自己点。

网站 → **账户** → **备份** → **下载备份**。存一个 JSON 到 iCloud 或 Google Drive。
超过 45 天没备份，那张卡会自己变橙提醒。

改过资料就点一次，尤其是：新租客签约、清历史欠租、删房间之前。

> 文件里有房客姓名和电话 —— **别放进这个仓库**，它是公开的。

代码不用另外备份：每次 `git commit` 就是一个存档点，随时能退回任何一版。
真正没有第二份的只有数据库里的资料。

## 试验站：改东西不影响正在用的

同一份代码，两个网址，**两个各自独立的 Supabase 项目**：

| | 网址 | 数据 |
|---|---|---|
| 生产站 | `…github.io/Personal/` | 真资料 |
| 试验站 | `…github.io/Personal/lab/` | 另一个 Supabase 项目，随便折腾 |

试验站顶栏是**橙色**、标题写着「试验站」，手机上扫一眼就分得出来。
它还多一个「从备份恢复」按钮（会清空数据，所以生产站没有）。

两个站的差别只有 `config.js` 一个文件 —— 里面写的是连哪个 Supabase 项目。
其余 `index.html` / `app.js` / `styles.css` 三个文件两边完全一样。

### 建试验站（一次性）

1. Supabase 新建第二个项目，比如叫 `rental-lab`，地区同样选 Singapore
   （免费版一般只让开 2 个活跃项目，这刚好是第 2 个）
2. 在它的 SQL Editor 跑一遍 `supabase/schema.sql`。**别跑 `seed.sql`** ——
   第 5 步会用真实备份灌进去，比那份初始数据新
3. **Authentication → URL Configuration** ← 最容易漏
   - Site URL：`https://wwsedisonwws.github.io/Personal/lab/`
   - Redirect URLs 加同一条

   末尾 `/lab/` 不能少。漏了这步，登录邮件里的链接会把你送去生产站或 localhost。
4. 把它的 Project URL 和 anon key 填进 `lab/config.js`（`isLab: true` 那行别删），
   push。打开 `…github.io/Personal/lab/` —— 顶栏该是**橙色**，登进去该是**空的**
5. 在生产站点「下载备份」，到试验站「清空并恢复」，试验站就有了一份一模一样的资料

第 5 步顺带把备份**验了一次**：能恢复的才叫备份，只导出没试过恢复的不算。

### 验一次隔离，别只是相信文档

在**试验站**改点显眼的 —— 账户余额改成 1，或者删掉一间房。回**生产站**刷新。

**生产站必须一点没变。** 变了就是两边连同一个库，`lab/config.js` 填成生产项目了，
立刻停下来改回去。这条是整件事成立与否的唯一证据，值得花两分钟。

> 两个项目都会被 `keepalive.yml` 每周 ping 一次，不会睡着。
> 试验站没配好时它自动跳过，不算失败。

### 改动的流程

```bash
./tools/sync-lab.sh    # 把生产站现在的代码复制到试验站，从能用的版本起步
# …改 lab/ 里的文件，在 lab 网址上试…
./tools/publish.sh     # 试好了，搬到生产站
git commit && git push # 几十秒后生效
```

两个脚本都**不碰 `config.js`** —— 覆盖掉的话，试验站就连回生产库了，等于白建。
`tools/bump.sh` 会顺手换掉 `?v=` 版本号；不换的话 iPhone Safari 会一直拿缓存里的旧代码，
表现就是「明明推上去了却没变」。

## 待办

- [x] ~~核对三处租金~~ —— 已确认，系统里的值就是对的：
      Bayan 一楼小房 RM900、三楼小房 RM1,400、Perling 一楼大房 RM1,600。
- [x] ~~设定收租日~~ —— 两位租客分别 19 号和 25 号，其余 1 号（谁是谁在网站上看）。
- [x] ~~提醒~~ —— iPhone 日历订阅 + 每日邮件都已设好并验证。
- [ ] 补房客电话。现在全是空的，填了才能用 WhatsApp 催租。
- [x] ~~生产站录 09-07 那条看房预约~~ —— 已录，`{"sent":2}` 证明函数读得到。
- [ ] 把 Perling 三楼中房独卫S 的招租价设成 RM2,000（房间详情最上面那栏）。
      上一任 RM1,800；不设的话 11 月起的空置损失会按旧价算，每月少报 200。
      这个数字不影响提醒，所以 `sent:2` 证明不了它 —— 得自己去看一眼。
- [ ] 更新两个支付宝的余额，押金覆盖率才准。账户名、币种、备注都能在「账户」页直接改。
- [x] ~~建试验站~~ —— 2026-09-05 建好并验过。试验站是项目 `jufpoofvpwwiqxkqlpyu`，
      生产是 `jqtirkwynqlwwwtktmat`。**隔离已实测**：在试验站改数据，生产站没变。
- [x] ~~点一次下载备份~~ —— 已下载，并且在试验站成功恢复过，所以这份备份是**验证过能用的**。
      不是一劳永逸：改过资料要再点，超过 45 天账户页会变橙提醒。
- [x] ~~处理历史欠租~~ —— 已在网站上逐间打勾清掉。

## 文件

```
index.html                      页面骨架 + 登录
app.js                          全部逻辑
styles.css                      样式（手机优先）
config.js                       Supabase 连接（公开值）
lab/                            试验站：同样三个文件 + 自己的 config.js（连第二个项目）
tools/sync-lab.sh               生产 → 试验，开始改之前跑
tools/publish.sh                试验 → 生产，试好了上线
tools/bump.sh                   换 ?v= 版本号，破 iPhone 缓存
tools/check-config.js           验两个站不是同一个项目、key 是 anon 不是 service_role
tools/build-fn.js               把 rules.ts + index.ts 拼成可粘贴的 bundled.ts
tools/check-fn.js               验 bundled.ts 没过期（生成物最怕悄悄过期）
supabase/schema.sql             建表 + RLS，可重复跑（改过表结构后要重跑一次）
supabase/seed.sql               初始数据（gitignore，不进仓库）
supabase/functions/agenda/      提醒用的 Edge Function（ICS 日历 + 邮件摘要）
  ├ rules.ts                    规则（真相来源，测试直接 import 它）
  ├ index.ts                    取数与 HTTP 入口
  └ bundled.ts                  ← 生成的，部署时贴这个
.github/workflows/keepalive.yml 每周保活
.github/workflows/notify.yml    每天叫一次 agenda 发提醒
```
