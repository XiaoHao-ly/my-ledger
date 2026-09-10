/* ==========================================================================
   算账大脑的自动测试
   --------------------------------------------------------------------------
   怎么跑：node tests/calc.test.mjs
   全绿才允许上线。CLAUDE.md 第 13 章：「算错不可接受」。

   这里专门盯着最容易出错的边界：
   月末月初、2月28/29、收租日31号、月中入住、月中退租、同月换租客、
   金额小数累加、未来的日子不算空置。
   ========================================================================== */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const C = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'calc.js'));

/* ---------- 极简测试框架 ---------- */
let pass = 0, fail = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { pass++; }
  else { fail++; failures.push(`${label}\n     期望 ${b}\n     实际 ${a}`); }
}

function section(name) { console.log(`\n── ${name} ──`); }

/* ---------- 造一份租约 ---------- */
const lease = (o) => ({
  id: 't1', roomId: 'r1', tenantName: '张三', tenantPhone: '138',
  monthlyRent: 1200, deposit: 2400,
  startDate: '2026-01-01', plannedEndDate: '', endedAt: null,
  ...o,
});

/* ==========================================================================
   1. 日期工具
   ========================================================================== */
section('日期工具');

eq(C.daysInMonth('2026-02'), 28, '2026年2月有28天（平年）');
eq(C.daysInMonth('2028-02'), 29, '2028年2月有29天（闰年）');
eq(C.daysInMonth('2026-09'), 30, '9月有30天');
eq(C.daysInMonth('2026-01'), 31, '1月有31天');
eq(C.daysInMonth('2026-13'), 0,  '非法月份返回0，不崩');

eq(C.addMonths('2026-01', -1), '2025-12', '1月往前一个月 → 去年12月（跨年）');
eq(C.addMonths('2026-12', 1),  '2027-01', '12月往后一个月 → 明年1月（跨年）');
eq(C.addMonths('2026-03', -3), '2025-12', '3月往前三个月 → 去年12月');
eq(C.addMonths('2026-05', 12), '2027-05', '往后一年');

eq(C.isValidDate('2026-02-28'), true,  '2026-02-28 合法');
eq(C.isValidDate('2026-02-29'), false, '2026-02-29 不存在（平年）');
eq(C.isValidDate('2028-02-29'), true,  '2028-02-29 合法（闰年）');
eq(C.isValidDate('2026-04-31'), false, '4月没有31号');
eq(C.isValidDate('2026-9-1'),   false, '月份没补零 → 不合法');
eq(C.isValidDate(''),           false, '空字符串不合法');

eq(C.monthRange('2026-11', '2027-02'), ['2026-11','2026-12','2027-01','2027-02'], '跨年月份区间');
eq(C.monthRange('2026-09', '2026-09'), ['2026-09'], '只有一个月');

/* ==========================================================================
   2. 金额精度（房东最容易被"零头"吓到）
   ========================================================================== */
section('金额精度');

eq(C.toFen(1200),    120000, '1200元 = 120000分');
eq(C.toFen(1200.5),  120050, '1200.5元 = 120050分');
eq(C.toFen(0.1) + C.toFen(0.2), 30, '0.1元+0.2元 = 30分（不是 30.000000000000004）');

eq(C.sumYuan([0.1, 0.2]), 0.3, '小数相加不出零头');
eq(C.sumYuan(Array(10).fill(0.1)), 1, '10个0.1元 = 正好1元');
eq(C.sumYuan([1200, 1000.5, 800]), 3000.5, '正常求和');
eq(C.sumYuan([]), 0, '空数组 = 0');

eq(C.fmtYuan(1200),    '¥1,200',   '格式化 1200');
eq(C.fmtYuan(1200.5),  '¥1,200.5', '格式化 1200.5');
eq(C.fmtYuan(0),       '¥0',       '格式化 0');

/* ==========================================================================
   3. 租约覆盖（endedAt 那天还算在租）
   ========================================================================== */
section('租约覆盖');

const t1 = lease({ startDate: '2026-03-01', endedAt: null });
eq(C.leaseCoversDay(t1, '2026-02-28'), false, '起租前一天：不算在租');
eq(C.leaseCoversDay(t1, '2026-03-01'), true,  '起租当天：算在租');
eq(C.leaseCoversDay(t1, '2026-09-10'), true,  '还在租');

const t2 = lease({ startDate: '2026-03-01', endedAt: '2026-09-15' });
eq(C.leaseCoversDay(t2, '2026-09-15'), true,  '退租当天：还算在租（房东直觉）');
eq(C.leaseCoversDay(t2, '2026-09-16'), false, '退租第二天：不算了');

/* ==========================================================================
   4. 一个月租了几天
   ========================================================================== */
