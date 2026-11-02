#!/usr/bin/env node
// Optional read-only companion when the deployed broker predates these boards.
// node tools/m59-fleet-insights-server.mjs --root C:/code/m59-lab/prod-deploy --fleet prod
// Never starts a broker or keeper. Health must confirm the exact source checkout.
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { collectInsights } from './m59-fleet-insights.mjs';
import { renderInsights } from './m59-fleet-insights-page.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const root = arg('root'), fleet = arg('fleet');
if (!root || !fleet) throw new Error('--root and --fleet are required; no implicit fleet');
const broker = arg('broker', 'http://127.0.0.1:8901');
const dashboard = arg('dashboard', 'http://127.0.0.1:8902');
const port = Number(arg('port', '8903'));
const sameRoot = p => resolve(p).replaceAll('\\', '/').toLowerCase().replace(/\/$/, '') === resolve(root).replaceAll('\\', '/').toLowerCase().replace(/\/$/, '');
let last = null, lastAt = 0, pending = null;
async function snapshot() {
  if (Date.now() - lastAt < 5000 && last) return last;
  if (pending) return pending;
  pending = (async () => {
    const response = await fetch(`${broker}/health`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Health returned ${response.status}`);
    const h = await response.json();
    if (!h.root || !sameRoot(h.root) || h.fleet !== fleet || !h.session_characters) throw new Error('Broker root/fleet identity differs from the requested source. Report refused.');
    const r = await fetch(`${broker}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'insights-read', method: 'tools/call', params: { name: 'fleet', arguments: {} } }), signal: AbortSignal.timeout(10_000) });
    const rpc = await r.json();
    if (!r.ok || rpc.error || rpc.result?.isError) throw new Error('Fleet snapshot unavailable');
    const body = JSON.parse(rpc.result.content.find(c => c.type === 'text').text);
    if (!Array.isArray(body.fleet)) throw new Error('Fleet snapshot has no rows');
    last = { live: body.fleet, characters: Object.entries(h.session_characters).map(([agent, character]) => ({ agent, character })) };
    lastAt = Date.now();
    return last;
  })();
  try { return await pending; } finally { pending = null; }
}
const server = createServer(async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); return res.end('Read-only'); }
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') { res.writeHead(302, { location: '/practice' }); return res.end(); }
  if (!['/practice', '/couriers'].includes(url.pathname)) { res.writeHead(404); return res.end('Not found'); }
  const hours = Math.max(.25, Math.min(720, Number(url.searchParams.get('hours')) || 24));
  const page = url.pathname.slice(1);
  try {
    const data = collectInsights({ root, fleet, hours, ...await snapshot() });
    const asJson = url.searchParams.get('format') === 'json';
    res.writeHead(200, { 'content-type': asJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8' });
    res.end(asJson ? JSON.stringify(data) : renderInsights({ data, page, dashboard }));
  } catch (error) {
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderInsights({ page, error: error.message, dashboard }));
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Fleet insights: http://127.0.0.1:${port}/practice (read-only, ${fleet})`));
