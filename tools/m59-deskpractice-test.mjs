#!/usr/bin/env node
// THE DESK'S PRACTICE RESERVE — offline, no socket, no roster.
//
//   node tools/m59-deskpractice-test.mjs
//
// WHAT THIS PINS. The operator's rule is one sentence — keep enough mana for two casts of the
// dearest service — and each way of getting it subtly wrong is a case below:
//
//   * the reserve is read off the MENU, so switching a service off lowers it;
//   * a service the caster does not KNOW reserves nothing, or the drill idles for a spell it
//     could never serve;
//   * the costs come from the kod catalogue, so the numbers here are the kod's, checked;
//   * a cast that would land exactly ON the reserve is allowed, one below is not;
//   * reagents the desk needs are kept back too, on top of the Rescue emeralds;
//   * a reserve at or above max mana is said out loud rather than read as "no mana yet".
import {
  PRACTICE_DEFAULTS, SERVICE_SPELLS, choosePractice, deskReserve, loadCatalogue,
  normalizePractice, offeredServices, reagentName, spellCost, pickCreatureTarget,
} from './m59-deskpractice.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? '  ' + extra : ''}`); }
};

const cat = loadCatalogue();
const DESK = { enabled: true, uncurse: true, reveal: true, fol_room: 38 };
const ALL = ['remove curse', 'reveal', 'forces of light', 'holy symbol', 'purify', 'detect evil'];
const have = (counts) => (item) => counts[item] ?? 0;

console.log('\nthe catalogue is the kod, read rather than typed');
{
  ok('the spell catalogue loaded', cat.size > 100, `size ${cat.size}`);
  ok('reveal is 30 mana, 3 orc teeth', JSON.stringify(spellCost('reveal')) ===
     JSON.stringify({ name: 'reveal', mana: 30, reagents: [['orc tooth', 3]] }), JSON.stringify(spellCost('reveal')));
  ok('remove curse is 9 mana, 1 emerald', spellCost('remove curse')?.mana === 9);
  ok('forces of light is 12 mana, 2 elderberry + 1 emerald',
     JSON.stringify(spellCost('forces of light')?.reagents) === JSON.stringify([['elderberry', 2], ['emerald', 1]]));
  ok('ElderBerry is the pack\'s elderberry', reagentName('ElderBerry') === 'elderberry');
  ok('Herbs matches the pack\'s herb', reagentName('Herbs') === 'herb');
  ok('OrcTooth is orc tooth', reagentName('OrcTooth') === 'orc tooth');
  ok('FairyWing is fairy wing', reagentName('FairyWing') === 'fairy wing');
  ok('every desk service names a spell the catalogue prices',
     Object.values(SERVICE_SPELLS).every(s => spellCost(s.spell)));
}

console.log('\nthe menu decides the reserve');
{
  ok('a full desk offers uncurse, reveal, fol', offeredServices(DESK).join() === 'uncurse,reveal,fol');
  ok('no fol room, no fol', !offeredServices({ ...DESK, fol_room: null }).includes('fol'));
  ok('a disabled chalice offers nothing', offeredServices({ ...DESK, enabled: false }).length === 0);
  ok('no chalice at all offers nothing', offeredServices(null).length === 0);

  const r = deskReserve({ services: offeredServices(DESK), known: ALL });
  ok('two reveals: 60 mana', r.mana === 60, JSON.stringify(r));
  ok('and it says reveal is the dearest', r.dearest?.spell === 'reveal');
  ok('the why names the arithmetic', /2 x reveal \(30 mana\)/.test(r.why), r.why);

  const noReveal = deskReserve({ services: offeredServices({ ...DESK, reveal: false }), known: ALL });
  ok('reveal switched off: two forces of light, 24', noReveal.mana === 24, JSON.stringify(noReveal));

  const unlearned = deskReserve({ services: offeredServices(DESK), known: ['remove curse', 'forces of light'] });
  ok('reveal not learned: it reserves nothing for reveal (24, not 60)', unlearned.mana === 24);

  const three = deskReserve({ practice: { ...PRACTICE_DEFAULTS, reserve_casts: 3 },
                              services: offeredServices(DESK), known: ALL });
  ok('reserve_casts 3: 90', three.mana === 90);

  const floorWins = deskReserve({ practice: { ...PRACTICE_DEFAULTS, mana_floor: 80 },
                                  services: offeredServices(DESK), known: ALL });
  ok('a mana_floor above the derived reserve wins', floorWins.mana === 80 && /mana_floor 80/.test(floorWins.why));

  const none = deskReserve({ services: [], known: ALL });
  ok('no desk, no floor: nothing kept, and it says so', none.mana === 0 && /nothing kept back/.test(none.why));
}

