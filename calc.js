/* ==========================================================================
   算账的大脑 —— 纯计算，不碰界面、不碰数据库
   --------------------------------------------------------------------------
   为什么单独放一个文件？
     这样它能被自动测试（tests/calc.test.mjs），而不只是靠人在手机上点。
     CLAUDE.md 第 13 章的规矩：「算错不可接受」唯一的工程手段就是这些测试。

   两条铁律（踩过坑，别改回去）：
     1. 日期一律用字符串 'YYYY-MM-DD' / 'YYYY-MM'，绝不用 Date 对象存。
        UTC 转换会让月初的账落到上个月。
     2. 金额一律先转成「分」做整数运算再求和。
        否则会出现 ¥12,345.670000000002 这种让房东失去信任的数字。
   ========================================================================== */

/* ==========================================================================
   [SECTION: 日期工具]
   ========================================================================== */

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 今天，如 '2026-09-10'。用本地时间，不经 UTC。 */
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** 当前月份，如 '2026-09' */
function currentMonth(today) {
  return (today || todayStr()).slice(0, 7);
}

/** 从 '2026-09-10' 取 '2026-09' */
function ymOf(dateStr) {
  return typeof dateStr === 'string' ? dateStr.slice(0, 7) : '';
}

/** 某个月有多少天。daysInMonth('2026-02') → 28 */
function daysInMonth(ym) {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  if (!y || !m || m < 1 || m > 12) return 0;
  return new Date(y, m, 0).getDate();   // 下个月的第 0 天 = 这个月最后一天
}

/** 月份加减。addMonths('2026-01', -1) → '2025-12' */
function addMonths(ym, n) {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const total = y * 12 + (m - 1) + n;
  return Math.floor(total / 12) + '-' + pad2((total % 12 + 12) % 12 + 1);
}

/** 是不是合法的 'YYYY-MM-DD' 且真实存在（会挡掉 2026-02-30） */
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const ym = s.slice(0, 7);
  const d = Number(s.slice(8, 10));
  return d >= 1 && d <= daysInMonth(ym);
}

/** 是不是合法的 'YYYY-MM' */
function isValidMonth(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}$/.test(s)) return false;
  const m = Number(s.slice(5, 7));
  return m >= 1 && m <= 12;
}

/** 日期加减天数。addDays('2026-09-30', 1) → '2026-10-01'（会自动跨月跨年） */
function addDays(dateStr, n) {
  if (!isValidDate(dateStr)) return dateStr;
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(5, 7));
  const d = Number(dateStr.slice(8, 10));
  const dt = new Date(y, m - 1, d + n);   // 用本地时间构造，Date 会自动处理跨月
  return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
}

/**
 * 时间戳 → 日期字符串。
 * 注意要用本地时间取年月日，不能用 toISOString()（那是 UTC，会差一天）。
 */
