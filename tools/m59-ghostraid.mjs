#!/usr/bin/env node
// THE GHOST OF FAR'NOHL, END TO END: form up outside Castle Victoria, dedicate a hammer for every
// raider, buff, go in together under forces of light, kill it, hold the throne room for half an
// hour — and say how many of the fleet were still alive at the end of it.
//
//   node tools/m59-ghostraid.mjs plan  --fleet shadow            who does what; sends nothing
//   node tools/m59-ghostraid.mjs setup --fleet shadow --lab      LAB ONLY: heal, place at room 2
//   node tools/m59-ghostraid.mjs all   --fleet shadow --lab --commit
//   node tools/m59-ghostraid.mjs all   --fleet prod --commit      the same code, no DM powers
//   node tools/m59-ghostraid.mjs arm|prep|fight --fleet <f> --commit      one phase
//   node tools/m59-ghostraid.mjs report --run substrate/raids/ghost-<stamp>
//   node tools/m59-ghostraid.mjs rehearse --fleet shadow --commit   rebuild a faithful clone, run it with NO DM
//   node tools/m59-ghostraid.mjs muster --fleet prod                 job 0, previewed (read-only)
//   ... room=<n> door=<n> target=<pattern> retarget the fight; armorers=a,b trips=n spare=zombie tune it
//
// ============================================================================
// ONE SCRIPT, TWO FLEETS, AND THE LINE BETWEEN THEM
// ============================================================================
//
// The operator's requirement: rehearse on the shadow fleet, then run THE SAME SCRIPT on prod,
// where there are no DM powers — so on prod the fleet has to share its reagents and hammers,
// rest for mana, and buff itself. That is exactly how this is built: every phase is a
// FleetScript that talks to the broker only, and `--lab` adds three conveniences that remove
// WAITING and SHOPPING without changing the fight (the bargain in docs/m59-fleetscratch.md):
//
//   * setup   heal everyone to full and, with --place, put them at room 2 over the DM socket
//   * arm     create a hammer when the fleet has none spare, grant a reagent the fleet is short
//             of, and refill a dedicator's mana instead of resting
//
// `--lab` goes through `assertLabFleet`, which throws for any fleet not in M59_LAB_FLEETS
// (default: shadow), and every DM packet goes through m59-dm.mjs, which refuses a non-loopback
// host. Two independent refusals; prod passes neither.
//
// NOTHING ACTS WITHOUT --commit. Without it every phase prints what it would do.
//
// ============================================================================
// THE REPORT IS MADE FROM EVIDENCE, NOT FROM THIS PROCESS'S MEMORY
// ============================================================================
//
// The survival rate comes from the fleet's own ledger (`died` rows, `killed` rows) and from the
// raid's samples file, both on disk. Keepers restart about once a minute and this process can
// be killed; a tally kept in memory by either is not a measurement (CLAUDE.md: "Kills come from
// the ledger, never from a keeper's own tally"). `report` can be re-run on a raid directory at
// any time, and says what fraction of the window it actually observed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { survivalReport, reportMarkdown, GHOST_ROOM, STAGE_ROOM, assignRoles, raidNeeds, chestPlan } from './m59-ghostraid-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');

const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const opt = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };

// Per-fleet defaults. A default here is only a default: the identity guard in fleetScript
// still refuses a broker that is not holding the roster file named below.
const FLEETS = {
  prod:   { port: 8901, agents: [...Array.from({ length: 21 }, (_, i) => `t${i + 1}`), 'hk1'],
            lightbearer: 'hk1', channel: 'guild' },
  shadow: { port: 8971, agents: Array.from({ length: 22 }, (_, i) => `shadow${String(i + 1).padStart(2, '0')}`),
            lightbearer: 'shadow20', channel: 'say' },
};

export function configure(env = process.env) {
  const fleet = opt('--fleet', env.M59_FLEET ?? null);
  if (!fleet) throw new Error('name the fleet: --fleet shadow | --fleet prod');
  const d = FLEETS[fleet] ?? {};
  const port = Number(opt('--broker-port', d.port ?? 8901));
  env.M59_FLEET = fleet;
  env.M59_CONTROL_URL = env.M59_CONTROL_URL ?? `http://127.0.0.1:${port}/`;
  const roster = opt('--roster', env.M59_STATE_FILE ?? null);
  if (roster) {
    env.M59_STATE_FILE = roster;
    // The run lock lives beside the roster it protects, so a run from a development checkout
    // takes THE SAME lock as the checkout that owns the broker (runlock-does-not-span-checkouts).
    env.M59_RUNLOCK_DIR = env.M59_RUNLOCK_DIR ?? path.dirname(path.dirname(roster));
  }
  const agents = String(opt('--agents', '') || '').split(',').map(s => s.trim()).filter(Boolean);
  return {
    fleet, port,
    agents: agents.length ? agents : d.agents ?? [],
    lightbearer: opt('--lightbearer', d.lightbearer ?? ''),
    healers: opt('--healers', ''),
    channel: opt('--channel', d.channel ?? 'say'),
    lab: flag('--lab'),
    commit: flag('--commit'),
    minutes: Number(opt('--minutes', 30)),
    stage: Number(opt('--stage', STAGE_ROOM)),
    // Empty by default: bless and super strength are cast at the DOOR by ghost-raid, where
    // three-to-five-minute bless still has most of its life at contact. prep then only feeds
    // everyone (vigor over 80 has to be eaten). Name buffs here to self-cast them in room 2 too.
    buffs: opt('--buffs', ''),
    ledger: opt('--ledger', env.M59_LEDGER_DIR ?? null),
    // THE DUM RAID PROFILE (meridian59-dum-bot, branch raid-profiles): a running DUM's
    // operation-profile overlay, switched on for the raid and off when it officially ends.
    dumUrl: opt('--dum-url', null),
    dumProfile: opt('--dum-profile', null),
  };
}

