#!/usr/bin/env node
// PRACTISE A SPELL THAT NEEDS NOTHING BUT THE CASTER — and stop when the reagents do.
//
//   node tools/m59-spelldrill.mjs --agent hk1 --spell "forces of light"            # plan only
//   node tools/m59-spelldrill.mjs --agent hk1 --spell "forces of light" --apply
//   node tools/m59-spelldrill.mjs --agent hk1 --spell purify --apply --max-casts 400
//   node tools/m59-spelldrill.mjs --agent hk1 --spell "forces of light" --apply \n//        --rooms 370,373,376,372            # a ROOM enchantment needs a circuit, not a chair
//
// WHY THIS IS NOT m59-shalille-train.mjs. That tool drills the HEAL ladder, and a heal needs
// somebody with a wound — which is the whole reason it carries an Amulet of Shadows, two
// health floors and an abort threshold. A self-targeted buff needs none of that: `forces of
// light`, `purify` and `holy symbol` all report `targets: 0`, so the caster is the entire
// apparatus. Bolting a mode onto the amulet rig for spells that cannot hurt anybody would put
// the dangerous machinery in the path of the safe case.
//
// THE FLEET ACQUIRED FOUR LEVEL-4 SHAL'ILLE SPELLS ON 2026-09-11 AND HAD NO WAY TO TRAIN ONE.
// Loial came through the PlayerCanLearn gate at hospice 81 and bought forces of light, purify,
// dazzle and mark of dishonor. Two of those are self-targeted and this drills them; the other
// two need a target and are refused here unless one is named, because a single-target spell
// cast at nothing is a silent no-op that looks exactly like practice.
//
// WHAT STOPS IT, in the order it checks:
//
//   * REAGENTS. Read from the pack every round rather than assumed from a count taken at the
//     start — a keeper that banks, a death on the road, or a hand-over changes them
//     underneath. `forces of light` is 2 x ElderBerry + 1 x Emerald, so the berry runs out
//     first and the run says which one it was.
//   * MANA. 12 of 65 buys five casts and then nothing until it comes back. This WAITS rather
//     than spending the attempt: the `cast` tool refuses an unaffordable spell without
//     sending it, and a refused cast is often silent, so a loop that ignores mana reads as
//     working while raising nothing. It never sits the caster DOWN to recover — it stands it
//     UP before every cast, because a RESTING player cannot cast at all (PFLAG_NO_MAGIC) and
//     the refusal is silent: the broker answers `cast: true, mana_spent: 0`. A caster parked
//     in an inn with restBelow 0.95 is sitting down almost all the time, so this is the
//     normal case rather than a corner of it.
//   * THE ROOM, for a RoomEnchantment. `forces of light` enchants the ROOM and its
//     CanPayCosts refuses while that room already holds it, silently — `cast: true,
//     mana_spent: 0, messages: []`. A caster standing still therefore gets ONE cast per
//     expiry cycle and burns the rest of the hour on refusals that read like being asleep.
//     `--rooms` walks a circuit instead; the ring self-sizes, because a room that refuses
//     twice is one we have already lit.
//   * THE ANTI-BOT CAP. ADVANCEMENT_LIMIT is 10 improvements per random 15-22 minute window,
//     spells and skills together (player.kod:66-68). Casting faster than that raises nothing
//     and spends reagents for it, so `--every` defaults to 8s rather than to as fast as the
//     wire allows.
//
// AND IT HOLDS THE BODY. Work, movement and economy are leased off the keeper for the run —
// identity, mortality, survival and recovery stay with it, which is the protected-faculty rule
// and not this tool's to switch off. Without the lease the keeper re-decides about every
// thirty seconds and walks the caster off to hunt mid-drill.
//
// THE RUN LOCK IS PER-CHARACTER AND IT DOES NOT SPAN CHECKOUTS. `m59-runlock.mjs` writes into
// its OWN repo's substrate, so a drill started from a clone and a fleetscript started from the
// deploy see each other as absent and both drive the same body. Point this at the deploy's
// lock when that is where the broker lives:
//   M59_RUNLOCK_DIR=/c/code/m59-lab/prod-deploy/substrate node tools/m59-spelldrill.mjs ...
import process from 'node:process';
import { takeAgentLocks } from './m59-runlock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = n => argv.includes(`--${n}`);
const die = (m, c = 1) => { console.error(m); process.exit(c); };

