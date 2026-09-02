#!/usr/bin/env node
// DRIVE ONE TOWN STOP FOR A LIVE CHARACTER: sell the loot, keep the reagents, buy the shorts.
//
//   node tools/m59-townstop-run.mjs --agent t6                      # plan only
//   node tools/m59-townstop-run.mjs --agent t6 --merchant Joguer    # plan against a counter
//   node tools/m59-townstop-run.mjs --agent t6 --merchant Joguer --commit
//   node tools/m59-townstop-run.mjs --agents t6,t7,t21              # plan several
//
// PLAN-ONLY BY DEFAULT, ON PURPOSE, and the reason is in docs/m59-economy.md: selling is an
// ALLOWLIST, "buys anything" is usually a robbery, and `trade` lies in both directions. A
// stop that reports success having moved nothing looks exactly like one that worked. So this
// shows what it WOULD do, reads the pack back afterwards when it does do it, and reports the
// difference rather than the intention.
//
// WHAT IT IS MADE OF, and none of it is duplicated here:
//   * tools/m59-townstop.mjs   — the arithmetic: pack + loadout -> {sell, keep, buy}
//   * substrate/strategies/    — this machine's stance, via the `atTownStop` hook
//   * the keeper's own /action — `sell_all` and `shop`, which are the only things on the wire
//
// The keeper is read directly rather than through the broker because the broker's in-process
// Autopilot is a shell on a keeper-backed fleet: `inventory` there answers about nobody.
import { planTownStop, neverSellsWhatItBuys } from './m59-townstop.mjs';
import { loadoutFor } from './m59-loadout.mjs';
import { load as loadStrategies, activeFor } from './m59-strategies.mjs';
import { resolveFleet } from './m59-fleetpath.mjs';
import {
  discoverKeeperStates,
  keeperIdentityHeaders,
  readVerifiedKeeperState,
  resolveKeeperBand,
} from './runtime/keeper-discovery.mjs';

const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const has = (n) => process.argv.includes('--' + n);
const COMMIT = has('commit');

// One resolver, and it knows that substrate/fleet-default is a commented file. Reading that
// file directly returns four lines of prose along with the name.
const FLEET_INFO = resolveFleet();
const FLEET = FLEET_INFO.fleet;

const agents = (arg('agents') || arg('agent') || '').split(',').map(s => s.trim()).filter(Boolean);
if (!agents.length) { console.error('need --agent t6 or --agents t6,t7'); process.exit(2); }

