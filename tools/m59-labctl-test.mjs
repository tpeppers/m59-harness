#!/usr/bin/env node
// THE LAB CONTROLLERS. Offline: no DM socket, no server — every one takes an injected `dmFn`.
//
//   node tools/m59-labctl-test.mjs
//
// Three things worth pinning, all of which are the difference between a controller and a hope:
//
//   1. A ROOM THAT COULD NOT BE FOUND IS A REFUSAL. "I muted the room" and "I could not find the
//      room" must not look the same to a pad about to spend twenty minutes walking into it.
//   2. IT READS THE BODY BACK. UtilGoNearSquare searches outward and returns success for a square
//      that does not exist, so a clean reply is not a body on the square you named.
//   3. SPAWNS GO OFF FIRST. A room still breeding can put a monster in the square you are about
//      to stage somebody onto, between the clear and the placement.
import { setSpawns, spawnsOff, spawnsOn, holdInRoom, stageAt, stageRoom,
         formatStaging, objectOf, roomOf, assertLabCtl, GENERATION_MSG } from './m59-labctl.mjs';

const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};
const LAB = { M59_ADMIN_HOST: '127.0.0.1' };
const REMOTE = { M59_ADMIN_HOST: '10.0.0.7' };

// A fake admin socket. It ECHOES each command, because m59-dm's split() locates a reply by
// finding the command text in the stream — a fake that returns bare replies parses as "nothing
// was found for anybody", which is a full hour of confusion if you meet it for the first time
// inside a real test.
// AND IT SPEAKS BLAKSTON v2.4, BECAUSE A FAKE THAT LIES IS WORSE THAN NO FAKE.
//
// This fake used to answer `show name <x>` with `object N <x> row R col C` and `show room <n>` with
// an object id. The real server does neither: `show name` answers with an object id and NOTHING else,
// and `show room` is not a command at all. So `stageAt`'s read-back — which parsed row/col out of
// `show name` — passed nine assertions here while being incapable of ever working, and it never did
// work: every real call returned "could not read the body back", the relocate having succeeded. The
// test was green about a protocol that does not exist. ("Verify the value, not the instrument.")
//
// Positions live on the OBJECT: `piRow`, `piCol`, and the fine offset inside the square as
// `piFine_row`/`piFine_col` in KOD units, where 32 of 64 is dead centre. A room is found only THROUGH
// a body standing in it: body -> `poOwner` -> the room object -> `piRoom_num`.
const fake = (world) => {
  const sent = [];
  const objectBlock = (id, fields) =>
    [`:< OBJECT ${id} is CLASS ${fields.class ?? 'User'}`,
     ...Object.entries(fields).filter(([k]) => k !== 'class')
       .map(([k, v]) => `: ${k.padEnd(20)} = ${typeof v === 'number' ? `INT ${v}` : v}`),
     ':>'].join(NL);
  const roomObjOf = (num) => world.rooms?.[String(num)] ?? null;
  const nameOfObject = (id) =>
    Object.keys(world.names ?? {}).find((n) => world.names[n] === Number(id)) ?? null;
  const reply = (c) => {
    let m = /^show name (.+)$/.exec(c);
    // The real reply: an object id, full stop. No name, no position.
    if (m) return world.names?.[m[1]] != null ? `:< object ${world.names[m[1]]}${NL}:>` : 'not found';
    m = /^show room (\d+)$/.exec(c);
    // v2.4 has no `show room` at all, so roomOf must go via a body. An older server DOES answer it,
    // and roomOf keeps that path — both are exercised, because dropping the legacy path would be a
    // silent capability loss on whatever server still has it.
    if (m) return world.legacyShowRoom
      ? (world.rooms?.[m[1]] != null ? `object ${world.rooms[m[1]]} room` : 'no such room')
      : 'unknown command';
    m = /^show object (\d+)$/.exec(c);
    if (m) {
      const id = Number(m[1]);
      const who = nameOfObject(id);
      if (who) {
        const at = world.at?.[who] ?? {};
        const owner = roomObjOf(at.room ?? Object.keys(world.rooms ?? {})[0]);
        return objectBlock(id, {
          self: `OBJECT ${id}`,
          ...(owner != null ? { poOwner: `OBJECT ${owner}` } : {}),
          piRow: at.row ?? 0, piCol: at.col ?? 0,
          piFine_row: at.fineRow ?? 32, piFine_col: at.fineCol ?? 32,
        });
      }
      // A room object: the only field roomOf wants off it, and it VERIFIES it against what was asked.
      const num = Object.keys(world.rooms ?? {}).find((n) => world.rooms[n] === id);
      if (num != null) return objectBlock(id, { class: 'Room', piRoom_num: Number(num) });
      return 'not found';
    }
    return world.refuse ? world.refuse : 'ok';
  };
  const dmFn = async (cmds) => { sent.push(...cmds); return cmds.map(c => `${c}${NL}${reply(c)}`).join(NL); };
  return { dmFn, sent };
};