async function rpc(name, args = {}, ms = 60_000) {
  const url = new URL('rpc', process.env.M59_CONTROL_URL).href;
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(ms) });
  const j = await r.json();
  const t = j?.result?.content?.[0]?.text;
  try { return JSON.parse(t); } catch { return t ?? j; }
}

// ---------------------------------------------------------------------------------- plan

async function plan(cfg) {
  const spells = {};
  const rows = new Map(((await rpc('fleet', {}, 40_000))?.fleet ?? []).map(r => [r.agent, r]));
  await Promise.all(cfg.agents.map(async a => {
    spells[a] = ((await rpc('spells', { agent: a }).catch(() => null))?.spells ?? []).map(s => String(s.name ?? '').toLowerCase());
  }));
  const roles = assignRoles(cfg.agents, spells, { lightbearer: cfg.lightbearer, healers: cfg.healers });
  const name = a => rows.get(a)?.character ?? a;
  console.log(`fleet ${cfg.fleet} via ${process.env.M59_CONTROL_URL}  ${cfg.lab ? '[LAB: DM conveniences on]' : '[no DM powers]'}`);
  console.log(`  ${cfg.agents.length} characters; stage room ${cfg.stage} (Outside Castle Victoria), door 38, throne room ${GHOST_ROOM}`);
  console.log(`  light-bearer  ${roles.lightbearer ? name(roles.lightbearer) : 'NOBODY KNOWS forces of light'}`);
  console.log(`  dedicators    ${roles.dedicators.map(name).join(', ') || 'NOBODY KNOWS enchant weapon'}`);
  console.log(`  healers       ${roles.healers.map(name).join(', ') || 'none'}`);
  console.log(`  raiders       ${roles.raiders.length}`);
  for (const a of cfg.agents) {
    const r = rows.get(a);
    console.log(`    ${a.padEnd(9)} ${String(r?.character ?? '?').padEnd(18)} ${String(r?.health ?? '?').padEnd(7)} ` +
                `room ${String(r?.room_num ?? '?').padEnd(4)} ${String(r?.wielding ?? '-').padEnd(12)}`);
  }
  console.log('\n  phases: arm (hammers, reagents, dedicate) -> prep (buffs) -> fight (door, light, kill, ' +
              `${cfg.minutes} min farm) -> report`);
  return roles;
}

// ---------------------------------------------------------------------------------- the chest plan

/**
 * WHAT THE RAID WILL TAKE OUT OF THE GUILD CHESTS, AND WHAT TO KEEP FREE FOR IT COMING BACK.
 * Read-only: the roles and the packs live, the chests from their last reading (a chest is never
 * pushed; `open-the-chests` refreshes it). Prints need / fleet / short per item, which chest and
 * stack each shortfall comes from, the surplus a whole-stack draw brings home, the bulk to
 * RESERVE in each chest for putting that back, and anything the chests cannot cover at all.
 */
async function chestReport(cfg) {
  const roles = await plan(cfg);
  const { outfitNeeds, OUTFIT } = await import('./fleetscripts/ghost-outfit.mjs');
  const { weighItem } = await import('./m59-items.mjs');
  const fleet = {}, outfit = { chain: 0, shield: 0, hammer: 0 };
  let purses = 0;
  const count = (items, item) => items.filter(i => String(i.name ?? '').toLowerCase().replace(/s$/, '') === item.replace(/s$/, ''))
    .reduce((n, i) => n + (Number(i.amount) || 1), 0);
  const items = ['orc tooth', 'elderberry', 'herb', 'emerald', 'sapphire', 'mushroom'];
  for (const a of cfg.agents) {
    const inv = (await rpc('inventory', { agent: a }).catch(() => null))?.items ?? [];
    for (const it of items) fleet[it] = (fleet[it] ?? 0) + count(inv, it);
    purses += Math.max(0, count(inv, 'shilling') - 20);
    if (a !== roles.lightbearer) { const n = outfitNeeds(inv); for (const k in n) if (n[k]) outfit[k]++; }
  }
  const needs = raidNeeds(cfg.agents, roles, { lightCasts: Number(opt('--light-casts', 16)),
    blessRounds: Number(opt('--bless-rounds', 4)), herbsEach: Number(opt('--herbs-each', 30)) });
  const dir = path.join(path.dirname(path.dirname(cfg.roster ?? process.env.M59_STATE_FILE ?? '.')), 'storage', 'chests');
  const chests = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { slot: j.slot ?? f.replace(/\.json$/, ''), items: j.items ?? [], observed_at: j.observed_at ?? null };
  }) : [];
  // Armour the chests already hold goes first; what is left is bought, and paid for in shillings.
  const onHand = (re) => chests.flatMap(c => c.items).filter(i => re.test(String(i.name ?? ''))).reduce((n, i) => n + (Number(i.amount) || 1), 0);
  const chainIn = onHand(/^chain armor$/i), shieldIn = onHand(/shield/i);
  const buyChain = Math.max(0, outfit.chain - chainIn), buyShield = Math.max(0, outfit.shield - shieldIn);
  needs.shilling = buyChain * OUTFIT.chain.price + buyShield * OUTFIT.shield.price + outfit.hammer * OUTFIT.hammer.price;
  fleet.shilling = purses;
  const out = chestPlan({ needs, fleet, chests, weigh: weighItem });
  console.log(`
THE GUILD CHESTS  (last read: ${chests.map(c => `${c.slot} ${c.observed_at ? new Date(c.observed_at).toISOString().slice(0, 16) : '?'}`).join(', ') || 'NEVER — run open-the-chests'})`);
  console.log(`  outfit: ${outfit.shield} want a shield (${Math.min(shieldIn, outfit.shield)} from the chests), ` +
              `${outfit.chain} want chain (${Math.min(chainIn, outfit.chain)} from the chests), ${outfit.hammer} want a hammer`);
  console.log('  item          need  fleet  short   from the chests (whole stacks)             surplus home');
  for (const r of out.rows) {
    console.log(`  ${r.item.padEnd(12)} ${String(r.need).padStart(6)} ${String(r.fleet).padStart(6)} ${String(r.short).padStart(6)}   ` +
      `${(r.draws.map(d => `${d.slot}:${d.take}`).join(' ') || (r.short ? '-' : 'not needed')).padEnd(42)} ${r.surplus || ''}` +
      (r.unmet ? `  UNMET ${r.unmet}` : ''));
  }
  console.log('  chest    bulk now   free   reserve for the return');
  for (const c of out.chests) console.log(`  ${c.slot.padEnd(7)} ${String(Math.round(c.bulk)).padStart(9)} ${String(Math.round(c.free)).padStart(6)}   ${c.reserve ? `keep ${Math.round(c.reserve)} bulk free` : '-'}`);
  for (const w of out.warnings) console.log(`  WARNING ${w}`);
  return out;
}