const AGENT = arg('agent') || die('--agent is required (the caster)');
// COMMA SEPARATED, TRIED IN ORDER. `--spell "forces of light,cure disease"` drills both in
// one loop; `--target` takes one per spell in the same order, and the word `self` resolves to
// this character own name.
const SPELLS = String(arg('spell') || die('--spell is required')).split(',')
  .map(x => x.trim().toLowerCase()).filter(Boolean);
// POSITIONAL, AND AN EMPTY SLOT IS MEANINGFUL. `--target ",self"` means the first spell
// takes no target and the second takes this character. Dropping the empties instead shifted
// every later target one place left and refused a perfectly good invocation.
const TARGETS = String(arg('target') ?? '').split(',').map(x => x.trim() || null);
const APPLY = has('apply');
const FLEET = arg('fleet') || null;
const MAX_CASTS = Number(arg('max-casts') || 300);
const EVERY_MS = Math.max(2000, Number(arg('every') || 8) * 1000);
const BROKER = `http://127.0.0.1:${Number(arg('broker') || 8901)}/`;
// THE ROOMS TO WALK BETWEEN, for a spell that enchants a ROOM rather than a body. Comma
// separated; omit it and the drill stands still, which is right for a spell that does not
// care where it is cast and wrong for every RoomEnchantment. See the refusal branch below.
const RING = String(arg('rooms') || '').split(',').map(x => Number(x.trim())).filter(Boolean);

