/* ==========================================================================
   Excel 导出测试
   --------------------------------------------------------------------------
   怎么跑：node tests/export.test.mjs

   为什么这个测试特别重要？
     .xlsx 本质上是个 ZIP 包着几个 XML，写错一个字节 Excel 就打不开。
     而我没法在房东的手机上验证 —— 所以必须在这里验到极致。

   验证方法（三层）：
     1. 自己写的 ZIP 读取器，逐项核对结构
     2. ★ 用专业的 Excel 库（SheetJS）把文件读回来 —— 读得回来，Excel 就能打开
     3. 逐格核对内容，确认算得对
   ========================================================================== */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// 浏览器里 calc.js / export.js 是 <script src> 加载的，函数挂在全局。
// 测试环境要手动挂上。
Object.assign(globalThis, require(join(ROOT, 'calc.js')));
const E = require(join(ROOT, 'export.js'));
const XLSX = require('xlsx');

/* ---------- 极简测试框架 ---------- */
let pass = 0, fail = 0;
const failures = [];
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) pass++;
  else { fail++; failures.push(`${label}\n     期望 ${b}\n     实际 ${a}`); }
}
function truthy(v, label) {
  if (v) pass++;
  else { fail++; failures.push(label + '\n     结果为空/假'); }
}
function section(n) { console.log(`\n── ${n} ──`); }

/* ==========================================================================
   1. 基础工具
   ========================================================================== */
section('基础工具');

eq(E.colLetter(1), 'A', '第1列 → A');
eq(E.colLetter(11), 'K', '第11列 → K');
eq(E.colLetter(26), 'Z', '第26列 → Z');
eq(E.colLetter(27), 'AA', '第27列 → AA');
eq(E.colLetter(52), 'AZ', '第52列 → AZ');

eq(E.xmlEsc('正常'), '正常', '普通文字原样保留');
eq(E.xmlEsc('A&B'), 'A&amp;B', '& 要转义（不转义文件就坏了）');
eq(E.xmlEsc('<标签>'), '&lt;标签&gt;', '< > 要转义');
eq(E.xmlEsc('他说"你好"'), '他说&quot;你好&quot;', '引号要转义');
eq(E.xmlEsc(null), '', 'null → 空字符串');
eq(E.xmlEsc('带\x07控制符'), '带控制符', 'XML 不允许的控制符要丢掉（否则 Excel 报文件损坏）');

eq(E.safeFileName('城东小区3栋'), '城东小区3栋', '正常名字不变');
eq(E.safeFileName('A/B:C*D?E"F<G>H|I'), 'A_B_C_D_E_F_G_H_I', '文件名非法字符换成下划线');
eq(E.safeFileName(''), '未命名', '空名字 → 未命名');
eq(E.safeFileName('   '), '未命名', '全空格 → 未命名');
eq(E.safeFileName('../../etc/passwd'), '.._.._etc_passwd', '路径穿越被挡住');

// CRC32 有标准测试值
eq(E.crc32(new TextEncoder().encode('123456789')), 0xCBF43926,
   'CRC32 标准测试值（算错 ZIP 就打不开）');
eq(E.crc32(new Uint8Array(0)), 0, '空数据的 CRC32 = 0');

/* ==========================================================================
   2. 自己写的 ZIP 读取器（用来核对生成结果）
   ========================================================================== */
function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是合法的 ZIP：找不到中央目录结尾标记');

  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014B50) {
      throw new Error('中央目录第 ' + i + ' 项的标记不对');
    }
    const flags  = dv.getUint16(off + 8, true);
    const method = dv.getUint16(off + 10, true);
    const crc    = dv.getUint32(off + 16, true);
    const size   = dv.getUint32(off + 24, true);
    const nLen   = dv.getUint16(off + 28, true);
    const eLen   = dv.getUint16(off + 30, true);
    const cLen   = dv.getUint16(off + 32, true);
    const local  = dv.getUint32(off + 42, true);
    const name   = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nLen));

    const lNameLen = dv.getUint16(local + 26, true);
    const lExtra   = dv.getUint16(local + 28, true);
    const start    = local + 30 + lNameLen + lExtra;
    const data     = bytes.subarray(start, start + size);

    entries.push({ name, method, crc, size, flags, data });
    off += 46 + nLen + eLen + cLen;
  }
  return entries;
}

section('ZIP 打包');

const testZip = E.zipStore([
  { name: '文件夹/中文名.txt', data: new TextEncoder().encode('你好世界') },
  { name: 'b.txt', data: new TextEncoder().encode('hello') },
]);

