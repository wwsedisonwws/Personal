#!/usr/bin/env bash
# 换掉 index.html 里 ?v= 后面的版本号。
#
# iOS Safari 没有强制刷新，旧的 app.js 会一直躺在缓存里。改了代码不换这个号，
# 手机上就是「明明推上去了却没变」。
set -euo pipefail
f="${1:?用法: bump.sh <index.html>}"
v=$(date -u -d '+8 hours' +%Y%m%d%H%M 2>/dev/null || date -u -v+8H +%Y%m%d%H%M)
sed -i.bak -E "s/\?v=[0-9]+/?v=$v/g" "$f" && rm -f "$f.bak"
echo "   $f → ?v=$v"
