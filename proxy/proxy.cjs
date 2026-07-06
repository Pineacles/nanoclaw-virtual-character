#!/usr/bin/env node
/**
 * Lightweight token-routing reverse proxy for multi-instance NanoClaw.
 * Maps auth tokens to backend ports. Single domain, multiple users.
 *
 * Config: proxy-config.json (same directory)
 * Usage: node proxy.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'proxy-config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
const PORT = config.port || 3000;

// Build token → backend URL map
const tokenMap = new Map();
for (const entry of config.routes) {
  tokenMap.set(entry.token, `http://localhost:${entry.backend_port}`);
}

function extractToken(req) {
  // Check Authorization header
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  // Check query parameter (for WebSocket upgrade)
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    return url.searchParams.get('token');
  } catch { return null; }
}

function proxy(req, res, backend) {
  const url = new URL(backend);
  const opts = {
    hostname: url.hostname,
    port: url.port,
    path: req.url,
    method: req.method,
    headers: req.headers,
  };
  const proxyReq = http.request(opts, (proxyRes) => {
    proxyRes.on('error', () => { try { res.destroy(); } catch {} });
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => {
    if (!res.headersSent) {
      try { res.writeHead(502); res.end('Bad Gateway'); } catch {}
    } else {
      try { res.destroy(); } catch {}
    }
  });
  req.on('error', () => { try { proxyReq.destroy(); } catch {} });
  res.on('error', () => { try { proxyReq.destroy(); } catch {} });
  req.pipe(proxyReq);
}

// Default backend for unauthenticated requests (static assets, login page)
const defaultBackend = config.routes[0] ? `http://localhost:${config.routes[0].backend_port}` : null;

const server = http.createServer((req, res) => {
  const token = extractToken(req);
  const backend = token && tokenMap.get(token);
  if (backend) {
    proxy(req, res, backend);
    return;
  }
  // No token — serve static assets from default backend (HTML/CSS/JS, login page)
  // API calls without valid token will get 401 from the backend itself
  if (defaultBackend) {
    proxy(req, res, defaultBackend);
  } else {
    res.writeHead(503);
    res.end('No backend configured');
  }
});

// WebSocket upgrade support
server.on('upgrade', (req, socket, head) => {
  const token = extractToken(req);
  const backend = token && tokenMap.get(token);
  if (!backend) { socket.destroy(); return; }

  socket.on('error', () => { try { socket.destroy(); } catch {} });

  const url = new URL(backend);
  const opts = {
    hostname: url.hostname,
    port: url.port,
    path: req.url,
    method: req.method,
    headers: req.headers,
  };
  const proxyReq = http.request(opts);
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    proxySocket.on('error', () => { try { proxySocket.destroy(); } catch {} });
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
      Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
      '\r\n\r\n'
    );
    if (proxyHead.length) socket.write(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  proxyReq.on('error', () => { try { socket.destroy(); } catch {} });
  proxyReq.end();
});

server.on('clientError', (err, socket) => {
  try { socket.destroy(); } catch {}
});

server.listen(PORT, () => {
  console.log(`NanoClaw proxy listening on port ${PORT}, routing ${tokenMap.size} instances`);
});