section('覆盖天数');

eq(C.coveredDaysInMonth([lease({ startDate: '2026-01-01' })], '2026-09'), 30, '整月都租着 = 30天');
eq(C.coveredDaysInMonth([], '2026-09'), 0, '没有租约 = 0天');
eq(C.coveredDaysInMonth([lease({ startDate: '2026-09-20' })], '2026-09'),
   11, '9月20日入住 → 覆盖 20~30 共11天');
eq(C.coveredDaysInMonth([lease({ startDate: '2026-01-01', endedAt: '2026-09-15' })], '2026-09'),
   15, '9月15日退租 → 覆盖 1~15 共15天');

// 同月换租客，中间没有空档（两人姓名和租金都不同，方便区分）
const handover = [
  lease({ id:'a', tenantName:'张三', startDate:'2026-01-01', endedAt:'2026-09-15', monthlyRent:1000 }),
  lease({ id:'b', tenantName:'李四', startDate:'2026-09-16', endedAt:null,          monthlyRent:1200 }),
];
eq(C.coveredDaysInMonth(handover, '2026-09'), 30, '15日退租、16日入住 → 整月无空档');
eq(C.vacantDaysInMonth(handover, '2026-09', null), 0, '同上：空置 0 天');

// 中间空了 2 天
const gap = [
  lease({ id:'a', startDate:'2026-01-01', endedAt:'2026-09-15', monthlyRent:1000 }),
  lease({ id:'b', startDate:'2026-09-18', endedAt:null,          monthlyRent:1200 }),
];
eq(C.vacantDaysInMonth(gap, '2026-09', null), 2, '15日退租、18日入住 → 中间空 16、17 两天');

/* ==========================================================================
   5. 同月换租客，租金取哪个
   ========================================================================== */
section('同月换租客的租金');

eq(C.rentOfLastActiveLeaseInMonth(handover, '2026-09'), 1200, '取该月最后一份租约的租金（1200）');
eq(C.rentOfLastActiveLeaseInMonth(handover, '2026-08'), 1000, '8月还是张三，租金 1000');
eq(C.rentOfLastActiveLeaseInMonth([], '2026-09'), 0, '没租约 = 0');
eq(C.tenantOfMonth(handover, '2026-09').name, '李四',
   '同月换租客：9月显示最后入住的那位（李四）');
eq(C.tenantOfMonth(handover, '2026-08').name, '张三',
   '8月还是张三');
eq(C.tenantOfMonth(handover, '2026-10').name, '李四',
   '10月延续李四');
eq(C.tenantOfMonth([], '2026-09').name, '',
   '没有租约 → 租客为空，不会崩');

/* ==========================================================================
   6. 收租日（含 31 号被夹取、新租客当月入住）
   ========================================================================== */
section('收租日');

const empty = [];
eq(C.effectiveDueDate({}, empty, '2026-09', {}),                     '2026-09-05', '没设置 = 默认5号');
eq(C.effectiveDueDate({ rentDueDay: 10 }, empty, '2026-09', {}),      '2026-09-10', '房间设10号');
eq(C.effectiveDueDate({}, empty, '2026-09', { rentDueDay: 20 }),      '2026-09-20', '用全局默认20号');
eq(C.effectiveDueDate({ rentDueDay: 31 }, empty, '2026-09', {}),      '2026-09-30', '设31号但9月只有30天 → 提前到30号');
eq(C.effectiveDueDate({ rentDueDay: 31 }, empty, '2026-02', {}),      '2026-02-28', '设31号但2026年2月 → 28号');
eq(C.effectiveDueDate({ rentDueDay: 31 }, empty, '2028-02', {}),      '2028-02-29', '设31号但2028年2月 → 29号（闰年）');
eq(C.effectiveDueDate({ rentDueDay: 30 }, empty, '2026-02', {}),      '2026-02-28', '设30号但2月 → 28号');

// 新租客当月入住
const newTenant = [lease({ startDate: '2026-08-20' })];
eq(C.effectiveDueDate({ rentDueDay: 5 }, newTenant, '2026-08', {}), '2026-08-20',
   '8月20日入住、收租日5号 → 8月的提醒日顺延到20号（8月5日不会误报未交租）');
eq(C.effectiveDueDate({ rentDueDay: 5 }, [lease({ startDate: '2026-08-03' })], '2026-08', {}), '2026-08-05',
   '8月3日入住（早于收租日）→ 还是按5号');
eq(C.effectiveDueDate({ rentDueDay: 5 }, newTenant, '2026-09', {}), '2026-09-05',
   '到了9月就恢复正常收租日');

/* ==========================================================================
   7. 收款状态
   ========================================================================== */
section('收款状态');