// ---------------------------------------------------------------------------------- muster preview

/**
 * JOB 0 ON PROD, PREVIEWED. Read-only: where everyone is, how far from room 2, who crosses
 * Ukgoth in the convoy, who is too hurt to set out, who is small, and who a person is playing.
 * The muster itself is step 0 of `all` — inside the same hold as the raid, so nobody is let go
 * between arriving and fighting.
 */
async function musterPreview(cfg) {
  const rows = new Map(((await rpc('fleet', {}, 40_000))?.fleet ?? []).map(r => [r.agent, r]));
  const rally = Number(opt('--rally', 598));
  const est = (from, to) => rpc('travel_estimate', { from, to }).catch(() => null);
  const lines = [];
  let worst = 0, convoy = 0, blocked = 0;
  for (const a of cfg.agents) {
    const r = rows.get(a);
    const room = Number(r?.room_num);
    const [h, m] = String(r?.health ?? '').split('/').map(Number);
    const [toStage, toRally] = await Promise.all([est(room, cfg.stage), est(room, rally)]);
    const inConvoy = room === rally || (toStage?.hops != null && toRally?.hops != null && toStage.hops === toRally.hops + 2);
    const notes = [];
    if (room === cfg.stage) notes.push('already here');
    if (inConvoy) { notes.push(`convoy via ${rally}`); convoy++; }
    if (m && h / m < 1 && room !== cfg.stage) notes.push(`rests first (${h}/${m})`);
    if (m && m < 25) notes.push('FRAGILE body');
    if (r?.connected === false) { notes.push('HUMAN-PILOTED — skipped'); blocked++; }
    if (r?.committed && r.committed.kind !== 'fleetscript') notes.push(`busy: ${r.committed.label ?? r.committed.kind}`);
    if (toStage?.hops == null && room !== cfg.stage) { notes.push(`NO ROUTE: ${String(toStage?.reason ?? '').slice(0, 60)}`); blocked++; }
    worst = Math.max(worst, toStage?.ms ?? 0);
    lines.push(`  ${a.padEnd(9)} ${String(r?.character ?? '?').padEnd(18)} room ${String(room).padEnd(4)} ` +
               `${String(r?.health ?? '?').padEnd(7)} ${toStage?.hops != null ? `${toStage.hops} hops ~${Math.round((toStage.ms ?? 0) / 60000)}m` : '-'}`.padEnd(70) +
               notes.join('; '));
  }
  console.log(`muster to room ${cfg.stage} — fleet ${cfg.fleet} (read-only)`);
  console.log(lines.join('\n'));
  console.log(`\n  convoy through Ukgoth: ${convoy}; blocked: ${blocked}; slowest walk p90 ~${Math.round(worst / 60000)} min`);
  console.log(`  run it: node tools/m59-ghostraid.mjs all --fleet ${cfg.fleet} --commit   (the muster is step 0, under the raid's hold)`);
}

// ---------------------------------------------------------------------------------- lab setup

