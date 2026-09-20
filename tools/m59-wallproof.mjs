#!/usr/bin/env node
// M59-WALLPROOF — THE LIVE HALF OF THE SAFE-WALL SPIKE, AS AN INSTRUMENT RATHER THAN AN ANECDOTE.
//
// `spike-safe-walls.mjs` states the theory and re-derives every offline number. This is the
// other half: the thing that goes and asks the running game whether the theory is true, and
// that can be re-run by anybody who doubts the answer.
//
//   node tools/m59-wallproof.mjs --collect --minutes 20     # record (needs a lab fleet)
//   node tools/m59-wallproof.mjs --analyze                  # the 2x2 and the verdict
//
// ── WHY IT COUNTS ATTACKS AND NOT HEALTH ───────────────────────────────────────────────────
//
// Six earlier designs watched the health bar and reasoned backwards to "was I attacked". Every
// one of them failed, and the failures were not bad luck:
//
//   * POISON GETS THROUGH ANY GEOMETRY. A poisoned body on a perfect wall loses health, so the
//     wall reads as leaking. Working around it meant hand-picking rooms by monster.
//   * REGENERATION HIDES BEATINGS. A keeper resting inside a safe spot heals between hits, so
//     start-minus-minimum nets a twelve-point beating against twelve points of regen and
//     reports zero.
//   * THE ROOMS WERE QUIET. With an idle fleet nothing attacks anybody, so every square passes.
//     Four rounds reported HELD before a control was added that also reported HELD.
//
// The flight recorder makes the question direct. The server announces every swing in words:
//
//     "You dodge the orc's attack."            <- attacked, missed
//     "The troll wounds you with its attack."  <- attacked, hit
//     "Your scimitar cleaves the battered skeleton."   <- I swung
//
// Counting those removes all three problems at once. A poison tick emits no attack message, so
// poison is excluded BY CONSTRUCTION rather than by choosing rooms. An attack counts whether or
// not it landed and whether or not the damage was healed. And a quiet room shows up honestly as
// an empty control cell instead of as a silent pass.
//
// ── INSTRUMENT FAULTS FOUND THE HARD WAY, RECORDED SO NOBODY REBUILDS THEM ──────────────────
//
//   `autopilot stop` DOES NOT STICK. It returns `running:false` — it acknowledges — and a
//   watchdog puts it back within three seconds with the same policy. An earlier round staged a
//   wall-versus-open comparison on top of it and reported "THE WALL LEAKED: 18 lost on the wall
//   against 14 in the open". Both phases were measured while the keeper was farming trolls, so
//   that was the difference between two fights, not two squares. `inert` does not help either:
//   the call returns a stale, already-expired record and `look` still shows `running:true`.
//   A body in this fleet cannot be held still from outside, so this tool does not try.
//
//   `combat.active` IS FALSE ON 100% OF SAMPLES, even while the keeper's own journal says
//   "hunting: zombie". It is not a swing signal. Outgoing attack MESSAGES are.
//
//   `kind:"moved"` IS NOT EMITTED PER STEP. One agent logged `moved@35,2` and then nothing for
//   46.7 seconds while the poll watched the body walk 36,36 -> 23,26 -> 9,27 -> 1,31 -> 2,32.
//   `player-moved` carries OTHER players. So the poll is the position stream, and an attack is
//   attributed to a square only when the polls either side of it agree on that square.
//
//   THE BAKED GEOMETRY CALLS ~2.5% OF REAL STANDING GROUND UNWALKABLE. 12 of 480 squares that
//   live bodies were observed standing on fail `geo.walkable()`. Those squares can never be
//   offered as safe walls, and any analysis that classifies a death square by the bake will
//   return NOT-WALKABLE for one in forty. Separate defect; flagged, not fixed here.
//
// ── ADMISSIBILITY ──────────────────────────────────────────────────────────────────────────
//
// The operator's bar, 2026-09-20, and it applies to the DENOMINATOR as well as the evidence:
//   "The monster should be in at least 2 different (fine position) locations while you're in
//    the safe spot not attacking for a true, full, refutation that I'd be happy with."
//
// So a second of exposure is counted only while a non-poisoning monster was within reach, and
// the strict denominator further requires that monster to have changed fine position between
// the two polls. Seconds when nothing was near are seconds during which no square was tested,
// on either kind of ground, and leaving them in pads both not-swinging cells with quiet time
// and drives the measured rates toward zero — which is exactly the artefact that made the first
// four rounds report that everything was safe.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { geometryFor, exposureAt } from './m59-safespots.mjs';
import { poisons } from './m59-ailments.mjs';