const entries = readZip(testZip);
eq(entries.length, 2, 'ZIP 里有 2 个文件');
eq(entries[0].name, '文件夹/中文名.txt', '★ 中文文件夹名和文件名读回来正确（UTF-8 标记生效）');
eq(entries[1].name, 'b.txt', '第二个文件名正确');
eq(new TextDecoder().decode(entries[0].data), '你好世界', '第一个文件内容正确');
eq(new TextDecoder().decode(entries[1].data), 'hello', '第二个文件内容正确');

let crcOk = true;
for (const e of entries) if (E.crc32(e.data) !== e.crc) crcOk = false;
truthy(crcOk, '★ 每个文件的 CRC 校验码都算对了（算错 Excel 会拒绝打开）');
truthy(entries.every(e => e.method === 0), '用的是"不压缩"模式');
truthy(entries.every(e => (e.flags & 0x0800) !== 0), '每个文件都标了"文件名是 UTF-8"');

/* ==========================================================================
   3. ★★★ 核心：生成 Excel，再用专业工具读回来
   ========================================================================== */
section('Excel 生成（用专业库读回来验证）');

const COLS = E.COLUMNS;
const sheet9 = {
  name: '9月',
  title: '城东小区3栋 · 2026年9月',
  columns: COLS,
  rows: [
    ['101', '城东小区3栋', 1200, 2400, '张三', '13800001111',
     '2026-03-01', '', '已收', 1200, '2026-09-03'],
    ['102', '城东小区3栋', 1000, 2000, '', '', '', '', '空置', '', ''],
    ['103', '城东小区3栋', 900, 0, '', '', '', '', '空置', '', ''],
  ],
};
const sheet10 = {
  name: '10月',
  title: '城东小区3栋 · 2026年10月',
  columns: COLS,
  rows: [['101', '城东小区3栋', 1200, 2400, '张三', '13800001111',
          '2026-03-01', '', '未到', '', '']],
};

const xlsxBytes = E.buildXlsx([sheet9, sheet10]);
truthy(xlsxBytes.length > 1000, `生成了 Excel 文件（${(xlsxBytes.length/1024).toFixed(1)} KB）`);
eq([...xlsxBytes.subarray(0, 2)], [0x50, 0x4B], '文件开头是 ZIP 标记（PK）');

// —— 用 SheetJS 读回来 ——
let wb = null;
try {
  wb = XLSX.read(Buffer.from(xlsxBytes), { type: 'buffer' });
  pass++;
} catch (err) {
  fail++; failures.push('★ 专业工具读不回这个 Excel 文件：' + err.message);
}

if (wb) {
  eq(wb.SheetNames, ['9月', '10月'], '★ 标签页名字正确，顺序正确');

  const ws = wb.Sheets['9月'];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });

  eq(grid[0][0], '城东小区3栋 · 2026年9月', '★ 第 1 行是标题（年份-区域-月份）');
  eq(grid[1].slice(0, 5), ['房号', '区域', '月租', '押金', '租客'], '★ 第 2 行是表头');

  eq(grid[2][0], '101', '第 3 行房号 = 101');
  eq(grid[2][2], 1200, '★ 月租读回来是数字 1200（不是文字，这样才能在 Excel 里求和）');
  eq(grid[2][3], 2400, '押金是数字 2400');
  eq(grid[2][4], '张三', '租客 = 张三');
  eq(grid[2][8], '已收', '状态 = 已收');
  eq(grid[2][9], 1200, '本月实收 = 1200（数字）');
  eq(grid[2][10], '2026-09-03', '收款日期 = 2026-09-03');

  eq(grid[3][0], '102', '第 4 行房号 = 102');
  eq(grid[3][8], '空置', '102 状态 = 空置');
  eq(grid[3][9], '', '空置房的本月实收是空的');
  eq(grid[4][0], '103', '第 5 行房号 = 103');

  eq(grid.length, 5, '一共 5 行（标题 + 表头 + 3 间房）');

  // 第二个标签页
  const grid10 = XLSX.utils.sheet_to_json(wb.Sheets['10月'], { header: 1, raw: true, defval: '' });
  eq(grid10[0][0], '城东小区3栋 · 2026年10月', '第 2 个标签页的标题正确');
  eq(grid10[2][0], '101', '第 2 个标签页有 101');
  eq(grid10[2][8], '未到', '未来的月份状态是「未到」');
  eq(grid10[2][4], '张三', '未来月份也显示租客（方便提前看）');

  // 数字格式：金额列应该是数字类型
  eq(typeof grid[2][2], 'number', '月租在 Excel 里是数字类型，能直接求和');
  eq(typeof grid[2][4], 'string', '租客名是文字类型');
}

