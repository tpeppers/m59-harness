#!/usr/bin/env node
// Offline tests for tools/fleetscripts/choose-hometown.mjs — the five sentences, the verdicts, and
// the plan: it compiles with its one room declared, refuses without confirm=true, and a character
// already living in the target town walks nowhere and says nothing.
//
// When an M59_ROOT (or C:/code/Meridian59) tree is present, every sentence and reply is read back
// out of Coruniv.kod, so a reworded resource fails here rather than at the hall — where a sentence
// that is one character off is simply ignored (StringEqual), which looks exactly like a refusal.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOWNS, LOCKED_REPLY, HALL_OF_GENEALOGY, townKey, hallVerdict, script }
  from './fleetscripts/choose-hometown.mjs';
import { trapCheck } from './m59-fleetscript.mjs';
import { hometownFrom, HOMETOWNS } from './m59-describe.mjs';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; };

const ROOT = process.env.M59_ROOT || 'C:/code/Meridian59';
const FILE = join(ROOT, 'kod', 'object', 'active', 'holder', 'room', 'crnthrm', 'Coruniv.kod');
const kod = existsSync(FILE) ? readFileSync(FILE, 'latin1') : null;
const resource = name => kod ? (new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, 'm').exec(kod)?.[1] ?? null) : null;

if (kod) await ok('every sentence and reply is the kod\'s own text', () => {
  for (const k of Object.keys(TOWNS)) {
    assert.equal(TOWNS[k].say, resource(`coruniv_choose_${k}_trigger`), `${k} trigger`);
    assert.equal(TOWNS[k].reply, resource(`coruniv_chose_${k}`), `${k} reply`);
  }
  assert.equal(LOCKED_REPLY, resource('coruniv_no_change'));
  assert.match(kod, /piRoom_num = RID_COR_UNIV/);
});

await ok('each town resolves to the inn the hometown table already knows', () => {
  for (const t of Object.values(TOWNS)) {
    const row = HOMETOWNS.find(h => h.town === t.town);
    assert.ok(row, `${t.town} in HOMETOWNS`);
    assert.equal(row.room, t.room, `${t.town} inn room`);
  }
  assert.equal(HALL_OF_GENEALOGY, 156);
});

await ok('town names an operator types', () => {
  assert.equal(townKey('Tos'), 'tos');
  assert.equal(townKey('Cor Noth'), 'cornoth');
  assert.equal(townKey('cor_noth'), 'cornoth');
  assert.equal(townKey('BARLOQUE'), 'barloque');
  assert.equal(townKey('Raza'), null);            // a newbie home, not a choice the hall offers
  assert.equal(townKey(''), null);
});

await ok('the hall\'s verdict, including the replies that never name the town', () => {
  assert.equal(hallVerdict('tos', ['Your guildmate Piggy has just departed.', TOWNS.tos.reply]), 'chosen');
  assert.equal(hallVerdict('marion', [TOWNS.marion.reply]), 'chosen');
  assert.equal(hallVerdict('barloque', [LOCKED_REPLY]), 'locked');
  assert.equal(hallVerdict('jasper', ['Hail your guildmate Beaker!']), null);
});

await ok('the profile lines the verdict is read from', () => {
  assert.equal(hometownFrom('He has been a citizen of Tos for three years.\r\n').town, 'Tos');
  assert.equal(hometownFrom('He has been a Marionite for three years.\r\n').town, 'Marion');
  assert.equal(hometownFrom('He hailed from Cor Noth for three years.\r\n').town, 'Cor Noth');
});

await ok('an unknown town is refused before any step exists', async () => {
  await assert.rejects(script.steps({ town: 'raza', agent: 't5', agents: ['t5'] }), /not one of/);
});

// A fake broker: status gives the self id, look_at answers about that id with a profile line.
const fakeCall = (extra, { room = 598 } = {}) => async (name, args) => {
  if (name === 'status') return { character: 'Bunsen', you: { id: 4454 }, room: { num: room } };
  if (name === 'look_at') return { id: Number(args.target), is_player: true, extra };
  if (name === 'wait_for_event') return { cursor: 7, events: [], timed_out: true };
  return {};
};

await ok('the plan compiles with its one room declared and passes the trap check', async () => {
  const steps = await script.steps({ town: 'tos', confirm: true, agent: 't5', agents: ['t5'] });
  assert.equal(trapCheck(steps), null);
  const walks = steps.filter(s => s.do === 'walk');
  assert.equal(walks.length, 1);
  assert.deepEqual(walks[0].candidates, [HALL_OF_GENEALOGY]);
  assert.equal(walks[0].to({ needed: true, here: 598 }), HALL_OF_GENEALOGY);
  const says = steps.filter(s => s.do === 'say');
  assert.equal(says.length, 1);
  assert.equal(says[0].text?.({ needed: true }) ?? says[0].lines?.({ needed: true }), TOWNS.tos.say);
});

await ok('without confirm=true it refuses, and says why', async () => {
  const steps = await script.steps({ town: 'tos', agent: 't5', agents: ['t5'] });
  const state = {};
  const r = await steps[0].fn({ agent: 't5', call: fakeCall('He hailed from Cor Noth for three years.'), state });
  assert.equal(r.ok, false);
  assert.match(r.why, /PERMANENT/);
});

await ok('already a resident: no walk, no sentence', async () => {
  const steps = await script.steps({ town: 'tos', confirm: true, agent: 't5', agents: ['t5'] });
  const state = {};
  const r = await steps[0].fn({ agent: 't5', call: fakeCall('He has been a citizen of Tos for three years.'), state });
  assert.equal(r.ok, true);
  assert.match(r.skipped, /already/);
  state.here = 598;
  assert.equal(steps.find(s => s.do === 'walk').to(state), 598);
  const say = steps.find(s => s.do === 'say');
  assert.equal(say.text?.(state) ?? say.lines?.(state), '');
});

console.log(`m59-choose-hometown-test: ${n} passed${kod ? '' : ' (no M59_ROOT: the kod text checks were skipped)'}`);