const BROKER = process.env.M59_CONTROL_URL || 'http://127.0.0.1:8971';
const STORE = process.env.WALLPROOF_FILE || 'substrate/wallproof.jsonl';
const REACH = 3;                     // monster.kod:1682 — SquaredDistanceTo <= range^2
const SWING_MS = 10000;              // "has not swung" means not within this long
const NEAR_MS = 6000;                // polls either side of an event must be this close

const rpc = async (name, args = {}) => {
  const r = await fetch(BROKER, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }).then(x => x.json()).catch(e => ({ error: String(e) }));
  const t = r?.result?.content?.[0]?.text; if (t == null) return r;
  try { return JSON.parse(t) } catch { return { text: t } }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── the server's combat vocabulary ───────────────────────────────────────────────────────────
//
// THIS USED TO CARRY ITS OWN PARSER AND THE VERB LIST WAS A BUG THAT FAILED TOWARD THE ANSWER
// THE MODEL WANTED. An enumerated list of damage verbs missed "Your mace CRUSHES the spider",
// scoring 22 of the body's own swings as unrecognised — which counts those intervals as
// "standing there not swinging", the direction that manufactures a safe-looking wall.
//
// It is gone. `tools/m59-combatlog.mjs` builds its patterns from battler.kod's four templates
// and its closed 81-verb table, so the vocabulary is the game's rather than a sample of it, and
// the same parser now reads fights for every tool in this repo. `--analyze` still PRINTS
// whatever it cannot classify rather than assuming it is harmless.
import { classifyCombatLine } from './m59-combatlog.mjs';

// This tool's own two-way shape, on top of the shared classifier. `kill`, the resisted/staggered
// reactions and an out-of-range swing all count as OUT: the question here is "did this body
// swing", not "did it connect", because a whiffed swing voids a safe wall exactly as a landed
// one does.
export const classifyMessage = text => {
  const c = classifyCombatLine(text);
  if (!c) return null;
  if (c.kind === 'poison') return { dir: 'poison' };
  if (c.kind === 'enemy-swing') return { dir: 'in', who: c.other, hit: c.landed === true };
  if (c.kind === 'my-swing' || c.kind === 'kill' || c.kind === 'karma')
    return { dir: 'out', who: c.other };
  return null;
};

// WHICH CREATURES POISON IS A FACT ABOUT THEIR CLASS, NOT THEIR NAME.
//
// This was `/spider/i`, and it was wrong in both directions. It MISSED `dusk rat`
// (DuskRat applies SID_POISON and no spider regex will ever match it), which is the
// dangerous direction -- its ticks would have counted as blows that got through a wall.
// And it excluded `baby spider`, which is `SpiderBaby is Monster` and poisons nothing, so
// that only threw evidence away. See tools/m59-ailments.mjs, whose test re-derives the
// list from kod on every run.

