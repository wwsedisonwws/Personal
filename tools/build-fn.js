#!/usr/bin/env node
// 把 rules.ts + index.ts 合成一个自足的文件，供 Supabase 网页编辑器粘贴。
//
// 为什么要有这东西：函数本来是两个文件，index.ts 用 import 引 rules.ts。
// 在网页编辑器里少一个文件、或名字打错，部署就报
// "Module not found ... /source/rules.ts" —— 房东就撞了这个。
// 一个文件没有 import，也就没有这种失败方式。
//
// rules.ts 仍是唯一的真相来源（测试直接 import 它）；这里只是把它和 index.ts
// 拼起来。tools/check-fn.js 会验证拼出来的东西跟源文件一致，防止它悄悄过期。

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'supabase/functions/agenda');

const HEADER = `// ⚠️ 这个文件是**生成的**，别直接改它。
//
// 改逻辑请改 rules.ts 或 index.ts，然后跑 node tools/build-fn.js 重新生成。
// 它的用途只有一个：在 Supabase 网页编辑器里当作 index.ts 粘贴，
// 一个文件、没有 import，不会再出现 "Module not found: rules.ts"。
//
// 生成自：rules.ts + index.ts
`;

function build() {
  const rules = fs.readFileSync(path.join(DIR, 'rules.ts'), 'utf8');
  const index = fs.readFileSync(path.join(DIR, 'index.ts'), 'utf8');
  // 去掉那行 import，其余原样保留（rules.ts 自己没有任何 import，可以直接拼）
  const body = index.replace(/^import \{[^}]*\} from '\.\/rules\.ts';\n/m, '');
  if (body === index) throw new Error('没找到 ./rules.ts 的 import —— index.ts 结构变了，检查这个脚本');
  return `${HEADER}\n${rules}\n${body}`;
}

module.exports = { build, OUT: path.join(DIR, 'bundled.ts') };

if (require.main === module) {
  const { OUT } = module.exports;
  fs.writeFileSync(OUT, build());
  console.log('✅ 已生成 supabase/functions/agenda/bundled.ts');
}
