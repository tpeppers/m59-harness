#!/usr/bin/env node
// TOUCH SPELL TRAINING — offline, no socket, no roster.
//
//   node tools/m59-touchspell-test.mjs
//
// The operator, 2026-10-02: a touch spell is a weapon replacement, so training one means the
// hand stays empty, the personal buff stays on, and a swing that reads "Your punch ..." rather
// than "Your acid touch ..." is the keeper's cue that the buff is off. Use case: Camilla (t9), a
// Qor disciple farming living trees in room 536, building acid touch.
//
// What this pins, against a fake client that behaves like the server's prose:
//   * the kod facts the keeper relies on (messages, costs) are classified as the server words them;
//   * entering training on the assigned room unuses a wielded weapon;
//   * the touch is cast on OURSELVES, by our numeric object id;
//   * a "Your punch" line triggers a recast; the STOP line flips the state and triggers a recast;
//   * a cast is counted only on proof (start line / mana / reagent), and is rate-limited;
//   * nothing re-equips on the assigned room — equipBest, armSelf, makeWeapon, fightNow;
//   * off the room the ordinary arming rules stand;
//   * the policy field exists in the default object (so a push is reflected), round-trips
//     through the keeper's POST /policy merge, and the broker validates and sets it.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'm59-touchspell-test-'));
process.env.M59_LEDGER_DIR = join(dir, 'ledger');
process.env.M59_PVP_HOLD_DIR = join(dir, 'holds');
process.env.M59_TOUCH_RECAST_MS = '10000';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' -- ' + detail : ''}`);
};

let touch = null, Autopilot = null, CONTINUE = null, skills = null;
try {
  touch = await import('./m59-touchspell.mjs');
  ({ Autopilot, CONTINUE } = await import('./m59-autopilot.mjs'));
  skills = await import('./m59-skills.mjs');
} catch (e) {
  ok('the touch spell module loads', false, e.message);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

// ------------------------------------------------------------------ the kod's words
console.log('the server\'s words');
{
  const k = (t) => touch.classifyTouchLine(t, 'acid touch');
  ok('START: acidtch.kod:26', k('The corrosive spittle of Qor\'s love oozes from the pores of your hand.') === 'start');
  ok('STOP: acidtch.kod:27', k('Your hands no longer drip with acidic ooze.') === 'stop');
  ok('ALREADY: acidtch.kod:28', k('Your hands are already dripping with acidic ooze.') === 'already');
  ok('a landed touch: "Your acid touch burns the living tree."', k('~bYour acid touch burns the living tree.') === 'touch');
  ok('a landed punch: "Your punch slaps the living tree."', k('~bYour punch slaps the living tree.') === 'punch');
  ok('a wielded weapon: "Your mace crushes ..."', k('Your mace crushes the living tree.') === 'weapon');
  ok('a miss names no weapon, so it proves nothing', k('The living tree dodges your attack.') === null);
  ok('a touch kill replaces "You killed"', k('The living tree screams and melts into an unobtrusive puddle.') === 'touch');
  ok('acid touch costs 10 mana and one entroot berry', touch.TOUCH_SPELLS['acid touch'].mana === 10
     && touch.TOUCH_SPELLS['acid touch'].reagents[0].item === 'entroot berry');
  ok('five touch spells, all named', touch.TOUCH_SPELL_NAMES.length === 5);
  ok('an unknown name is refused, not switched off', (() => { try { touch.touchSpellName('acid tuoch'); return false; } catch { return true; } })());
  ok('null and "" are off', touch.touchSpellName(null) === null && touch.touchSpellName('') === null);
  ok('case and spacing are forgiven', touch.touchSpellName('  Acid   Touch ') === 'acid touch');
}

// ------------------------------------------------------------------ a fake server
const SELF = 4471, MACE = 801, BERRY = 802, SPELL = 900, OTHER = 2599;
const ON = 'The corrosive spittle of Qor\'s love oozes from the pores of your hand.';
const OFF = 'Your hands no longer drip with acidic ooze.';
function world({ room = 536, armed = true, mana = 40, berries = 5, castWorks = true } = {}) {
  const names = { r_mace: 'mace', r_berry: 'entroot berry', r_acid: 'acid touch', r_me: 'Camilla' };
  const log = { cast: [], unuse: [], use: [] };
  const c = {
    selfId: SELF, me: { name: 'Camilla' }, events: [], evSeq: 0,
    room: { id: 1234, objects: new Map() },
    rsc: { get: (r) => names[r] ?? '' },
    inventory: [
      { id: MACE, nameRsc: 'r_mace', name: 'mace' },
      { id: BERRY, nameRsc: 'r_berry', name: 'entroot berry', amount: berries },
    ],
    spells: [{ id: SPELL, nameRsc: 'r_acid' }],
    using: new Set(armed ? [MACE] : []),
    manaNow: mana,
    vitals() { return { health: { value: 60, max: 60 }, mana: { value: this.manaNow, max: 40 },
                        vigor: { value: 190, max: 200 } }; },
    equipment() {
      return { known: true, equipped: [...this.using].map(id => ({ id, name: id === MACE ? 'mace' : 'thing' })) };
    },
    say(text) { this.events.push({ seq: ++this.evSeq, kind: 'message', text, at: Date.now() }); },
    eventsSince(since = 0) { return this.events.filter(e => e.seq > since); },
    async waitFor() { return { events: [] }; },
    requestInventory() {}, requestSpells() {}, stand() {},
    unuse(id) { log.unuse.push(id); this.using.delete(id); this.events.push({ seq: ++this.evSeq, kind: 'equipment' }); },
    use(id) { log.use.push(id); this.using.add(id); },
    cast(spellId, targets) {
      log.cast.push({ spellId, targets: [...targets] });
      if (!castWorks) return;
      // The server: takes 10 mana and a berry up front, then announces the enchantment.
      this.manaNow -= 10;
      const b = this.inventory.find(o => o.id === BERRY); if (b) b.amount -= 1;
      this.say(ON);
    },
  };
  const s = { name: 't9', live: true, client: c, need: () => c,
              pacer: { submit: async (_k, fn) => fn() },
              world: { room: { num: room, name: `room ${room}` }, geometry: null } };
  const ap = new Autopilot(s, { mode: 'farm', policy: { hunt: 'living tree', touchSpell: 'acid touch' } });
  ap.policy.assignedRoom = 536;
  ap.settledIn = room;
  return { ap, s, c, log };
}

// ------------------------------------------------------------------ entering training
console.log('entering training on the assigned room');
{
  const { ap, s, c, log } = world();
  ok('training here: farm mode, room 536 = assignment', ap.touchTrainingHere() === true);
  ok('the regimen in force is bare hands', ap.trainingStyleFor() === 'unarmed');
  const v = await ap.passArm({ s, c, room: s.world.room });
  ok('passArm continues the ladder', v === CONTINUE);
  ok('a wielded weapon is unused on entering training', log.unuse.includes(MACE) && !skills.isArmed(c),
     JSON.stringify(log.unuse));

  const r = await ap.maintainTouchSpell('test');
  ok('the touch is cast once', log.cast.length === 1, JSON.stringify(log.cast));
  ok('...at our own numeric object id, never a name and never "me"',
     log.cast[0]?.spellId === SPELL && log.cast[0]?.targets.length === 1 && log.cast[0]?.targets[0] === SELF);
  ok('...and counted landed on proof (the START line)', r.landed === true && ap.touchState().active === true
     && ap.touchState().lastStart != null && ap.touchState().recasts === 1);

  await ap.maintainTouchSpell('test');
  ok('an active touch is not recast', log.cast.length === 1);

  // "Your punch" — the server says the touch is not on, whatever we believed.
  c.say('~bYour punch slaps the living tree.');
  ap.touchState().lastCastAt = Date.now() - 60_000;       // past the rate limit
  await ap.maintainTouchSpell('test');
  ok('a "your punch" line flips it inactive and triggers a recast', log.cast.length === 2
     && ap.touchState().recasts === 2, JSON.stringify(ap.touchSpellStatus()));
  ok('...and resets punches_since_cast once the recast lands', ap.touchState().punchesSinceCast === 0);

  // The touch hits are counted.
  c.say('~bYour acid touch burns the living tree.');
  c.say('~bYour acid touch sears the living tree.');
  ap.observeTouchSpell(c);
  ok('touch hits are counted from the combat log', ap.touchState().touchHits === 2);

  // STOP.
  c.say(OFF);
  ap.observeTouchSpell(c);
  ok('the STOP message flips the state to inactive', ap.touchState().active === false
     && ap.touchState().lastStop != null);
  ap.touchState().lastCastAt = Date.now() - 60_000;
  await ap.maintainTouchSpell('test');
  ok('...and triggers a recast', log.cast.length === 3 && ap.touchState().active === true);

  const st = ap.status().touch_spell;
  ok('status reports touch_spell with every field', st && st.name === 'acid touch' && st.active === true
     && 'last_start' in st && 'last_stop' in st && 'punches_since_cast' in st && st.touch_hits === 2
     && st.recasts === 3 && 'blocked_reason' in st, JSON.stringify(st));
}

// ------------------------------------------------------------------ rate limit and proof
console.log('rate limit, proof, and what it cannot afford');
{
  const { ap, c, log } = world({ armed: false, castWorks: false });
  await ap.maintainTouchSpell('test');
  ok('a cast that spends nothing is NOT counted as landed', log.cast.length === 1
     && ap.touchState().active !== true && ap.touchState().castsUnproven === 1
     && /no trace/.test(ap.touchState().blockedReason ?? ''));
  await ap.maintainTouchSpell('test');
  ok('and is not retried inside the rate limit', log.cast.length === 1);
  // A punch inside the window does not bypass the limit either.
  c.say('Your punch slaps the living tree.');
  await ap.maintainTouchSpell('test');
  ok('a punch inside the window waits for it too (no spam)', log.cast.length === 1);
}
{
  const { ap, log } = world({ armed: false, mana: 4 });
  const r = await ap.maintainTouchSpell('test');
  ok('short of mana: no cast, and the reason is on the status', log.cast.length === 0 && r.blocked === 'not enough mana'
     && ap.status().touch_spell.blocked_reason === 'not enough mana');
}
{
  const { ap, log } = world({ armed: false, berries: 0 });
  const r = await ap.maintainTouchSpell('test');
  ok('short of entroot berries: no cast, and it says which', log.cast.length === 0 && /entroot/.test(r.blocked ?? ''));
}
{
  // ALREADY settles an unknown state at no cost (a keeper restart while the touch was on).
  const { ap, c, log } = world({ armed: false });
  c.cast = (id, t) => { log.cast.push({ spellId: id, targets: t }); c.say('Your hands are already dripping with acidic ooze.'); };
  await ap.maintainTouchSpell('test');
  ok('"already" reads as active, not as a failed cast', ap.touchState().active === true
     && ap.touchState().castsUnproven === 0 && ap.touchState().recasts === 0);
}

// ------------------------------------------------------------------ nothing re-arms
console.log('nothing re-equips on the assigned room');
{
  const { ap, s, c, log } = world({ armed: false });
  const eq = await skills.equipBest(s, { priority: null, banned: null });
  ok('equipBest is vetoed (equip_best, a gift, a rescue plea, a magic swap)', eq.vetoed === true && !log.use.length,
     JSON.stringify(eq).slice(0, 160));
  ok('armSelf stays bare on purpose', await ap.armSelf() === true && !log.use.length && !skills.isArmed(c));
  await ap.makeWeapon('test');
  ok('makeWeapon declines to conjure', !log.cast.length);
  const src = readFileSync(join(HERE, 'm59-autopilot.mjs'), 'utf8');
  ok('fightNow (fight-back, blockers, levers) fights with equip:false here',
     /fightNow\(opts\) \{\s*const o = \(this\.touchTrainingHere\(\) && opts\?\.equip === undefined\) \? \{ \.\.\.opts, equip: false \}/.test(src));
  ok('the player-target fight does too', /\.\.\.\(this\.touchTrainingHere\(\) \? \{ equip: false \} : \{\}\)/.test(src));
  ok('the prey fight maintains the touch before swinging',
     /if \(this\.touchTrainingHere\(\)\)\s*await this\.maintainTouchSpell\(/.test(src));
}

// ------------------------------------------------------------------ off the room
console.log('off the assigned room, the ordinary rules');
{
  const { ap, s, c, log } = world({ room: 600, armed: false });
  ok('not training here', ap.touchTrainingHere() === false && ap.touchEquipVeto() === null);
  ok('the regimen is the configured one, not bare hands', ap.trainingStyleFor() === 'normal');
  const eq = await skills.equipBest(s, { priority: null, banned: null, refresh: false });
  ok('travel can still arm: equipBest wields the mace', !eq.vetoed && log.use.includes(MACE),
     JSON.stringify(eq).slice(0, 200));
  await ap.maintainTouchSpell('test');
  ok('and no touch is cast off the room', !log.cast.length);
}
{
  const { ap } = world();
  ap.mode = 'survive';
  ok('not in farm mode: not training', ap.touchTrainingHere() === false);
  ap.mode = 'farm'; ap.policy.touchSpell = null;
  ok('touch_spell null: inert, status null', ap.touchTrainingHere() === false && ap.status().touch_spell === null);
}

// ------------------------------------------------------------------ the policy surfaces
console.log('the policy surfaces');
{
  const fresh = new Autopilot({ name: 'x', client: null, world: { room: null } }, { mode: 'farm' });
  ok('touchSpell is a key of the default policy object (so a push is reflected)',
     Object.hasOwn(fresh.policy, 'touchSpell') && fresh.policy.touchSpell === null);
  // The keeper's POST /policy is Object.assign(autopilot.policy, fields): what the broker pushes.
  const pushed = { touchSpell: 'acid touch' };
  Object.assign(fresh.policy, pushed);
  fresh.policy.assignedRoom = 536;
  fresh.s.world.room = { num: 536 };
  ok('a pushed touchSpell round-trips and takes effect on the next decision',
     fresh.policy.touchSpell === 'acid touch' && fresh.touchTrainingHere() === true);
  const keeper = readFileSync(join(HERE, 'm59-keeper-process.mjs'), 'utf8');
  ok('the keeper merges pushed fields into autopilot.policy', /Object\.assign\(autopilot\.policy, fields\)/.test(keeper));

  const broker = readFileSync(join(HERE, 'm59-broker.mjs'), 'utf8');
  ok('the autopilot schema declares touch_spell', /touch_spell: \{ type: \['string', 'null'\],\s*enum: \[\.\.\.TOUCH_SPELL_NAMES, null\]/.test(broker));
  ok('the setter validates and writes p.policy.touchSpell',
     /p\.policy\.touchSpell = touchSpellName\(a\.touch_spell\)/.test(broker));
  const { reflectPolicy } = await import('./m59-policy-controls.mjs');
  const fakeTool = { schema: { properties: { touch_spell: { type: ['string', 'null'] } } },
                     run: () => 'p.policy.touchSpell = touchSpellName(a.touch_spell)' };
  const spec = reflectPolicy(fakeTool, [fresh.policy]).find(sp => sp.id === 'touch_spell');
  ok('policy_control reflects it onto policy.touchSpell', spec?.policy === 'touchSpell');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