let seq = 0;
async function call(name, args = {}, ms = 60_000) {
  // A DROPPED SOCKET IS NOT AN ANSWER. Node reuses keep-alive connections the broker has
  // already closed and does not retry a POST, so a read comes back `fetch failed /
  // ECONNRESET` in single-digit milliseconds. Reads are asked again; a `cast` is not,
  // because a reset cannot say whether the spell was sent and a repeat spends the reagents
  // twice. Same rule, same reason, as m59-fleetscript's `call`.
  const retries = /^(status|inventory|abilities|spells|fleet)$/.test(name) ? 4 : 1;
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(BROKER, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call',
                               params: { name, arguments: args } }),
        signal: AbortSignal.timeout(ms),
      });
      const d = await r.json();
      try { return JSON.parse(d.result.content[0].text); } catch { return d.result?.content?.[0]?.text ?? d; }
    } catch (e) {
      last = e;
      if (e?.name === 'TimeoutError' || i + 1 >= retries) throw e;
      await new Promise(r => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw last;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s ?? '').toLowerCase().replace(/\s+/g, '');
const countIn = (items, want) => (items ?? [])
  .filter(i => norm(i.name) === norm(want))
  .reduce((s, i) => s + (i.amount ?? 1), 0);

// ---------------------------------------------------------------- what the spells cost
//
// MORE THAN ONE SPELL, BECAUSE SOME CANNOT BE CAST ON DEMAND. `cure disease` needs a target
// that is ALREADY diseased — cdisease.kod's CanPayCosts wants exactly one target, a User, and
// `IsEnchanted #byClass=&Disease` — so a drill that knows only that spell spends its whole run
// refusing while it waits to catch something. Paired with a spell that is always castable the
// waiting costs nothing: try each in order and take whichever actually spends reagents.
const book = await call('spells', { agent: AGENT });
const me0 = await call('status', { agent: AGENT }).catch(() => null);
const SELF = me0?.character ?? null;

const ROWS = SPELLS.map((want, idx) => {
  const found = (book.spells ?? []).find(s => String(s.name).toLowerCase() === want)
             ?? (book.spells ?? []).find(s => String(s.name).toLowerCase().includes(want));
  if (!found)
    die(`${AGENT} does not know a spell matching "${want}". Knows: ` +
        (book.spells ?? []).map(s => s.name).join(', '));
  const raw = TARGETS[idx] ?? (SPELLS.length === 1 ? TARGETS[0] : null) ?? null;
  const target = raw && /^self$/i.test(raw) ? SELF : raw;
  // A SINGLE-TARGET SPELL CAST AT NOTHING IS A SILENT NO-OP. `dazzle` and `mark of dishonor`
  // report targets: 1, the server answers a targetless cast with nothing at all, and the loop
  // would read as practice while spending a reagent a round.
  if (found.targets > 0 && !target)
    die(`"${found.name}" needs a target (targets: ${found.targets}) and a targetless cast is ` +
        'silent rather than refused — it would look exactly like practice. Pass --target ' +
        '<who>, or --target self, or drill a spell that takes none.');
  const cost = (found.reagents ?? []).map(t => {
    const m = /^\s*(\d+)\s*x\s*(.+?)\s*$/i.exec(String(t));
    return m ? { n: Number(m[1]), item: m[2] } : { n: 1, item: String(t) };
  });
  return { row: found, target, cost };
});
const row = ROWS[0].row;

// EVERY REAGENT ANY OF THEM NEEDS, merged by name — this is what the run stops on and what
// the preflight reports. Two spells that share elderberry must not each be measured as if it
// had the stack to itself.
const COST = [...new Map(ROWS.flatMap(r => r.cost)
  .map(c => [c.item.toLowerCase(), c])).values()];

for (const { row: sp, target, cost } of ROWS)
  console.log(`${sp.name} — school ${sp.school}, level ${sp.level}, ${sp.mana} mana, ` +
              `targets ${sp.targets}${target ? ` (${target})` : ''}, ` +
              `karma ${sp.required_karma ?? '-'} | ` +
              `${cost.map(c => `${c.n} x ${c.item}`).join(' + ') || 'no reagents'}`);

const scoreOfNamed = (a, nm) => (a?.spells ?? [])
  .find(s => String(s.name).toLowerCase() === String(nm).toLowerCase())?.ability ?? null;
const scoreOf = (a) => (a?.spells ?? [])
  .find(s => String(s.name).toLowerCase() === String(row.name).toLowerCase())?.ability ?? null;
const before = await call('abilities', { agent: AGENT });
console.log(`ability now: ${scoreOf(before) ?? 'null (never cast)'}`);

const inv0 = await call('inventory', { agent: AGENT });
for (const c of COST)
  console.log(`  carrying ${countIn(inv0.items, c.item)} ${c.item} — ` +
              `${Math.floor(countIn(inv0.items, c.item) / c.n)} cast(s)`);
// THE BEST ANY ONE SPELL CAN DO, not the worst across all of them. Taking the minimum over
// the MERGED reagent list lets a second spell the character cannot currently afford zero out
// a first spell it can: with 109 elderberry, 23 emerald and no herbs, `forces of light` has
// fifty-four casts in hand and `cure disease` none, and the merged minimum called that zero
// and refused the run. A drill stops when NOTHING is castable, not when something is not.
const castsFor = (r) => r.cost.length
  ? Math.min(...r.cost.map(c => Math.floor(countIn(inv0.items, c.item) / c.n)))
  : MAX_CASTS;
for (const r of ROWS) console.log(`  ${r.row.name}: ${castsFor(r)} cast(s) in the pack`);
const affordable = Math.max(...ROWS.map(castsFor));
console.log(`reagents allow ${affordable} cast(s); capped at ${MAX_CASTS}, paced at ${EVERY_MS / 1000}s`);

if (!APPLY) { console.log('\n--apply to run it. Nothing was cast.'); process.exit(0); }
if (affordable < 1) die('\nnot enough reagents for a single cast — buy them first.');

// ---------------------------------------------------------------- one driver per character
const health = await (await fetch(`${BROKER}health`)).json();
const fleet = FLEET ?? health.fleet;
const held = takeAgentLocks(fleet, [AGENT], { label: `spelldrill ${SPELLS.join('+')} [${AGENT}]`, force: has('force') });
if (!held.ok) {
  console.error(`REFUSING — ${AGENT} is already being driven by pid ${held.holder?.pid} ` +
                `(${held.holder?.label}). Wait for it, stop that pid, or pass --force.`);
  process.exit(2);
}

// ---------------------------------------------------------------- the lease
const owner = `spelldrill:${process.pid}`;
let lease = null;
const leaseCall = (action, extra = {}) => call('commander_lease', {
  action, fleet, broker_pid: health.pid, owner, lease_ms: 30_000, ...extra }, 30_000)
  .catch(e => ({ error: e.message }));
// THE COMMANDER REFUSES A LEASE WITHOUT AN EXACT SERVER HOST AND PORT, and from the
// caller side that refusal reads only as a bare refusal. The sentence it actually
// returns is: commander request requires an exact game server host and port. The broker
// states both under /health.game_server, so they are read here rather than hard-coded —
// m59-shalille-train.mjs carries a literal 76.214.42.186 and would lease against the wrong
// server the day this fleet moves.
// AND IT WANTS THE CHARACTER NAME AS WELL AS THE AGENT: `each commander agent needs an exact
// agent and character`. Both refusals arrive as prose, and the caller sees only that no lease
// came back, so they are named in full here rather than left to be rediscovered.
const gs = health.game_server ?? {};
if (!gs.host || !gs.port)
  console.log('WARNING: /health names no game server — the commander will refuse the lease');
const me = await call('status', { agent: AGENT }).catch(() => null);

// A LEASE REFUSED ONCE IS USUALLY A LEASE HELD BY A PROCESS THAT HAS JUST DIED.
//
// Leases run 30s and the previous holder's does not vanish when its process is killed — it
// lapses. So restarting this drill inside that window is refused, and the first version
// shrugged: it printed a warning and then drove an UNHELD body for as long as the run lasted.
// Measured 2026-09-11, restarting minutes after a prod roll. The character this matters most
// for is exactly the one it was running on — a 20-max-HP body whose keeper walks it into open
// country the moment nothing is holding it.
const takeLease = async () => {
  const r = await leaseCall('acquire', {
    agents: [{ agent: AGENT, character: me?.character }],
    server_host: gs.host, server_port: gs.port });
  return { id: r?.lease_id ?? r?.lease_token ?? r?.token ?? null, why: r?.error ?? 'refused' };
};
let why = null;
for (let i = 0; i < 8 && !lease; i++) {
  const got = await takeLease();
  lease = got.id; why = got.why;
  if (!lease && i + 1 < 8) {
    if (i === 0) console.log(`lease refused (${why}) — waiting out the previous holder's 30s`);
    await sleep(5000);
  }
}
if (!lease) {
  // NOT A WARNING. Driving a body nothing is holding is the failure this tool exists beside,
  // and an hour of casting is long enough for a keeper to take the character anywhere.
  held.release?.();
  die(`refusing to drill an UNHELD ${AGENT}: the commander would not grant a lease after ` +
      `eight tries (${why}). Whatever is holding it has to let go first.`, 3);
}
console.log(`holding ${AGENT} (lease ${String(lease).slice(0, 12)})`);

let stopped = false;
const stop = async () => {
  if (stopped) return;
  stopped = true;
  if (lease) await leaseCall('release', { lease_token: lease });
  held.release?.();
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await stop(); process.exit(130); });

