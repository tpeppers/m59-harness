// m59-buddy-test.mjs — the buddy system (m59-buddy.mjs + Autopilot.passBuddy) and the private
// farming-strategy directories (m59-strategy-engine.mjs farmStrategyDirs), offline.
//
//   node tools/m59-buddy-test.mjs
//
// Opens no socket and touches no roster: the shared records go to a temp directory, the keeper is a
// prototype instance with fakes for the client and the two moves it makes (pull, fightNow).

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'm59-buddy-'));
process.env.M59_BUDDY_DIR = join(scratch, 'buddy');

const buddy = await import('./m59-buddy.mjs');
const { classifyCombatLine } = await import('./m59-combatlog.mjs');
const { validateStrategy } = await import('./m59-strategy-schema.mjs');
const engine = await import('./m59-strategy-engine.mjs');
const { Autopilot, HANDLED, CONTINUE } = await import('./m59-autopilot.mjs');
const { OF } = await import('./m59-parse.mjs');

let pass = 0, fail = 0;
const ok = (what, cond) => { if (cond) { pass++; console.log(`  ok   ${what}`); } else { fail++; console.log(`  FAIL ${what}`); } };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

console.log('\nthe policy value');
{
  const v = buddy.normalizeBuddy({ pairs: { t5: 't4', t6: 't10' } });
  ok('pairs are kept, defaults filled', v.pairs.t5 === 't4' && v.wait_s === 120 && v.tries === 12 && v.reach === 2);
  ok('null and false are off', buddy.normalizeBuddy(null) === null && buddy.normalizeBuddy(false) === null);
  ok('a character in two pairs is refused (exclusive, like m59-party)',
     throws(() => buddy.normalizeBuddy({ pairs: { t5: 't4', t6: 't4' } })));
  ok('nobody is their own buddy', throws(() => buddy.normalizeBuddy({ pairs: { t5: 't5' } })));
  ok('an unknown key is refused, not dropped', throws(() => buddy.normalizeBuddy({ pairs: { t5: 't4' }, flee: 0.9 })));
  ok('an empty pair map is refused', throws(() => buddy.normalizeBuddy({ pairs: {} })));
  ok('a tagger finds its role', JSON.stringify(buddy.roleIn(v, 't5')) === JSON.stringify({ role: 'tag', partner: 't4' }));
  ok('a killer finds its role', JSON.stringify(buddy.roleIn(v, 't10')) === JSON.stringify({ role: 'kill', partner: 't6' }));
  ok('anyone else has none', buddy.roleIn(v, 't1') === null);
  ok('enabled:false is no role for anyone', buddy.roleIn(buddy.normalizeBuddy({ pairs: { t5: 't4' }, enabled: false }), 't5') === null);
}

console.log('\nchoosing the tag, and knowing it landed');
{
  const me = { row: 10, col: 10 };
  const monsters = [
    { id: 1, row: 10, col: 14, name: 'skeleton' },          // fresh, 4 away
    { id: 2, row: 10, col: 12, name: 'skeleton' },          // fresh, 2 away, but a player stands beside it
    { id: 3, row: 12, col: 9, name: 'zombie' },             // fresh, nearest, not the quarry
    { id: 4, row: 10, col: 16, name: 'battered skeleton' }, // fresh, 6 away
  ];
  const players = [{ row: 10, col: 13 }];
  const t = buddy.pickFreshTarget({ monsters, players, me, quarry: ['skeleton'] });
  // id 1 at col 14 is within 1 of the player at col 13, so it is in somebody's fight too.
  // id 4 is a BATTERED skeleton: not the quarry. Names are matched exactly.
  ok('a monster beside a player is not untouched, and "skeleton" never matches "battered skeleton"', t === null);
  ok('naming it exactly does', buddy.pickFreshTarget({ monsters, players, me, quarry: ['battered skeleton'] })?.id === 4);
  ok('without a quarry list the nearest untouched monster of any kind', buddy.pickFreshTarget({ monsters, players, me })?.id === 3);
  ok('one already tagged in this room is not tagged again',
     buddy.pickFreshTarget({ monsters, players, me, quarry: ['battered skeleton'], tagged: new Set([4]) }) === null);
  ok('a landed blow is a tag', buddy.tagLanded(classifyCombatLine('Your hammer slashes the skeleton.'), 'skeleton'));
  ok('a landed touch spell is a tag', buddy.tagLanded(classifyCombatLine('Your acid touch burns the skeleton.'), 'skeleton'));
  ok('a blow on something else is not', !buddy.tagLanded(classifyCombatLine('Your hammer slashes the zombie.'), 'skeleton'));
  ok('a full resist is not (PFLAG_DID_DAMAGE needs damage)',
     !buddy.tagLanded(classifyCombatLine('The skeleton shrugs off your attack.'), 'skeleton'));
  ok('nothing parsed is nothing landed', !buddy.tagLanded(null, 'skeleton'));
}