/* ==========================================================================
   4. 表格内容算得对不对
   ========================================================================== */
section('表格内容计算');

const TODAY = '2026-09-10';
const AREA = { id: 'a1', name: '城东小区3栋' };
const ROOMS = [
  { id: 'r1', areaId: 'a1', no: '101', rent: 1200, deposit: 2400 },
  { id: 'r2', areaId: 'a1', no: '102', rent: 1000, deposit: 2000 },
  { id: 'r3', areaId: 'a1', no: '103', rent: 900,  deposit: 0 },
];
const TENS = [
  { id: 't1', roomId: 'r1', tenantName: '张三', tenantPhone: '13800001111',
    monthlyRent: 1200, deposit: 2400, startDate: '2026-03-01', endedAt: null },
];
const PAYS = [
  { id: 'p1', roomId: 'r1', tenancyId: 't1', month: '2026-09', amount: 1200, payDate: '2026-09-03' },
  { id: 'p2', roomId: 'r1', tenancyId: 't1', month: '2026-08', amount: 1000, payDate: '2026-08-04' },
];
const ctx = (ym) => ({ area: AREA, ym, rooms: ROOMS, tenancies: TENS, payments: PAYS, today: TODAY });

const r9 = E.rowsForMonth(ctx('2026-09'));
eq(r9[0].no, '101', '9月：第一行是 101');
eq(r9[0].status, '已收', '9月：101 已收');
eq(r9[0].paid, 1200, '9月：101 实收 1200');
eq(r9[0].payDate, '2026-09-03', '9月：101 收款日期正确');
eq(r9[0].tenant, '张三', '9月：101 租客张三');
eq(r9[0].start, '2026-03-01', '9月：101 入住时间 = 起租日');
eq(r9[0].end, '—', '9月：101 还在租，退租时间显示「—」（意思是没退租）');
eq(r9[1].status, '空置', '9月：102 空置');
eq(r9[1].paid, '', '9月：空置房没有实收金额');

const r8 = E.rowsForMonth(ctx('2026-08'));
eq(r8[0].status, '已收', '8月：101 已收');
eq(r8[0].paid, 1000, '★ 8月：实收如实记 1000（租客少给了 200），不是月租 1200');
eq(r8[0].rent, 1200, '8月：月租仍是 1200（能看出差在哪）');

const r7 = E.rowsForMonth(ctx('2026-07'));
eq(r7[0].status, '未收', '★ 7月：租出去了但没收到钱 → 未收');
eq(r7[0].paid, '', '7月：未收，实收是空的');

const r10 = E.rowsForMonth(ctx('2026-10'));
eq(r10[0].status, '未到', '10月：还没到，状态是「未到」');
eq(r10[0].paid, '', '10月：没有实收金额');

const r1 = E.rowsForMonth(ctx('2026-01'));
eq(r1[0].status, '空置', '★ 1月：101 是 3 月才起租的，1 月应该算空置');
eq(r1[0].tenant, '—', '1月：那时候还没租客，显示「—」');
eq(r1[0].rent, 1200, '1月：月租仍显示房间租金（能看出这间房本该收多少）');

/* ==========================================================================
   5.1 一个月里换过租客 → 两个租客各一行 ★ 房东 2026-09-10 选定
   --------------------------------------------------------------------------
   张三 9/1~9/15（9月8日交了租），李四 9/20 入住（还没交）。
   挤成一行的话，只能写一个名字却要写两个人的钱，打印出来会看错。
   ========================================================================== */
section('同月换租客 → 一个租客一行');

const HANDOVER_TENS = [
  { id: 'ta', roomId: 'r1', tenantName: '张三', tenantPhone: '13800001111',
    monthlyRent: 1000, deposit: 2000, startDate: '2026-01-01', endedAt: '2026-09-15' },
  { id: 'tb', roomId: 'r1', tenantName: '李四', tenantPhone: '13900002222',
    monthlyRent: 1200, deposit: 2400, startDate: '2026-09-20', endedAt: null },
];
const HANDOVER_PAYS = [
  { id: 'ha', roomId: 'r1', tenancyId: 'ta', month: '2026-09',
    amount: 1000, payDate: '2026-09-08' },
];
const hctx = (ym, pays) => ({
  area: AREA, ym, rooms: [ROOMS[0]], tenancies: HANDOVER_TENS,
  payments: pays == null ? HANDOVER_PAYS : pays, today: TODAY,
});