// ---------------------------------------------------------------- the loop
let cast = 0, refused = 0, waited = 0, beats = 0, blindRounds = 0;
let ringAt = 0, roomRefusals = 0;
const perSpell = new Map();
const started = Date.now();
for (let round = 0; cast < MAX_CASTS; round++) {
  if (lease && ++beats % 3 === 0) await leaseCall('heartbeat', { lease_token: lease });

  // AN EMPTY PACK READ IS NOT AN EMPTY PACK.
  //
  // A keeper that has just restarted answers `inventory` with `items: []` for a few seconds
  // before the server has pushed it anything. Measured 2026-09-11, minutes after a prod roll:
  // this loop read one of those, concluded "out of Elderberry after 0 cast(s)" and exited —
  // while the character stood in the inn holding fifteen. Same family as every other trap in
  // this repository: a read that could not answer is not a fact about the world.
  //
  // So an empty list is treated as unreadable, and a shortage has to survive a second look
  // before it ends the run. A real shortage says so twice a second apart; a cold snapshot
  // does not.
  const readPack = async () => {
    const r = await call('inventory', { agent: AGENT }).catch(() => null);
    return Array.isArray(r?.items) && r.items.length ? r : null;
  };
  let inv = await readPack();
  if (!inv) {
    await sleep(1500);
    inv = await readPack();
  }
  // AN UNREADABLE PACK IS A REASON TO WAIT, NOT A REASON TO STOP.
  //
  // Keepers restart about once a minute on this fleet, and each restart leaves a window where
  // `inventory` answers empty. Two bad reads a second and a half apart is well inside one of
  // those windows — and this used to end an hour-long run on it: measured 2026-09-11, the
  // drill exited after three casts with ninety-seven elderberries in the pack and the caster
  // parked safely in an inn. Nothing was wrong except the timing of two reads.
  //
  // So a bad read costs a round, not the run. It still gives up eventually, because a body
  // that has been unreadable for two solid minutes is a body something else has taken.
  if (!inv) {
    if (++blindRounds >= 12) {
      console.log(`the pack has been unreadable for ${blindRounds} rounds — stopping rather ` +
                  'than casting blind');
      break;
    }
    if (blindRounds === 1) console.log('  pack unreadable — waiting rather than stopping');
    await sleep(EVERY_MS);
    continue;
  }
  blindRounds = 0;
  let short = COST.find(c => countIn(inv.items, c.item) < c.n);
  if (short) {
    await sleep(1500);
    const again = await readPack();
    short = again ? COST.find(c => countIn(again.items, c.item) < c.n) : short;
    if (again) inv = again;
  }
  if (short) { console.log(`out of ${short.item} after ${cast} cast(s)`); break; }

  const st = await call('status', { agent: AGENT }).catch(() => null);
  const mana = st?.mana?.value ?? st?.vitals?.mana?.value ?? null;
  if (mana != null && mana < row.mana) {
    waited++;
    if (waited % 5 === 1) console.log(`  mana ${mana}/${row.mana} — waiting`);
    await sleep(EVERY_MS);
    continue;
  }

  // A RESTING PLAYER CANNOT CAST AT ALL (PFLAG_NO_MAGIC) and the refusal is SILENT. This is
  // not a corner case for a drill: the caster is parked in an inn precisely so it is safe,
  // and its keeper's restBelow was 0.95 on the night this was written, so it is sitting down
  // almost all the time. Standing costs one call and is idempotent.
  await call('rest', { agent: AGENT, stand: true }).catch(() => null);

  // EACH SPELL IN TURN, STOPPING AT THE FIRST THAT SPENDS ANYTHING. The reagent check below
  // is the only honest test of whether a cast happened, so it runs per spell rather than once
  // for the round — otherwise a `cure disease` that refused would be credited with the
  // elderberry a `forces of light` spent, and vice versa: they share the berry.
  let r = null, castSpell = null, spent = false;
  for (const attempt of ROWS) {
    r = await call('cast', { agent: AGENT, spell: attempt.row.name,
                             ...(attempt.target ? { target: attempt.target } : {}) })
      .catch(e => ({ cast: false, reason: e.message }));
    castSpell = attempt;
    for (let i = 0; i < (ROWS.length > 1 ? 4 : 8) && !spent; i++) {
      await sleep(900);
      const now = await call('inventory', { agent: AGENT }).catch(() => null);
      spent = !!now && attempt.cost.some(c => countIn(now.items, c.item) < countIn(inv.items, c.item));
    }
    if (spent || (r?.cast && (r.mana_spent ?? 0) > 0)) break;
  }

  // THE REAGENTS ARE THE RECEIPT — NOT `cast`, AND NOT `mana_spent`.
  //
  // `cast: true` only means the request went out. `mana_spent` looked like the honest answer
  // and is not: it is a before/after difference the broker computes across the same event
  // race every post-transaction read here loses, so it reads 0 on casts that plainly
  // happened. Measured 2026-09-11 on the first run of this file — every round reported
  // `mana_spent: 0` with "NOTHING was spent", and the pack had gone 62 -> 58 elderberry and
  // 39 -> 37 emerald while the ability moved 16 -> 18. Two real casts, reported as two
  // refusals. Reagents are consumed only on a SUCCESSFUL cast, they are a count rather than a
  // rate, and they settle in the pack — so the pack is what gets asked.
  // The window is generous because the pack arrives on an EVENT: a 2.8s window still filed
  // real casts as refusals on the run this was measured on, with the reagents showing up a
  // moment later. First read that shows a drop wins, so a fast reply costs nothing.
  // (The loop above does this per spell; `spent` and `castSpell` carry its verdict here.)
  if (spent || (r?.cast && (r.mana_spent ?? 0) > 0)) {
    cast++;
    perSpell.set(castSpell.row.name, (perSpell.get(castSpell.row.name) ?? 0) + 1);
    if (cast === 1 || cast % 10 === 0) {
      const a = await call('abilities', { agent: AGENT }).catch(() => null);
      const scores = ROWS.map(x => `${x.row.name} ${scoreOfNamed(a, x.row.name) ?? '?'}`).join(', ');
      console.log(`  ${cast} cast(s) [${[...perSpell].map(([k, v]) => `${k} x${v}`).join(', ')}] ` +
                  `| ${scores} | ` +
                  COST.map(c => `${countIn(inv.items, c.item)} ${c.item}`).join(', '));
    }
  } else {
    refused++;
    const why = r?.reason ?? r?.what_the_mana_says ?? 'no reason given';
    if (refused % 5 === 1) console.log(`  refused (${refused}): ${String(why).slice(0, 130)}`);

    // A ROOM ENCHANTMENT CANNOT BE CAST TWICE IN THE SAME ROOM, AND SAYS SO IN SILENCE.
    //
    // `forces of light` is a RoomEnchantment (kod/object/passive/spell/roomench/forceslt.kod)
    // and its CanPayCosts refuses outright while the room already holds it:
    //
    //     if Send(oRoom,@IsEnchanted,#what=self)
    //        { Send(who,@MsgSendUser,#message_rsc=forcesoflight_already_enchanted);
    //          return FALSE; }
    //
    // The refusal never reaches the wire as anything readable — measured 2026-09-11, three
    // casts in a row answered `cast: true, mana_spent: 0, messages: []`. So a caster standing
    // in one room gets ONE cast per expiry cycle and silently burns the rest of the hour on
    // refusals, which is exactly what this drill did from 16 to 50 with hundreds of them in
    // the log. The operator spotted it from the outside: an area spell wants a circuit.
    //
    // The ring self-sizes rather than hard-coding a duration: a room that refuses twice is
    // one we have already lit, so move on. By the time the ring comes round it has expired.
    if (RING.length > 1 && ++roomRefusals >= 2) {
      roomRefusals = 0;
      ringAt = (ringAt + 1) % RING.length;
      const to = RING[ringAt];
      console.log(`  this room is already enchanted — moving to ${to} ` +
                  `(${ringAt + 1} of ${RING.length})`);
      const t = await call('travel', { agent: AGENT, to }, 600_000).catch(e => ({ error: e.message }));
      if (t?.arrived) console.log(`  arrived at ${to}`);
      else console.log(`  did not reach ${to}: ${String(t?.why ?? t?.error ?? 'unknown').slice(0, 90)}`);
      continue;                       // the walk is the round; do not also sleep out a tick
    }
    if (refused > 40 && cast === 0) { console.log('forty refusals and nothing cast — stopping'); break; }
  }
  await sleep(EVERY_MS);
}

const after = await call('abilities', { agent: AGENT }).catch(() => null);
console.log(`\n${cast} cast(s), ${refused} refused, ${waited} mana wait(s) in ` +
            `${Math.round((Date.now() - started) / 60000)} min`);
for (const x of ROWS)
  console.log(`${x.row.name}: ${scoreOfNamed(before, x.row.name) ?? 'null'} -> ` +
              `${after ? (scoreOfNamed(after, x.row.name) ?? 'null') : '?'}` +
              ` (${perSpell.get(x.row.name) ?? 0} cast)`);
await stop();