console.log('\nreserve_services narrows the reserve');
{
  const two = deskReserve({ practice: normalizePractice({ spells: ['purify'], reserve_services: ['uncurse', 'fol'] }),
                            services: offeredServices(DESK), known: ALL, keep: { emerald: 4 } });
  ok('uncurse + fol only: 2 x forces of light = 24, not 60', two.mana === 24, JSON.stringify(two));
  ok('the why says which services it was for', /among uncurse, fol/.test(two.why), two.why);
  ok('no orc teeth are kept when reveal is not reserved for', !two.reagents['orc tooth']);
  ok('an unknown service is reported', normalizePractice({ spells: ['purify'], reserve_services: ['teleport'] })
     .problems.some(p => /teleport/.test(p)));
  // Loial, 2026-09-25: 65 max mana against two reveals.
  const full = deskReserve({ services: offeredServices(DESK), known: ALL });
  const stuck = choosePractice({ practice: normalizePractice({ spells: ['purify', 'holy symbol'] }),
    spells: [{ name: 'purify', targets: 0 }, { name: 'holy symbol', targets: 0 }],
    mana: { value: 65, max: 65 }, have: () => 99, reserve: full });
  ok('65 max against a 60 reserve is named as never, not waiting', stuck.blocked === 'reserve_leaves_no_room'
     && /leaves 5/.test(stuck.why), JSON.stringify(stuck));
  const fits = choosePractice({ practice: normalizePractice({ spells: ['purify', 'holy symbol'] }),
    spells: [{ name: 'purify', targets: 0 }, { name: 'holy symbol', targets: 0 }],
    mana: { value: 65, max: 65 }, have: () => 99, reserve: two });
  ok('and with the narrowed reserve he practises purify at 65', fits.cast?.name === 'purify', JSON.stringify(fits));
}

console.log('\nreagents the desk needs are kept back too');
{
  const r = deskReserve({ services: offeredServices(DESK), known: ALL, keep: { emerald: 4 } });
  // 4 Rescue emeralds + 2 x remove curse (1) + 2 x forces of light (1) = 8
  ok('emeralds: 4 for Rescue + 2 for uncurse + 2 for fol = 8', r.reagents.emerald === 8, JSON.stringify(r.reagents));
  ok('orc teeth: 2 reveals x 3 = 6', r.reagents['orc tooth'] === 6);
  ok('elderberry: 2 fol x 2 = 4', r.reagents.elderberry === 4);
}