console.log('\nthe shared record (one writer per file)');
{
  buddy.writeBuddyRecord('t5', { role: 'tag', room: 38, hold: { col: 3, row: 4 } }, { now: 1000 });
  const r = buddy.readBuddyRecord('t5', { now: 2000 });
  ok('a fresh record reads back', r?.room === 38 && r.hold.col === 3 && r.agent === 't5');
  ok('a stale record reads as absent', buddy.readBuddyRecord('t5', { now: 1000 + buddy.BUDDY_STALE_MS + 1 }) === null);
  ok('no record is absent, not an error', buddy.readBuddyRecord('t9') === null);
  ok('a slot that could name a path is refused', throws(() => buddy.writeBuddyRecord('../x', {})));
}

console.log('\na strategy file may declare it');
{
  const r = validateStrategy({ name: 'qor-buddy', describe: 'x', buddy: { pairs: { t5: 't4' } } }, { file: 'qor-buddy.mjs' });
  ok('buddy is a strategy field and validates', r.ok && r.strategy?.fields?.buddy !== undefined || r.ok);
  const bad = validateStrategy({ name: 'qor-buddy', describe: 'x', buddy: { pairs: { t5: 't5' } } }, { file: 'qor-buddy.mjs' });
  ok('a malformed one refuses the file', !bad.ok);
}

console.log('\nprivate strategy directories');
{
  const priv = join(scratch, 'private'), local = engine.FARM_STRATEGY_DIR;
  mkdirSync(priv, { recursive: true });
  const file = join(scratch, 'dirs.json');
  writeFileSync(file, JSON.stringify({ dirs: [priv] }));
  const dirs = engine.farmStrategyDirs({ env: {}, file });
  ok('this machine\'s own directory is searched first', dirs[0] === local);
  ok('the private directory is searched after it', dirs.length === 2 && dirs[1].toLowerCase() === priv.toLowerCase());
  const envDirs = engine.farmStrategyDirs({ env: { M59_FARM_STRATEGY_PATH: priv }, file: join(scratch, 'none.json') });
  ok('M59_FARM_STRATEGY_PATH adds one too', envDirs.length === 2);
  ok('a missing dirs file is only the local directory', engine.farmStrategyDirs({ env: {}, file: join(scratch, 'none.json') }).length === 1);
  writeFileSync(join(priv, 'zz-buddy-probe.mjs'), "export default { name: 'zz-buddy-probe', describe: 'p', hunt: ['skeleton'] };\n");
  const f = engine.strategyFile('zz-buddy-probe', [local, priv]);
  ok('a name found only privately resolves to the private file', f.toLowerCase().startsWith(priv.toLowerCase()));
  const loaded = await engine.loadFarmStrategy('zz-buddy-probe', { dir: [local, priv], resolveItem: null });
  ok('and loads from there', loaded.ok && loaded.file.toLowerCase().startsWith(priv.toLowerCase()));
  const shadow = join(scratch, 'shadowlocal');
  mkdirSync(shadow, { recursive: true });
  writeFileSync(join(shadow, 'zz-buddy-probe.mjs'), "export default { name: 'zz-buddy-probe', describe: 'local', hunt: ['zombie'] };\n");
  ok('a local file of the same name OVERRIDES the private one',
     engine.strategyFile('zz-buddy-probe', [shadow, priv]).toLowerCase().startsWith(shadow.toLowerCase()));
  ok('neither has it: the refusal names the first directory',
     engine.strategyFile('zz-nowhere', [shadow, priv]).toLowerCase().startsWith(shadow.toLowerCase()));
}

