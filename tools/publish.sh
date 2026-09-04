#!/usr/bin/env bash
# 把试验站里试好的代码搬到生产站 —— 这就是「上线」。
#
# 不碰 config.js：生产站连的是生产库，试验站连的是试验库，这个差别是两个站的全部区别。
set -euo pipefail
cd "$(dirname "$0")/.."

cp lab/index.html lab/app.js lab/styles.css .
"$(dirname "$0")/bump.sh" index.html
echo "✅ 已上线。接着 git commit + push，几十秒后 GitHub Pages 生效。"
echo "   上线前记得先在网页上点一次「下载备份」—— 改坏了才有得退。"
