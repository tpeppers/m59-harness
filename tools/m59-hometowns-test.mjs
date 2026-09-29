import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordHometown, readHometown, hometownDir, refreshHometowns } from './m59-hometowns.mjs';
import { hometownReport, renderHometownsBoard } from './m59-hometowns-page.mjs';
import { TABS } from './m59-page-chrome.mjs';
import { isDashboardOnlyPath } from './m59-dashboard-route.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm59-hometowns-'));
try {
  const dir = path.join(root, 'prod'), other = path.join(root, 'shadow');
  assert.equal(readHometown('Alpha', { dir }), null);
  assert.equal(recordHometown('Alpha', '', { dir }), null);
  recordHometown('Alpha', 'He has been a Barloquan for a year.', { dir, at: 1000 });
  assert.equal(readHometown('Alpha', { dir }).current.room, 106);
  recordHometown('Alpha', 'He has been a Barloquan for two years.', { dir, at: 2000 });
  let record = readHometown('Alpha', { dir });
  assert.equal(record.changes.length, 1);
  assert.equal(record.checked_at, 2000);
  assert.equal(record.changed_at, 1000);
  recordHometown('Alpha', 'He has been a resident of Tos for a year.', { dir, at: 3000 });
  recordHometown('Alpha', 'He has been a Barloquan for a year.', { dir, at: 1500 });
  recordHometown('Alpha', 'No residency here', { dir, at: 4000 });
  record = readHometown('Alpha', { dir });
  assert.equal(record.current.town, 'Tos');
  assert.equal(record.changes.length, 2);
  assert.equal(record.checked_at, 3000);
  assert.equal(readHometown('Alpha', { dir: other }), null);
  assert.notEqual(hometownDir('/prod.json'), hometownDir('/shadow.json'));
  recordHometown('../<Wanderer>', 'He has wandered for years.', { dir, at: 3000 });
  recordHometown('Outside fleet', 'He has been a Marionite for a year.', { dir });
  const roster = [{ agent: 'a', character: 'Alpha' }, { agent: 'b', character: '../<Wanderer>' },
    { agent: 'c', character: 'Unchecked' }];
  const report = hometownReport({ dir, roster });
  assert.equal(report.rows.length, 3);
  assert.equal(report.groups.reduce((n, g) => n + g.members.length, 0), 3);
  assert.equal(report.groups.find(g => g.town === 'Marion').members.length, 0);
  assert.equal(report.groups.find(g => g.town === 'Unknown').members.length, 1);
  assert.equal(report.groups.find(g => g.town === 'Wandering').members.length, 1);
  const html = renderHometownsBoard({ dir, roster, label: '<prod>' });
  assert.ok(html.indexOf('By hometown') < html.indexOf('By character'));
  assert.ok(html.includes('&lt;Wanderer&gt;'));
  assert.ok(!html.includes('<Wanderer>'));
  assert.ok(!html.includes('Outside fleet'));
  assert.ok(renderHometownsBoard({ dir, roster: [] }).includes('No characters in this fleet.'));
  assert.ok(isDashboardOnlyPath(TABS.find(t => t.key === 'hometowns').href));
  fs.writeFileSync(path.join(dir, fs.readdirSync(dir)[0]), '{bad');
  assert.doesNotThrow(() => hometownReport({ dir, roster }));
  const stateFile = path.join(root, 'fleet.json');
  fs.writeFileSync(stateFile, JSON.stringify({ a: { credentials: { character: 'Self' } },
    b: { credentials: { character: 'Human' } }, c: { credentials: { character: 'Away' } } }));
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ state: stateFile }) });
  try {
    let ownLooks = 0, humanLooks = 0;
    const call = async (name, args) => {
      if (name === 'status') return { character: { a: 'Self', b: 'Human', c: 'Away' }[args.agent],
        in_game: true, connected: args.agent === 'a', you: null };
      if (name === 'scene_capture') {
        assert.equal(args.agent, 'a', 'never use a disconnected human as observer');
        return { scene: { actors: [
          { kind: 'player', mine: true, name: 'Self', object_at_capture: 10 },
          { kind: 'player', mine: false, name: 'Human', object_at_capture: 20 }] } };
      }
      assert.equal(name, 'look_at'); assert.equal(args.agent, 'a');
      if (args.target === 10) { ownLooks++; return { id: 10, is_player: true, editable: true, extra: 'He is a Marionite' }; }
      assert.equal(args.target, 20); humanLooks++;
      return { id: 20, is_player: true, editable: false, extra: 'She called Jasper home' };
    };
    let refreshed = await refreshHometowns({ stateFile, force: true, call });
    assert.equal(refreshed.filter(r => r.checked).length, 2);
    assert.equal(refreshed.find(r => r.character === 'Human').observed_by, 'a');
    assert.equal(refreshed.find(r => r.character === 'Away').checked, false);
    assert.equal(readHometown('Self', { dir: hometownDir(stateFile) }).current.town, 'Marion');
    assert.equal(ownLooks, 1); assert.equal(humanLooks, 1);
    // Cached units still provide observations when checking only missing entries.
    const cache = hometownDir(stateFile);
    for (const file of fs.readdirSync(cache)) {
      const full = path.join(cache, file);
      if (JSON.parse(fs.readFileSync(full)).character === 'Human') fs.unlinkSync(full);
    }
    refreshed = await refreshHometowns({ stateFile, call });
    assert.equal(refreshed.find(r => r.character === 'Human').checked, true);
    assert.equal(ownLooks, 1); assert.equal(humanLooks, 2);
  } finally { globalThis.fetch = oldFetch; }
  console.log('Hometown cache, changes, fleet isolation, missing readings, grouping, escaping and route checks passed.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
