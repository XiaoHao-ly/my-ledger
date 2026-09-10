/* ==========================================================================
   离线小工（Service Worker）
   --------------------------------------------------------------------------
   它是干嘛的？
     浏览器和网络之间的一层"中转站"。App 要什么文件，先经过它。
     有了它，"断网也能打开" 才有可能。

   三条铁律（见 CLAUDE.md 第 13 章）：
     1. 页面和脚本用"先联网、失败再读缓存"，绝不用"先读缓存"。
        否则一旦忘记改版本号，房东会永远卡在旧版本上，而且没人会发现。
     2. 预缓存要一个一个来（allSettled），不能用 addAll。
        任何一个文件 404 都会让整个离线功能装不上，极难排查。
     3. 绝不碰 IndexedDB。数据只由页面写。
        这样"更新 App"永远不会碰到房东的数据。
   ========================================================================== */

const CACHE = 'lz-shell-v5';

const PRECACHE = [
  './',
  './index.html',
  './calc.js',
  './export.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png',
  './icons/favicon.svg',
];

/* ---------- 安装：把要用的文件提前存一份，离线时才有东西可给 ---------- */
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 逐个抓取。任何一个失败都只记录，不影响其他文件。
    const results = await Promise.allSettled(
      PRECACHE.map(u => c.add(new Request(u, { cache: 'reload' })))
    );
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed) console.warn('[离线小工] 有', failed, '个文件没能预先缓存');

    await self.skipWaiting();   // 立即生效，不等用户关掉所有页面
  })());
});

/* ---------- 激活：清掉旧版本留下的缓存 ---------- */
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();  // 立刻接管已有页面
  })());
});

/* ---------- 抓取：决定每个请求走哪条路 ---------- */
async function fetchAndCache(req) {
  const res = await fetch(req);
  if (res && res.ok) {
    const c = await caches.open(CACHE);
    c.put(req, res.clone());
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;

  // 只处理自己网站的文件，别人的一概不管
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;

  // ① 打开页面：先联网拿最新的，断网了再给缓存
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(CACHE);
        c.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('./index.html'))
            || (await caches.match('./'))
            || new Response('打不开，而且没有缓存', {
                 status: 503,
                 headers: { 'Content-Type': 'text/plain; charset=utf-8' },
               });
      }
    })());
    return;
  }

  // ② 图标：几乎不会变，先用缓存的（快）
  if (url.pathname.includes('/icons/')) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try { return await fetchAndCache(req); }
      catch { return new Response('', { status: 504 }); }
    })());
    return;
  }

  // ③ 其他文件（脚本、清单）：先联网拿最新的，失败回退缓存
  e.respondWith((async () => {
    try { return await fetchAndCache(req); }
    catch {
      const hit = await caches.match(req);
      return hit || new Response('', { status: 504 });
    }
  })());
});

/* ---------- 收到页面的指令：立即换成新版本 ---------- */
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
