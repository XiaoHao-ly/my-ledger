/* ==========================================================================
   数据库集成测试
   --------------------------------------------------------------------------
   怎么跑：node tests/db.test.mjs

   这个测试回答一个房东最关心的问题：
     「我建了房间，关掉 App 再打开，东西还在吗？」

   做法：用 fake-indexeddb 在电脑上模拟一个手机浏览器数据库，
   把 index.html 里的真实代码跑起来，走一遍建区域 → 建房间 → 重启 App 的流程。

   ⚠️ fake-indexeddb 只是测试工具，不会进 App。App 本身零依赖。
   ========================================================================== */

import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 浏览器里 calc.js 是 <script src> 加载的（函数挂在全局）。
// 测试环境里要手动挂上，否则 App 代码找不到 todayStr 这些函数。
const require = createRequire(import.meta.url);
Object.assign(globalThis, require(join(ROOT, 'calc.js')));

/* ==========================================================================
   搭一个"假的浏览器环境"
   ========================================================================== */

class El {
  constructor(id = '') {
    this.children = [];
    this.parentNode = null;
    this._html = '';
    this.textContent = '';
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.tagName = 'DIV';
    this._listeners = {};
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      contains: (c) => this.classList._s.has(c),
    };
    if (id) this.id = id;
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); }
  set id(v) { this._id = v; REG.set(v, this); }
  get id() { return this._id; }
  addEventListener(t, f) { (this._listeners[t] ||= []).push(f); }
  removeEventListener(t, f) {
    this._listeners[t] = (this._listeners[t] || []).filter(x => x !== f);
  }
  closest() { return null; }
  cloneNode() { const e = new El(); e.tagName = this.tagName; return e; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  replaceChild(n, o) {
    const i = this.children.indexOf(o);
    if (i >= 0) this.children[i] = n;
    n.parentNode = this;
    if (o) o.parentNode = null;
  }
  querySelector() { return null; }
}

const REG = new Map();

// 预先登记脚本会直接拿的那些元素
for (const id of [
  'updateBar', 'btnUpdate', 'btnInstall', 'btnStat', 'btnGear',
  'tabsArea', 'tabsStatus', 'roomList', 'notice', 'toast',
  'sheetMask', 'sheet', 'sheetCancel', 'sheetTitle', 'sheetOk', 'sheetBody',
]) REG.set(id, new El(id));

// body 里要有 sheetBody，因为 openSheet 会用到 parentNode.replaceChild
const body = new El('body');
body.appendChild(REG.get('sheetBody'));

global.document = {
  body,
  getElementById(id) {
    // 表单字段是动态生成的，测试里自动补一个占位元素，方便直接赋值
    if (!REG.has(id)) REG.set(id, new El(id));
    return REG.get(id);
  },
  createElement: () => new El(),
  addEventListener() {},
  querySelector: () => null,
};

global.window = {
  addEventListener() {},
  matchMedia: () => ({ matches: false }),
  location: { reload() {} },
};
global.location = global.window.location;

// Node 24 自带的 navigator 是只读的，必须用 defineProperty 才能换掉
Object.defineProperty(globalThis, 'navigator', {
  value: {
    storage: { persisted: async () => true, persist: async () => true },
  },
  writable: true,
  configurable: true,
});

global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

/* ==========================================================================
   把 index.html 里的真实代码跑起来
   ========================================================================== */

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (scripts.length !== 1) { console.log('❌ 预期 1 段内联脚本，实际 ' + scripts.length); process.exit(1); }
const appScript = scripts[0];

/* ==========================================================================
   测试主体（接在 App 代码后面，这样能访问到它内部的变量）
   ========================================================================== */

