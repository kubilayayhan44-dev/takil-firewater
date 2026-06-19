// Takıl Dev Server — Lokal HTML + Canlı VPS API proxy
// Kullanım: node dev-server.js
// URL: http://localhost:8765
//
// - /api/* istekleri → https://178-105-90-130.nip.io/api/*
// - Diğer her şey → lokaldeki dosyalardan servis
// - WebSocket / PeerJS direkt connect olabilir

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8765;
const ROOT = __dirname;
const UPSTREAM_HOST = '178-105-90-130.nip.io';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function proxyToUpstream(req, res) {
  const buffers = [];
  req.on('data', c => buffers.push(c));
  req.on('end', () => {
    const body = Buffer.concat(buffers);
    const headers = { ...req.headers };
    headers.host = UPSTREAM_HOST;
    delete headers['accept-encoding']; // gzip karışıklığı olmasın
    
    const options = {
      hostname: UPSTREAM_HOST,
      port: 443,
      path: req.url,
      method: req.method,
      headers,
      // Self-signed kabul et (nip.io üzerinde valid ama yine de)
      rejectUnauthorized: false,
    };
    
    const upstream = https.request(options, upRes => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    });
    
    upstream.on('error', err => {
      console.error('[PROXY ERROR]', req.url, err.message);
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('Proxy error: ' + err.message);
    });
    
    if (body.length) upstream.write(body);
    upstream.end();
  });
}

function serveFile(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('404 Not Found: ' + filePath);
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}

// Cloudflare tunnel URL'ini okur
function getTunnelUrl() {
  try {
    const logPath = '/tmp/cf-tunnel-app.log';
    if (!fs.existsSync(logPath)) return null;
    const log = fs.readFileSync(logPath, 'utf8');
    // En son trycloudflare.com URL'ini bul
    const matches = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
    if (matches && matches.length) return matches[matches.length - 1];
  } catch(e) {}
  return null;
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  
  // Özel endpoint: tunnel URL
  if (url === '/api/_tunnel-url') {
    const tunnelUrl = getTunnelUrl();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ tunnel: tunnelUrl, host: req.headers.host }));
  }
  
  // /api/* → canlı VPS'e proxy
  if (url.startsWith('/api/')) {
    console.log(`[PROXY] ${req.method} ${url} → https://${UPSTREAM_HOST}${url}`);
    return proxyToUpstream(req, res);
  }
  
  // Statik dosya
  let filePath = url === '/' ? '/index.html' : url;
  filePath = path.join(ROOT, filePath);
  
  // Güvenlik: ROOT dışına çıkmasın
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  
  console.log(`[STATIC] ${req.method} ${url}`);
  serveFile(filePath, res);
});

server.listen(PORT, () => {
  console.log(`\n  🎮 Takıl Dev Server`);
  console.log(`  ─────────────────────────────`);
  console.log(`  🌐 http://localhost:${PORT}`);
  console.log(`  📁 Root: ${ROOT}`);
  console.log(`  🔌 API proxy: https://${UPSTREAM_HOST}/api/*`);
  console.log(`  ✋ Durdur: Ctrl+C\n`);
});