console.log('\nthe choice honours the reserve');
{
  const practice = normalizePractice({ spells: ['purify', 'holy symbol'] });
  const reserve = deskReserve({ services: offeredServices(DESK), known: ALL, keep: { emerald: 4 } });
  const spells = [{ name: 'purify', targets: 0 }, { name: 'holy symbol', targets: 0 },
                  { name: 'reveal', targets: 1 }, { name: 'detect evil', targets: 0 }];
  const rich = have({ emerald: 20, elderberry: 40, 'orc tooth': 9 });

  const a = choosePractice({ practice, spells, mana: { value: 100, max: 120 }, have: rich, reserve });
  ok('plenty of everything: the first spell in the list', a.cast?.name === 'purify', JSON.stringify(a));

  // purify is 10 mana: 70 - 10 = 60, exactly the reserve — allowed.
  const edge = choosePractice({ practice, spells, mana: { value: 70, max: 120 }, have: rich, reserve });
  ok('a cast landing exactly ON the reserve is allowed', edge.cast?.name === 'purify', JSON.stringify(edge));
  // 69 - 10 = 59, and holy symbol (8) leaves 61 — so it falls through to holy symbol.
  const under = choosePractice({ practice, spells, mana: { value: 69, max: 120 }, have: rich, reserve });
  ok('one under: purify is refused and the cheaper holy symbol still fits', under.cast?.name === 'holy symbol',
     JSON.stringify(under));
  const low = choosePractice({ practice, spells, mana: { value: 65, max: 120 }, have: rich, reserve });
  ok('at 65 nothing fits above 60, and it is blocked on MANA', !low.cast && low.blocked === 'mana', JSON.stringify(low));
  ok('the why says what the reserve was for', /reserve/.test(low.why));

  // Emeralds: 8 kept, purify needs 2. 9 on hand leaves one spare — short.
  const gems = choosePractice({ practice, spells, mana: { value: 100, max: 120 },
                                have: have({ emerald: 9, elderberry: 40 }), reserve });
  ok('purify refused when it would eat the desk\'s emeralds; holy symbol instead', gems.cast?.name === 'holy symbol',
     JSON.stringify(gems));
  // Elderberry: 4 kept for fol. 6 on hand: holy symbol wants 3 -> 6 - 4 = 2 < 3.
  const berries = choosePractice({ practice, spells, mana: { value: 100, max: 120 },
                                   have: have({ emerald: 9, elderberry: 6 }), reserve });
  ok('and holy symbol refused when it would eat the fol elderberries', !berries.cast && berries.blocked === 'none',
     JSON.stringify(berries));
  ok('the why names the reagent, what is on hand and what is kept', /elderberry \(6 on hand, 4 kept, needs 3\)/.test(berries.why),
     berries.why);

  const refused = choosePractice({ practice, spells, mana: { value: 100, max: 120 }, have: rich, reserve,
                                   refusedUntil: new Map([['purify', 10_000]]), now: 5_000 });
  ok('a spell the server just refused is set aside', refused.cast?.name === 'holy symbol');
  const lapsed = choosePractice({ practice, spells, mana: { value: 100, max: 120 }, have: rich, reserve,
                                  refusedUntil: new Map([['purify', 10_000]]), now: 20_000 });
  ok('and comes back when the set-aside lapses', lapsed.cast?.name === 'purify');

  const cap = choosePractice({ practice, spells, mana: { value: 55, max: 55 }, have: rich, reserve });
  ok('a reserve at or above max mana is named, not read as waiting for mana',
     cap.blocked === 'reserve_exceeds_max' && /max mana 55/.test(cap.why), JSON.stringify(cap));

  const blind = choosePractice({ practice, spells, mana: null, have: rich, reserve });
  ok('unreadable mana casts nothing', !blind.cast && blind.blocked === 'unreadable');

  const unknown = choosePractice({ practice: normalizePractice({ spells: ['major heal'] }), spells,
                                  mana: { value: 100, max: 120 }, have: rich, reserve });
  ok('a spell the character does not know is skipped with a reason', !unknown.cast && /not known/.test(unknown.why));
}

console.log('\ntargets');
{
  const reserve = { mana: 0, reagents: {}, why: 'none' };
  const spells = [{ name: 'minor heal', targets: 1 }, { name: 'holy symbol', targets: 0 }];
  const self = choosePractice({ practice: normalizePractice({ spells: ['minor heal'] }), spells,
                                mana: { value: 50, max: 50 }, have: () => 99, reserve });
  ok('a one-target spell is cast on self by default', self.cast?.target === 'self');
  const none = choosePractice({ practice: normalizePractice({ spells: ['holy symbol'] }), spells,
                                mana: { value: 50, max: 50 }, have: () => 99, reserve });
  ok('a no-target spell is cast at nothing', none.cast?.target === 'none');
  const forced = choosePractice({ practice: normalizePractice({ spells: [{ name: 'minor heal', target: 'none' }] }),
                                  spells, mana: { value: 50, max: 50 }, have: () => 99, reserve });
  ok('an explicit target wins', forced.cast?.target === 'none');
}

console.log('\nthe config says what it did not apply');
{
  ok('null is off', normalizePractice(null) === null);
  ok('enabled:false is off', normalizePractice({ enabled: false, spells: ['purify'] }) === null);
  const bad = normalizePractice({ spells: ['purify'], gap_ms: 5, wibble: 1 });
  ok('an out-of-range number keeps the default', bad.gap_ms === PRACTICE_DEFAULTS.gap_ms);
  ok('and says so', bad.problems.some(p => /gap_ms/.test(p)));
  ok('an unknown key is reported, not applied', bad.problems.some(p => /wibble/.test(p)) && !('wibble' in bad));
  ok('no spells is a problem worth naming', normalizePractice({}).problems.some(p => /no spells/.test(p)));
  ok('a bad target is refused per entry', normalizePractice({ spells: [{ name: 'purify', target: 'them' }] })
     .problems.some(p => /target/.test(p)));
  ok('the default reserve is TWO casts, the operator\'s number', PRACTICE_DEFAULTS.reserve_casts === 2);
}