async function setup(cfg) {
  const { assertLabFleet } = await import('./m59-fleetscript.mjs');
  assertLabFleet('m59-ghostraid setup');
  const dm = await import('./m59-dm.mjs');
  const rows = ((await rpc('fleet', {}, 40_000))?.fleet ?? []).filter(r => cfg.agents.includes(r.agent));
  const names = rows.map(r => r.character).filter(Boolean);
  if (!cfg.commit) { console.log(`would heal ${names.length} and${flag('--place') ? '' : ' NOT'} place them in room ${cfg.stage}`); return; }
  // FIDELITY, NOT HELP: make the light-bearer the caster prod actually has.
  //
  // MANA COMES FROM MANA NODES, NOT FROM A NUMBER. Max mana is recomputed from the melded-node
  // bitmask (player.kod ComputeMaxMana: base + each node's GetManaAdjust), so writing
  // piMax_Mana directly reverted to 25 within minutes on the second rehearsal. Prod's Loial
  // reads 65 against the clone's base 25: +40, which at mysticism 50 is five standard nodes of
  // (5+50)/10+3 = 8 each (mananode.kod). Which five does not matter to a fight; 0x1F is
  // H9, G9, Victoria, Badlands and the Orc Caves (blakston.khd NODE_*). `--light-nodes`
  // overrides.
  //
  // AND KARMA: forces of light refuses a caster under +40 ("your karma is 0; forces of light
  // needs >= +40"); the shadow was built at 0 while prod's Loial reads 64 (2026-09-24).
  const light = rows.find(r => r.agent === cfg.lightbearer)?.character;
  const lightNodes = Number(opt('--light-nodes', cfg.fleet === 'shadow' ? 0x1F : 0));
  const lightKarma = Number(opt('--light-karma', cfg.fleet === 'shadow' ? 64 : 0));
  if (light && (lightNodes || lightKarma)) {
    const obj = (await dm.resolve([light]))[light];
    if (obj != null) {
      if (lightKarma) await dm.kit(light, { karma: lightKarma });
      if (lightNodes) await dm.dm([`set object ${obj} piNodelist INT ${lightNodes}`,
                                   `send object ${obj} ComputeMaxMana`, `send object ${obj} NewMana`]);
      const show = String(await dm.dm([`show object ${obj}`]));
      const maxMana = /piMax_Mana\s+= INT (-?\d+)/.exec(show)?.[1];
      console.log(`${light}: nodes 0x${lightNodes.toString(16)}, karma ${lightKarma} -> max mana ${maxMana} (prod: 65)`);
    }
  }
  const h = await dm.heal(names);
  console.log(`healed ${h.healed.length}${h.missing.length ? `, missing ${h.missing.join(', ')}` : ''}`);
  // --place is NOT done here. Placed before the hold, a keeper walks its character straight
  // back to its station — through Ukgoth, on the first run. ghost-arm places after the hold.
}

// ---------------------------------------------------------------------------------- phases

const runPhase = (cfg, file, params, extra = {}) => runPhases(cfg, [{ file, params }], extra);

/**
 * ONE RUN, ONE HOLD, ANY NUMBER OF PHASES.
 *
 * Every FleetScript run releases its hold when it ends, and a released keeper walks its
 * character back to its station at once. Run as three separate commands, arm -> prep -> fight
 * left the fleet unheld between each pair — and the first shadow attempt showed what that
 * costs: fifteen of twenty-two characters were in Ukgoth within forty seconds of being let go.
 * So `all` concatenates the phases' step lists into ONE run: one lock, one hold, from the
 * muster to the last minute of the farm.
 */
async function runPhases(cfg, phases, extra = {}) {
  const { fleetScript } = await import('./m59-fleetscript.mjs');
  const loaded = [];
  for (const ph of phases) {
    const s = (await import(pathToFileURL(path.join(HERE, 'fleetscripts', ph.file)).href)).script;
    const all = { ...Object.fromEntries(Object.entries(s.params ?? {}).map(([k, v]) => [k, v?.default])), ...ph.params };
    loaded.push({ s, all });
  }
  const compile = async (agent, state) => {
    const out = [];
    for (const { s, all } of loaded) out.push(...await s.steps({ ...all, agent, agents: cfg.agents }, agent, state));
    return out;
  };
  const name = loaded.map(l => l.s.name).join('+');
  if (!cfg.commit) {
    const sample = await compile(cfg.agents[0], {});
    console.log(`${name}: ${cfg.agents.length} agent(s); ${cfg.agents[0]}'s steps:`);
    for (const [i, st] of sample.entries()) console.log(`  ${i}. ${st.do}${st.to != null ? ` -> room ${st.to}` : ''}${st.why ? `  (${st.why})` : ''}`);
    console.log('  (nothing was sent — pass --commit)');
    return null;
  }
  return fleetScript({
    name, agents: cfg.agents, provenance: loaded[0].s.provenance ?? null, unsafe: loaded[0].s.unsafe ?? null,
    // The raid's own floors. Full health to set out is the harness default and it is right for a
    // road; this errand's walks are 2 -> 38 -> 40 inside Castle Victoria, and it rests people itself.
    minHealth: extra.minHealth ?? 0.6,
    // Loial has 20 maximum health. fragileBody refuses a journey for a body that small, which is
    // right on a road and wrong for two rooms of a castle — see fleetlib's note on fragileBelow.
    fragileBelow: extra.fragileBelow ?? 15,
    // A WALK'S PATIENCE, FLOORED AT TEN MINUTES. The harness sizes a walk's budget from its p90 with
    // a three-minute floor, and a convoy crossing Ukgoth under troll fire takes longer: the first
    // no-DM rehearsal re-issued walks that were still in progress, got 'busy', and dropped live
    // raiders from the run. Ten minutes is the rally's own patience.
    budgetFloorMs: extra.budgetFloorMs ?? 600_000,
    steps: compile,
  });
}

function summarise(label, res) {
  if (!res) return;
  const rs = Object.entries(res.results ?? {});
  const bad = rs.filter(([, r]) => !r?.ok);
  console.log(`${label}: ${rs.length - bad.length}/${rs.length} completed` +
              (bad.length ? ` — ${bad.map(([a, r]) => `${a}: ${String(r?.why ?? '?').slice(0, 80)}`).join('; ')}` : ''));
}

