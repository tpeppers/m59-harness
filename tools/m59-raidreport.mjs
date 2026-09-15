#!/usr/bin/env node
// WHAT ACTUALLY KILLED IT, AND WOULD THE OTHER FLEET MANAGE — post-hoc analysis of a raid.
//
//   node tools/m59-raidreport.mjs --hp <sample.log> --raid <raid.log> [--raiders 23]
//
// Answers three questions from evidence rather than impression:
//
//   1. how fast did the boss actually die, and was that fast enough
//   2. how much did each preparation contribute — and the honest answer for most of them is
//      "this analysis cannot separate it", which is said rather than guessed
//   3. would a DIFFERENT fleet manage it, which is the question the operator actually asked
//
// ============================================================================
// WHAT THIS CAN AND CANNOT SEE
// ============================================================================
//
// CAN: the boss's health over time, sampled by CLASS inside one run; how many raiders were in
// the room; swings, closes, too-far rounds and deaths per raider; and the kod damage model.
//
// CANNOT: damage per individual blow. The server sends no number — a hit is a sentence
// ("Your hammer crushes the ghost of Far'Nohl."), and the resistance band is a different
// sentence that only appears in the resisted bands. So per-hit damage is INFERRED from the
// health curve divided by landed hits, and that inference is stated as one.
//
// The effect sizes below therefore come from kod constants, not from measurement, except
// where a before/after pair exists. Saying which is which is the whole point: an analysis that
// presents a derived multiplier and a measured rate in the same voice is the instrument
// problem this repository keeps paying for, one level up.
import { readFileSync } from 'node:fs';
import { damageAfterResistance, damageDelivered, GHOST_OF_FARNOHL } from './m59-resistance.mjs';

const arg = (f, d = null) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : d; };

/** Parse the class-sampled health log into a curve. */
export function parseCurve(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = /^\+\s*(\d+)s/.exec(line);
    if (!t) continue;
    const at = Number(t[1]);
    const hp = /ghost (\d+)\/(\d+)/.exec(line);
    const raiders = /raiders (\d+)/.exec(line);
    const escort = /escort (.+)$/.exec(line);
    rows.push({ at, hp: hp ? Number(hp[1]) : null, max: hp ? Number(hp[2]) : null,
                gone: /NO GHOST/.test(line), raiders: raiders ? Number(raiders[1]) : null,
                escort: escort ? escort[1].trim() : null });
  }
  return rows;
}

/** Per-raider melee lines from a raid log. */
export function parseMelee(text) {
  const rows = [];
  // FIELD BY NAME, NOT BY POSITION. The first version of this matched the summary line as one
  // fixed sequence, so adding `hits=` between `landed=` and `too_far=` made every line stop
  // matching — and the report printed "swings 0, closes 0" under a curve that plainly showed a
  // kill, which is the same class of confident-nonsense this whole exercise is about.
  const num = (line, key) => {
    const m = new RegExp(`\\b${key}=(\\d+)`).exec(line);
    return m ? Number(m[1]) : 0;
  };
  for (const line of String(text).split(/\r?\n/)) {
    // The role word ('boss' / 'ESCORT') sits between the agent and the counters.
    const head = /^\s*(\S+)\s+(?:boss|ESCORT)?\s*swings=\d+/.exec(line);
    if (!head) continue;
    const magic = /\bmagic=(\w+)/.exec(line)?.[1];
    rows.push({ agent: head[1], role: /\bESCORT\b/.test(line) ? 'ESCORT' : 'boss',
                swings: num(line, 'swings'), closes: num(line, 'closes'),
                landed: num(line, 'landed'), too_far: num(line, 'too_far'),
                hits: num(line, 'hits'), stood_up: num(line, 'stood_up'),
                refused: num(line, 'refused'),
                magic: magic === 'true' ? true : magic === 'false' ? false : null });
  }
  const deaths = (String(text).match(/DIED/g) ?? []).length;
  const heals = [...String(text).matchAll(/healed: (\d+)\/(\d+) cast/g)]
    .map(m => ({ landed: +m[1], cast: +m[2] }));
  const healWhy = {};
  for (const m of String(text).matchAll(/failures: (\{[^}]*\})/g)) {
    let parsed = null;
    try { parsed = JSON.parse(m[1]); } catch { /* leave it out rather than guess */ }
    for (const [k, v] of Object.entries(parsed ?? {})) healWhy[k] = (healWhy[k] ?? 0) + v;
  }
  return { rows, deaths, heals, healWhy };
}

