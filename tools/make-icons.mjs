/* ==========================================================================
   图标生成器 —— 用纯代码画出 App 图标
   --------------------------------------------------------------------------
   为什么要有这个文件？
     房东不会做图。硬要他去下载 Photoshop 或找设计素材是不现实的。
     所以图标直接用代码画出来：一个蓝底 + 白色房子 + 一个 ¥ 符号。

   怎么用？（改完图标设计后跑一次）
     node tools/make-icons.mjs

   生成到 icons/ 目录：
     icon-192.png            安卓桌面图标
     icon-512.png            安卓桌面图标（高清）
     icon-maskable-512.png   安卓"自适应图标"（系统会自己裁形状）
     apple-touch-icon-180.png  苹果手机用

   这个文件【不需要】上传到网上给 App 用，只是开发时的画笔。
   它零外部依赖，只用 Node 自带的 zlib。
   ========================================================================== */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SS = 4;   // 超采样倍数：先在 4 倍大的画布上画，再缩小 → 边缘平滑

/* ==========================================================================
   [SECTION: PNG 编码]
   ========================================================================== */

// CRC32 查表（PNG 每个数据块都要带校验码，算错文件就打不开）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 把 RGBA 像素数据编码成 PNG 文件内容 */
function encodePNG(width, height, rgba) {
  const stride = width * 4;
  // 每行前面要加一个"过滤器"字节，这里统一用 0（不过滤）
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 每通道 8 位
  ihdr[9] = 6;   // 颜色类型 6 = RGBA
  ihdr[10] = 0;  // 压缩方式
  ihdr[11] = 0;  // 过滤方式
  ihdr[12] = 0;  // 不隔行

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ==========================================================================
   [SECTION: 画布与图形]
   逻辑坐标一律按 512×512 来写，实际画布是它的 SS 倍大。
   ========================================================================== */

const canvas = (w, h) => ({ w, h, px: new Uint8ClampedArray(w * h * 4) });

function setPx(c, x, y, [r, g, b, a = 255]) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 4;
  c.px[i] = r; c.px[i + 1] = g; c.px[i + 2] = b; c.px[i + 3] = a;
}

const edge = (a, b, p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);

function fillTriangle(c, p0, p1, p2, colorAt) {
  const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)));
  const maxX = Math.min(c.w - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
  const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)));
  const maxY = Math.min(c.h - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));
  const area = edge(p0, p1, p2);
  if (area === 0) return;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const p = { x: x + 0.5, y: y + 0.5 };
      let w0 = edge(p1, p2, p), w1 = edge(p2, p0, p), w2 = edge(p0, p1, p);
      if (area < 0) { w0 = -w0; w1 = -w1; w2 = -w2; }
      if (w0 >= 0 && w1 >= 0 && w2 >= 0) setPx(c, x, y, colorAt(p.x, p.y));
    }
  }
}

/** 四边形 = 两个三角形拼起来（用来画 ¥ 的斜笔画） */
function fillQuad(c, p0, p1, p2, p3, colorAt) {
  fillTriangle(c, p0, p1, p2, colorAt);
  fillTriangle(c, p0, p2, p3, colorAt);
}

function fillRect(c, x0, y0, x1, y1, colorAt) {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++)
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++)
      setPx(c, x, y, colorAt(x + 0.5, y + 0.5));
}

function fillRoundedRect(c, x0, y0, x1, y1, r, colorAt) {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const px = x + 0.5, py = y + 0.5;
      // 把点夹到"圆角矩形内部的那个小矩形"上，算距离，超过半径就在外面
      const qx = Math.max(x0 + r, Math.min(px, x1 - r));
      const qy = Math.max(y0 + r, Math.min(py, y1 - r));
      const dx = px - qx, dy = py - qy;
      if (dx * dx + dy * dy <= r * r) setPx(c, x, y, colorAt(px, py));
    }
  }
}

/** 把大画布按 SS 倍缩小，得到平滑边缘 */
function downsample(c, outW, outH) {
  const out = new Uint8ClampedArray(outW * outH * 4);
  const n = SS * SS;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * c.w + (x * SS + sx)) * 4;
          // 按 alpha 加权，避免透明区域的黑色渗进边缘
          const al = c.px[i + 3] / 255;
          r += c.px[i] * al; g += c.px[i + 1] * al; b += c.px[i + 2] * al; a += al;
        }
      }
      const o = (y * outW + x) * 4;
      if (a > 0) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; }
      out[o + 3] = (a / n) * 255;
    }
  }
  return out;
}

/* ==========================================================================
   [SECTION: 图标设计]
   想改图标长什么样，改这一节就够了。
   ========================================================================== */

const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const BLUE_TOP = hex('#2f7bf6');
const BLUE_BOT = hex('#1a56d6');
const WHITE    = [255, 255, 255];