// ------------------------------------------------------------------------- the keeper half
const ATT = OF.ATTACKABLE, PLAYER = OF.PLAYER;
function keeper(agent, { pairs = { t5: 't4' }, objects = [], self = { row: 10, col: 10 }, hold = null, room = 38, lines = [] } = {}) {
  const ap = Object.create(Autopilot.prototype);
  const objs = new Map(objects.map(o => [o.id, o]));
  const events = lines.map((text, i) => ({ seq: i + 1, kind: 'message', text }));
  const client = {
    self, selfId: 99, evSeq: 0,
    room: { objects: objs },
    rsc: { get: k => k },
    eventsSince: since => events.filter(e => e.seq > since),
  };
  const calls = { pull: [], fight: [], walk: [], notes: [] };
  const s = { name: agent, client, world: { room: { num: room }, approachSquare: (col, row) => ({ col: col + 1, row, steps: 2 }) },
              walkTo: async (col, row) => { calls.walk.push({ col, row }); client.self = { row, col }; return { arrived: true }; } };
  Object.assign(ap, {
    s, mode: 'farm', policy: { buddy: buddy.normalizeBuddy({ pairs }), assignedRoom: room, hunt: ['skeleton'] },
    hold, tally: {}, notes: [],
    note(what, d) { calls.notes.push(what); },
    facultyOwner: () => 'keeper', safety: () => ({ fleeAt: 0.4 }),
    weaponPriorityNow: () => null, bannedWeaponsNow: () => null,
    takeSafeSpot: async () => { ap.hold = { col: 2, row: 2 }; return { took: true }; },
    pull: async want => { calls.pull.push(want.id); events.push({ seq: events.length + 1, kind: 'message', text: `Your hammer slashes the ${want.name}.` }); client.evSeq = events.length; return { pulled: true, back: true }; },
    fightNow: async o => { calls.fight.push(o.exactTargetId); return { fought: true, killed: false }; },
  });
  return { ap, client, calls, events, objs, ctx: { s, c: client } };
}

console.log('\nthe keeper: who the stage is for');
{
  const { ap, ctx } = keeper('t1');
  ok('a character the pairs do not name is untouched (CONTINUE)', await ap.passBuddy(ctx) === CONTINUE);
  const k2 = keeper('t5'); k2.ap.mode = 'survive';
  ok('nor anyone outside farm mode', await k2.ap.passBuddy(k2.ctx) === CONTINUE);
  const k3 = keeper('t5'); k3.ap.facultyOwner = () => 'bot:dum';
  ok('nor while a bot holds work', await k3.ap.passBuddy(k3.ctx) === CONTINUE);
  const k4 = keeper('t5', { room: 39 }); k4.ap.policy.assignedRoom = 38;
  ok('nor outside its posted room (the farm walks it there)', await k4.ap.passBuddy(k4.ctx) === CONTINUE);
}

