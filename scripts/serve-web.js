/**
 * serve-web.js -- 静态门户服务器 + /api 反向代理
 *   node scripts/serve-web.js [port]       默认 8899
 * 网页：http://127.0.0.1:8899
 * 作用：① 把 web/ 目录当静态站点发布（可直接搬到任意静态托管）
 *       ② 把 /api/* 反代到本地网关，避免浏览器跨域问题
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB = path.resolve(__dirname, '..', 'web');
const PORT = Number(process.argv[2] || process.env.WEB_PORT || 8899);
const API_HOST = process.env.API_HOST || '127.0.0.1';
const API_PORT = Number(process.env.API_PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

function proxy(req, res) {
  const opt = {
    host: API_HOST,
    port: API_PORT,
    method: req.method,
    path: req.url,
    headers: Object.assign({}, req.headers, { host: API_HOST + ':' + API_PORT })
  };
  const up = http.request(opt, (ur) => {
    res.writeHead(ur.statusCode || 502, ur.headers);
    ur.pipe(res);
  });
  up.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'upstream unreachable', detail: e.message, hint: '确认网关已启动: scripts\\start-local-windows.ps1' }));
  });
  req.pipe(up);
}

const srv = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);

  if (url.startsWith('/api/') || url === '/v1' || url.startsWith('/v1/')) return proxy(req, res);

  let rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const abs = path.resolve(WEB, rel);
  if (!abs.startsWith(WEB)) { res.writeHead(403); return res.end('forbidden'); }

  fs.readFile(abs, (err, buf) => {
    if (err) {
      // 目录 -> index.html
      const idx = path.join(abs, 'index.html');
      if (!err.code && fs.existsSync(idx)) return fs.createReadStream(idx).pipe(res);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 ' + url);
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

srv.listen(PORT, () => {
  console.log('[serve-web] portal  http://127.0.0.1:' + PORT + '   (static root: ' + WEB + ')');
  console.log('[serve-web] proxy   /api/*  /v1/*  ->  http://' + API_HOST + ':' + API_PORT);
});