const h1 = E.rowsForMonth(hctx('2026-09'));
eq(h1.length, 2, '★ 9 月换过租客 → 101 出两行（不是一行）');
eq(h1[0].tenant, '张三', '第 1 行是张三（先入住的排前面）');
eq(h1[0].status, '已收', '★ 张三那行：他 9 月交过 → 已收');
eq(h1[0].paid, 1000, '★ 张三那行金额是他交的 1000');
eq(h1[0].payDate, '2026-09-08', '★ 张三那行的收款日期是他交的那天');
eq(h1[0].end, '2026-09-15', '张三那行带着他的退租日');
eq(h1[1].tenant, '李四', '第 2 行是李四');
eq(h1[1].status, '未收', '★★ 李四那行：他没交 → 未收（不再继承张三的已收）');
eq(h1[1].paid, '', '★ 李四那行金额是空的');
eq(h1[1].end, '—', '李四还在租，退租时间显示「—」');
eq(h1[1].rent, 1200, '李四那行的月租是他谈的 1200（不是张三的 1000）');
eq(h1[1].deposit, 2400, '押金也是各是各的');

// 两个人都交了 → 两行都是已收，钱各归各的
const h2 = E.rowsForMonth(hctx('2026-09', [
  ...HANDOVER_PAYS,
  { id: 'hb', roomId: 'r1', tenancyId: 'tb', month: '2026-09',
    amount: 1200, payDate: '2026-09-20' },
]));
eq(h2.length, 2, '两人都交了 → 还是两行');
eq(h2[0].paid, 1000, '★ 张三 1000、李四 1200，各归各的行（不会挤成一笔 2200）');
eq(h2[1].paid, 1200, '★ 李四那行是他自己的 1200');
eq(h2[0].status, '已收', '两个人都是「已收」');
eq(h2[1].status, '已收', '两个人都是「已收」');

// 没换过租客的月份不能被拆开
const h8 = E.rowsForMonth(hctx('2026-08', []));
eq(h8.length, 1, '8 月只有张三一个人 → 还是一行（不能凭空多出来）');
eq(h8[0].status, '未收', '8 月没交 → 未收');

/* ==========================================================================
   6. 行样式（让房东一眼看出空房 / 未收，不用逐行读文字）
   ========================================================================== */
section('行样式');

// —— 状态标记 ——
eq(r9[0]._style, 'paid',    '已收的房 → 行样式 paid（白底）');
eq(r9[1]._style, 'vacant',  '空置的房 → 行样式 vacant（灰底）');
eq(r7[0]._style, 'unpaid',  '未收的房 → 行样式 unpaid（红底）');
eq(r10[0]._style, 'future', '未来的月份 → 行样式 future（淡灰字）');

// —— 空房不该显示押金 ——
eq(r9[1].deposit, '', '★ 空置房的押金是空的（没租出去就没有押金，写数字才是误导）');
eq(r9[0].deposit, 2400, '已租房的押金照显示');

// —— 空着的文字格写「—」，避免一大片空白看着像数据丢了 ——
eq(r9[1].tenant, '—', '★ 空置房的租客显示「—」，不是空白');
eq(r9[1].phone,  '—', '空置房的电话显示「—」');
eq(r9[1].start,  '—', '空置房的入住时间显示「—」');
eq(r7[0].payDate, '—', '未收的房子，收款日期显示「—」');

// —— 金额列必须保持真空，否则 Excel 里选中一列求和会出错 ——
eq(r9[1].paid, '', '★ 空置房的实收是真空的（不是「—」），保证 Excel 求和不出错');
eq(r7[0].paid, '', '未收房的实收也是真空的');

// —— 样式真的写进 Excel 文件了吗？直接拆开 XML 逐项查 ——
const xmlOf = (bytes, path) => new TextDecoder().decode(
  readZip(bytes).find(e => e.name === path).data);

/** 用真实数据生成一张带样式的表，再取出指定行的 XML */
function styledSheet(ym, legend) {
  const bytes = E.buildXlsx([{
    name: 'x', title: 't', legend: legend || '',
    columns: COLS,
    rows: E.rowObjectsToArrays(E.rowsForMonth(ctx(ym))),
  }]);
  const xml = xmlOf(bytes, 'xl/worksheets/sheet1.xml');
  return {
    styles: xmlOf(bytes, 'xl/styles.xml'),
    xml,
    row: (n) => (xml.match(new RegExp('<row r="' + n + '">([\\s\\S]*?)</row>')) || [, ''])[1],
  };
}