// ------------------------------------------------------------------ the keeper half
//
// A client stub shaped like the real one where practiceAtDesk touches it, the same arrangement
// m59-buff-service-test.mjs uses. The server is modelled by one rule: a cast spends its catalogue
// mana unless the spell is in `refuses`, which is how a silent refusal looks from here.
const { Autopilot } = await import('./m59-autopilot.mjs');
const makeAp = ({ mana = 100, max = 120, room = 2, known = ALL.map(n => [n, 0]), refuses = [],
                  pack = { emerald: 20, elderberry: 40, 'orc tooth': 9 }, practice = { spells: ['purify', 'holy symbol'] },
                  chalice = { ...DESK, holder: 'Desk', station_room: 2, rescue_emeralds: 4 }, hold = false } = {}) => {
  const names = new Map();
  const inv = Object.entries(pack).map(([n, amount], i) => { names.set(2000 + i, n); return { id: 500 + i, nameRsc: 2000 + i, amount }; });
  const spells = known.map(([n, targets], i) => { names.set(3000 + i, n); return { id: 700 + i, nameRsc: 3000 + i, numTargets: targets }; });
  const client = {
    selfId: 1, me: { name: 'Desk' }, inventory: inv, spells, rsc: { get: r => names.get(r) ?? '' },
    room: { num: room, objects: new Map() }, sent: [], mana,
    vitals: () => ({ health: { value: 50, max: 50 }, mana: { value: client.mana, max } }),
    cast: async (id, targets) => {
      const name = names.get(spells.find(s => s.id === id).nameRsc);
      client.sent.push({ name, targets });
      if (!refuses.includes(name)) client.mana -= spellCost(name).mana;
      return true;
    },
    waitFor: async () => ({ events: [] }),
  };
  const ap = Object.create(Autopilot.prototype);
  ap.policy = { practiceSpells: practice, assignedRoom: null };
  ap._chaliceCfg = chalice;
  ap.hold = hold ? {} : null;
  ap.tally = {};
  ap.declined = []; ap.casts = []; ap.notes = [];
  ap.s = { client, need: () => client, world: { room: { num: room } }, pacer: { submit: async (_k, fn) => fn() } };
  ap.threat = () => ({ landing: 0 });
  ap.busyStatus = () => null;
  ap.travelInterrupted = () => false;
  ap.declinedCast = (what, why, detail) => { ap.declined.push({ what, why, detail }); return false; };
  ap.recordCast = (spell, d) => { ap.casts.push({ spell, ...d }); };
  ap.note = (what, detail) => { ap.notes.push({ what, detail }); };
  return ap;
};