const armParams = cfg => ({
    stage: cfg.stage, lightbearer: cfg.lightbearer, healers: cfg.healers, lab: cfg.lab, channel: cfg.channel,
    place: cfg.lab && flag('--place'),
    start_positions: cfg.startPositions ? JSON.stringify(cfg.startPositions) : '',
    start_cup: cfg.startCup ?? '',
    muster_wait_s: cfg.lab && flag('--place') ? 240 : 1500,
    light_casts: Math.ceil((cfg.minutes + 10) * 60 / 150) + 2,
});
const prepParams = cfg => ({ target: 'Ghost', buffs: cfg.buffs, channel: cfg.channel });
const fightParams = (cfg, dir, mustered) => ({
  stage: cfg.stage, lightbearer: cfg.lightbearer, healers: cfg.healers, channel: cfg.channel,
  minutes: cfg.minutes, run_dir: cfg.commit ? dir : '', lab: cfg.lab, mustered,
  ...(opt('--room') ? { room: Number(opt('--room')) } : {}), ...(opt('--door') ? { door: Number(opt('--door')) } : {}),
  ...(opt('--target') ? { target: opt('--target') } : {}),
  dum_profile: !!cfg.dumUrl,
});

async function arm(cfg) {
  const res = await runPhase(cfg, 'ghost-arm.mjs', armParams(cfg));
  summarise('arm', res);
  return res;
}

async function prep(cfg) {
  // raid-prep casts on the caster itself; the characters who know neither spell report a
  // `failed` line for it and nothing else happens. Forces of light is NOT in this list on
  // purpose: raid-action casts every deferred buff in the staging room, and a room enchantment
  // cast in room 2 lights room 2. The light-bearer handles it at the door instead.
  const res = await runPhase(cfg, 'raid-prep.mjs', prepParams(cfg));
  summarise('prep', res);
  return res;
}

async function fight(cfg, { composed = false } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(REPO, 'substrate', 'raids', `ghost-${cfg.fleet}-${stamp}`);
  if (cfg.commit) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'raid.json'), JSON.stringify({
      fleet: cfg.fleet, agents: cfg.agents, lightbearer: cfg.lightbearer, healers: cfg.healers,
      minutes: cfg.minutes, lab: cfg.lab, started: new Date().toISOString(),
      control_url: process.env.M59_CONTROL_URL, roster: process.env.M59_STATE_FILE ?? null,
      ledger: ledgerDir(cfg),
    }, null, 1));
    console.log(`raid directory: ${dir}`);
  }
  // The DUM raid profile, ON before the script touches anyone (see dumOn) and OFF however this ends.
  const roles = cfg.dumUrl && cfg.commit ? await plan(cfg) : null;
  if (roles) await dumOn(cfg, roles, dir);
  let res;
  try {
    res = composed
      ? await runPhases(cfg, [{ file: 'ghost-arm.mjs', params: armParams(cfg) },
                              { file: 'raid-prep.mjs', params: prepParams(cfg) },
                              { file: 'ghost-raid.mjs', params: fightParams(cfg, dir, true) }])
      : await runPhase(cfg, 'ghost-raid.mjs', fightParams(cfg, dir, false));
  } finally {
    if (roles) await dumOff(cfg);
  }
  summarise(composed ? 'muster+arm+prep+fight' : 'fight', res);
  if (res) {
    fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(res, null, 1));
    await report({ ...cfg, run: dir });
  }
  return res;
}

function ledgerDir(cfg) {
  if (cfg.ledger) return cfg.ledger;
  // The ledger is written by the KEEPERS, beside the code that spawned them — for the shadow
  // fleet that is the lab worktree, not this checkout (m59-fleetpath.mjs, "where the evidence is
  // written"). Ask the broker where it lives rather than guessing from this checkout.
  return null;
}

// ---------------------------------------------------------------------------------- report

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

async function brokerLedgerDir() {
  try {
    const h = await (await fetch(new URL('health', process.env.M59_CONTROL_URL), { signal: AbortSignal.timeout(8000) })).json();
    if (h?.root && h?.fleet) return path.join(h.root, 'substrate', 'history', h.fleet);
  } catch { /* fall through */ }
  return null;
}