// 9月：第3行=101(已收,白底)  第4行=102(空置,灰底)  第5行=103(空置,灰底)
const S9 = styledSheet('2026-09', '灰底＝空房');
const r3 = S9.row(3), r4 = S9.row(4);

truthy(/s="4"/.test(r4),  '★ 空置那行真的用了灰底样式（s="4"）');
truthy(!/s="4"/.test(r3), '已收那行没有用灰底样式（保持白底，不抢眼）');
truthy(/s="8"/.test(r3),  '★ 已收行的「本月状态」格用绿字浅绿底（s="8"）');
truthy(/s="10"/.test(r4), '★ 空置行的「本月状态」格用灰字灰底（s="10"）');
truthy(/s="5"/.test(r4),  '空置行的金额格用灰色金额样式（s="5"）');
truthy(/—/.test(r4),      '空置行的文字格真的写了「—」');

// 7月：101 租出去了但没收到钱 → 整行红底
const S7 = styledSheet('2026-07', '灰底＝空房');
const r7x = S7.row(3);
truthy(/s="6"/.test(r7x), '★ 未收那行用红底样式（s="6"）');
truthy(/s="9"/.test(r7x), '★ 未收行的「本月状态」格用红字浅红底（s="9"）');

// 样式表本身
truthy(/<fonts count="7">/.test(S9.styles),
       '样式表里有 7 种字体（普通／表头／标题／绿／红／灰／淡灰）');
truthy(/<fills count="6">/.test(S9.styles), '样式表里有 6 种底色');
truthy(/<cellXfs count="14">/.test(S9.styles), '样式表里有 14 种单元格样式');
const fillsBlock = (S9.styles.match(/<fills[\s\S]*?<\/fills>/) || [''])[0];
const pNone = fillsBlock.indexOf('patternType="none"');
const pGray = fillsBlock.indexOf('patternType="gray125"');
const pSolid = fillsBlock.indexOf('patternType="solid"');
truthy(pNone >= 0 && pNone < pGray && pGray < pSolid,
  '★ 底色顺序必须是 none → gray125 → 自定义色（Excel 硬性要求，顺序错了文件打不开）');

// 标题行 + 图例 + 冻结
truthy(/灰底＝空房/.test(S9.xml), '★ 标题行右边带颜色图例（打印出来也能看懂）');
truthy(/<mergeCells count="2">/.test(S9.xml), '标题和图例各自合并了单元格');
truthy(/<pane ySplit="2"/.test(S9.xml), '前两行冻结（往下滚时标题和表头一直看得见）');
truthy(/<dimension ref="A1:K5"\/>/.test(S9.xml), '表格范围标注正确（A1 到 K5）');

// —— ★ 最关键：带样式的表，专业工具还读得回来吗 ——
const styledBytes = E.buildXlsx([{
  name: '9月', title: '城东小区3栋 · 2026年9月', legend: '灰底＝空房',
  columns: COLS,
  rows: E.rowObjectsToArrays(E.rowsForMonth(ctx('2026-09'))),
}]);
let wbStyled = null;
try {
  wbStyled = XLSX.read(Buffer.from(styledBytes), { type: 'buffer' });
  pass++;
} catch (err) {
  fail++; failures.push('★★ 加了样式之后 Excel 读不回来了：' + err.message);
}
if (wbStyled) {
  const g = XLSX.utils.sheet_to_json(wbStyled.Sheets['9月'], { header: 1, raw: true, defval: '' });
  eq(g[0][0], '城东小区3栋 · 2026年9月', '★ 加样式后标题仍正确');
  eq(g[1].slice(0, 3), ['房号', '区域', '月租'], '★ 加样式后表头仍正确');
  eq(g[2][0], '101', '★ 加样式后 101 的数据在');
  eq(g[2][2], 1200, '★ 加样式后金额仍是数字类型（能求和）');
  eq(g[3][4], '—', '★ 空置房的租客列读回来是「—」');
  eq(g[3][9], '', '★ 空置房的实收列读回来是空的');
}

/* ==========================================================================
   5. 完整的导出包（ZIP）
   ========================================================================== */
section('完整导出包');

const result = E.buildExportZip({
  areas: [AREA, { id: 'a2', name: '老房子' }],
  rooms: [...ROOMS, { id: 'r4', areaId: 'a2', no: '201', rent: 800, deposit: 0 }],
  tenancies: TENS,
  payments: PAYS,
  years: ['2026'],
  today: TODAY,
});