const rented = [lease({ startDate: '2026-01-01' })];
const S = (o) => C.roomMonthState({
  tenancies: rented, hasPayment: false, room: { rentDueDay: 5 },
  ym: '2026-09', today: '2026-09-10', defaults: {}, ...o,
});

eq(S({ tenancies: [] }),                              'vacant',    '没租出去 → vacant');
eq(S({ hasPayment: true }),                           'paid',      '已确认收到 → paid（哪怕今天还没到收租日）');
eq(S({ ym: '2026-10' }),                              'future',    '未来的月份 → 不提示');
eq(S({ ym: '2026-08' }),                              'overdue',   '过去的月份没收到 → overdue');
eq(S({ today: '2026-09-04' }),                        'pending',   '今天4号、收租日5号 → 还没到，不催');
eq(S({ today: '2026-09-05' }),                        'dueToday',  '今天就是收租日 → dueToday');
eq(S({ today: '2026-09-06' }),                        'overdue',   '过了收租日 → overdue（进入未交租列表）');
eq(S({ today: '2026-09-05', hasPayment: true }),      'paid',      '收租日当天就收到 → paid');
eq(S({ tenancies: [], hasPayment: true }),            'vacant',    '空置房即使有记录也算空置（数据异常时优先信租约）');

/* ==========================================================================
   8. 空置损失（机会成本）
   ========================================================================== */
section('空置损失');

eq(C.vacantLossFen(1200, 19, 30), 76000, '月租1200、30天的月里空19天 → 760元');
eq(C.vacantLossFen(1200, 30, 30), 120000, '整月空置 → 全额1200元');
eq(C.vacantLossFen(1200, 0, 30),  0, '没空置 → 0');
eq(C.vacantLossFen(0, 19, 30),    0, '租金为0 → 0（不会算出 NaN）');
eq(C.vacantLossFen(1000, 1, 31),  Math.round(100000/31), '1000元、31天的月里空1天 → 取整到分');

// 只算到今天，不预言未来
const vacantRoom = [lease({ startDate: '2026-01-01', endedAt: '2026-08-31' })];
eq(C.vacantDaysInMonth(vacantRoom, '2026-09', '2026-09-10'), 10,
   '9月1日空到现在（9月10日）→ 只算10天，不算整月');
eq(C.vacantDaysInMonth(vacantRoom, '2026-09', '2026-09-30'), 30,
   '到月底再算 → 30天');

eq(C.referenceRent([lease({ startDate:'2026-01-01', monthlyRent:1000 })], { rent: 999 }, '2026-09'), 1000,
   '有历史租约 → 用租约租金（1000），不用房间上填的');
eq(C.referenceRent([], { rent: 888 }, '2026-09'), 888,
   '从没租过 → 用房间上填的租金');

/* ==========================================================================
   9. 一整个真实场景走一遍
   ========================================================================== */
section('真实场景：101房，月租1200，收租日5号');

const room101 = { rentDueDay: 5 };
const tl101 = [
  lease({ id:'1', startDate:'2026-03-01', endedAt:'2026-06-30', monthlyRent:1200 }),
  lease({ id:'2', startDate:'2026-08-20', endedAt:null,          monthlyRent:1200 }),
];

eq(C.coveredDaysInMonth(tl101, '2026-07'), 0,  '7月：整月空着');
eq(C.isRentedInMonth(tl101, '2026-07'), false, '7月：没租出去');
eq(C.vacantDaysInMonth(tl101, '2026-07', null), 31, '7月：空置31天');
eq(C.vacantLossFen(C.referenceRent(tl101, room101, '2026-07'), 31, 31), 120000,
   '7月空置损失 = 1200元');

eq(C.effectiveDueDate(room101, tl101, '2026-08', {}), '2026-08-20',
   '8月：新租客20日入住，提醒日顺延到20号');
eq(C.roomMonthState({ tenancies: tl101, hasPayment:false, room:room101, ym:'2026-08', today:'2026-08-25', defaults:{} }),
   'overdue', '8月25日还没确认 → 未交租');
eq(C.roomMonthState({ tenancies: tl101, hasPayment:true, room:room101, ym:'2026-08', today:'2026-08-25', defaults:{} }),
   'paid', '确认后 → 已收');

eq(C.vacantDaysInMonth(tl101, '2026-09', '2026-09-10'), 0, '9月：一直租着，没空置');

/* ==========================================================================
   结果
   ========================================================================== */
console.log('\n' + '─'.repeat(52));
if (fail === 0) {
  console.log(`🎉 全部通过（${pass} 项）`);
  process.exit(0);
} else {
  console.log(`❌ 失败 ${fail} 项，通过 ${pass} 项\n`);
  failures.forEach(f => console.log('   ✗ ' + f + '\n'));
  process.exit(1);
}