console.log('\nthe keeper casts at the post and reads the mana back');
{
  const ap = makeAp();
  ok('a holder at its station with mana to spare casts', await ap.practiceAtDesk() === true);
  ok('it cast the first spell in the list, purify', ap.s.client.sent[0]?.name === 'purify', JSON.stringify(ap.s.client.sent));
  ok('purify takes no target, so none was sent', ap.s.client.sent[0]?.targets.length === 0);
  ok('the cast was recorded as landed', ap.casts[0]?.ok === true);
  ok('the reserve it honoured was 60 (two reveals)', ap.practiceState?.reserve === 60, JSON.stringify(ap.practiceState));
  ok('and the rescue emeralds sit under the service ones', ap.practiceState?.reagents_kept?.emerald === 8);
  ok('a second pass inside gap_ms casts nothing', await ap.practiceAtDesk() === false && ap.s.client.sent.length === 1);
}
{
  const ap = makeAp({ mana: 65 });
  ok('at 65 of 120 against a 60 reserve it does not cast', await ap.practiceAtDesk() === false && !ap.s.client.sent.length);
  ok('and says the reserve is why', ap.declined[0]?.why === 'mana' && /reserve/.test(ap.declined[0]?.detail?.why ?? ''));
}
{
  const ap = makeAp({ refuses: ['purify'] });
  await ap.practiceAtDesk();
  ok('a cast that spent no mana is recorded as NOT landed', ap.casts[0]?.ok === false);
  ok('and purify is set aside', ap._practiceRefused.get('purify') > Date.now());
  ap._practiceAt = 0;                                   // as if gap_ms had passed
  await ap.practiceAtDesk();
  ok('the next pass tries holy symbol instead', ap.s.client.sent[1]?.name === 'holy symbol', JSON.stringify(ap.s.client.sent));
}
{
  const ap = makeAp({ known: [['minor heal', 1]], practice: { spells: ['minor heal'] }, pack: { herb: 5 } });
  await ap.practiceAtDesk();
  ok('a one-target spell is cast on the caster\'s own object id', JSON.stringify(ap.s.client.sent[0]?.targets) === '[1]',
     JSON.stringify({ sent: ap.s.client.sent, declined: ap.declined, state: ap.practiceState }));
  ok('a character that knows no service keeps nothing back', ap.practiceState?.reserve === 0);
}
{
  const away = makeAp({ room: 50 });
  ok('away from the post it does not practise', await away.practiceAtDesk() === false && !away.s.client.sent.length);
  const serving = makeAp(); serving._chaliceServe = { kind: 'desk' };
  ok('with a desk job in flight it does not practise', await serving.practiceAtDesk() === false && !serving.s.client.sent.length);
  const post = makeAp(); post.isRoomEnchantPost = () => true;
  ok('a posted caster off its wall does not practise', await post.practiceAtDesk() === false && !post.s.client.sent.length);
  const walled = makeAp({ hold: true }); walled.isRoomEnchantPost = () => true;
  ok('and on its wall it does', await walled.practiceAtDesk() === true);
  const errand = makeAp(); errand.errand = { kind: 'loot run' };
  ok('under an errand it does not practise', await errand.practiceAtDesk() === false);
  const off = makeAp({ practice: null });
  ok('with the policy off it does nothing', await off.practiceAtDesk() === false && !off.s.client.sent.length);
  const nowhere = makeAp({ chalice: null });
  ok('with no post anywhere it declines and says why',
     await nowhere.practiceAtDesk() === false && /no post/.test(nowhere.declined[0]?.why ?? ''));
}
{
  // A traveller — not holder, not alternate — serves nothing, so nothing is reserved for services.
  const ap = makeAp({ chalice: { ...DESK, holder: 'Someone Else', station_room: 2 } });
  await ap.practiceAtDesk();
  ok('a character that is not on the desk keeps no service reserve', ap.practiceState?.reserve === 0);
}

console.log('\nthe desk is served before it is practised at');
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('  async passErrand(ctx) {'));
  const duty = body.indexOf('this.chaliceDuty()'), practice = body.indexOf('this.practiceAtDesk()');
  ok('passErrand calls chaliceDuty BEFORE practiceAtDesk', duty >= 0 && practice > duty);
  const broker = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  ok('the broker accepts practice_spells and stores it AS SENT, so a doctrine diff can settle',
     /a\.practice_spells !== undefined/.test(broker) && /p\.policy\.practiceSpells = JSON\.parse\(JSON\.stringify\(value\)\)/.test(broker));
}