/** 背景渐变：从顶部的浅蓝到底部的深蓝 */
function bgAt(y, H) {
  const t = Math.min(1, Math.max(0, y / H));
  return [
    Math.round(BLUE_TOP[0] + (BLUE_BOT[0] - BLUE_TOP[0]) * t),
    Math.round(BLUE_TOP[1] + (BLUE_BOT[1] - BLUE_TOP[1]) * t),
    Math.round(BLUE_TOP[2] + (BLUE_BOT[2] - BLUE_TOP[2]) * t),
    255,
  ];
}

/**
 * 画一个图标
 * @param size      输出尺寸（如 512）
 * @param maskable  true = 安卓自适应图标：背景铺满、内容缩到中间安全区
 * @param radius    非 maskable 时的圆角（逻辑 512 单位）
 */
function drawIcon(size, { maskable = false, radius = 0 } = {}) {
  const W = size * SS;
  const S = W / 512;                    // 逻辑单位 → 像素
  // 自适应图标要求内容落在中间 80% 的圆内，所以把房子缩小
  const k = maskable ? 0.80 : 0.94;

  const c = canvas(W, W);
  const px = (x, y) => ({ x: W / 2 + (x - 256) * S * k, y: W / 2 + (y - 256) * S * k });
  const bg = (_, y) => bgAt(y, W);

  // —— 背景 ——
  if (maskable) {
    fillRect(c, 0, 0, W, W, bg);                       // 铺满，无圆角无透明
  } else {
    fillRoundedRect(c, 0, 0, W, W, radius * S, bg);    // 圆角
  }

  // —— 房子屋顶（三角形）——
  fillTriangle(c, px(256, 116), px(90, 252), px(422, 252), () => WHITE);

  // —— 房子主体（矩形）——
  fillRect(c, px(142, 246).x, px(0, 246).y, px(370, 0).x, px(0, 412).y, () => WHITE);

  // —— ¥ 符号（用背景色"挖"出来，看起来像镂空）——
  //
  //      \   /
  //       \ /
  //        |
  //      ------
  //        |
  //      ------
  //        |
  //
  const w = 19;   // 笔画粗细（逻辑单位）
  const blue = (_, y) => bgAt(y, W);   // 用该处背景色，看起来像镂空

  // 两条斜笔画
  fillQuad(c, px(206, 264), px(206 + w, 264), px(256 + w / 2, 322), px(256 - w / 2, 322), blue);
  fillQuad(c, px(306, 264), px(306 - w, 264), px(256 - w / 2, 322), px(256 + w / 2, 322), blue);

  // 竖笔画
  fillRect(c, px(256 - w / 2, 312).x, px(0, 312).y, px(256 + w / 2, 0).x, px(0, 380).y, blue);

  // 两条横杠
  fillRect(c, px(210, 328).x, px(0, 328).y, px(302, 0).x, px(0, 328 + w).y, blue);
  fillRect(c, px(210, 354).x, px(0, 354).y, px(302, 0).x, px(0, 354 + w).y, blue);

  return encodePNG(size, size, downsample(c, size, size));
}

/* ==========================================================================
   [SECTION: 生成文件]
   ========================================================================== */

const OUT = join(ROOT, 'icons');
mkdirSync(OUT, { recursive: true });

const jobs = [
  ['icon-192.png',            () => drawIcon(192, { radius: 106 })],
  ['icon-512.png',            () => drawIcon(512, { radius: 106 })],
  ['icon-maskable-512.png',   () => drawIcon(512, { maskable: true })],
  ['apple-touch-icon-180.png',() => drawIcon(180, { radius: 0 })],
];

for (const [name, make] of jobs) {
  const buf = make();
  writeFileSync(join(OUT, name), buf);
  console.log(`✅ ${name.padEnd(26)} ${(buf.length / 1024).toFixed(1)} KB`);
}

// 浏览器标签页上的小图标：SVG 版，任意尺寸都清晰
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#2f7bf6"/><stop offset="1" stop-color="#1a56d6"/>
  </linearGradient></defs>
  <rect width="512" height="512" rx="106" fill="url(#g)"/>
  <path d="M256 116 L422 252 L90 252 Z" fill="#fff"/>
  <rect x="142" y="246" width="228" height="166" fill="#fff"/>
  <g stroke="#1a56d6" stroke-width="19" stroke-linecap="butt">
    <path d="M208 264 L256 322 L304 264" fill="none"/>
    <path d="M256 322 L256 380" fill="none"/>
    <path d="M212 328 L300 328" fill="none"/>
    <path d="M212 354 L300 354" fill="none"/>
  </g>
</svg>
`;
writeFileSync(join(OUT, 'favicon.svg'), favicon);
console.log(`✅ favicon.svg                ${(favicon.length / 1024).toFixed(1)} KB`);