export function analyse(curve, melee, { raiders = null, avgMaxHealth = 50 } = {}) {
  const seen = curve.filter(r => r.hp != null);
  const first = seen[0] ?? null;
  const last = seen[seen.length - 1] ?? null;
  // "NO GHOST IN ROOM" BEFORE THE FIGHT IS NOT A KILL. From a cold room the boss does not
  // exist until the first raider walks in and triggers FirstUserEntered, so the opening
  // samples all say NO GHOST — and taking the first of those as the moment of death reported
  // a kill at +0s from a room nobody had entered.
  const appearedAt = seen[0]?.at ?? null;
  const goneAt = appearedAt == null ? null
               : (curve.find(r => r.gone && r.at > appearedAt)?.at ?? null);
  const startAt = first?.at ?? 0;
  // The fight is from the first sample BELOW full health to the one where it is gone: before
  // that the raiders are present but nothing is happening, and counting it flatters the rate.
  const engagedFrom = seen.find(r => r.hp < r.max)?.at ?? startAt;
  const killWindow = goneAt != null ? goneAt - engagedFrom : null;
  const maxHp = first?.max ?? null;
  // THE PEAK IS THE WRONG DENOMINATOR. Raiders arrive, fight, and are driven off: fifteen in
  // the room at first contact and three at the kill is the normal shape, so dividing by the
  // peak reports a per-raider rate about four times too low and makes the fleet look useless.
  // Average over the window the damage actually happened in.
  const during = curve.filter(r => r.at >= engagedFrom && r.at <= (goneAt ?? Infinity) &&
                                   r.raiders != null);
  const meanInRoom = during.length
    ? during.reduce((n, r) => n + r.raiders, 0) / during.length : null;
  const peakInRoom = Math.max(0, ...curve.map(r => r.raiders ?? 0));
  const inRoom = raiders ?? meanInRoom ?? peakInRoom;

  // A LOST RUN STILL HAS A RATE. Killed: the whole bar over the kill window. Lost: the drop
  // to the lowest health the boss reached, over the same window `incoming` uses, so the two
  // sides of the ledger are comparable.
  const lowest = seen.filter(r => r.at > engagedFrom).reduce((m, r) => Math.min(m, r.hp), maxHp ?? 0);
  const dealt = killWindow ? maxHp : (maxHp != null ? maxHp - lowest : null);
  const dps = killWindow ? maxHp / killWindow : null;
  const perRaider = dps && inRoom ? dps / inRoom : null;

  const totals = melee.rows.reduce((a, r) => ({
    swings: a.swings + r.swings, closes: a.closes + r.closes,
    landed: a.landed + r.landed, too_far: a.too_far + r.too_far,
    hits: a.hits + (r.hits ?? 0), refused: a.refused + (r.refused ?? 0),
    stood_up: a.stood_up + (r.stood_up ?? 0),
  }), { swings: 0, closes: 0, landed: 0, too_far: 0, hits: 0, refused: 0, stood_up: 0 });
  // WHO ACTUALLY FOUGHT. Across every controlled run, two or three raiders of twenty-one did
  // essentially all the damage and the rest reported swings=0 — so a fleet-wide average is a
  // number describing nobody. This is the count that matters for sizing a raid.
  const effective = melee.rows.filter(r => (r.hits ?? 0) > 0).length;
  const onEscort = melee.rows.filter(r => r.role === 'ESCORT').length;
  const reported = melee.rows.length;
  // PER BLOW MEANS PER BLOW ON THE BOSS. The health curve tracks the boss only, so dividing it
  // by EVERY hit in the log charges the boss for damage that went into tusked skeletons — and
  // a run with seven raiders on the escort reported 4.1 health a blow against 10.9 for the
  // same fleet with the same weapons. Boss-role hits only.
  const bossHits = melee.rows.filter(r => r.role !== 'ESCORT')
    .reduce((n, r) => n + (r.hits ?? 0), 0);
  const perHit = bossHits && maxHp && goneAt != null ? maxHp / bossHits : null;
  // THE WEAPON CHECK, COUNTED RATHER THAN ASSUMED. `magic` is three-valued: the server only
  // names a resistance band in the bands it has one for, so `null` is "it never said",
  // which is not evidence either way and must not be averaged in with the noes.
  const weapon = melee.rows.reduce((a, r) => {
    a[r.magic === true ? 'magic' : r.magic === false ? 'mundane' : 'unsaid']++; return a;
  }, { magic: 0, mundane: 0, unsaid: 0 });

  // INCOMING, from the raider side of the same window. The curve measures what the fleet
  // DEALT; this is what it TOOK, and the two together are the only honest way to say whether
  // a smaller fleet survives long enough to finish the job.
  const lost = [];
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1], b = curve[i];
    if (a.raiders == null || b.raiders == null || b.at > (goneAt ?? Infinity)) continue;
    if (b.raiders < a.raiders) lost.push({ at: b.at, left: a.raiders - b.raiders });
  }
  // AND WHETHER IT WAS LOST RATHER THAN WON. A boss that stops falling and starts climbing is
  // regenerating, which means nobody is hitting it — the fleet ran out before the boss did.
  // That is a different outcome from "did not die in this window" and reads identically.
  const tail = seen.filter(r => r.at > engagedFrom);
  const low = tail.length ? Math.min(...tail.map(r => r.hp)) : null;
  const ended = tail.length ? tail[tail.length - 1].hp : null;
  const attrition = goneAt == null && low != null && ended != null && ended > low
    ? { low, ended, left: tail[tail.length - 1].raiders } : null;

  // WHEN THE FIGHT ENDED — the denominator under every rate below, and it took three tries.
  //
  // Not when the SAMPLER stopped: a losing run keeps sampling for another eight minutes with
  // two raiders standing about, which divided a 160-second beating by 760 seconds.
  //
  // And not when the room thinned out either. Raiders leave at the 35% line, heal,
  // and come back: run N dipped to one raider and climbed back to four, taking the boss from
  // 214 to 87 over the three minutes that heuristic threw away — which reported 169 health
  // dealt in 50 seconds, a rate more than twice the run that actually killed the thing.
  //
  // The unambiguous end of a lost fight is the sample where the boss is at its LOWEST. After
  // that its health is going up, which is the definition of nobody hitting it.
  const lowAt = seen.filter(r => r.at > engagedFrom)
    .reduce((best, r) => (best == null || r.hp < best.hp ? r : best), null);
  const lastAt = curve.length ? curve[curve.length - 1].at : null;
  const window = killWindow ?? (lowAt ? lowAt.at - engagedFrom
                                      : lastAt != null ? lastAt - engagedFrom : null);
  return { maxHp, engagedFrom, goneAt, killWindow, window, avgMaxHealth, dealt, lowest, onEscort, bossHits, inRoom, meanInRoom, peakInRoom, effective, reported,
           perHit, dps, perRaider, totals, weapon, attrition,
           lost, escort: curve.find(r => r.escort && r.escort !== 'none')?.escort ?? null,
           deaths: melee.deaths, heals: melee.heals, healWhy: melee.healWhy ?? {}, curve: seen };
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : 'n/a');