// A CREATURE TARGET (2026-09-25): "Have Loial practice dazzle on skeletons from safe spots".
console.log('\na one-target spell practised on a creature');
{
  const bare = normalizePractice({ spells: [{ name: 'dazzle', target: 'creature' }] });
  ok('target "creature" without on is refused with a reason',
     bare.spells.length === 0 && bare.problems.some(p => /needs on/.test(p)), JSON.stringify(bare.problems));
  const cfg = normalizePractice({ spells: [{ name: 'Dazzle', target: 'creature', on: ['Skeleton'] }] });
  ok('it is kept, lower-cased, with its creature list',
     cfg.spells[0]?.target === 'creature' && cfg.spells[0]?.on?.[0] === 'skeleton', JSON.stringify(cfg.spells));
  ok('an unknown target is still refused', normalizePractice({ spells: [{ name: 'x', target: 'orc' }] })
     .problems.some(p => /self", "none" or "creature/.test(p)));

  const objects = [
    { id: 1, name: 'skeleton', row: 10, col: 10, attackable: true },
    { id: 2, name: 'skeleton', row: 11, col: 11, attackable: true },
    { id: 3, name: 'zombie', row: 10, col: 11, attackable: true },
    { id: 4, name: 'dead skeleton', row: 10, col: 10, attackable: false },
    { id: 5, name: 'Skeleton Slayer', row: 10, col: 10, attackable: true, player: true },
    { id: 6, name: 'battered skeleton', row: 30, col: 30, attackable: true },
  ];
  const me = { row: 11, col: 12 };
  ok('the nearest matching skeleton is chosen', pickCreatureTarget({ objects, on: ['skeleton'], me })?.id === 2);
  ok('never a player, a corpse or a non-match',
     ![3, 4, 5].includes(pickCreatureTarget({ objects, on: ['skeleton'], me })?.id));
  ok('one cast on within the window is skipped for the next',
     pickCreatureTarget({ objects, on: ['skeleton'], me, recentlyUntil: new Map([[2, 5000]]), now: 1000 })?.id === 1);
  ok('and becomes eligible again once the window has passed',
     pickCreatureTarget({ objects, on: ['skeleton'], me, recentlyUntil: new Map([[2, 5000]]), now: 6000 })?.id === 2);
  ok('nothing matching is null, not a guess', pickCreatureTarget({ objects, on: ['orc'], me }) === null);

  const { readFileSync } = await import('node:fs');
  const AP = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const at = AP.indexOf("if (choice.cast.target === 'creature') {");
  ok('the keeper casts a creature target only from a proven wall',
     at > 0 && AP.slice(at, at + 300).includes('if (!(this.hold && this.holdWorks()))'));
  ok('a refused creature cast sets aside the creature, not the spell',
     AP.includes('if (creature) this._practiceTargets.set(creature.id, now + (landed === false ? 60_000 : 16_000));'));
}

// A PRACTICE ROOM THAT IS NOT THE DESK (2026-09-25): Loial keeps the chalice at 2 and practises
// dazzle on 38's skeletons in bounded sessions between customers.
console.log('\npractice sessions in another room');
{
  const cfg = normalizePractice({ spells: ['purify',
    { name: 'dazzle', target: 'creature', on: ['skeleton'], room: 38 }] });
  const dz = cfg.spells.find(s => s.name === 'dazzle');
  ok('an entry keeps its room, with default session and spacing',
     dz?.room === 38 && dz.session_ms === 60_000 && dz.every_ms === 180_000, JSON.stringify(dz));
  ok('a desk entry has no room', cfg.spells.find(s => s.name === 'purify')?.room === undefined);
  ok('a nonsense room is refused', normalizePractice({ spells: [{ name: 'dazzle', target: 'creature',
     on: ['skeleton'], room: 'castle' }] }).problems.some(p => /room must be/.test(p)));
  ok('a session outside its bounds is refused', normalizePractice({ spells: [{ name: 'dazzle',
     target: 'creature', on: ['skeleton'], room: 38, session_ms: 5 }] }).problems.some(p => /session_ms/.test(p)));

  const { readFileSync } = await import('node:fs');
  const AP = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const next = AP.slice(AP.indexOf('  chaliceNextJob(cfg, role, cup, store, me, now) {'));
  const practiceAt = next.indexOf("return job('practice', 'go'");
  ok('the session is the LAST job: after rides, forces of light and desk tickets',
     practiceAt > next.indexOf("job('ride', 'go'") && practiceAt > next.indexOf("job('fol', 'go'")
       && practiceAt > next.indexOf("job('desk', 'go'") && practiceAt < next.indexOf('if (cup) return null;'));
  const castStage = AP.slice(AP.indexOf("case 'practice:cast': {"), AP.indexOf("case 'practice:back'"));
  ok('any waiting ticket ends the session', /\['ride', 'fol', 'uncurse', 'reveal', 'relief', 'return'\]/.test(castStage)
     && castStage.includes('waiting > 0'));
  ok('...as does losing the wall', castStage.includes('!(this.hold && this.holdWorks())'));
  ok('the wall stage never casts in the open', AP.includes("this.chaliceEvent('practice_no_wall'"));
  ok('at the desk, a roomed entry is never cast; in a session only this room\'s entries are',
     AP.includes('? sp.room === here : (sp.room == null || sp.room === here)'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