console.log(NL + 'every controller refuses off a lab BEFORE it sends anything');
{
  const threw = async (f) => { try { await f(); return null; } catch (e) { return e.message; } };
  ok('assertLabCtl allows loopback', assertLabCtl(LAB).host === '127.0.0.1');
  const why = await threw(() => setSpawns(45, false, { dmFn: async () => 'ok', env: REMOTE }));
  ok('setSpawns refuses a remote admin target', !!why);
  ok('and says these set the world by fiat', /by fiat/.test(why), why);
  ok('and calls the alternative an incident', /incident/.test(why));

  const f = fake({ rooms: { 45: 900 } });
  await threw(() => stageAt('Marco', 45, { row: 1, col: 1 }, { dmFn: f.dmFn, env: REMOTE }));
  ok('NOTHING WAS SENT on the refused path', f.sent.length === 0, f.sent.join(' | '));
}

console.log(NL + '1. A ROOM THAT COULD NOT BE FOUND IS A REFUSAL, NOT A QUIET NO-OP');
{
  const f = fake({ rooms: {} });
  const r = await setSpawns(45, false, { dmFn: f.dmFn, env: LAB });
  ok('it refuses', r.ok === false);
  ok('it says the spawners were NOT touched', /were NOT/.test(r.why), r.why);
  ok('and warns against reading it as success',
     /do not read this as/.test(r.why), r.why);
  ok('and no SetMonsterGeneration went out',
     !f.sent.some(c => c.includes(GENERATION_MSG)), f.sent.join(' | '));
}

console.log(NL + 'spawns off sends the supported MESSAGE, not a poke at the property');
{
  // ON v2.4 THIS NEEDS A `via`, AND WITHOUT ONE IT MUST REFUSE RATHER THAN GUESS. A room is findable
  // only through a body standing in it, so "mute room 45" with nobody named is a question this server
  // cannot answer — and answering it anyway is what a silent no-op would be.
  const blind = fake({ rooms: { 45: 900 }, names: { Marco: 7124 }, at: { Marco: { row: 60, col: 46, room: 45 } } });
  const nope = await spawnsOff(45, { dmFn: blind.dmFn, env: LAB });
  ok('with no via on a v2.4 server it refuses', nope.ok === false, JSON.stringify(nope));
  ok('and no SetMonsterGeneration went out', !blind.sent.some(c => c.includes(GENERATION_MSG)));

  const f = fake({ rooms: { 45: 900 }, names: { Marco: 7124 }, at: { Marco: { row: 60, col: 46, room: 45 } } });
  const r = await spawnsOff(45, { dmFn: f.dmFn, env: LAB, via: 'Marco' });
  ok('it succeeds', r.ok === true, JSON.stringify(r));
  ok('it resolved the room', r.object === 900);
  const cmd = f.sent.find(c => c.includes(GENERATION_MSG));
  ok('it sent SetMonsterGeneration', !!cmd, f.sent.join(' | '));
  ok('to the room object', /900/.test(cmd), cmd);
  ok('with bValue INT 0 — the admin socket syntax', /bValue INT 0/.test(cmd), cmd);
  // The property poke is the OTHER way and is deliberately not used: the cap is read elsewhere,
  // and a room left at 0 looks configured rather than muted.
  ok('and it did NOT poke piMonster_count_max',
     !f.sent.some(c => /piMonster_count_max/.test(c)), f.sent.join(' | '));

  const on = fake({ rooms: { 45: 900 }, names: { Marco: 7124 }, at: { Marco: { row: 60, col: 46, room: 45 } } });
  await spawnsOn(45, { dmFn: on.dmFn, env: LAB, via: 'Marco' });
  ok('spawnsOn is the same message with 1',
     /bValue INT 1/.test(on.sent.find(c => c.includes(GENERATION_MSG))));

  // AND THE LEGACY PATH STILL WORKS WITHOUT A via, which is the only reason roomOf keeps it.
  const old = fake({ rooms: { 45: 900 }, legacyShowRoom: true });
  const leg = await spawnsOff(45, { dmFn: old.dmFn, env: LAB });
  ok('on a server where `show room` IS a command, no via is needed', leg.ok === true, JSON.stringify(leg));
  ok('...resolving the same room object', leg.object === 900);

  // A body in the WRONG room must not resolve the room asked about — roomOf verifies piRoom_num.
  const elsewhere = fake({ rooms: { 45: 900, 46: 901 },
                           names: { Marco: 7124 }, at: { Marco: { row: 1, col: 1, room: 46 } } });
  const wrong = await spawnsOff(45, { dmFn: elsewhere.dmFn, env: LAB, via: 'Marco' });
  ok('a via standing in a DIFFERENT room resolves nothing', wrong.ok === false, JSON.stringify(wrong));
}

