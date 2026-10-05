#!/usr/bin/env node
// The fleet board's learning threshold and event details, against a scratch ledger.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-dashboard-test-'));
process.env.M59_LEDGER_DIR = dir;
const { recordSample, recordEvent } = await import('./m59-ledger.mjs');
recordSample([{
  character: 'Tester', level: 20, health: '20/20', mana: '10/10', vigor_of: '200/200',
  room: 'Somewhere', room_num: 1, strategy: 'test', has_weapon: true, has_food: true,
  learning: {
    progress: { target: 'weaponcraft', label: 'Weaponcraft 2', source: 'automatic',
      current_level: 1, next_level: 2, points: 25, example_ability: 'dodge' },
    planned: { configured: 1, ready: 0, next: null },
  },
}]);
const eventCases = [
  ['blocker_event', { refuge: { row: 34, col: 65 }, took: true, cancelled: false, swings: 0, episode_id: null },
    ['refuge: {&quot;row&quot;:34,&quot;col&quot;:65}', 'took: true', 'cancelled: false', 'swings: 0', 'episode_id: null']],
  ['town_trip_completed', { cash: { purse: 120, bank: 300 }, cash_before: { purse: 100, bank: 300 } },
    ['cash: {&quot;purse&quot;:120,&quot;bank&quot;:300}', 'cash_before: {&quot;purse&quot;:100,&quot;bank&quot;:300}']],
  ['cast_declined', { have: { elderberry: 1, herbs: 0 }, needs: '2 elderberry + 2 herbs' },
    ['have: {&quot;elderberry&quot;:1,&quot;herbs&quot;:0}', 'needs: 2 elderberry + 2 herbs']],
  ['chalice', { short: { herbs: 2 } }, ['short: {&quot;herbs&quot;:2}']],
  ['left_pack', { items: [{ name: 'herbs', amount: 2 }] },
    ['items: [{&quot;name&quot;:&quot;herbs&quot;,&quot;amount&quot;:2}]']],
  ['looted', { items: [{ name: 'herbs', amount: 2 }, { name: 'elderberry', amount: 1 }] },
    ['items: [{&quot;name&quot;:&quot;herbs&quot;,&quot;amount&quot;:2},{&quot;name&quot;:&quot;elderberry&quot;,&quot;amount&quot;:1}]']],
  ['nested_detail', { detail: { items: [{ name: '<img src=x onerror="alert(1)"> & loot' }], empty: [], missing: null } },
    ['detail: {&quot;items&quot;:[{&quot;name&quot;:&quot;&lt;img src=x onerror=\\&quot;alert(1)\\&quot;&gt; &amp; loot&quot;}],&quot;empty&quot;:[],&quot;missing&quot;:null}']],
];
for (const [kind, detail] of eventCases) recordEvent('Tester', kind, detail);
const { renderDashboard } = await import('./m59-dashboard.mjs');
const html = renderDashboard({ hours: 1 });
let pass = 0, fail = 0;
const ok = (name, condition) => {
  if (condition) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};
ok('the fleet table names the progression column', /points to next/.test(html));
ok('the target track and level are visible', /Weaponcraft 2/.test(html));
ok('the exact remaining points are visible', /title="next ability: dodge[^>]*">25<\/strong>/.test(html));
ok('the board remains read-only', !/buy_next_planned_skills|api\/planned-learning/.test(html));
for (const [kind, , expected] of eventCases) {
  const row = html.match(/<tr>[\s\S]*?<\/tr>/g)?.find(r => r.includes(`>${kind.replace(/_/g, ' ')}</td>`));
  ok(`${kind} preserves its structured event details`, !!row && expected.every(value => row.includes(value)));
}
ok('objects are never implicitly coerced in event details', !html.includes('[object Object]'));
ok('nested event strings cannot inject HTML', !html.includes('<img src=x'));
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