function dateOfTimestamp(ts) {
  if (ts === null || ts === undefined || ts === '') return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** 显示用月份名。'2026-09' → '2026年9月' */
function monthLabel(ym) {
  if (!isValidMonth(ym)) return String(ym || '');
  return ym.slice(0, 4) + '年' + Number(ym.slice(5, 7)) + '月';
}

/** 生成从 startYm 到 endYm（含）的所有月份 */
function monthRange(startYm, endYm) {
  const out = [];
  if (!isValidMonth(startYm) || !isValidMonth(endYm)) return out;
  let cur = startYm;
  let guard = 0;
  while (cur <= endYm && guard++ < 1200) {   // guard 防止参数写错时死循环
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}

/* ==========================================================================
   [SECTION: 金额工具]
   存储用「元」，算账一律转「分」。
   ========================================================================== */

/** 元 → 分。toFen(1200.5) → 120050 */
function toFen(yuan) {
  const n = Number(yuan);
  if (!isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** 分 → 元。toYuan(120050) → 1200.5 */
function toYuan(fen) {
  return Math.round(fen) / 100;
}

/** 显示用：1500 → '¥1,500'；1200.5 → '¥1,200.5' */
function fmtYuan(yuan) {
  return '¥' + toYuan(toFen(yuan)).toLocaleString('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

/* ==========================================================================
   [SECTION: 租约]
   一份租约覆盖一段时间：从 startDate 到 endedAt（都含当天）。
   endedAt 为空 = 还在租。
   ========================================================================== */

/** 这份租约在 date 这天是否有效 */
function leaseCoversDay(t, date) {
  if (!t || !t.startDate) return false;
  if (date < t.startDate) return false;
  if (t.endedAt && date > t.endedAt) return false;   // 退租当天还算在租
  return true;
}

/** 这个月有多少天被租约覆盖 */
function coveredDaysInMonth(tenancies, ym) {
  const dim = daysInMonth(ym);
  let n = 0;
  for (let d = 1; d <= dim; d++) {
    const date = ym + '-' + pad2(d);
    if (tenancies.some(t => leaseCoversDay(t, date))) n++;
  }
  return n;
}

/** 这个月租出去了吗（哪怕只有一天） */
function isRentedInMonth(tenancies, ym) {
  return coveredDaysInMonth(tenancies, ym) > 0;
}

/** 这个月最后一份生效的租约（同月换租客时，按最后那份算） */
function activeLeaseInMonth(tenancies, ym) {
  let best = null;
  for (const t of tenancies) {
    if (!isRentedInMonth([t], ym)) continue;
    if (!best || t.startDate > best.startDate) best = t;
  }
  return best;
}

/** 这个月的月租金（同月换租客只算一次，取最后那份） */
function rentOfLastActiveLeaseInMonth(tenancies, ym) {
  const t = activeLeaseInMonth(tenancies, ym);
  return t ? Number(t.monthlyRent) || 0 : 0;
}

/** 这个月在租的话，租客是谁（列表显示用） */
function tenantOfMonth(tenancies, ym) {
  const t = activeLeaseInMonth(tenancies, ym);
  return t ? { name: t.tenantName || '', phone: t.tenantPhone || '' } : { name: '', phone: '' };
}

/* ==========================================================================
   [SECTION: 收租日与收款状态]
   ========================================================================== */

/**
 * 这个月应该哪天收租。
 * 规则：
 *   - 房间自己设了就用房间的，否则用区域的，再否则用全局默认（5 号）
 *   - 设了 31 号但小月只有 30 天 → 自动提前到该月最后一天（2 月自动 28/29）
 *   - 新租客当月入住 → 提醒日不早于起租日（8月5日不会误报"未交租"）
 */
function effectiveDueDate(room, tenancies, ym, defaults) {
  const d0 = defaults || {};
  const day = Number(
    (room && room.rentDueDay) ||
    d0.rentDueDay ||
    5
  );
  const dim = daysInMonth(ym);
  if (!dim) return ym + '-01';
  const safeDay = Math.max(1, Math.min(day || 5, dim));
  let due = ym + '-' + pad2(safeDay);

  const lease = activeLeaseInMonth(tenancies, ym);
  if (lease && ymOf(lease.startDate) === ym && lease.startDate > due) {
    due = lease.startDate;
  }
  return due;
}

/**
 * 这间房这个月的收款状态。
 * 'vacant'   没租出去（不提收租的事）
 * 'paid'     已确认收到
 * 'future'   还没到的月份
 * 'overdue'  过了收租日还没确认（高亮提醒）
 * 'dueToday' 收租日就是今天
 * 'pending'  还没到收租日
 */
function roomMonthState(opts) {
  const { tenancies = [], hasPayment = false, room, ym, today, defaults } = opts;

  if (!isRentedInMonth(tenancies, ym)) return 'vacant';
  if (hasPayment) return 'paid';

  const cm = currentMonth(today);
  if (ym > cm) return 'future';
  if (ym < cm) return 'overdue';

  const due = effectiveDueDate(room, tenancies, ym, defaults);
  if (today > due) return 'overdue';
  if (today === due) return 'dueToday';
  return 'pending';
}

/* ==========================================================================
   [SECTION: 空置损失（机会成本）]
   注意：这不是支出，也不会从收入里扣。只是让你知道房子空着亏了多少。
   按天折算，且只算到今天 —— 否则"9月20日租出去"会被算成整月空置。
   ========================================================================== */

/** 这个月有几天没人住（只算到 cutoff 那天为止；cutoff 为空则算整月） */
function vacantDaysInMonth(tenancies, ym, cutoff) {
  const dim = daysInMonth(ym);
  let n = 0;
  for (let d = 1; d <= dim; d++) {
    const date = ym + '-' + pad2(d);
    if (cutoff && date > cutoff) break;
    if (!tenancies.some(t => leaseCoversDay(t, date))) n++;
  }
  return n;
}

/** 空置少收的钱（分）。租金按「分」先转好再乘，避免浮点误差 */
function vacantLossFen(monthlyRentYuan, vacantDays, dim) {
  if (!dim || !vacantDays) return 0;
  return Math.round(toFen(monthlyRentYuan) * vacantDays / dim);
}

/**
 * 用哪份租金来估算空置损失。
 * 优先用最近一份租约的租金，没有就用房间自己填的租金。
 */
function referenceRent(tenancies, room, ym) {
  let best = null;
  for (const t of tenancies) {
    if (t.startDate && t.startDate.slice(0, 7) <= ym) {
      if (!best || t.startDate > best.startDate) best = t;
    }
  }
  if (best) return Number(best.monthlyRent) || 0;
  return Number(room && room.rent) || 0;
}

/* ==========================================================================
   [SECTION: 汇总]
   ========================================================================== */

/** 一组金额（元）求和，先在「分」域加完再转回来 */
function sumYuan(list) {
  let fen = 0;
  for (const v of list) fen += toFen(v);
  return toYuan(fen);
}

/* ==========================================================================
   [SECTION: 导出（给 Node 测试用；浏览器里这些函数是全局的）]
   ========================================================================== */
/* istanbul ignore else */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    pad2, todayStr, currentMonth, ymOf, daysInMonth, addMonths, addDays,
    isValidDate, isValidMonth, monthRange, monthLabel, dateOfTimestamp,
    toFen, toYuan, fmtYuan, sumYuan,
    leaseCoversDay, coveredDaysInMonth, isRentedInMonth,
    activeLeaseInMonth, rentOfLastActiveLeaseInMonth, tenantOfMonth,
    effectiveDueDate, roomMonthState,
    vacantDaysInMonth, vacantLossFen, referenceRent,
  };
}