export async function report(cfg) {
  const dir = cfg.run ?? opt('--run');
  if (!dir || !fs.existsSync(dir)) throw new Error(`no raid directory: ${dir}`);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'raid.json'), 'utf8'));
  const events = readJsonl(path.join(dir, 'events.jsonl'));
  const samples = readJsonl(path.join(dir, 'samples.jsonl'));
  const entered = events.find(e => e.kind === 'entered')?.t ?? null;
  const killAt = events.find(e => e.kind === 'ghost_gone')?.t ?? null;
  const ledger = cfg.ledger ?? meta.ledger ?? await brokerLedgerDir();
  let died = [], killed = [];
  if (ledger && fs.existsSync(ledger)) {
    const { readLedger } = await import('./m59-savelog.mjs');
    const rows = readLedger(ledger, (entered ?? Date.now()) - 60_000);
    died = rows.filter(r => r.kind === 'died');
    // THE THRONE ROOM'S KILLS, NOT THE FLEET'S. The keeper ledger records kills wherever they
    // happen, and after a death a keeper walks its character home and goes on hunting: the
    // third rehearsal's "30 kills in the window" were 12 ants and 17 spiders from other maps.
    killed = rows.filter(r => r.kind === 'killed' && Number(r.room_num) === GHOST_ROOM);
  }
  // A death the ledger did not catch but the raid saw is still a death. The reverse is the
  // common case (a keeper records every death; the raid only sees the ones it was looking at).
  const charOf = new Map(samples.map(s => [s.agent, s.character]));
  // ONE DEATH IS ONE DEATH, however many places recorded it. The first rehearsal reported "24
  // deaths" for 16 characters: the raid's own `died` event and the keeper's ledger row for the
  // same death landed minutes apart (the ledger row is written when the keeper gets round to
  // it), so a 2-minute match window counted most deaths twice. A character cannot die twice
  // inside five minutes here — the walk back from the temple alone takes longer — so rows for
  // one character within that span are one death, keeping the earliest.
  const DEDUP_MS = 5 * 60_000;
  const ofChar = r => r.agent ?? [...charOf].find(([, c]) => c === r.character)?.[0] ?? r.character;
  const all = [...died.map(d => ({ ...d, who: ofChar(d) })),
               ...events.filter(e => e.kind === 'died').map(e => ({ t: e.t, agent: e.agent, who: e.agent, killed_by: null, source: 'raid' }))]
    .sort((a, b) => a.t - b.t);
  died = [];
  for (const d of all) {
    const prev = died.find(x => x.who === d.who && d.t - x.t < DEDUP_MS);
    if (prev) { prev.killed_by ??= d.killed_by; continue; }
    died.push(d);
  }
  const lightEvents = events.filter(e => e.kind === 'light');
  const participants = meta.agents.map(a => ({
    agent: a, character: charOf.get(a) ?? a,
    role: a === meta.lightbearer ? 'light' : (String(meta.healers ?? '').split(',').includes(a) ? 'healer' : 'raider'),
  }));
  // AND THE RAID'S OWN KILLS. Script-driven swings are not the keeper's fight, so the ledger
  // does not see them; the farm loop records each "You killed ..." sentence as an event.
  for (const e of events.filter(e => e.kind === 'kill'))
    if (!killed.some(k => (k.agent === e.agent) && Math.abs(k.t - e.t) < 5000))
      killed.push({ t: e.t, agent: e.agent, creature: e.creature, room_num: GHOST_ROOM, source: 'raid' });
  const endAt = samples.length ? Math.max(...samples.map(s => s.t)) : null;
  const rep = survivalReport({ participants, killAt, startAt: entered, windowMin: meta.minutes,
                               died, killed, samples, endAt });
  const notes = [
    `forces of light: ${lightEvents.filter(e => e.outcome === 'cast').length} cast(s), ` +
      `${lightEvents.filter(e => /failed/.test(e.outcome ?? '')).length} failed, ` +
      `${lightEvents.filter(e => e.outcome === 'still up').length} arrived while still lit`,
    `retreats to room 38: ${events.filter(e => e.kind === 'retreat').length}; walked back in: ${events.filter(e => e.kind === 'return').length}`,
    healNote(events),
    roomNote(events, killAt),
    buffNote(events),
    `ledger read: ${ledger && fs.existsSync(ledger) ? ledger : 'NONE — deaths are only the ones the raid itself saw'}`,
    meta.lab ? 'LAB RUN: DM conveniences were on (healed/placed/granted/refilled); the fight itself was not assisted' : 'no DM powers were used',
  ];
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(rep, null, 1));
  const md = reportMarkdown(rep, { fleet: meta.fleet, startedIso: entered ? new Date(entered).toISOString() : '', notes });
  fs.writeFileSync(path.join(dir, 'report.md'), md);
  console.log(md);
  console.log(`written: ${path.join(dir, 'report.md')}`);
  return rep;
}

function healNote(events) {
  const h = events.filter(e => e.kind === 'heal_summary'), f = events.filter(e => e.kind === 'farm_summary'),
        l = events.filter(e => e.kind === 'light_summary');
  const landed = h.reduce((n, e) => n + (e.landed ?? 0), 0) + f.reduce((n, e) => n + (e.heals_landed ?? 0), 0) +
                 l.reduce((n, e) => n + (e.heals_landed ?? 0), 0);
  const tried = h.reduce((n, e) => n + (e.casts ?? 0), 0) + f.reduce((n, e) => n + (e.heals ?? 0), 0) +
                l.reduce((n, e) => n + (e.heals ?? 0), 0);
  return `minor heal in the window: ${landed}/${tried} landed (healers ${h.reduce((n, e) => n + (e.landed ?? 0), 0)}, ` +
         `medics between swings ${f.reduce((n, e) => n + (e.heals_landed ?? 0), 0)}, light-bearer ${l.reduce((n, e) => n + (e.heals_landed ?? 0), 0)})`;
}

// DID SPARING ZOMBIES MOVE THE ROOM? Average escort by kind over the first and last five minutes
// of the window, from the raid's own look samples.
function roomNote(events, killAt) {
  const rooms = events.filter(e => e.kind === 'room' && killAt && e.t >= killAt);
  if (!rooms.length) return 'room composition: not sampled';
  const kinds = [...new Set(rooms.flatMap(r => Object.keys(r.count ?? {})))];
  const avg = rs => Object.fromEntries(kinds.map(k => [k, rs.length ? Number((rs.reduce((n, r) => n + (r.count?.[k] ?? 0), 0) / rs.length).toFixed(1)) : 0]));
  const t0 = rooms[0].t, t1 = rooms[rooms.length - 1].t;
  const fmt = o => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') || 'empty';
  return `room composition (avg): first 5 min ${fmt(avg(rooms.filter(r => r.t - t0 < 300_000)))}; ` +
         `last 5 min ${fmt(avg(rooms.filter(r => t1 - r.t < 300_000)))}`;
}

