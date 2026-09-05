#!/usr/bin/env node
// 验证 bundled.ts 跟 rules.ts + index.ts 一致。
//
// 生成的文件最危险的失败方式是**悄悄过期**：改了逻辑忘了重新生成，
// 房东照旧去粘那个文件，部署上去的是旧代码，而且哪里都不会报错。
// 所以这条检查挂进 sync-lab.sh 和 publish.sh，每次同步和上线都跑。

const fs = require('fs');
const { build, OUT } = require('./build-fn.js');

if (!fs.existsSync(OUT)) {
  console.error('❌ 缺少 bundled.ts —— 跑一次 node tools/build-fn.js');
  process.exit(1);
}
if (fs.readFileSync(OUT, 'utf8') !== build()) {
  console.error('❌ bundled.ts 已过期（rules.ts 或 index.ts 改过了）'
              + '\n   跑一次：node tools/build-fn.js');
  process.exit(1);
}
console.log('✅ bundled.ts 与源文件一致');