const TEST = `
;(function(){
  const results = [];
  const eq = (a, b, label) => {
    const ok = JSON.stringify(a) === JSON.stringify(b);
    results.push({ ok, label, detail: ok ? '' : \`期望 \${JSON.stringify(b)}，实际 \${JSON.stringify(a)}\` });
  };
  const truthy = (v, label) => {
    results.push({ ok: !!v, label, detail: v ? '' : '结果为假' });
  };

  globalThis.__runTests = (async () => {
    // 等 App 启动完成
    let guard = 0;
    while (!state.loaded && guard++ < 500) await new Promise(r => setTimeout(r, 10));
    if (!state.loaded) { results.push({ ok:false, label:'App 启动超时', detail:'' }); return results; }

    /* ---------- 1. 首次启动 ---------- */
    eq(state.areas.length, 0, '第一次打开：没有区域');
    eq(state.rooms.length, 0, '第一次打开：没有房间');
    truthy(state.settings.statsStartMonth, '自动记下了「统计起始月」＝ ' + state.settings.statsStartMonth);
    eq(localStorage.getItem('lz_everUsed'), '1', '留下了「用过了」的标记（用于发现数据被清空）');

    /* ---------- 2. 建区域 ---------- */
    await createArea('城东小区3栋');
    eq(state.areas.length, 1, '建成 1 个区域');
    eq(state.areas[0].name, '城东小区3栋', '区域名字对');
    truthy(curArea === state.areas[0].id, '自动切换到新建的区域');

    await createArea('老房子');
    eq(state.areas.length, 2, '再建一个，共 2 个区域');

    /* ---------- 3. 建房间 ---------- */
    const areaId = state.areas[0].id;
    await createRoom({ areaId, no:'101', rent:1200, deposit:2400, rentDueDay:null });
    await createRoom({ areaId, no:'102', rent:1000, deposit:2000, rentDueDay:10 });
    eq(state.rooms.length, 2, '建了 2 间房');
    eq(roomsOfArea(areaId).length, 2, '这 2 间都属于第一个区域');
    eq(state.rooms[0].no, '101', '房号 101');
    eq(state.rooms[0].rent, 1200, '租金 1200');
    eq(state.rooms[1].rentDueDay, 10, '102 单独设了 10 号收租');

    // 刚建的房间没租客 → 应该是未租
    eq(isRentedNow(state.rooms[0]), false, '新建房间 = 未租（因为还没有租约）');
    eq(monthStateOf(state.rooms[0], currentMonth()), 'vacant', '这个月状态 = 空置');

    /* ---------- 4. ★ 最关键：模拟"关掉 App 再打开" ---------- */
    // 把内存清空、数据库连接关掉，完全重新来一遍
    db.close();
    state.areas = []; state.rooms = []; state.tenancies = []; state.payments = [];
    state.loaded = false;
    db = await openDB();
    await loadAll();

    eq(state.areas.length, 2, '重启后：2 个区域还在');
    eq(state.areas[0].name, '城东小区3栋', '重启后：区域名字还对');
    eq(state.rooms.length, 2, '重启后：2 间房还在');
    const r101 = state.rooms.find(r => r.no === '101');
    truthy(r101, '重启后：101 还在');
    eq(r101 && r101.rent, 1200, '重启后：101 的租金还是 1200');
    const r102 = state.rooms.find(r => r.no === '102');
    eq(r102 && r102.rentDueDay, 10, '重启后：102 的收租日还是 10 号');

    /* ---------- 5. 改房间 ---------- */
    await updateRoom(r101, { rent: 1300 });
    eq(r101.rent, 1300, '改租金 → 内存立刻更新');
    const fromDb = await dbGet('rooms', r101.id);
    eq(fromDb.rent, 1300, '改租金 → 数据库里也更新了');

    /* ---------- 6. 区域改名 / 排序 ---------- */
    await renameArea(state.areas[0], '城东小区3栋A座');
    eq((await dbGet('areas', state.areas[0].id)).name, '城东小区3栋A座', '改名写进数据库了');

    const before = state.areas.map(a => a.name);
    await moveArea(state.areas[1], -1);
    const after = state.areas.map(a => a.name);
    truthy(before[0] !== after[0], '排序变了：' + before.join(' | ') + '  →  ' + after.join(' | '));

    /* ---------- 7. 设置项 ---------- */
    await saveSetting('defaultRentDueDay', 8);
    eq(state.settings.defaultRentDueDay, 8, '默认收租日改成 8 号');
    state.settings.defaultRentDueDay = 5;      // 先改回内存
    await loadAll();                            // 重新读
    eq(state.settings.defaultRentDueDay, 8, '重启后：默认收租日还是 8 号');

    /* ---------- 8. 删除（进回收站，不是真删） ---------- */
    const areaToDelete = state.areas.find(a => a.name === '老房子') || state.areas[1];
    // 先给老房子加一间房，验证"删区域会把房间一起收走"
    await createRoom({ areaId: areaToDelete.id, no:'201', rent:800, deposit:0, rentDueDay:null });
    const roomsBefore = state.rooms.length;
    await deleteArea(areaToDelete);

    eq(state.areas.some(a => a.id === areaToDelete.id), false, '删除后：区域不在列表里了');
    eq(state.rooms.length, roomsBefore - 1, '删除后：它下面的房间也一起收走了');

    const areaRow = await dbGet('areas', areaToDelete.id);
    eq(areaRow.isDeleted, true, '数据库里区域是"打标记删除"，不是真删（以后能恢复）');

    // 重启后确认真的看不到
    state.areas = []; state.rooms = [];
    await loadAll();
    eq(state.areas.some(a => a.id === areaToDelete.id), false, '重启后：删掉的区域依然看不到');
    eq(state.rooms.some(r => r.no === '201'), false, '重启后：被收走的房间也看不到');
    eq(state.rooms.some(r => r.no === '101'), true, '重启后：没被删的 101 还在');

    /* ---------- 9. 批量建房 ---------- */
    const F = (o) => genRoomNumbers({ mode:'floor', prefix:'', floorFrom:1, floorTo:6, perFloor:4, ...o });

    eq(F({}).length, 24, '批量：6层 × 每层4户 = 24 间');
    eq(F({}).slice(0, 5), ['101','102','103','104','201'], '房号从 101 开始，第二层是 201');
    eq(F({}).slice(-1)[0], '604', '最后一间是 604');
    eq(F({ floorFrom:6, floorTo:6 }), ['601','602','603','604'], '只建一层（6层）');
    eq(F({ floorFrom:10, floorTo:10, perFloor:2 }), ['1001','1002'], '10层以上 → 1001 1002');
    eq(F({ perFloor:1 }).slice(0,3), ['101','201','301'], '每层1户');
    eq(genRoomNumbers({ mode:'seq', prefix:'', floorFrom:1, floorTo:6, perFloor:4 }).slice(0,3),
       ['1','2','3'], '纯序号：1 2 3');
    eq(genRoomNumbers({ mode:'seq', prefix:'', floorFrom:1, floorTo:6, perFloor:4 }).slice(-1)[0],
       '24', '纯序号：最后一间是 24');
    eq(genRoomNumbers({ mode:'prefix', prefix:'A', floorFrom:1, floorTo:2, perFloor:3 }),
       ['A101','A102','A103','A201','A202','A203'], '加前缀：A101…A203');

    // 真的批量建一次，并验证"关掉再打开还在"
    const batchArea = state.areas[0];
    const beforeCount = roomsOfArea(batchArea.id).length;
    const nums = F({});
    const nowSet = new Set(roomsOfArea(batchArea.id).map(r => r.no));
    const fresh = nums.filter(n => !nowSet.has(n));
    truthy(fresh.length > 0 && fresh.length < 24,
      \`已存在的房号会被跳过（24 间里跳过 \${24 - fresh.length} 间已存在的）\`);

    const stamp = Date.now();
    const newRooms = fresh.map(no => ({
      id: newId('r'), areaId: batchArea.id, no, rent: 1200, rentDueDay: null,
      deposit: 2400, isDeleted: false, createdAt: stamp, updatedAt: stamp,
    }));
    await dbPutAll('rooms', newRooms);
    state.rooms.push(...newRooms);
    eq(roomsOfArea(batchArea.id).length, beforeCount + newRooms.length, '批量建房后房间数正确增加');

    // 房号要按人眼习惯排：101 必须在 102 前面（不能排到 1001 后面）
    const sortedNos = roomsOfArea(batchArea.id).map(r => r.no);
    const i101 = sortedNos.indexOf('101'), i102 = sortedNos.indexOf('102');
    truthy(sortedNos.length >= 2 && i101 < i102,
      \`房号按人眼习惯排序（\${sortedNos.slice(0,4).join(' ')} …）\`);

    // 重启验证
    db.close();
    state.areas = []; state.rooms = []; state.loaded = false;
    db = await openDB();
    await loadAll();
    eq(roomsOfArea(batchArea.id).length, beforeCount + newRooms.length, '重启后：批量建的房间都还在');
    truthy(roomsOfArea(batchArea.id).some(r => r.no === '604'), '重启后：604 还在');

    /* ---------- 10. 数据库结构对不对 ---------- */
    const names = [...db.objectStoreNames].sort();
    eq(names, ['areas','meta','payments','rooms','tenancies'], '五本账本都建好了');
    const roomStore = db.transaction('rooms').objectStore('rooms');
    eq([...roomStore.indexNames].sort(), ['areaId'], 'rooms 上的索引对');
    const payStore = db.transaction('payments').objectStore('payments');
    eq([...payStore.indexNames].sort(), ['roomId','room_month'], 'payments 上的索引对');

    return results;
  })();
})();
`;

// 真正跑起来
eval(appScript + TEST);

const results = await globalThis.__runTests;

const failed = results.filter(r => !r.ok);
const width = Math.max(...results.map(r => r.label.length), 10);
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'} ${r.label.padEnd(width)}${r.detail ? '  ← ' + r.detail : ''}`);
}
console.log('\n' + '─'.repeat(60));
if (failed.length === 0) {
  console.log(`🎉 全部通过（${results.length} 项）`);
  process.exit(0);
} else {
  console.log(`❌ 失败 ${failed.length} 项，通过 ${results.length - failed.length} 项`);
  process.exit(1);
}