function buffNote(events) {
  const b = events.filter(e => e.kind === 'buffs');
  const sum = (where, k) => b.filter(e => e.where === where).reduce((n, e) => n + (e[k] ?? 0), 0);
  return `buffs at the door: bless ${sum(38, 'bless')}, super strength ${sum(38, 'strength')}, already up ${sum(38, 'already')}, ` +
         `failed ${sum(38, 'failed')}, skipped ${sum(38, 'skipped')}; refreshed in the throne room: bless ${sum(40, 'bless')}, ` +
         `super strength ${sum(40, 'strength')}`;
}

// ---------------------------------------------------------------------------------- rehearse

/**
 * THE WHOLE REHEARSAL, ONE COMMAND: rebuild a faithful shadow clone of prod, then run the raid on
 * it with NO DM power at all, then write the report.
 *
 *   node tools/m59-ghostraid.mjs rehearse --fleet shadow --commit
 *
 * The rebuild (m59-shadow-run.mjs --until play) is where DM powers belong: creating characters is
 * a DM act, and the clone copies prod's purses, reagents, packs, the chalice, worn gear and the
 * guild with its hall and chests. The run that follows is `all` WITHOUT --lab: every weapon,
 * armour, shield and reagent is walked, pooled, bought and handed over exactly as on prod. That
 * split is the point — a rehearsal that borrows a DM power in the run rehearses something prod
 * cannot do.
 *
 * --skip-rebuild runs the raid against the shadow fleet as it stands.
 */
async function rehearse(cfg) {
  const { assertLabFleet } = await import('./m59-fleetscript.mjs');
  assertLabFleet('m59-ghostraid rehearse');
  if (cfg.lab) throw new Error('rehearse runs the raid WITHOUT DM powers; drop --lab (the rebuild uses them on its own)');
  const roster = process.env.M59_STATE_FILE;
  if (!roster) throw new Error('set M59_STATE_FILE to the shadow roster (e.g. .../prod-deploy/substrate/fleets/shadow.json)');
  if (!flag('--skip-rebuild')) {
    const shim = opt('--shadow-run', path.join(HERE, 'm59-shadow-run.mjs'));
    const host = process.env.M59_HOST ?? '127.0.0.1', port = process.env.M59_PORT ?? '15959';
    const args = [shim, '--until', 'play', '--roster', roster, '--server', `${host}:${port}`,
                  '--admin', `${process.env.M59_ADMIN_HOST ?? host}:${process.env.M59_ADMIN_PORT ?? '19998'}`,
                  '--http', String(cfg.port), '--dashboard', String(Number(opt('--dashboard', cfg.port + 1))),
                  // --no-settle: take the fleet the moment it is logged in. Waiting for keepers to go quiet
                  // is waiting for them to wander: the first no-DM rehearsal's light-bearer walked from
                  // room 2 to Tos in that gap, and died crossing Ukgoth on the way back.
                  // --trim-items: a clone carries what its prod character carries and NOTHING ELSE.
                  // Top-up alone let a previous run's leftovers accumulate: on 2026-09-25 Gonzo's
                  // clone held a second Chalice of the Rain that prod does not have, the raid took
                  // HIM for the cup holder, and the ride failed. A rehearsal must be prod-shaped.
                  '--no-settle', '--trim-items', ...(cfg.commit ? [] : ['--dry'])];
    console.log(`rebuilding the shadow fleet: node ${args.join(' ')}`);
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
    if (r.status !== 0) throw new Error(`the shadow rebuild stopped (exit ${r.status}); the raid was not run`);
  }
  // THE CLONE'S OWN ROSTER. Shadow names follow prod characters, not slot numbers, so the raiders and
  // the light-bearer are read off the snapshot: the clones of prod's raiders, and the clone of hk1.
  // Hardcoding shadow01..22 and shadow20 made a 75-health fighter the light-bearer on 2026-09-25.
  const snapFile = path.join(path.dirname(path.dirname(roster)), 'shadow-snapshot.json');
  const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  const prodRaid = new Set(FLEETS.prod.agents);
  const clones = (snap.characters ?? []).filter(c => prodRaid.has(c.prod_agent) && c.shadow_account);
  const light = clones.find(c => c.prod_agent === FLEETS.prod.lightbearer);
  const startPositions = Object.fromEntries(clones.filter(c => c.room != null)
    .map(c => [c.shadow_account, { room: c.room, row: c.row ?? null, col: c.col ?? null }]));
  console.log(`clone roster: ${clones.length} raiders from ${snapFile}; light-bearer ${light?.shadow_account ?? 'NONE'} (${light?.prod_character ?? '-'})`);
  return fight({ ...cfg, lab: false, agents: clones.map(c => c.shadow_account),
                 lightbearer: light?.shadow_account ?? '', startPositions,
                 startCup: clones.find(c => JSON.stringify(c.inventory ?? []).match(/chalice/i))?.shadow_account ?? '' },
               { composed: true });
}

// ---------------------------------------------------------------------------------- the DUM raid profile

/**
 * SWITCH THE RAID PROFILE ON FOR THE RAID, AND OFF WHEN IT ENDS.
 *
 * A running DUM holds every character's normal role — its station, its hunt, its shifts. For the
 * raid it takes an OPERATION PROFILE instead (`POST /overlay` on its loopback control port): it
 * snapshots each raider's settings to disk, holds them to the raid role, and on `off` puts back
 * exactly what was there. DUM steps over any character the raid script holds, so switching it on
 * at the start is harmless and switching it on FIRST is the point: the snapshot must be of the
 * normal settings, before the script applies its own raid posture at the door.
 *
 * It is the SAFETY FLOOR, not the fighter: the script still drives the hold (focus fire and
 * two-second heals are not keeper abilities). If the script dies mid-raid its lease lapses and
 * the raiders fall to the raid profile INSIDE the throne room, instead of back to their shifts
 * and out through the castle. Loial is left out by default: on prod DUM does not drive him.
 *
 * Optional throughout: no --dum-url, or a DUM that does not answer, is a warning and the raid
 * goes on exactly as before.
 */
