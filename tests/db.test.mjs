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
Object.assign(globalThis, require(join(ROOT, 'export.js')));

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
    // 哨兵标记：只在"真的存过数据"时才打。
    // 这样房东主动清空数据后重启，不会误报"数据读不到了"
    eq(localStorage.getItem('lz_hadData'), null,
       '刚打开还没有数据 → 不打「曾经有数据」的标记（避免清空后误报数据丢失）');

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

    /* ---------- 10. 登记租客 ---------- */
    const today = todayStr();

    const R = state.rooms.find(r => r.no === '101');
    truthy(R, '找到 101 房');

    eq(isRentedNow(R), false, '登记租客前：101 是「未租」');
    eq(monthStateOf(R, currentMonth()), 'vacant', '登记租客前：状态是空置');

    // 起租日设成 40 天前，确保「现在」确实在租期内（不受今天是几号影响）
    const earlier = addDays(today, -40);
    const leaseA = await createTenancy(R, {
      tenantName: '张三', tenantPhone: '13800001111',
      monthlyRent: 1200, deposit: 2400,
      startDate: earlier, plannedEndDate: '',
    });
    eq(isRentedNow(R), true, '登记租客后：101 变成「已租」');
    truthy(monthStateOf(R, currentMonth()) !== 'vacant', '登记租客后：不再显示空置');
    eq(tenantOfMonth(tenanciesOf(R.id), currentMonth()).name, '张三', '这个月显示租客张三');

    /* ---------- 11. 租约不能重叠（否则天数会算重） ---------- */
    truthy(tenancyConflict(R.id, addDays(today, -10), null, null),
      '同一间房登记两份重叠的租约 → 会被告警拦住');
    eq(tenancyConflict(R.id, addDays(today, -10), null, leaseA.id), null,
      '改自己那份租约时，不会跟自己撞上');
    eq(tenancyConflict(R.id, addDays(earlier, -100), addDays(earlier, -1), null), null,
      '完全不重叠的租约（在它之前）→ 不告警');

    /* ---------- 12. 确认收租 ---------- */
    const ymNow = currentMonth();
    eq(isPaidInMonth(R.id, ymNow), false, '收租前：本月没有收款记录');

    const pay = await createPayment(R, { month: ymNow, amount: 1200, payDate: ymNow + '-03' });
    eq(isPaidInMonth(R.id, ymNow), true, '确认收租后：本月有记录了');
    eq(pay.amount, 1200, '实收金额 1200');
    eq(pay.expected, 1200, '同时记下了"当月的租金"以便事后核对');
    eq(pay.tenancyId, leaseA.id, '记录里记下了当时是哪个租客租的');

    // 租客少给钱的情况
    const R2 = state.rooms.find(r => r.no === '102');
    await createTenancy(R2, {
      tenantName: '李四', tenantPhone: '', monthlyRent: 1000, deposit: 2000,
      startDate: earlier, plannedEndDate: '',
    });
    const pay2 = await createPayment(R2, { month: ymNow, amount: 800, payDate: ymNow + '-06' });
    eq(pay2.amount, 800, '租客少给钱：实收如实记 800');
    eq(pay2.expected, 1000, '同时记下当月租金本来是 1000');
    truthy(toFen(pay2.amount) !== toFen(pay2.expected), '实收 ≠ 应收，这个差异能被查出来');

    // 收入统计就是把这些实收加起来
    const incomeNow = sumYuan(state.payments.filter(p => p.month === ymNow).map(p => p.amount));
    eq(incomeNow, 2000, '本月实际收到 = 1200 + 800 = 2000（按实收算，不是应收的 2200）');

    /* ---------- 13. 撤销收款 ---------- */
    const payCountBefore = paymentsOf(R.id).length;
    await deletePayment(pay);
    eq(paymentsOf(R.id).length, payCountBefore - 1, '撤销后：收款记录少了一条');
    eq(isPaidInMonth(R.id, ymNow), false, '撤销后：这间房变回「未收」');
    eq(await dbGet('payments', pay.id), undefined, '撤销是彻底删掉记录（这样还能重新记）');

    const payAgain = await createPayment(R, { month: ymNow, amount: 1200, payDate: ymNow + '-03' });
    eq(isPaidInMonth(R.id, ymNow), true, '撤销之后可以重新记一遍');

    /* ---------- 14. 办退租 ---------- */
    const yesterday = addDays(today, -1);
    await endTenancy(leaseA, yesterday);
    eq(leaseCoversDay(tenancyById(leaseA.id), yesterday), true, '退租当天：还算在租');
    eq(leaseCoversDay(tenancyById(leaseA.id), today), false, '退租第二天：不算了');
    eq(isRentedNow(R), false, '办退租后：101 变回「未租」');
    eq(tenancyById(leaseA.id).tenantName, '张三', '退租后：租客信息没有被抹掉，历史查得到');

    /* ---------- 15. 换租客，历史不覆盖 ---------- */
    const newStart = today;
    await createTenancy(R, {
      tenantName: '王五', tenantPhone: '13900002222',
      monthlyRent: 1300, deposit: 2600,
      startDate: newStart, plannedEndDate: '',
    });
    eq(tenanciesOf(R.id).length, 2, '换租客后：这间房有 2 份租约（不是覆盖成 1 份）');
    eq(isRentedNow(R), true, '换租客后：又变回「已租」');
    eq(tenantOfMonth(tenanciesOf(R.id), currentMonth()).name, '王五', '现在显示新租客王五');
    truthy(tenanciesOf(R.id).some(t => t.tenantName === '张三'),
      '张三那份租约还在（去年的账还查得到）');

    /* ---------- 16. 全部重启一次，看数据还在不在 ---------- */
    db.close();
    state.areas = []; state.rooms = []; state.tenancies = []; state.payments = [];
    state.loaded = false;
    db = await openDB();
    await loadAll();

    eq(state.tenancies.length, 3, '重启后：3 份租约都在（张三、李四、王五）');
    truthy(isPaidInMonth(R.id, ymNow), '重启后：101 本月「已收」状态还在');
    const R3 = state.rooms.find(r => r.no === '101');
    eq(isRentedNow(R3), true, '重启后：101 依然是「已租」');
    eq(tenantOfMonth(tenanciesOf(R3.id), currentMonth()).name, '王五', '重启后：租客还是王五');
    eq(sumYuan(state.payments.filter(p => p.month === ymNow).map(p => p.amount)), 2000,
       '重启后：本月实收还是 2000');

    /* ---------- 17. 统计（最容易算错的地方，用可控场景验证） ---------- */
    // 先把当前状态收起来，跑完再放回去
    const keep = {
      areas: state.areas, rooms: state.rooms,
      tenancies: state.tenancies, payments: state.payments,
      settings: { ...state.settings },
    };

    // 造一个干净场景：屋主从 2019 年就有这两间房
    // 用一个已经过完的年份（2020），这样不受"今天是几号"影响
    const Y = '2020';
    const owned = new Date(2019, 0, 1).getTime();

    state.areas = [{ id:'ta', name:'测试区', order:1, rentDueDay:null,
                     isDeleted:false, createdAt:owned, updatedAt:owned }];
    state.rooms = [
      { id:'tr1', areaId:'ta', no:'101', rent:1200, rentDueDay:null, deposit:0,
        isDeleted:false, createdAt:owned, updatedAt:owned },
      { id:'tr2', areaId:'ta', no:'102', rent:1000, rentDueDay:null, deposit:0,
        isDeleted:false, createdAt:owned, updatedAt:owned },
    ];
    state.tenancies = [{
      id:'tt1', roomId:'tr1', tenantName:'张三', tenantPhone:'',
      monthlyRent:1200, deposit:0, startDate:'2019-01-01', plannedEndDate:'',
      endedAt:null, isDeleted:false,
    }];
    // 101 整年出租，但只有 1~3 月确认收到了钱
    state.payments = ['01','02','03'].map(m => ({
      id:'tp'+m, roomId:'tr1', tenancyId:'tt1', month: Y+'-'+m,
      amount:1200, expected:1200, payDate: Y+'-'+m+'-03', createdAt:owned,
    }));
    state.settings.defaultRentDueDay = 5;

    const S = statsForYear(Y);
    const row = (m) => S.rows.find(r => r.ym === Y + '-' + m);

    eq(S.totalReceivedFen, toFen(3600), '统计：整年实收 = 3个月 × 1200 = ¥3,600');
    eq(row('01').receivedFen, toFen(1200), '统计：1月收到 ¥1,200');
    eq(row('04').receivedFen, 0, '统计：4月没收到钱 → 0');

    eq(S.totalUnpaidCount, 9, '统计：101 有 9 个月没收（4月~12月）');
    eq(S.totalUnpaidFen, toFen(9 * 1200), '统计：这 9 个月合计 ¥10,800');

    eq(S.totalVacantFen, toFen(12 * 1000), '统计：102 整年空置 = 12 × 1000 = ¥12,000');

    // ★ 三个数字必须互相独立
    eq(S.totalReceivedFen, toFen(3600),
       '★ 空置损失没有混进"实际收到"（还是 3600，不是 3600-12000）');
    truthy(S.totalReceivedFen !== S.totalUnpaidFen
        && S.totalUnpaidFen !== S.totalVacantFen
        && S.totalReceivedFen !== S.totalVacantFen,
       '★ 三个数字各不相同 → 确实不能相加相减');

    // 未来的年份不预估
    const FUT = statsForYear('2099');
    eq(FUT.totalReceivedFen, 0, '统计：未来的年份不预估收入');
    eq(FUT.totalVacantFen, 0, '统计：未来的年份不预估空置损失');
    eq(FUT.totalUnpaidCount, 0, '统计：未来的年份不预告欠租');

    // 空置只从"房间被加进 App 那天"开始算，不会凭空补出历史空置
    state.rooms[1].createdAt = new Date(2020, 5, 1).getTime();   // 102 改成 6 月才加进来
    const S2 = statsForYear(Y);
    eq(S2.totalVacantFen, toFen(7 * 1000),
       '统计：102 是 6 月才加进 App 的 → 只算 6~12 月共 7 个月空置');

    // 把状态放回去
    state.areas = keep.areas;
    state.rooms = keep.rooms;
    state.tenancies = keep.tenancies;
    state.payments = keep.payments;
    state.settings = keep.settings;

    /* ---------- 18. 几个界面函数能不能正常打开（冒烟测试） ---------- */
    for (const [name, fn] of [
      ['统计面板',     () => sheetStats()],
      ['设置面板',     () => sheetSettings()],
      ['管理区域面板', () => sheetManageAreas()],
      ['批量建房面板', () => sheetBatchRooms()],
      ['新建区域面板', () => sheetNewArea()],
      ['导出 Excel 面板', () => sheetExportExcel()],
      ['清空数据面板', () => sheetWipeAll()],
    ]) {
      try { fn(); results.push({ ok: true, label: '界面：' + name + '能正常打开（不崩）', detail: '' }); }
      catch (e) { results.push({ ok: false, label: '界面：' + name + '打开时报错', detail: e.message }); }
      closeSheet();
    }

    // 房间详情 + 各种子弹窗
    const anyRoom = state.rooms[0];
    for (const [name, fn] of [
      ['房间详情',   () => sheetEditRoom(anyRoom)],
      ['登记租客',   () => sheetTenancy(anyRoom, null)],
      ['收租记录',   () => sheetPayHistory(anyRoom)],
      ['历届租客',   () => sheetTenancyHistory(anyRoom)],
      ['新建房间',   () => sheetNewRoom()],
    ]) {
      try { fn(); results.push({ ok: true, label: '界面：' + name + '能正常打开（不崩）', detail: '' }); }
      catch (e) { results.push({ ok: false, label: '界面：' + name + '打开时报错', detail: e.message }); }
      closeSheet();
    }

    /* ---------- 19. 备份与恢复 ---------- */
    const dbCounts = {
      areas:     (await dbGetAll('areas')).length,
      rooms:     (await dbGetAll('rooms')).length,
      tenancies: (await dbGetAll('tenancies')).length,
      payments:  (await dbGetAll('payments')).length,
    };
    const visibleBefore = {
      areas: state.areas.length, rooms: state.rooms.length,
      tenancies: state.tenancies.length, payments: state.payments.length,
    };

    // 用指纹比对内容，而不只是比数量
    const fingerprint = () => JSON.stringify({
      areas:     state.areas.map(a => [a.id, a.name, a.order]).sort(),
      rooms:     state.rooms.map(r => [r.id, r.areaId, r.no, r.rent, r.deposit, r.rentDueDay]).sort(),
      tenancies: state.tenancies.map(t => [t.id, t.roomId, t.tenantName, t.startDate, t.endedAt, t.monthlyRent]).sort(),
      payments:  state.payments.map(p => [p.id, p.roomId, p.month, p.amount, p.payDate]).sort(),
    });
    const printBefore = fingerprint();

    const backup = await buildBackup();
    eq(backup.app, '房东记账', '备份：文件里写了 App 名字（用来认领）');
    eq(backup.formatVersion, 1, '备份：有格式版本号');
    eq(backup.counts.rooms, dbCounts.rooms, '备份：记下了房间条数');
    truthy(backup.exportedAtLocal, '备份：记下了导出时间（' + backup.exportedAtLocal + '）');
    eq(backup.data.rooms.length, dbCounts.rooms,
       '备份：包含全部房间记录（含回收站里的，这样恢复才完整）');
    eq(backup.data.payments.length, dbCounts.payments, '备份：收款记录全都装进去了');

    /* —— 校验：正常文件要能通过 —— */
    truthy(validateBackup(JSON.parse(JSON.stringify(backup))).ok, '校验：正常的备份文件能通过');

    /* —— 校验：坏文件必须被拒绝（宁可拒绝，也不要猜着导入）—— */
    eq(validateBackup(null).ok, false, '校验：空文件 → 拒绝');
    eq(validateBackup({}).ok, false, '校验：随便一个 JSON → 拒绝');
    eq(validateBackup({ app:'别的App', formatVersion:1, data:{} }).ok, false,
       '校验：别的 App 的备份 → 拒绝');
    eq(validateBackup({ app:'房东记账', formatVersion:99,
                        data:{areas:[],rooms:[],tenancies:[],payments:[]} }).ok, false,
       '校验：来自更新版本的备份 → 拒绝（提示先更新 App）');
    eq(validateBackup({ app:'房东记账', formatVersion:1,
                        data:{areas:[],rooms:[],tenancies:[]} }).ok, false,
       '校验：缺了一张表 → 拒绝');

    const tampered = JSON.parse(JSON.stringify(backup));
    tampered.counts.rooms = 999;
    eq(validateBackup(tampered).ok, false,
       '★ 校验：条数对不上 → 拒绝（防止半截数据被悄悄导进来）');

    /* —— ★★ 核心：导出 → 清空 → 恢复 → 必须一模一样 —— */
    await replaceAllData({ areas: [], rooms: [], tenancies: [], payments: [], meta: [] });
    await loadAll();
    eq(state.rooms.length, 0, '清空后：房间没了');
    eq(state.areas.length, 0, '清空后：区域也没了');

    const reloaded = JSON.parse(JSON.stringify(backup));   // 模拟"从文件重新读出来"
    truthy(validateBackup(reloaded).ok, '恢复前：文件校验通过');
    await replaceAllData(reloaded.data);
    await loadAll();

    eq(state.rooms.length, visibleBefore.rooms, '★ 恢复后：房间数量一模一样');
    eq(state.areas.length, visibleBefore.areas, '★ 恢复后：区域数量一模一样');
    eq(state.tenancies.length, visibleBefore.tenancies, '★ 恢复后：租约数量一模一样');
    eq(state.payments.length, visibleBefore.payments, '★ 恢复后：收款记录一模一样');
    eq(fingerprint(), printBefore,
       '★★ 恢复后：每一间房、每一个租客、每一笔收款的内容都完全相同');

    // 恢复后业务逻辑还是对的（不只是数据在，还要能正常算）
    const R4 = state.rooms.find(r => r.no === '101');
    truthy(R4, '恢复后：能找到 101');
    eq(isRentedNow(R4), true, '恢复后：101 依然是「已租」');
    eq(tenantOfMonth(tenanciesOf(R4.id), currentMonth()).name, '王五', '恢复后：租客还是王五');
    truthy(isPaidInMonth(R4.id, currentMonth()), '恢复后：本月「已收」状态还在');
    eq(statsForYear(currentMonth().slice(0, 4)).totalReceivedFen,
       toFen(sumYuan(state.payments.filter(p => p.month === currentMonth()).map(p => p.amount))),
       '恢复后：统计算出来的收入和收款记录对得上');

    /* ---------- 20. 数据库结构对不对 ---------- */
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