export function report(a, { raiders = null, label = 'this run' } = {}) {
  const o = [];
  o.push(`RAID ANALYSIS — ${label}`);
  o.push('');
  o.push('WHAT HAPPENED');
  if (a.killWindow != null) {
    o.push(`  the boss died in ${a.killWindow}s of contact, from ${a.maxHp} health`);
    o.push(`  fleet damage      ${a.dps.toFixed(1)} hp/s`);
    o.push(`  in the room       ${a.meanInRoom?.toFixed(1) ?? '?'} on average over the fight, ` +
           `${a.peakInRoom} at the peak`);
    o.push(`  per raider        ${a.perRaider.toFixed(2)} hp/s each`);
  } else if (a.attrition) {
    o.push(`  THE FLEET RAN OUT FIRST. The boss reached ${a.attrition.low}/${a.maxHp} and then ` +
           `climbed back to ${a.attrition.ended}`);
    o.push(`  with ${a.attrition.left} raider(s) left in the room — a boss that regenerates is a ` +
           'boss nobody is hitting');
    // A LOST RUN STILL HAS A DAMAGE RATE, and it is the number the ablation turns on. `dps`
    // was computed only from a kill, so the two runs that lost printed no outgoing rate at
    // all — and the one comparison this exists to make, enchanted against mundane, had a
    // number on one side and a blank on the other.
    if (a.window && a.dealt != null) {
      o.push(`  fleet damage      ${(a.dealt / a.window).toFixed(2)} hp/s — ${a.dealt} health taken ` +
             `in the ${a.window}s the fleet was in the room`);
      o.push(`  in the room       ${a.meanInRoom?.toFixed(1) ?? '?'} on average, ${a.peakInRoom} at the peak`);
      if (a.totals.hits)
        o.push(`  per landed blow   ~${(a.dealt / a.totals.hits).toFixed(1)} health over ` +
               `${a.totals.hits} landed hits`);
    }
  } else {
    o.push(`  the boss did not die in this window (last seen ${a.curve.at(-1)?.hp}/${a.maxHp})`);
  }
  o.push(`  raiders that landed at least one blow: ${a.effective} of ${a.reported}` +
         (a.onEscort ? ` (${a.onEscort} of them were on the ESCORT, not the boss)` : ''));
  if (a.perHit) o.push(`  per landed blow   ~${a.perHit.toFixed(1)} health over ${a.bossHits} blows ON THE BOSS ` +
                       '(a mundane blow floors at 1)');
  o.push(`  deaths            ${a.deaths}`);
  const healCast = a.heals.reduce((n, h) => n + h.cast, 0);
  const healLanded = a.heals.reduce((n, h) => n + h.landed, 0);
  o.push(`  heals             ${healLanded} landed of ${healCast} attempted` +
         (healCast === 0 ? '  — the healers never cast, which needs explaining' : ''));
  o.push('');
  o.push('THE CURVE, as sampled by class inside one run');
  // CUT AT THE KILL. Everything after it is a RESPAWNED boss and belongs to a different
  // fight — and its max health differs (233, 236 and 282 observed across spawns), so
  // averaging across the boundary would invent a number describing neither.
  const upTo = a.goneAt ?? Infinity;
  for (const r of a.curve.filter(r => r.at <= upTo)) o.push(`  +${String(r.at).padStart(4)}s  ${r.hp}/${r.max}`);
  if (a.goneAt != null) o.push(`  +${String(a.goneAt).padStart(4)}s  gone`);
  const after = a.curve.filter(r => r.at > upTo);
  if (after.length)
    o.push(`  (then a RESPAWN at +${after[0].at}s on ${after[0].max} max health, untouched — a ` +
           'different boss, excluded from every number above)');
  o.push('');
  o.push('PARTICIPATION');
  o.push(`  swings ${a.totals.swings}, closes ${a.totals.closes}, ` +
         `rounds refused as out of reach ${a.totals.too_far}` +
         (a.totals.refused ? `, attack CALLS refused ${a.totals.refused}` : ''));
  o.push(`  weapon, read from the server's own resistance sentence: ` +
         `${a.weapon.magic} enchanted, ${a.weapon.mundane} mundane, ${a.weapon.unsaid} never said`);
  if (a.escort) o.push(`  escort in the room: ${a.escort}`);
  if (a.lost.length)
    o.push(`  raiders left the room at ${a.lost.map(l => `+${l.at}s (${l.left})`).join(', ')}` +
           ' — a departure is not a death; the disengage line is 35% health');
  // INCOMING, AND IT IS DERIVED — say so in the same breath as the number.
  //
  // The sampler reads the BOSS's health, not the raiders'. What it does see is raiders
  // leaving, and a raider leaves at the 35% disengage line — so one departure is about 65% of
  // one raider's maximum health, taken. That is a floor on incoming damage, not a measurement
  // of it: it counts nothing taken by raiders who stayed, and nothing taken by the ones who
  // died. `--avg-max-health` is this fleet's average; the default is the shadow fleet's.
  if (a.lost.length && a.window) {
    const left = a.lost.reduce((n, l) => n + l.left, 0);
    const taken = left * a.avgMaxHealth * 0.65;
    o.push(`  incoming, DERIVED  >= ${(taken / a.window).toFixed(1)} hp/s across the fleet ` +
           `(${left} raiders driven below 35% of ~${a.avgMaxHealth} health in ${a.window}s)`);
    if (a.dps) o.push(`  against            ${a.dps.toFixed(1)} hp/s dealt — the fleet is taking ` +
                      `about ${(taken / a.window / a.dps).toFixed(1)}x what it deals`);
    o.push('  this is a FLOOR: it counts nothing taken by raiders who stayed, and the escort is');
    o.push('  most of it — AND THE ESCORT IS A CLOCK, NOT A CONSTANT. Measured from a cold room:');
    o.push('  zero at the moment the first raider enters, then one tusked skeleton every ~12s to');
    o.push('  a cap of NINE (piMonster_count_max 10, minus the ghost, which counts). So every');
    o.push('  second the boss survives buys it another twelfth of a skeleton.');
  }
  if (a.totals.landed === 0 && a.totals.swings > 0)
    o.push('  landed reads 0 against a boss that died — the hit counter is not to be trusted ' +
           'here, so per-hit damage below is inferred from the CURVE, not from hit counts');
  o.push('');

  // ---- effect sizes, from kod, clearly labelled as derived
  const g = GHOST_OF_FARNOHL;
  const mundane = damageDelivered(30, g.resistNonMagic);
  const magic = damageDelivered(30, g.resistMagic);
  o.push('WHAT EACH PREPARATION IS WORTH — derived from kod, not measured here');
  o.push(`  dedicated weapon   a 30-damage blow delivers ${mundane} mundane against ${magic} ` +
         `enchanted — ${(magic / mundane).toFixed(1)}x (ghost.kod:87-88, battler.kod:258)`);
  o.push('                     and a resisted blow still floors at 1 (monster.kod:1562), so a');
  o.push('                     mundane raider is a stalemate rather than nothing');
  o.push('  forces of light    +50..+150 to the HIT ROLL of every good player in the room');
  o.push('                     (forceslt.kod ModifyHitRoll); damage untouched. Only applies to');
  o.push('                     karma > 0, and lapses in as little as 6s');
  o.push('  a COLD room       measured, and it is the largest effect in this whole exercise:');
  o.push('                     294 health killed in 90s with 0 deaths from a cold room, against');
  o.push('                     254 in 171s from a room already at the escort cap. Same fleet,');
  o.push('                     same weapons, same buffs — 2.2x the damage rate.');
  o.push('  bless / heals      NOT SEPARABLE from this data. One run, several changes at once.');
  o.push('');
  if (raiders && a.perRaider) {
    const est = a.perRaider * raiders;
    const secs = a.maxHp / est;
    o.push(`WOULD A FLEET OF ${raiders} MANAGE IT?`);
    o.push(`  at the same ${a.perRaider.toFixed(2)} hp/s per raider: ${est.toFixed(1)} hp/s, ` +
           `so ${Math.round(secs)}s to take ${a.maxHp} health`);
    o.push('  ASSUMES the same per-raider rate, which assumes the same weapons, the same');
    o.push('  positioning and the same escort. Read it as an order of magnitude: this says the');
    o.push('  fight is winnable at that size, not that it takes exactly that long.');
  }
  return o.join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('m59-raidreport.mjs')) {
  const hpFile = arg('--hp'), raidFile = arg('--raid');
  if (!hpFile || !raidFile) {
    console.error('usage: m59-raidreport.mjs --hp <sample.log> --raid <raid.log> [--raiders N]');
    process.exit(2);
  }
  const curve = parseCurve(readFileSync(hpFile, 'utf8'));
  const melee = parseMelee(readFileSync(raidFile, 'utf8'));
  const a = analyse(curve, melee, { avgMaxHealth: Number(arg("--avg-max-health")) || 50 });
  console.log(report(a, { raiders: Number(arg('--raiders')) || null, label: arg('--label', 'shadow fleet vs the ghost of Far\'Nohl') }));
}
