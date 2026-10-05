#!/usr/bin/env node
// serve.mjs -- static file server for reading the compendium.
//
//   node tools/serve.mjs [port]                    default 8099, this computer only
//   node tools/serve.mjs [port] --access lan-read  ...and readable from the LAN
//
// Same three modes as tools/m59-compendium.mjs (also M59_COMPENDIUM_ACCESS): local (the
// default), lan-read and lan-write. This server is a static tree and accepts nothing but
// reads, so the two LAN modes behave alike here; both are accepted so one setting works
// for either server. An unrecognised mode is refused, not guessed at.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { networkInterfaces } from 'node:os';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.join(HERE, '..');
const argv = process.argv.slice(2);
const accessAt = argv.indexOf('--access');
const ACCESS = String((accessAt >= 0 ? argv[accessAt + 1] : process.env.M59_COMPENDIUM_ACCESS) || 'local').toLowerCase();
if (!['local', 'lan-read', 'lan-write'].includes(ACCESS)) {
  console.error(`unknown compendium access "${ACCESS}" — use local, lan-read or lan-write`);
  process.exit(2);
}
const PORT = Number(argv.find((a, i) => /^\d+$/.test(a) && argv[i - 1] !== '--access') || 8099);
const HOST = ACCESS === 'local' ? '127.0.0.1' : '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8',
};

http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + p); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, HOST, () => {
  console.log(`compendium on http://127.0.0.1:${PORT}/  (access: ${ACCESS})`);
  if (HOST === '0.0.0.0') {
    for (const addresses of Object.values(networkInterfaces()))
      for (const address of addresses || [])
        if (address.family === 'IPv4' && !address.internal)
          console.log(`  LAN: http://${address.address}:${PORT}/`);
  }
});
