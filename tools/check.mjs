/* ==========================================================================
   上线前的一键全检
   --------------------------------------------------------------------------
   怎么跑：node tools/check.mjs

   做完任何改动，推送到 GitHub 之前跑一遍。
   四项全绿才允许上线 —— 这几项任何一项红了，房东手机上就会出问题。

     1. 算账大脑的单元测试（82 项）
     2. 数据库集成测试（36 项，含"关掉 App 再打开数据还在"）
     3. 文件完整性：页面和离线小工引用的文件是否都存在
     4. 离线缓存清单是否覆盖了所有必需文件
   ========================================================================== */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (f) => spawnSync(process.execPath, [join(ROOT, f)], { encoding: 'utf8' });

let allOk = true;
const line = (s) => console.log(s);

/* ---------- 1 & 2. 跑测试 ---------- */
for (const [name, file] of [
  ['算账大脑单元测试', 'tests/calc.test.mjs'],
  ['数据库集成测试',   'tests/db.test.mjs'],
]) {
  line(`\n${'='.repeat(60)}\n【${name}】\n${'='.repeat(60)}`);
  const r = run(file);
  const out = (r.stdout || '') + (r.stderr || '');
  // 只打印最后几行，避免刷屏
  const lines = out.trim().split('\n');
  line(lines.slice(-2).join('\n'));
  if (r.status !== 0) {
    allOk = false;
    line('↑ 上面这个测试没通过，先看完整输出：node ' + file);
    if (lines.length > 3) line(lines.slice(0, -2).join('\n'));
  }
}

/* ---------- 3. 文件完整性 ---------- */
line(`\n${'='.repeat(60)}\n【文件完整性】\n${'='.repeat(60)}`);

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
const mf = JSON.parse(readFileSync(join(ROOT, 'manifest.webmanifest'), 'utf8'));

const problems = [];

// index.html 里引用的本地文件
for (const m of html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)) {
  const f = m[1].replace(/^\.\//, '');
  if (!existsSync(join(ROOT, f))) problems.push(`index.html 引用了不存在的文件: ${f}`);
}

// manifest 里的图标
for (const ic of mf.icons) {
  const f = ic.src.replace(/^\.\//, '');
  if (!existsSync(join(ROOT, f))) problems.push(`manifest 引用了不存在的图标: ${f}`);
}

// 离线小工预缓存清单里的文件
const precache = [...(sw.match(/const PRECACHE = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g))]
  .map(m => m[1]);
for (const p of precache) {
  if (p === './') { if (!existsSync(join(ROOT, 'index.html'))) problems.push('缺 index.html'); continue; }
  const f = p.replace(/^\.\//, '');
  if (!existsSync(join(ROOT, f))) problems.push(`离线缓存清单里有不存在的文件: ${f}`);
}

// 反过来：页面用到的本地文件，是否都在离线缓存清单里？
// 漏了会导致"断网时打不开"
for (const m of html.matchAll(/<script src="(\.\/[^"]+)"/g)) {
  if (!precache.includes(m[1])) problems.push(`离线缓存清单漏了: ${m[1]}（断网时会加载不到）`);
}

if (problems.length) {
  allOk = false;
  problems.forEach(p => line('  ❌ ' + p));
} else {
  line(`  ✅ 页面引用的 ${[...html.matchAll(/<script src=/g)].length} 个脚本、`
     + `${mf.icons.length} 个图标、离线清单 ${precache.length} 个文件，全都在`);
}

/* ---------- 4. 关键的写法检查 ---------- */
line(`\n${'='.repeat(60)}\n【关键写法】\n${'='.repeat(60)}`);

const checks = [
  // 离线小工
  [sw.includes('Promise.allSettled'), '离线小工用 allSettled 预缓存（单个文件404不会拖垮全部）'],
  [!sw.includes('addAll('), '离线小工没有用危险的 addAll'],
  [sw.includes('skipWaiting') && sw.includes('clients.claim'), '离线小工能立即接管新版本'],
  [!/indexedDB|IDBDatabase/.test(sw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')),
   '离线小工不碰数据库（更新 App 不会碰到你的数据）'],
  // 数据库迁移
  [/switch \(e\.oldVersion\)[\s\S]{0,60}case 0/.test(html), '数据库升级用的是级联穿透写法'],
  // 日期与金额
  [/function todayStr[\s\S]{0,200}getFullYear/.test(readFileSync(join(ROOT,'calc.js'),'utf8')),
   '日期用本地时间构造（不用 UTC，避免月初的账落到上个月）'],
  [/function toFen/.test(readFileSync(join(ROOT,'calc.js'),'utf8')), '金额有「元转分」函数（避免小数零头）'],
  // 持久化
  [/navigator\.storage[\s\S]{0,80}persist/.test(html), '启动时申请了持久化存储（防浏览器自动清理）'],
  [/lz_everUsed/.test(html), '有「数据是否被清空」的哨兵检查'],
];

for (const [ok, label] of checks) {
  line(`  ${ok ? '✅' : '❌'} ${label}`);
  if (!ok) allOk = false;
}

/* ---------- 结果 ---------- */
line('\n' + '='.repeat(60));
line(allOk ? '🎉 全部通过，可以推送上线' : '❌ 有问题，先修好再推送');
line('='.repeat(60));
process.exit(allOk ? 0 : 1);