const zipEntries = readZip(result.zip);
const names = zipEntries.map(e => e.name);

truthy(names.includes('房东记账/Excel/2026/2026-城东小区3栋.xlsx'),
       '★ 压缩包里有 Excel：房东记账/Excel/2026/2026-城东小区3栋.xlsx');
truthy(names.includes('房东记账/Excel/2026/2026-老房子.xlsx'),
       '老房子的 Excel 也在');
truthy(names.some(n => n.includes('备用CSV') && n.includes('2026-城东小区3栋.csv')),
       '★ 附带了 CSV 保底（万一 Excel 打不开时不至于两手空空）');

eq(result.stats.files, 4, '一共 4 个文件（2 个区域 × Excel+CSV）');
eq(result.stats.years, ['2026'], '年份正确');

// 把压缩包里的 Excel 解出来，再读一遍
const xlsxEntry = zipEntries.find(e => e.name.endsWith('城东小区3栋.xlsx'));
let wb2 = null;
try {
  wb2 = XLSX.read(Buffer.from(xlsxEntry.data), { type: 'buffer' });
  pass++;
} catch (err) {
  fail++; failures.push('★ 从压缩包里解出来的 Excel 读不回来：' + err.message);
}
if (wb2) {
  eq(wb2.SheetNames.length, 12, '★ 一个文件里 12 个标签页（1月~12月）');
  eq(wb2.SheetNames[0], '1月', '第一个标签页是 1月');
  eq(wb2.SheetNames[11], '12月', '最后一个标签页是 12月');
  const g = XLSX.utils.sheet_to_json(wb2.Sheets['9月'], { header: 1, raw: true, defval: '' });
  eq(g[0][0], '城东小区3栋 · 2026年9月', '标签页标题正确');
  eq(g[2][0], '101', '数据在');
}

// CSV 保底：检查中文不乱码（靠开头那 3 个 BOM 字节）
// ⚠️ 注意：不能用 TextDecoder 解码后查 ﻿ —— 解码器会自动把 BOM 吃掉。
//    必须直接查原始字节，那才是 Excel 真正看到的东西。
const csvEntry = zipEntries.find(e => e.name.endsWith('城东小区3栋.csv'));
truthy(csvEntry.data[0] === 0xEF && csvEntry.data[1] === 0xBB && csvEntry.data[2] === 0xBF,
       '★ CSV 开头有 BOM 三个字节 EF BB BF（没有它 Excel 打开中文是乱码）');
const csvText = new TextDecoder().decode(csvEntry.data);
truthy(csvText.includes('城东小区3栋'), 'CSV 里中文正常');
truthy(csvText.includes('月份'), 'CSV 多了一列「月份」用来区分 12 个月');
eq(csvText.split('\r\n').length > 30, true, 'CSV 里有全部 12 个月的数据');

// 没有房间的区域不应该生成空文件
const empty = E.buildExportZip({
  areas: [{ id: 'a9', name: '空区域' }], rooms: [], tenancies: [], payments: [],
  years: ['2026'], today: TODAY,
});
eq(readZip(empty.zip).length, 0, '没有房间的区域不会生成空文件');

// 多个年份
const twoYears = E.buildExportZip({
  areas: [AREA], rooms: ROOMS, tenancies: TENS, payments: PAYS,
  years: ['2026', '2025'], today: TODAY,
});
const n2 = readZip(twoYears.zip).map(e => e.name);
truthy(n2.some(n => n.includes('/2026/')), '导出多个年份时，2026 文件夹在');
truthy(n2.some(n => n.includes('/2025/')), '2025 文件夹也在');

// 年份倒序（最新的在前）
eq(twoYears.stats.years, ['2026', '2025'], '年份按从新到旧排列');
// 两个区域：城东小区3栋 3 间房 + 老房子 1 间房，各 12 个月
eq(result.stats.rows, 12 * 3 + 12 * 1, '统计出导出了多少行数据（4 间房 × 12 个月 = 48）');

/* ==========================================================================
   结果
   ========================================================================== */
console.log('\n' + '─'.repeat(60));
if (fail === 0) {
  console.log(`🎉 全部通过（${pass} 项）`);
  process.exit(0);
} else {
  console.log(`❌ 失败 ${fail} 项，通过 ${pass} 项\n`);
  failures.forEach(f => console.log('   ✗ ' + f + '\n'));
  process.exit(1);
}