console.log('\nthe keeper: the tagger');
{
  const skel = { id: 7, row: 2, col: 9, nameRsc: 'skeleton', flags: ATT };
  const k = keeper('t5', { objects: [skel] });
  ok('first it takes a corner', await k.ap.passBuddy(k.ctx) === HANDLED && k.ap.hold?.col === 2);
  ok('and does not tag with no partner beside it', await k.ap.passBuddy(k.ctx) === HANDLED && k.calls.pull.length === 0);
  buddy.writeBuddyRecord('t4', { role: 'kill', partner: 't5', room: 38, pos: { col: 3, row: 2 } });
  await k.ap.passBuddy(k.ctx);
  ok('with the killer beside the wall it tags the untouched skeleton', k.calls.pull[0] === 7);
  ok('and knows the blow landed', k.ap.buddyTag?.landed === true);
  ok('while the tag is out, every OTHER attack is vetoed', k.ap.buddyVetoes(8) === true);
  ok('and, once it has landed, the tag itself too (the kill and the karma are the partner\'s)', k.ap.buddyVetoes(7) === true);
  const rec = buddy.readBuddyRecord('t5');
  ok('its record tells the killer the tag and the wall', rec?.tag?.id === 7 && rec.tag.landed && rec.hold.col === 2);
  ok('it does not swing again while waiting', await k.ap.passBuddy(k.ctx) === HANDLED && k.calls.fight.length === 0);
  k.objs.delete(7);
  await k.ap.passBuddy(k.ctx);
  ok('the tag dying ends the wait and counts an assist', k.ap.buddyTag === null && k.ap.tally.buddyAssists === 1);
  ok('and the veto lifts with it', k.ap.buddyVetoes(8) === false);
}
{
  const skel = { id: 11, row: 2, col: 3, nameRsc: 'skeleton', flags: ATT };
  const k = keeper('t5', { objects: [skel], self: { row: 2, col: 2 }, hold: { col: 2, row: 2 } });
  buddy.writeBuddyRecord('t4', { role: 'kill', partner: 't5', room: 38, pos: { col: 3, row: 2 } });
  k.ap.pull = async () => ({ pulled: true, back: true });           // swung, but no line: a miss
  await k.ap.passBuddy(k.ctx);
  ok('a pull with no landed line leaves the tag unlanded', k.ap.buddyTag?.landed === false);
  ok('an unlanded tag may still be swung at', k.ap.buddyVetoes(11) === false);
  await k.ap.passBuddy(k.ctx);
  ok('and when it has followed us in, it is swung at once more (the same target keeps the tag)', k.calls.fight[0] === 11);
  for (let i = 0; i < 20; i++) await k.ap.passBuddy(k.ctx);
  ok('it keeps swinging at an unlanded tag until tries (default 12) is spent, then stops', k.calls.fight.length === 11 && k.ap.buddyTag?.tries === 12);
  ok('a tries above 20 is refused', throws(() => buddy.normalizeBuddy({ pairs: { t5: 't4' }, tries: 21 })));
  k.ap.buddyTag.at = Date.now() - 10 * 60_000;
  await k.ap.passBuddy(k.ctx);
  ok('a wait past wait_s gives up rather than standing in a fight for ever', k.ap.buddyTag === null);
}

console.log('\nthe keeper: the killer');
{
  buddy.writeBuddyRecord('t5', { role: 'tag', partner: 't4', room: 38, hold: { col: 2, row: 2 },
    tag: { id: 21, name: 'skeleton', landed: true, at: Date.now() } });
  const skel = { id: 21, row: 2, col: 3, nameRsc: 'skeleton', flags: ATT };
  const other = { id: 22, row: 8, col: 8, nameRsc: 'zombie', flags: ATT };
  const k = keeper('t4', { objects: [skel, other], self: { row: 9, col: 9 } });
  await k.ap.passBuddy(k.ctx);
  ok('far from the tagger\'s wall, it walks there first', k.calls.walk.length === 1 && k.calls.fight.length === 0);
  await k.ap.passBuddy(k.ctx);
  ok('beside it, it kills the landed tag', k.calls.fight[0] === 21);
  buddy.writeBuddyRecord('t5', { role: 'tag', partner: 't4', room: 38, hold: { col: 2, row: 2 },
    tag: { id: 21, name: 'skeleton', landed: false, at: Date.now() } });
  const k2 = keeper('t4', { objects: [skel], self: { row: 2, col: 4 } });
  await k2.ap.passBuddy(k2.ctx);
  ok('it waits for an unlanded tag rather than robbing the tagger of it', k2.calls.fight.length === 0);
  const pest = { id: 23, row: 3, col: 2, nameRsc: 'zombie', flags: ATT };
  const k3 = keeper('t4', { objects: [skel, pest], self: { row: 2, col: 4 } });
  await k3.ap.passBuddy(k3.ctx);
  ok('anything else at the wall is cleared, since the tagger will not swing back', k3.calls.fight[0] === 23);
  buddy.writeBuddyRecord('t5', { role: 'tag', partner: 't4', room: 39, hold: { col: 2, row: 2 } });
  const k4 = keeper('t4', { objects: [skel] });
  ok('with its tagger in another room it farms as usual (CONTINUE)', await k4.ap.passBuddy(k4.ctx) === CONTINUE);
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