const stripJsonc = t => String(t).replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? '');

async function dumOverlay(cfg, body) {
  const r = await fetch(new URL('/overlay', cfg.dumUrl), body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) }
    : { signal: AbortSignal.timeout(60_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

export async function dumOn(cfg, roles, dir) {
  if (!cfg.dumUrl) return null;
  try {
    if (!cfg.dumProfile) throw new Error('--dum-url needs --dum-profile <path to raid-hold.jsonc>');
    const h = await (await fetch(new URL('/health', cfg.dumUrl), { signal: AbortSignal.timeout(10_000) })).json();
    if (h?.fleet && h.fleet !== cfg.fleet) throw new Error(`the DUM on ${cfg.dumUrl} drives fleet ${h.fleet}, not ${cfg.fleet}`);
    const profile = JSON.parse(stripJsonc(fs.readFileSync(cfg.dumProfile, 'utf8')));
    const members = {};
    for (const a of roles.raiders ?? []) members[a] = 'raider';
    for (const a of roles.healers ?? []) members[a] = 'healer';
    const out = await dumOverlay(cfg, { action: 'on', profile, members, expected_fleet: cfg.fleet,
                                        by: 'm59-ghostraid', why: 'ghost of Far\'Nohl raid' });
    if (dir) fs.writeFileSync(path.join(dir, 'overlay-on.json'), JSON.stringify(out, null, 1));
    console.log(`DUM raid profile ON for ${Object.keys(members).length} raider(s) via ${cfg.dumUrl}`);
    return out;
  } catch (e) {
    console.log(`WARNING: the DUM raid profile was NOT switched on (${e.message}); the raid runs without it`);
    return null;
  }
}

export async function dumOff(cfg) {
  if (!cfg.dumUrl) return null;
  try {
    await dumOverlay(cfg, { action: 'off', expected_fleet: cfg.fleet, by: 'm59-ghostraid', why: 'the raid has ended' });
    const until = Date.now() + 3 * 60_000;
    let st = null;
    while (Date.now() < until) {
      st = await dumOverlay(cfg, null);
      if (!st?.active || st.clearable) break;
      await new Promise(r => setTimeout(r, 5000));
    }
    if (st?.clearable) await dumOverlay(cfg, { action: 'clear' });
    console.log(`DUM raid profile OFF${st?.clearable ? ' and cleared: everyone is back on their own role'
      : ` — ${st?.unrestored?.length ?? '?'} not yet restored; check \`dum.mjs overlay status\``}`);
    return st;
  } catch (e) {
    console.log(`WARNING: could not switch the DUM raid profile off (${e.message}). Do it by hand: ` +
                'node bin/dum.mjs overlay off --commit (from the DUM checkout)');
    return null;
  }
}

// ---------------------------------------------------------------------------------- restore

/**
 * PUT EVERY RAIDER'S OWN SETTINGS BACK from the snapshot the raid wrote before changing them.
 * The fight script restores each character as its part ends; this is for a run that did not get
 * that far (killed, crashed, memory-reaped). Idempotent: writing a saved value twice is harmless.
 */
async function restoreSettings(cfg) {
  const dir = opt('--run');
  const file = dir && path.join(dir, 'policy-snapshot.json');
  if (!file || !fs.existsSync(file)) throw new Error(`no policy snapshot in ${dir}`);
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [agent, saved] of Object.entries(snap)) {
    if (!cfg.commit) { console.log(`would restore ${agent}: ${JSON.stringify(saved)}`); continue; }
    const r = await rpc('autopilot', { agent, action: 'start', ...saved }).catch(e => ({ error: e.message }));
    console.log(`${agent}: ${r?.error ? `NOT restored — ${r.error}` : 'restored'}`);
  }
}

// ---------------------------------------------------------------------------------- main

async function main() {
  const verb = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'plan';
  if (verb === 'report') return report({ ledger: opt('--ledger') });
  if (verb === 'restore') { const c = configure(); await dumOff(c); return restoreSettings(c); }
  if (verb === 'rehearse') return rehearse(configure());
  const cfg = configure();
  if (cfg.lab) { const { assertLabFleet } = await import('./m59-fleetscript.mjs'); assertLabFleet('m59-ghostraid --lab'); }
  if (verb === 'plan') return plan(cfg);
  if (verb === 'muster') return musterPreview(cfg);
  if (verb === 'chests') return chestReport(cfg);
  if (verb === 'setup') return setup(cfg);
  if (verb === 'arm') return arm(cfg);
  if (verb === 'prep') return prep(cfg);
  if (verb === 'fight') return fight(cfg);
  if (verb === 'all') {
    await plan(cfg);
    if (cfg.lab) await setup(cfg);
    return fight(cfg, { composed: true });
  }
  throw new Error(`unknown verb ${verb}: plan | setup | arm | prep | fight | all | report`);
}

const isEntryPoint = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) main().then(() => { process.exitCode = 0; }, e => { console.error(`m59-ghostraid: ${e.message}`); process.exitCode = 1; })
  // Exit on our own once the work is done, but let libuv close its handles first: process.exit
  // inside a promise continuation trips "handle->flags & UV_HANDLE_CLOSING" on Windows.
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 10_000).unref());
