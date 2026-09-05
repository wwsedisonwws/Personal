#!/usr/bin/env bash
# 把生产站的代码复制到试验站 —— 开始一轮新改动之前跑，让试验站从「现在能用的版本」起步。
#
# 不碰 lab/config.js：那里存着第二个 Supabase 项目的地址，覆盖掉试验站就连回生产库了。
set -euo pipefail
cd "$(dirname "$0")/.."

# 先验两个 config：填成同一个项目的话界面上看不出区别，
# 但在试验站按「清空并恢复」删的就是真数据。
node tools/check-config.js

cp index.html app.js styles.css lab/
"$(dirname "$0")/bump.sh" lab/index.html
echo "✅ 试验站已同步到生产站的当前版本（lab/config.js 未动）"
