#!/usr/bin/env node
// 提交前跑一次：确认生产站和试验站不是同一个 Supabase 项目。
//
// 为什么值得单独写一个检查：填错的话界面上**看不出任何区别** —— 试验站顶栏照样是橙的、
// 「清空并恢复」照样在，但按下去删的是真数据。这是这套东西最坏的失败方式，
// 而且要等到房东真的按下去才会发现。让它在提交前就炸掉。
//
// 顺带验 anon key 的 role 和它指向的项目：ref 就写在 JWT 载荷里，
// 所以 url 跟 key 对不对得上是能验的，贴串时手滑贴错一半也能抓到。

const fs = require('fs');
const path = require('path');

// require() 解析相对路径是相对**这个脚本**的位置，不是相对当前目录 ——
// 写 './config.js' 会去找 tools/config.js。所以一律转成绝对路径。
const ROOT = path.join(__dirname, '..');

function load(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  global.window = {};
  delete require.cache[abs];
  require(abs);
  return global.window.SUPABASE_CONFIG || {};
}

function payload(key) {
  try {
    return JSON.parse(Buffer.from(String(key).split('.')[1], 'base64url').toString());
  } catch { return null; }
}

let bad = 0;
const fail = m => { console.error('❌ ' + m); bad++; };
const pass = m => console.log('✅ ' + m);

const prod = load('config.js');
const lab = load('lab/config.js');

if (!prod) fail('找不到 config.js');

const CONFIGURED = c => /^https:\/\/[a-z0-9-]+\.supabase\.co/i.test(String(c?.url || '').trim());

for (const [name, c, file] of [['生产站', prod, 'config.js'], ['试验站', lab, 'lab/config.js']]) {
  if (!c) continue;
  if (!CONFIGURED(c)) { console.log(`⏭️  ${name}（${file}）还没填，跳过`); continue; }

  const p = payload(c.anonKey);
  if (!p) { fail(`${name}：anonKey 不是能解析的 JWT`); continue; }

  // service_role 绕过 RLS。进了公开仓库，任何人都能读写整个库。
  if (p.role !== 'anon') fail(`${name}：key 的 role 是 ${p.role}，不是 anon —— 立刻去 Supabase 后台轮换这把钥匙`);
  else pass(`${name}：role=anon`);

  // url 里的 ref 和 key 载荷里的 ref 必须是同一个项目
  const urlRef = String(c.url).match(/https:\/\/([a-z0-9-]+)\.supabase\.co/i)?.[1];
  if (urlRef !== p.ref) fail(`${name}：url 指向 ${urlRef}，但 key 是 ${p.ref} 的 —— 两个值来自不同项目`);
  else pass(`${name}：url 与 key 同属项目 ${p.ref}`);
}

if (CONFIGURED(prod) && CONFIGURED(lab)) {
  if (prod.url === lab.url) {
    fail('生产站和试验站连的是同一个项目 —— 在试验站删数据就是删真数据。'
       + '\n   lab/config.js 要填第二个 Supabase 项目，不是生产那个。');
  } else {
    pass(`两个站是不同项目（生产 ${payload(prod.anonKey)?.ref} ≠ 试验 ${payload(lab.anonKey)?.ref}）`);
  }
  if (!lab.isLab) fail('lab/config.js 少了 isLab: true —— 顶栏不会变橙，会跟生产站混淆');
  else pass('试验站带 isLab 标记');
  if (prod.isLab) fail('根目录 config.js 不该有 isLab —— 生产站会露出「清空并恢复」');
}

process.exit(bad ? 1 : 0);