console.log(NL + 'holding a room stops the clocks of what resolved, and names what did not');
{
  const f = fake({ names: { 'giant rat': 7001, 'orc': 7002 } });
  const r = await holdInRoom(['giant rat', 'orc', 'a ghost long gone'], { dmFn: f.dmFn, env: LAB });
  ok('it held the two that exist', r.held.length === 2, JSON.stringify(r.held));
  ok('and named the one that does not', r.missing.includes('a ghost long gone'));
  const holds = f.sent.filter(c => c.includes('ClearBasicTimers'));
  ok('two holds went out', holds.length === 2, holds.join(' | '));
  ok('addressed by resolved id', /7001/.test(holds[0]) || /7001/.test(holds[1]));
  ok('an empty list is a no-op rather than an error',
     (await holdInRoom([], { dmFn: f.dmFn, env: LAB })).ok === true);
}

console.log(NL + '2. IT READS THE BODY BACK — the server never says no');
{
  // The square was standable: it landed where it was asked.
  const good = fake({ names: { Marco: 7124 }, rooms: { 45: 900 }, at: { Marco: { row: 60, col: 46 } } });
  const r = await stageAt('Marco', 45, { row: 60, col: 46 }, { dmFn: good.dmFn, env: LAB });
  ok('it reports where it landed', r.landed?.row === 60 && r.landed?.col === 46, JSON.stringify(r));
  ok('and marks it exact', r.exact === true);
  ok('with no complaint', r.why === null);

  // THE CASE THAT MATTERS: UtilGoNearSquare searched outward and put him somewhere else.
  const slid = fake({ names: { Marco: 7124 }, rooms: { 45: 900 }, at: { Marco: { row: 58, col: 44 } } });
  const s = await stageAt('Marco', 45, { row: 60, col: 46 }, { dmFn: slid.dmFn, env: LAB });
  ok('a body that landed elsewhere is NOT exact', s.exact === false);
  ok('it is still ok — somebody was moved', s.ok === true);
  ok('and it says what was asked and what happened',
     /asked for r60c46 and it landed on r58c44/.test(s.why), s.why);
  ok('and explains the searched-outward behaviour', /searched outward/.test(s.why));

  const gone = fake({ names: {}, rooms: { 45: 900 } });
  const g = await stageAt('Nobody', 45, { row: 1, col: 1 }, { dmFn: gone.dmFn, env: LAB });
  ok('an unknown character is a refusal', g.ok === false && /was not found/.test(g.why), g.why);

  let threw = null;
  try { await stageAt('Marco', 45, {}, { dmFn: good.dmFn, env: LAB }); } catch (e) { threw = e.message; }
  ok('missing coordinates are refused', !!threw);
  ok('and the refusal names the axis order', /row,col in KOD order/.test(threw), threw);
}

console.log(NL + '3. SPAWNS GO OFF FIRST, and a failure there stops the sequence');
{
  const f = fake({ names: { Marco: 7124, 'giant rat': 7001 }, rooms: { 45: 900 },
                   at: { Marco: { row: 60, col: 46 } } });
  const r = await stageRoom(45, { spawns: 'off', hold: ['giant rat'],
                                  place: { name: 'Marco', row: 60, col: 46 },
                                  dmFn: f.dmFn, env: LAB });
  ok('the whole sequence succeeds', r.ok === true, JSON.stringify(r.steps));
  const order = f.sent.filter(c => !/^show /.test(c));
  ok('SetMonsterGeneration came first', order[0].includes(GENERATION_MSG), order.join(' | '));
  ok('then the hold', order[1].includes('ClearBasicTimers'), order.join(' | '));
  ok('then the placement', /UtilGoNearSquare/.test(order[2]), order.join(' | '));
  ok('and the placement uses m59-dm’s own relocate form, not a second spelling',
     /what OBJECT 7124 where OBJECT 900 new_row INT 60 new_col INT 46/.test(order[2]), order[2]);

  // A room that cannot be muted stops everything: staging into a breeding room is the bug.
  const bad = fake({ names: { Marco: 7124 }, rooms: {} });
  const b = await stageRoom(45, { spawns: 'off', place: { name: 'Marco', row: 1, col: 1 },
                                  dmFn: bad.dmFn, env: LAB });
  ok('a room that will not mute stops the sequence', b.ok === false);
  ok('AND NOBODY WAS STAGED INTO IT',
     !bad.sent.some(c => /UtilGoNearSquare/.test(c)), bad.sent.join(' | '));
  ok('the render leads with the failure', /STAGING FAILED/.test(formatStaging(b)), formatStaging(b));
  ok('and a good one reads plainly', /^staged/.test(formatStaging(r)), formatStaging(r));
}

console.log(NL + `${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