// ── COLLECT ───────────────────────────────────────────────────────────────────────────────────
async function collect(minutes, tick) {
  const fleet = (await rpc('fleet', {})).fleet || [];
  if (!fleet.length) throw new Error('no fleet — is the broker up?');
  writeFileSync(STORE, '');
  // A fleet left alone collapses: a keeper standing where its prey does not spawn leaves for the
  // top-ranked room for its creature, and one agent was seen in TEN rooms in 3.5 minutes. The
  // rooms must be live or every square reads as safe.
  await rpc('spread', { apply: true, travel: true, max_per_room: 4 });
  console.log(`recording ${fleet.length} agents for ${minutes} min -> ${STORE}`);

  const lastSeq = {};
  const until = Date.now() + minutes * 60000;
  let sweeps = 0;
  while (Date.now() < until) {
    const t0 = Date.now();
    await Promise.all(fleet.map(async c => {
      const [rec, lk] = await Promise.all([
        rpc('recording', { agent: c.agent, action: 'tail', limit: 500 }),
        rpc('look', { agent: c.agent }),
      ]);
      if (lk?.you && lk?.room) appendFileSync(STORE, JSON.stringify({
        type: 'look', t: Date.now(), agent: c.agent, who: c.character,
        room: lk.room.num, col: lk.you.col, row: lk.you.row, hp: lk.hp?.value ?? null,
        mon: (lk.objects || []).filter(o => !o.is_player && (o.can || []).includes('attack'))
               .map(o => ({ id: o.id, name: o.name, x: o.x, y: o.y, d: o.distance })),
      }) + '\n');
      const since = lastSeq[c.agent] ?? -1;
      let mx = since;
      for (const e of (rec?.tail || [])) {
        if (e.seq <= since) continue;
        if (e.seq > mx) mx = e.seq;
        if (e.kind === 'message' && e.text)
          appendFileSync(STORE, JSON.stringify({ type: 'msg', t: e.at, agent: c.agent, who: c.character, text: e.text }) + '\n');
      }
      lastSeq[c.agent] = mx;
    }));
    if (++sweeps % 20 === 0) console.log(`  ${sweeps} sweeps, ${Math.round((until - Date.now()) / 1000)}s left`);
    const rest = tick - (Date.now() - t0);
    if (rest > 0) await sleep(rest);
  }
  console.log(`done — ${sweeps} sweeps.`);
}

// ── ANALYZE ───────────────────────────────────────────────────────────────────────────────────
export function analyze(file = STORE, mapFile = 'substrate/m59-map.json') {
  const rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const byAgent = {};
  for (const r of rows) {
    const a = (byAgent[r.agent] ??= { look: [], msg: [] });
    if (r.type === 'look') a.look.push(r);
    else if (r.type === 'msg' && typeof r.text === 'string') a.msg.push(r);
  }
  for (const a of Object.values(byAgent)) {
    a.look.sort((x, y) => x.t - y.t); a.msg.sort((x, y) => x.t - y.t);
    a.out = a.msg.filter(m => classifyMessage(m.text)?.dir === 'out').map(m => m.t);
  }

  const map = JSON.parse(readFileSync(mapFile, 'utf8'));
  const geo = {}, cache = {};
  for (const r of Object.values(map.rooms ?? map)) if (r?.num != null) { try { geo[Number(r.num)] = geometryFor(r) } catch {} }
  const attackersAt = (room, col, row) => {
    const k = `${room}:${col}:${row}`; if (k in cache) return cache[k];
    let v = null;
    try { const g = geo[room]; if (g) v = !g.walkable(row, col) ? 'NW' : (exposureAt(g, row, col, { fine: false })?.attackers ?? null) } catch {}
    return (cache[k] = v);
  };
  const swungWithin = (outs, t) => { for (let i = outs.length - 1; i >= 0; i--) { if (outs[i] > t) continue; return t - outs[i] <= SWING_MS } return false };
  const placeAt = (L, t) => {
    let b = null, a = null;
    for (const l of L) { if (l.t <= t) b = l; else { a = l; break } }
    if (!b || !a || t - b.t > NEAR_MS || a.t - t > NEAR_MS) return null;
    if (b.room !== a.room || b.col !== a.col || b.row !== a.row) return null;
    return b;
  };

  const cells = { A: [], B: [], C: [], D: [] };
  const secs = { A: 0, B: 0, C: 0, D: 0 }, strict = { A: 0, B: 0, C: 0, D: 0 };
  const sqs = { A: new Set(), B: new Set(), C: new Set(), D: new Set() };
  const perSquare = {}, unknown = [];
  let inTot = 0, poison = 0, quiet = 0;
  const unparsed = {};

  for (const r of rows) if (r.type === 'msg' && typeof r.text === 'string') {
    const c = classifyMessage(r.text);
    if (!c) { const g = r.text.replace(/\b\d+\b/g, '#'); unparsed[g] = (unparsed[g] || 0) + 1 }
  }

  for (const a of Object.values(byAgent)) {
    for (const m of a.msg) {
      const c = classifyMessage(m.text);
      if (c?.dir === 'poison') { poison++; continue }
      if (c?.dir !== 'in') continue;
      inTot++;
      const p = placeAt(a.look, m.t);
      if (!p) continue;
      const e = attackersAt(p.room, p.col, p.row);
      if (typeof e !== 'number') { unknown.push(`${p.room}:${p.col},${p.row}`); continue }
      const k = e === 0 ? (swungWithin(a.out, m.t) ? 'B' : 'A') : (swungWithin(a.out, m.t) ? 'D' : 'C');
      cells[k].push({ who: m.who, room: p.room, col: p.col, row: p.row, attacker: c.who, hit: c.hit, attackers: e });
      const sq = (perSquare[`${p.room}:${p.col},${p.row}`] ??= { attackers: e, still: { s: 0, a: 0 }, swing: { s: 0, a: 0 } });
      sq[k === 'A' || k === 'C' ? 'still' : 'swing'].a++;
    }
    for (let i = 0; i < a.look.length - 1; i++) {
      const p = a.look[i], q = a.look[i + 1];
      if (q.t - p.t > NEAR_MS) continue;
      if (p.room !== q.room || p.col !== q.col || p.row !== q.row) continue;
      const e = attackersAt(p.room, p.col, p.row);
      if (typeof e !== 'number') continue;
      const dt = (q.t - p.t) / 1000;
      let near = false, moved = false;
      for (const m of (p.mon || [])) {
        if (poisons(m.name) || m.d > REACH) continue;
        near = true;
        const m2 = (q.mon || []).find(x => x.id === m.id);
        if (m2 && (m2.x !== m.x || m2.y !== m.y)) moved = true;
      }
      if (!near) { quiet += dt; continue }
      const sw = swungWithin(a.out, (p.t + q.t) / 2);
      const k = e === 0 ? (sw ? 'B' : 'A') : (sw ? 'D' : 'C');
      secs[k] += dt; if (moved) strict[k] += dt;
      sqs[k].add(`${p.room}:${p.col},${p.row}`);
      const sq = (perSquare[`${p.room}:${p.col},${p.row}`] ??= { attackers: e, still: { s: 0, a: 0 }, swing: { s: 0, a: 0 } });
      sq[sw ? 'swing' : 'still'].s += dt;
    }
  }
  return { rows, byAgent, cells, secs, strict, sqs, perSquare, unknown, inTot, poison, quiet, unparsed };
}

