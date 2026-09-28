#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { compendiumOrigin, withCompendiumRequest } from './m59-compendium-links.mjs';
import { roomLink, lore } from './m59-dashboard.mjs';

assert.equal(compendiumOrigin('192.168.254.76:8902', ''), 'http://192.168.254.76:8099');
assert.equal(compendiumOrigin('localhost:8902', ''), 'http://localhost:8099');
assert.equal(compendiumOrigin('meridian.local:8902', ''), 'http://meridian.local:8099');
assert.equal(compendiumOrigin('[::1]:8902', ''), 'http://[::1]:8099');
assert.equal(compendiumOrigin('192.168.254.76:8902', 'https://lore.example/game/'), 'https://lore.example/game');
for (const host of [undefined, '', 'bad/path', 'bad?query', 'bad#fragment', 'user@host', 'bad\\host', 'bad"host']) {
  assert.equal(compendiumOrigin(host, ''), 'http://localhost:8099');
}

// Exercise the actual shared room and item renderers through concurrent HTTP
// requests. A mutable global would send one visitor to another visitor's host.
const previous = process.env.M59_COMPENDIUM;
delete process.env.M59_COMPENDIUM;
const server = http.createServer(withCompendiumRequest(async (req, res) => {
  await delay(req.headers.host.startsWith('192.') ? 25 : 1);
  res.end(roomLink('Underworld', 1) + lore('acid ring'));
}));
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const request = host => new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: server.address().port, headers: { host } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
  const hosts = ['192.168.254.76:8902', 'localhost:8902', '[::1]:8902', 'meridian.local:8901'];
  const pages = await Promise.all(hosts.map(request));
  for (let i = 0; i < hosts.length; i++) {
    const links = [...pages[i].matchAll(/href="([^"]+)"/g)].map(match => match[1]);
    assert.equal(links.length, 2, 'both room and lore are linked');
    assert.ok(links.every(link => link.startsWith(compendiumOrigin(hosts[i]) + '/')));
    assert.ok(links[0].includes('/zones/'));
    assert.ok(links[1].endsWith('/items/acidring.html'));
  }
  process.env.M59_COMPENDIUM = 'https://lore.example/game/';
  assert.match(await request(hosts[0]), /href="https:\/\/lore.example\/game\/zones\//);
  console.log('Compendium host links: origins, concurrent HTTP rendering, and explicit override passed.');
} finally {
  await new Promise(resolve => server.close(resolve));
  if (previous === undefined) delete process.env.M59_COMPENDIUM;
  else process.env.M59_COMPENDIUM = previous;
}
