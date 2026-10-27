#!/usr/bin/env node
// RESCUE INSTEAD OF A SIP ON THE ISLAND RIDE -- offline, against a fake broker that plays the server's lines.
//
//   node tools/m59-island-rescue-test.mjs
//
// Operator, 2026-10-27: "anyone who knows rescue doesn't need to grab a chalice they can just go in the first lap and
// bring 5 emeralds and cast rescue when the chalice would be drank during the trip". What this pins
// (tools/m59-island-chalice.mjs rescueReady / rideMode / castTo):
//   * ready only with the spell known, karma >= +30 (spell.kod KarmaCheck) and an emerald per leg; unreadable is a no;
//   * auto: one full cup rides the cup; no cup and rescue ready rides rescue; neither refuses naming why;
//   * a ride by rescue casts at 2500 and 2510, lands in 2510 then 2001 exactly as the sips do, retries a failed roll,
//     drinks the pool between, and skips the jungle refill (no cup to refill);
//   * a karma refusal and a PvP lockout stop the ride at once.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};
const I = await import('./m59-island-chalice.mjs');

function fakeBroker({ knows = true, karma = 40, emeralds = 5, cup = false, rolls = ['fail', 'start'], spells = 'list', karmaRefuse = false } = {}) {
  const st = { room: 2500, row: 10, col: 10, hp: 30, max: 30, casts: 0, rolls: [...rolls], log: [], pendingTo: null, landAt: 0 };
  const items = [{ id: 11, name: 'emerald', amount: emeralds }, ...(cup ? [{ id: 12, name: 'chalice of the rain' }] : [])];
  const call = async (name, a = {}) => {
    st.log.push(name === 'cast' ? `cast ${a.spell}` : name);
    if (name === 'abilities') return spells === 'unreadable' ? { spells: null, spells_unreadable: 'not yet' }
      : { spells: knows ? [{ name: 'rescue', ability: 8 }] : [{ name: 'blink', ability: 40 }] };
    if (name === 'status') return { karma: { value: karma } };
    if (name === 'inventory') return { items };
    if (name === 'look_at') return { id: a.target, description: 'It is filled to the brim with pure water.' };
    if (name === 'rest') return { ok: true };
    if (name === 'look') {
      if (st.pendingTo && Date.now() >= st.landAt) { st.room = st.pendingTo; st.pendingTo = null; }
      return { room: { num: st.room }, you: { row: st.row, col: st.col }, hp: { value: st.hp, max: st.max } };
    }
    if (name === 'cast') {
      if (karmaRefuse) return { cast: false, reason: 'your karma is 5; rescue needs >= +30' };
      const r = st.rolls.shift() ?? 'start';
      if (r === 'fail') return { cast: true, messages: ['You were unsuccessful in casting rescue.'], mana_spent: 8 };
      if (r === 'lockout') return { cast: true, messages: ["You've attacked a player too recently."] };
      st.casts++;
      st.pendingTo = st.room === 2500 ? 2510 : st.room === 2510 ? 2001 : null;
      st.landAt = Date.now() + 50;
      return { cast: true, messages: ['You start your rescue preparations.'], mana_spent: 16 };
    }
    if (name === 'safe_spots') return { room: { num: st.room }, standing_at: { row: st.row, col: st.col },
      spots: [{ row: st.row, col: st.col, can_reach_you: 0, rim: false, distance: 0 }] };
    if (name === 'autopilot') return { ok: true };
    throw new Error(`fake broker: ${name} not modelled`);
  };
  return { st, ctx: { agent: 't2', call, state: {}, rescueTries: 4 } };
}

console.log('who may ride by rescue');
ok('known, karma 40, 5 emeralds: ready', (await I.rescueReady(fakeBroker().ctx)).ok === true);
ok('does not know rescue: no', /does not know rescue/.test((await I.rescueReady(fakeBroker({ knows: false }).ctx)).why));
ok('karma 20: no (rescue needs +30)', /karma 20, rescue needs \+30/.test((await I.rescueReady(fakeBroker({ karma: 20 }).ctx)).why));
ok('one emerald for two casts: no', /1 emerald\(s\) for 2 casts/.test((await I.rescueReady(fakeBroker({ emeralds: 1 }).ctx)).why));
ok('an unreadable spell list is a no, never "does not know"', /not readable yet/.test((await I.rescueReady(fakeBroker({ spells: 'unreadable' }).ctx)).why));

console.log('which way to ride');
ok('one full cup: the cup', await I.rideMode(fakeBroker({ cup: true }).ctx) === 'cup');
ok('no cup, rescue ready: rescue', await I.rideMode(fakeBroker().ctx) === 'rescue');
let why = null; try { await I.rideMode(fakeBroker({ knows: false }).ctx); } catch (e) { why = e.message; }
ok('neither: refused, naming both', /requires_exactly_one_chalice_or_rescue: .*does not know rescue/.test(why ?? ''), why);
why = null; try { await I.rideMode(fakeBroker({ cup: true, karma: 0 }).ctx, 'rescue'); } catch (e) { why = e.message; }
ok('mode rescue insists on rescue even with a cup', /rescue_not_ready: karma 0/.test(why ?? ''), why);

console.log('the ride, by rescue');
{
  const dir = mkdtempSync(join(tmpdir(), 'm59-island-rescue-'));
  const f = fakeBroker({ rolls: ['fail', 'start', 'start'] });
  // The pool drink needs the pool: model it as a no-op for this ride.
  const r = await I.rideIslandCup({ ...f.ctx, call: async (n, a) => n === 'go' || n === 'walk_to' || n === 'say' ? { ok: true } : f.ctx.call(n, a) },
    { evidenceDir: dir }).catch(e => ({ error: e.message }));
  ok('it lands in 2001 having cast at 2500 and 2510', r?.ok === true && f.st.room === 2001 && f.st.casts === 2, JSON.stringify(r).slice(0, 200));
  ok('a failed roll is retried, not fatal', f.st.log.filter(x => x === 'cast rescue').length === 3, f.st.log.join(','));
  ok('no jungle refill: a rescuer carries no cup', !f.st.log.includes('drop') && !f.st.log.some(x => /refill/.test(x)));
}
{
  const f = fakeBroker({ karmaRefuse: true });
  const dir = mkdtempSync(join(tmpdir(), 'm59-island-rescue-'));
  // karma reads 40 to the readiness probe but the server refuses: the cast's own answer wins, and the ride stops.
  const r = await I.rideIslandCup(f.ctx, { evidenceDir: dir }).catch(e => ({ error: e.message }));
  ok('a karma refusal stops the ride at once', /rescue_karma/.test(r?.error ?? ''), r?.error);
}
{
  const f = fakeBroker({ rolls: ['lockout'] });
  const dir = mkdtempSync(join(tmpdir(), 'm59-island-rescue-'));
  const r = await I.rideIslandCup(f.ctx, { evidenceDir: dir }).catch(e => ({ error: e.message }));
  ok('a PvP teleport lockout stops it too', /pvp_teleport_lockout/.test(r?.error ?? ''), r?.error);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