function report(R) {
  const f = n => (Math.round(n * 1000) / 1000).toFixed(3);
  const span = (Math.max(...R.rows.map(r => r.t)) - Math.min(...R.rows.map(r => r.t))) / 60000;
  console.log(`${R.rows.length} records, ${Object.keys(R.byAgent).length} agents, ${span.toFixed(1)} min`);
  console.log(`${R.inTot} incoming attacks; ${R.poison} poison ticks excluded (a tick is not an attack); ` +
              `${R.unknown.length} on squares the bake calls NOT WALKABLE`);
  // THE AUDIT SHOWS COMBAT-SHAPED LINES ONLY, and that is not a way of hiding the rest.
  // Most of what a session says is doors, food and spell fizzles; listing all of it buried the
  // one thing the audit exists to catch — a combat line the parser does not understand, which
  // would drop either a swing of ours (inflating cell A) or a blow against us (deflating it).
  // So the filter is "mentions attacking", and the total is still printed beside it.
  const un = Object.entries(R.unparsed).sort((a, b) => b[1] - a[1]);
  const combatish = un.filter(([k]) => /\battack\b|\byou with\b|your (?:attack|blow)\b|\bswings?\b/i.test(k));
  const total = un.reduce((a, b) => a + b[1], 0);
  console.log(`\n${total} message(s) are not combat lines (doors, food, spells); ` +
              `${combatish.length} of them are COMBAT-SHAPED and unparsed:`);
  if (!combatish.length) console.log('  none — every line mentioning an attack was classified.');
  for (const [k, v] of combatish.slice(0, 10)) console.log(`  ${String(v).padStart(4)}  ${k.slice(0, 96)}`);
  console.log('\n──────── THE 2x2 ────────');
  const line = (k, label) => {
    const n = R.cells[k].length, s = R.secs[k], st = R.strict[k];
    console.log(`  ${label.padEnd(28)} ${String(n).padStart(4)} attacks  ${String(Math.round(s)).padStart(5)}s in-reach  ` +
                `${String(Math.round(st)).padStart(5)}s moving  ${String(R.sqs[k].size).padStart(3)} sq  ` +
                `${st ? f(n / st) : ' n/a'} /s strict`);
  };
  line('A', 'A  wall,  NOT swinging'); line('B', 'B  wall,  swinging');
  line('C', 'C  open,  NOT swinging'); line('D', 'D  open,  swinging');
  console.log(`  (${Math.round(R.quiet)}s discarded: no monster in reach — no square was being tested)`);

  // The within-square control: same ground, same monsters, only the swinging differs.
  const both = Object.entries(R.perSquare).filter(([, v]) => v.attackers === 0 && v.still.s > 20 && v.swing.s > 20);
  if (both.length) {
    console.log('\n──────── THE WITHIN-SQUARE CONTROL ────────');
    console.log('  One square, both states. Geometry, room and monsters are held constant by');
    console.log('  construction, so the only thing that differs is whether the body swung.\n');
    console.log('  square              NOT swinging        swinging');
    for (const [k, v] of both.sort((a, b) => b[1].still.s - a[1].still.s))
      console.log(`  ${k.padEnd(18)} ${(v.still.a + ' atk / ' + Math.round(v.still.s) + 's').padEnd(20)}${v.swing.a} atk / ${Math.round(v.swing.s)}s`);
  }

  const A = R.cells.A.length, C = R.cells.C.length;
  console.log('\n──────── VERDICT ────────');
  if (!R.strict.A || !R.strict.C) {
    console.log('  INCONCLUSIVE — a not-swinging cell has no admissible exposure. Collect longer.');
  } else if (A === 0 && C > 0) {
    const rate = C / R.strict.C, expect = R.strict.A * rate;
    console.log(`  THE WALL PROTECTS, AND ONLY WHILE THE BODY DOES NOT SWING.`);
    console.log(`    A  ${Math.round(R.strict.A)}s on attackers===0, not swinging, monster in reach and MOVING -> 0 attacks.`);
    console.log(`    C  open ground under the same rule took ${C} attacks at ${(rate).toFixed(3)}/s.`);
    console.log(`    At that rate cell A predicts ${expect.toFixed(0)} attacks. It observed none:`);
    console.log(`    Poisson P(0 | lambda=${expect.toFixed(0)}) = ${Math.exp(-expect).toExponential(1)}.`);
    console.log(`    B  swinging FROM a wall drew ${R.cells.B.length} attacks. The wall does not cover a body`);
    console.log(`       that swings — that is the contract, not a leak, and it is why "free shots"`);
    console.log(`       from a safe spot do not exist.`);
  } else if (A === 0 && C === 0) {
    console.log('  NOT PROVEN. Nothing attacked anybody anywhere, so stillness explains the whole');
    console.log('  result and the geometry has not been shown to do anything.');
  } else {
    console.log(`  ${A} COUNTEREXAMPLE(S) — attacks on attackers===0 with no swing within ${SWING_MS / 1000}s:`);
    for (const r of R.cells.A.slice(0, 15))
      console.log(`    ${String(r.who).padEnd(6)} room ${String(r.room).padEnd(5)} @ ${r.col},${r.row}  ${r.attacker} ${r.hit ? 'HIT' : 'missed'}`);
  }
  if (R.unknown.length) {
    const u = [...new Set(R.unknown)];
    console.log(`\n  SEPARATE DEFECT: ${R.unknown.length} attack(s) landed on ${u.length} square(s) the bake calls NOT`);
    console.log('  WALKABLE. A body cannot stand where the bake says it cannot, so the bake is wrong');
    console.log('  about them — and squares like that can never be offered as safe walls at all.');
  }
}

// RUN AS A SCRIPT, IMPORTABLE AS A LIBRARY. The first version dereferenced `process.argv[1]`
// unguarded, so `import { analyze } from './m59-wallproof.mjs'` threw before it could export
// anything — which defeated the point of exporting `analyze` and `classifyMessage` at all.
const argv = process.argv.slice(2);
const invokedDirectly = typeof process.argv[1] === 'string' &&
  import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (invokedDirectly || argv.length) {
  const want = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null };
  if (argv.includes('--collect')) {
    await collect(Number(want('--minutes') ?? 20), Number(want('--tick') ?? 5000));
  } else if (argv.includes('--analyze') || argv.includes('--report')) {
    if (!existsSync(STORE)) { console.error(`no recording at ${STORE} — run --collect first`); process.exit(2) }
    report(analyze());
  } else {
    console.log('usage: m59-wallproof.mjs --collect [--minutes N] | --analyze');
  }
}