// Discovery scans only this fleet's fixed band. `/live` proves the cheap identity first;
// rich state is then requested only for the named agents below.
const KEEPER_BAND = resolveKeeperBand(FLEET, {
  ...(Object.hasOwn(process.env, 'M59_KEEPER_PORT_BASE')
    ? { override: process.env.M59_KEEPER_PORT_BASE }
    : {}),
});
const jpost = async (identity, path, body, ms = 120000) => {
  try {
    const r = await fetch(`http://127.0.0.1:${identity.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...keeperIdentityHeaders(identity) },
      body: JSON.stringify({
        ...body,
        agent: identity.agent,
        character: identity.character,
        keeper_pid: identity.pid,
      }),
      signal: AbortSignal.timeout(ms),
    });
    return await r.json();
  } catch (e) { return { error: String(e.message || e) }; }
};

const discovered = await discoverKeeperStates({
  band: KEEPER_BAND,
  expectedAgents: agents,
  liveTimeoutMs: 1500,
  stateTimeoutMs: 8000,
});

const strategies = await loadStrategies();
for (const p of strategies.problems) console.error(`  (strategy problem) ${p.file}: ${p.why}`);
const townHooks = activeFor(strategies, 'atTownStop');

for (const agent of agents) {
  const st = discovered.states.get(agent);
  const identity = st?.__identity ?? null;
  if (!identity) { console.log(`\n${agent}: no verified keeper answering in this fleet's band`); continue; }

  const character = st.character;
  const items = (st.items || []).map(i => ({ name: i.name, amount: i.amount ?? 1 }));
  // WHAT THE SERVER SAYS IS WORN, not what the pack contains. plUsing is the only honest
  // list; selling something we are fighting in is the one mistake with no undo.
  const equipped = (st.equipment || []).map(e => (typeof e === 'string' ? e : e.name));
  const loadout = loadoutFor(character);

  console.log(`\n=== ${character} (${agent}) · room ${st.room?.num} ${st.room?.name ?? ''} ===`);
  console.log(`    pack ${items.length} kinds · bulk ${st.carry?.load?.bulk}/${st.carry?.bulk_max}` +
              ` · free ${st.carry?.room_for?.bulk ?? '?'} · purse ${st.gold ?? '?'}`);
  if (!loadout) {
    console.log('    NO LOADOUT — declining. An absent loadout means "the behaviour that was ' +
                'already there", never "sell everything".');
    continue;
  }

  // Ask this machine's strategies first; fall back to the bare filter so the tool still works
  // on a clone with an empty strategies directory.
  const ctx = { loadout, items, equipped, room: st.room, purse: st.gold,
                bulkFree: st.carry?.room_for?.bulk ?? null };
  let plan = null, from = null;
  for (const s of townHooks) {
    try { const a = await s.atTownStop(ctx); if (a) { plan = a; from = s.name; break; } }
    catch (e) { console.error(`    (strategy ${s.name} threw: ${e.message})`); }
  }
  if (!plan) { plan = planTownStop(loadout, { items, equipped }); from = 'the bare filter'; }
  if (!plan) { console.log('    nothing to decide'); continue; }

  const inv = neverSellsWhatItBuys(plan);
  if (!inv.ok) { console.log(`    REFUSING: would sell and buy the same thing: ${inv.both.join(', ')}`); continue; }

  console.log(`    plan from ${from}: ${plan.summary}`);
  for (const x of plan.sell) console.log(`      sell  ${String(x.amount).padStart(4)} ${x.item}   (${x.why})`);
  for (const x of plan.buy) console.log(`      buy   ${String(x.short).padStart(4)} ${x.item}   (${x.why})`);
  for (const x of plan.withheld) console.log(`      keep  ${String(x.over).padStart(4)} ${x.item} over ceiling — ${x.why}`);
  for (const c of plan.conflicts) console.log(`      !     ${c.item}: ${c.why}`);
  console.log(`      protecting: ${plan.keep_fragments.join(', ') || '(nothing)'}`);

  if (!COMMIT) { console.log('      (plan only — pass --commit to execute)'); continue; }

  const merchant = arg('merchant');
  if (!merchant) { console.log('      --commit needs --merchant <name or id>'); continue; }

  // SELL. `keep` is handed straight from the plan, which is the entire point of the exercise:
  // nobody types the protected list a second time and nobody forgets the third reagent.
  const before = { ...Object.fromEntries(items.map(i => [i.name.toLowerCase(), i.amount])) };
  const sold = await jpost(identity, '/action', {
    name: 'sell_all',
    args: { merchant, keep: plan.keep_fragments, min_price: 1, max_stack: 50 },
  });
  console.log(`      sold: ${JSON.stringify(sold).slice(0, 260)}`);

  // READ THE PACK BACK. A completed handshake that moved nothing is the normal failure here.
  const after = await readVerifiedKeeperState(identity, { fresh: true, timeoutMs: 12000 });
  const now = Object.fromEntries((after?.items || []).map(i => [String(i.name).toLowerCase(), i.amount ?? 1]));
  const kept = plan.keep_fragments.filter(f => {
    const hitBefore = Object.keys(before).some(k => k.includes(f));
    const hitAfter = Object.keys(now).some(k => k.includes(f));
    return hitBefore && !hitAfter;
  });
  if (kept.length) console.log(`      WARNING: protected and now missing: ${kept.join(', ')}`);
  console.log(`      bulk now ${after?.carry?.load?.bulk}/${after?.carry?.bulk_max}` +
              ` (free ${after?.carry?.room_for?.bulk ?? '?'}) · purse ${after?.gold ?? '?'}`);
}
