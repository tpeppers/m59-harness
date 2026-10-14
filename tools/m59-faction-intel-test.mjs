#!/usr/bin/env node
// Offline tests for tools/m59-faction-intel.mjs and the /faction board (m59-faction-page.mjs):
// every overheard sentence parses to the right observation, the log folds duplicates, the power
// estimate follows parlia.kod's arithmetic, the benefit table matches its Effects Part, and the
// page renders with its tab. Writes only to a temp directory.
//
// When an M59_ROOT (or C:/code/Meridian59) tree is present, the sentences are checked against
// the kod resources they were copied from, so a reworded server fails here.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFactionLine, recordIntel, noteFactionLine, readIntelRows, foldIntel, estimatePower,
         powerBand, powerContribution, benefitValue, BENEFITS } from './m59-faction-intel.mjs';
import { factionReport, renderFaction } from './m59-faction-page.mjs';
import { TABS } from './m59-page-chrome.mjs';
import { isDashboardOnlyPath } from './m59-dashboard-route.mjs';

let n = 0;
const ok = (name, fn) => { try { fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; } };

const ROOT = process.env.M59_ROOT || 'C:/code/Meridian59';
const kod = f => { const p = join(ROOT, 'kod', f); return existsSync(p) ? readFileSync(p, 'latin1') : null; };
const parl = kod('util/parlia.kod'), flag = kod('object/active/flag.kod'), token = kod('object/item/passitem/token.kod'),
      council = kod('object/active/holder/nomoveon/battler/monster/council.kod');

if (parl) ok('the sentences are the kod\'s', () => {
  for (const s of ['sense a shift in the balance of power at the Royal Court', 'wield unsurpassable influence',
    'completely lack any influence', "I've heard that the Duke and his servants now",
    'Techniques learned from %s help guide your attack', 'If %s were more favored, your spells would have more power'])
    assert.ok(parl.includes(s), s);
  if (flag) assert.ok(flag.includes('who has successfully claimed %s%s in the name of %s!'));
  if (token) assert.ok(token.includes('who has returned %s%s to the Meridian Council.'));
  if (council) assert.ok(council.includes('I will pay more attention to the matters which concern the Duke.'));
  assert.match(parl, /piBalanceFactor = 25/);
});

ok('broadcasts parse, and keep no player name', () => {
  const f = parseFactionLine('~IAll hail Bob, who has successfully claimed the Bleak Pass in the name of Princess Kateriina!');
  assert.deepEqual(f, { type: 'flag', place: 'the Bleak Pass', holder: 'princess' });
  assert.equal(parseFactionLine('All hail X, who has successfully claimed a hill in the name of the rebel forces!').holder, 'rebel');
  assert.equal(parseFactionLine('Al has bravely staked a claim to the Bleak Pass in the name of Duke Akardius!').faction, 'duke');
  assert.deepEqual(parseFactionLine('~IAll hail Al who has returned the jade cat token to the Meridian Council.~n'),
    { type: 'token_returned', token: 'jade cat token' });
  assert.equal(parseFactionLine('~IYou sense a shift in the balance of power at the Royal Court.').type, 'power_shift');
  assert.ok(!JSON.stringify(f).includes('Bob'));
});

ok('councilors, rumours and personal hints', () => {
  assert.deepEqual(parseFactionLine('Thank you. You have done me a great service. Al I will look upon rebellion as a sign of good change.',
    { speaker: 'Councilor Cylill' }), { type: 'councilor', councilor: 'Cylill', faction: 'rebel', source: 'thanks' });
  assert.deepEqual(parseFactionLine('Bei Naq is suspected to be a dedicated believer in our desires.'),
    { type: 'councilor', councilor: 'Bei Naq', faction: 'princess', strength: 'dedicated', source: 'liege' });
  assert.deepEqual(parseFactionLine("I've heard that the Duke and his servants now show considerable influence in the decisions of the Meridian Council."),
    { type: 'rumour', faction: 'duke', band: 4 });
  assert.deepEqual(parseFactionLine("The rumors about Jonas say his rebels just don't seem to have much influence with the Meridian Council"),
    { type: 'rumour', faction: 'rebel', band: 2 });
  assert.deepEqual(parseFactionLine("~ITechniques learned from Jonas D'Accor help guide your attack."),
    { type: 'bonus', kind: 'hit', up: true, faction: 'rebel' });
  assert.deepEqual(parseFactionLine('~IIf Princess Kateriina were more favored, your spells would have more power.'),
    { type: 'bonus', kind: 'spell', up: false, faction: 'princess' });
  assert.equal(parseFactionLine('You killed the orc.'), null);
});

ok('the power bands follow FigurePowerFromCount', () => {
  // balance = 2000 * 25% = 500
  assert.deepEqual([1000, 750, 500, 250, 249].map(p => powerBand(p)), [5, 4, 3, 2, 1]);
  assert.equal(powerContribution(0), -10);
  assert.equal(powerContribution(500), 100);
  assert.equal(powerContribution(1000), 150);
  assert.equal(powerContribution(5000), 150);
});

