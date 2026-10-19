// 工坊的入口：一个零依赖的 HTTP 服务。
//   /            前端（web/dist，先 pnpm build）
//   /health      不要钥匙，只回 { ok }，给"连得上吗"用
//   /api/hello   要钥匙：可选的模型、claude 找没找到
//   /term/*      要钥匙：全交给 term.mjs
// 钥匙：请求头 Authorization: Bearer <token>，或者 ?token=（<img> 和 EventSource 带不了请求头）。
import { createServer } from 'http';
import { createReadStream, existsSync, statSync } from 'fs';
import { networkInterfaces } from 'os';
import { extname, join, normalize, sep } from 'path';
import { timingSafeEqual } from 'crypto';
import { CFG, CLAUDE_EXE, CLAUDE_PROBLEM, DATA_DIR, ROOT } from './config.mjs';
import { handleTerm } from './term.mjs';

const DIST = join(ROOT, 'web', 'dist');
const VERSION = '1.0.0';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS }); res.end(JSON.stringify(data)); };

const TOKEN = Buffer.from(String(CFG.token));
function authed(req, url) {
  const h = req.headers.authorization || '';
  const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token') || '');
  return got.length === TOKEN.length && timingSafeEqual(got, TOKEN);
}

/** 前端的静态文件。找不到的路径回 index.html（单页） */
function serveStatic(res, pathname) {
  if (!existsSync(join(DIST, 'index.html'))) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('前端还没打包：在项目根目录跑 pnpm install && pnpm build');
  }
  let rel;
  try { rel = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, ''); } catch { rel = ''; }
  let file = join(DIST, rel);
  if (!file.startsWith(DIST + sep) || !existsSync(file) || !statSync(file).isFile()) file = join(DIST, 'index.html');
  const ext = extname(file).toLowerCase();
  // 打包出来的 assets 带哈希，可以久存；index.html 每次都要新的，不然升级后手机上还是旧页面
  const cache = file.includes(sep + 'assets' + sep) ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (path === '/health') return json(res, { ok: true, app: 'gongfang' });
    if (path === '/api/hello' || path.startsWith('/term/')) {
      if (!authed(req, url)) return json(res, { error: '钥匙不对' }, 401);
      if (path === '/api/hello') {
        return json(res, { ok: true, version: VERSION, models: Array.isArray(CFG.claude?.models) ? CFG.claude.models : [], ...(CLAUDE_PROBLEM ? { problem: CLAUDE_PROBLEM } : {}) });
      }
      return await handleTerm(req, res, url);
    }
    if (req.method === 'GET') return serveStatic(res, path);
    json(res, { error: 'not found' }, 404);
  } catch (e) {
    console.error('[server]', e);
    if (!res.headersSent) json(res, { error: '服务器出错了：' + (e.message || e) }, 500);
    else res.end();
  }
});

server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `端口 ${CFG.port} 被占了，在 config.json 里换一个 port` : e);
  process.exit(1);
});

server.listen(CFG.port, CFG.host, () => {
  const local = CFG.host === '0.0.0.0' || CFG.host === '::';
  const hosts = local
    ? ['127.0.0.1', ...Object.values(networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address)]
    : [CFG.host];
  console.log(`\n  工坊 ${VERSION} 开着了\n`);
  for (const h of hosts) console.log(`  http://${h}:${CFG.port}/?token=${encodeURIComponent(CFG.token)}`);
  console.log(`\n  手机和电脑在同一个网络（或同一个 Tailscale）里，点上面任意一个地址就能用。`);
  console.log(`  这串钥匙等于这台电脑的操作权限，别发给别人、别把端口开到公网上。\n`);
  console.log(`  claude: ${CLAUDE_EXE}`);
  console.log(`  数据:   ${DATA_DIR}`);
  if (CLAUDE_PROBLEM) console.log(`\n  [!] ${CLAUDE_PROBLEM}`);
  console.log('');
});
