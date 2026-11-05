#!/usr/bin/env node
// m59-page-filter-test.mjs — the board filter script and `?who=` narrowing, offline.
import assert from 'node:assert/strict';
import { FLEET_FILTER_JS, narrowToWho } from './m59-page-filter.mjs';
import { NAV, heroLink } from './m59-page-chrome.mjs';
import { renderHero } from './m59-hero-page.mjs';

let n = 0;
const ok = (what, fn) => { fn(); n++; };

ok('the script parses and carries no template hole', () => {
  new Function(FLEET_FILTER_JS);
  assert.doesNotMatch(FLEET_FILTER_JS, /\$\{/);
  assert.doesNotMatch(FLEET_FILTER_JS, /<\/script/i);
});
ok('every board that has a tab bar has the script', () => {
  assert.ok(NAV('deaths').includes(FLEET_FILTER_JS));
});
ok('heroLink links and escapes', () => {
  assert.equal(heroLink('Zheng He'), '<a class="hero" href="/hero/Zheng%20He">Zheng He</a>');
  assert.equal(heroLink('<b>'), '<a class="hero" href="/hero/%3Cb%3E">&lt;b&gt;</a>');
  assert.equal(heroLink(null), '?');
});
ok('no who: unchanged, same object', () => {
  const s = new Set(['Janice']);
  assert.equal(narrowToWho(s, null), s);
  assert.equal(narrowToWho(s, ''), s);
});
ok('a Set of names stays a Set, case-insensitive', () => {
  const out = narrowToWho(new Set(['Janice', 'Zoot']), 'janice');
  assert.ok(out instanceof Set);
  assert.deepEqual([...out], ['Janice']);
});
ok('agent rows narrow by character', () => {
  const rows = [{ agent: 't1', character: 'Janice' }, { agent: 't2', character: 'Zoot' }];
  assert.deepEqual(narrowToWho(rows, 'Zoot'), [rows[1]]);
});
ok('an unknown name narrows to nobody, not to everybody', () => {
  assert.equal(narrowToWho(new Set(['Janice']), 'Kermit').size, 0);
});
ok('null characters (no roster) is left alone', () => {
  assert.equal(narrowToWho(null, 'Janice'), null);
});
ok('hero page: board tabs framed with who + embed, private boards loopback only', () => {
  const h = { name: 'Zheng He', agent: 't9', vitals: {}, inventory: [] };
  const lan = renderHero(h, { localhost: false });
  const local = renderHero(h, { localhost: true });
  assert.match(lan, /data-src="\/deaths\?who=Zheng%20He&embed=1"/);
  assert.match(lan, /data-tab="overview"/);
  assert.doesNotMatch(lan, /\/pvp\?who=/);
  assert.match(local, /data-src="\/pvp\?who=Zheng%20He&embed=1"/);
  assert.doesNotMatch(lan, /http-equiv="refresh"/);   // a refresh would reload every framed board
});

console.log(`page filter: ${n} passed`);