ok('benefits follow the Effects Part', () => {
  const by = k => BENEFITS.find(b => b.kind === k);
  assert.equal(benefitValue(by('hit'), 'duke'), null);                       // Duke and Princess get no to-hit
  assert.deepEqual(benefitValue(by('hit'), 'rebel', { contribution: 150 }), { value: 150, max: 150 });
  assert.deepEqual(benefitValue(by('vigor'), 'duke', { contribution: 100 }), { value: 30, max: 45 });
  assert.deepEqual(benefitValue(by('defense'), 'princess', { contribution: -10 }), { value: -20, max: 300 });
  assert.deepEqual(benefitValue(by('defense'), 'neutral', { contribution: -10 }), { value: 0, max: 75 });   // never negative
  assert.deepEqual(benefitValue(by('spell'), 'duke', { intriguing: false }), { value: 3, max: 3, flat: true });
  assert.equal(benefitValue(by('damage'), 'rebel').value, 2);
});

const dir = mkdtempSync(join(tmpdir(), 'faction-intel-'));
try {
  const file = join(dir, 'intel.jsonl');
  ok('the log folds duplicates and keeps servers apart', () => {
    const S = '1.2.3.4:5959', t0 = 1_000_000;
    for (let i = 0; i < 3; i++)       // three keepers hear one broadcast
      noteFactionLine({ text: 'All hail A, who has successfully claimed the Bleak Pass in the name of Duke Akardius!', at: t0 + i }, { file, server: S, character: `c${i}` });
    noteFactionLine({ text: 'All hail A, who has successfully claimed the Bleak Pass in the name of the rebel forces!', at: t0 + 10 }, { file, server: S });
    noteFactionLine({ text: 'All hail A, who has successfully claimed Elsewhere in the name of the rebel forces!', at: t0 }, { file, server: 'other:1' });
    noteFactionLine({ text: '~IYou sense a shift in the balance of power at the Royal Court.', at: t0 }, { file, server: S, character: 'c1' });
    noteFactionLine({ text: '~IYou sense a shift in the balance of power at the Royal Court.', at: t0 + 5 }, { file, server: S, character: 'c2' });
    recordIntel({ type: 'rank', army: 'the ducal army', title: 'a great warrior' }, { file, agent: 't5', at: t0 });
    // a bonus hint is throttled per character and kind
    noteFactionLine({ text: '~IDuke Akardius\'s guidance helps you retain some of your vigor.', at: t0 }, { file, server: S, character: 'Kermit' });
    noteFactionLine({ text: '~IDuke Akardius\'s guidance helps you retain some of your vigor.', at: t0 + 1000 }, { file, server: S, character: 'Kermit' });
    const st = foldIntel(readIntelRows({ file, server: S, now: t0 + 20 }));
    assert.deepEqual(Object.keys(st.flags), ['the Bleak Pass']);
    assert.equal(st.flags['the Bleak Pass'].holder, 'rebel');                // the later claim wins
    assert.equal(st.shifts.length, 1);
    assert.equal(st.ranks.t5.title, 'a great warrior');
    assert.equal(st.bonuses.Kermit.vigor.up, 1);
    const est = estimatePower(st);
    assert.equal(est.seen_flags, 1);
    assert.deepEqual(est.factions.rebel.territory, [27, 1000]);              // 1/36 seen; all 36 at most
    assert.deepEqual(est.factions.duke.territory, [0, 972]);
  });

  ok('the board renders the fleet, the estimate and its tab', () => {
    const statusDir = join(dir, 'status'); mkdirSync(statusDir);
    writeFileSync(join(statusDir, 'Kermit.json'), JSON.stringify({ character: 'Kermit', faction: 'duke', soldier: true,
      observed_at: 1_000_000, loyalty: { warned_at: 900_000, served_at: 950_000 } }));
    const characters = [{ agent: 't5', character: 'Kermit' }, { agent: 't6', character: 'Gonzo' }];
    const r = factionReport({ characters, statusDir, intelFile: file, server: '1.2.3.4:5959', now: 1_000_100 });
    assert.equal(r.counts.duke, 1); assert.equal(r.counts.unknown, 1); assert.equal(r.soldiers, 1);
    const k = r.people.find(p => p.character === 'Kermit');
    assert.deepEqual(k.kills_to_max, { min: 1, max: 2 });                     // great warrior: rank 7 or 8
    assert.ok(k.benefits.some(b => b.kind === 'vigor') && !k.benefits.some(b => b.kind === 'hit'));
    assert.equal(r.people.find(p => p.character === 'Gonzo').benefits.length, 0);
    const html = renderFaction({ report: r });
    assert.match(html, /<h1>Factions<\/h1>/);
    assert.match(html, /href="\/faction" class="on"/);
    assert.match(html, /Kermit/); assert.match(html, /a great warrior/); assert.match(html, /the Bleak Pass/);
    assert.ok(TABS.some(t => t.key === 'faction' && t.href === '/faction'));
    assert.ok(isDashboardOnlyPath('/faction'));
  });

  ok('an empty log is an empty estimate, not a crash', () => {
    const r = factionReport({ characters: [], statusDir: join(dir, 'none'), intelFile: join(dir, 'none.jsonl') });
    assert.equal(r.rows, 0);
    assert.equal(r.power.unseen_flags, 36);
    assert.match(renderFaction({ report: r }), /No claim heard yet/);
  });
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`faction-intel: ${n} groups passed${parl ? ' (sentences read from the kod)' : ' (no kod tree)'}`);
