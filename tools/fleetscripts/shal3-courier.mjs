// SHAL'ILLE LEVEL-3 TRAINEE COURIER — one lap: stock up, farm orc teeth, serve a hunting room, Rescue home.
//
//   shal3-courier agents=<trainee>[,<trainee>] [farmers=a,b,c] [serve=599] [teeth=40] [herbs=80]
//
// A Shal'ille trainee holding level 3 (identify, hospice, rescue) is a travelling service for a farming
// party, and every service it gives is practice:
//
//   HALL      deposit what the last lap brought back (diamonds, rings, amulets -- never an Amulet of Shadows) into the guild chests,
//             draw shillings for the shopping. Rescue lands a guild member in the hall when the hall is in
//             the region it was cast from (rescue.kod DoRescue), which is why the lap ENDS with a Rescue
//             and BEGINS here. Not in the hall at the start: walk to the chalice station and ride in.
//   SHOPS     herbs (hospice: 3 a cast) and emeralds (rescue and remove curse: 1 each), topped up to the
//             targets. Bought by name with `buyByName`, which re-reads the pack rather than trusting a
//             shop reply.
//   ICKY      orc teeth (identify: 1 a cast) from "A Deep, Dark, Spooky, Icky Cave" (27): half its
//             spawns are orcs, nothing above level 50. Fight steps whose TARGET is a function of the run
//             state: once the pack holds `teeth` (or the budget runs out) it answers null and the
//             remaining legs are skipped, rather than swinging at whatever is nearest.
//   SERVE     in the farmers' room, until the reagents or the budget run out: hospice on a hurt
//             fleet-mate (never anyone else -- a stranger is not an ally), identify on every ring and
//             unidentified item on the floor and in the trainee's own pack, pick the rings up, take
//             the farmers' diamonds and rings off them (`supply`, which verifies the hand-over), and
//             remove curse on itself when an identify reads a curse.
//   RESCUE    cast with an emerald kept back for it (`emeraldReserve`), judged by the ROOM 35s later,
//             because the teleport lands 15-25s after the cast and the cast reply cannot say
//             (rescue.kod, piRescueBaseDelaySec). If it does not take, walk.
//
// Run it in a loop (one lap per run) for a standing courier. Survival stays with each trainee's
// keeper throughout; the service loop also stops itself below `leaveBelow` health.
import { walk, verify, rideChalice, fight, knownCharacters, observe, call as brokerCall } from '../m59-fleetscript.mjs';
import { withdrawWithRecovery, depositWithRecovery } from '../m59-hall-access.mjs';
import { buyByName } from '../m59-inventory.mjs';

const HALL = 714, STATION = 2;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lc = x => String(x ?? '').toLowerCase();
const count = (inv, rx) => (inv?.items ?? []).filter(i => rx.test(String(i.name ?? '').trim())).reduce((n, i) => n + (Number(i.amount) || 1), 0);
const RX = {
  herb: /^herbs?$/i, emerald: /^emeralds?$/i, tooth: /^orc (tooth|teeth)$/i, shilling: /^shillings?$/i,
  // What the lap brings home. Rings first: a fire-resistance ring is what the next ghost strike wants.
  valuable: /\b(diamond|ring|amulet|necklace|circlet)s?\b/i,
  ring: /\bring\b/i,
  // THE HOSPICE ENGINE, NOT LOOT. Wearing it hurts the wearer on every attempt to take it off, which is the only
  // way a healer at full health has anything to heal (tools/m59-shalille-train.mjs). Picked up, taken off farmers,
  // and NEVER deposited: a trainee without one cannot drill hospice between laps.
  engine: /amulet of shadows/i,
};
export const goesToHall = name => RX.valuable.test(String(name ?? '')) && !RX.engine.test(String(name ?? ''));
/** What an identify sentence says that matters to this errand. */
export function readIdentify(lines = []) {
  const text = lines.join(' ');
  return { cursed: /\bcurse/i.test(text), fire: /fire/i.test(text), text: text.slice(0, 240) };
}
/** Who in a fleet row list is hurt enough for a hospice: fleet-mates in the room, worst first. */
export function hurtAllies(rows = [], { room, below = 0.7, exclude = [] } = {}) {
  const frac = r => { const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(r?.health ?? '')); return m ? Number(m[1]) / Number(m[2]) : 1; };
  return rows.filter(r => Number(r.room_num) === Number(room) && !exclude.includes(r.agent) && r.in_game !== false && frac(r) < below)
    .sort((a, b) => frac(a) - frac(b)).map(r => ({ agent: r.agent, name: r.character ?? r.name ?? r.agent, frac: frac(r) }));
}

export const script = {
  name: 'shal3-courier',
  describe: 'One lap of a Shal\'ille level-3 trainee courier: hall, herbs and emeralds, orc teeth at the Icky Cave, identify/hospice/collect in the farmers\' room, Rescue home.',
  unsafe: { reason: 'a trainee courier walks into the farmers\' hunting room (Ukgoth by default) on purpose to serve them', waives: ['trapCheck', 'fragileBody'] },
  allowTraps: true,
  params: {
    agents: { type: 'agents', required: true, describe: 'the trainees (Shal\'ille level 3: identify, hospice, rescue)' },
    farmers: { type: 'string', default: '', describe: 'fleet agents to serve; empty = every fleet-mate standing in `serve`' },
    serve: { type: 'number', default: 599, describe: 'the farmers\' room' },
    toothRoom: { type: 'number', default: 27, describe: 'where the orc teeth come from' },
    teeth: { type: 'number', default: 40 }, toothRounds: { type: 'number', default: 12 },
    herbs: { type: 'number', default: 80 }, emeralds: { type: 'number', default: 15 },
    emeraldReserve: { type: 'number', default: 3, describe: 'never spent on anything but Rescue' },
    herbShop: { type: 'number', default: 53 }, herbSeller: { type: 'string', default: 'Frisconar' },
    emeraldShop: { type: 'number', default: 54 }, emeraldSeller: { type: 'string', default: 'Skivlat' },
    purse: { type: 'number', default: 3000, describe: 'shillings drawn from the hall for the shopping' },
    serveMin: { type: 'number', default: 45 }, hurtBelow: { type: 'number', default: 0.7 },
    leaveBelow: { type: 'number', default: 0.5 },
    home: { type: 'number', default: 38, describe: 'where the lap ends: the keeper home' },
    assumeSpells: { type: 'string', default: '', describe: 'DRY RUNS ONLY: plan as though these spells were known' },
  },
  async steps(p) {
    const agent = p.agent, hall = HALL;
    const o = await observe(agent).catch(() => null);
    const inv = await brokerCall('inventory', { agent }, 60_000).catch(() => null);
    const ab = await brokerCall('abilities', { agent, kind: 'spells' }, 60_000).catch(() => null);
    const assumed = String(p.assumeSpells ?? '').split(',').map(x => lc(x.trim())).filter(Boolean);
    const knows = n => assumed.includes(n) || (ab?.spells ?? []).some(s => lc(s?.name) === n);
    const has = { identify: knows('identify'), hospice: knows('hospice'), rescue: knows('rescue'), uncurse: knows('remove curse') };
    console.log(`  ${agent}: knows ${Object.entries(has).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none of the level-3 spells'}; ` +
                `holds ${count(inv, RX.herb)} herbs, ${count(inv, RX.emerald)} emeralds, ${count(inv, RX.tooth)} teeth`);
    if (!has.identify && !has.hospice)
      return [verify(async () => ({ ok: false, why: `${agent} holds neither identify nor hospice -- not a level-3 trainee yet` }), 'a level-3 trainee')];
    const fleetNames = new Set([...knownCharacters().keys()]);
    const steps = [];

    // ---------------------------------------------------------------- HALL: deposit and draw
    // At the END of a lap (Rescue lands a guild member there) and at the start only when the purse is short or
    // the pack still holds last lap's haul. A no-op anywhere but the hall.
    const hallPhase = () => ({ ...verify(async ({ call }) => {
      if (Number((await call('status', { agent }, 30_000).catch(() => null))?.room?.num) !== hall) return true;
      const now = await call('inventory', { agent }, 60_000).catch(() => null);
      const goods = [...new Set((now?.items ?? []).filter(i => goesToHall(i.name)).map(i => lc(i.name)))];
      if (goods.length) {
        const d = await depositWithRecovery(call, agent, goods);
        console.log(`  ${agent}: deposited ${goods.join(', ')}: ${d.ok ? `${d.left} item(s) into the chests` : d.why}`);
      }
      const purse = count(now, RX.shilling);
      if (purse < Number(p.purse)) {
        const w = await withdrawWithRecovery(call, agent, [{ item: 'shilling', amount: Number(p.purse) - purse }]);
        console.log(`  ${agent}: drew ${w.arrived?.shilling ?? 0} shillings${w.ok ? '' : ` (${w.why})`}`);
      }
      return true;
    }, 'the hall: deposit the haul, draw the shopping money'), optional: true });
    const short = count(inv, RX.shilling) < Number(p.purse) / 2, haul = (inv?.items ?? []).some(i => goesToHall(i.name));
    if ((short || haul) && !(o?.ok && Number(o.room) === hall))
      steps.push(walk(STATION, { why: 'the chalice station' }), rideChalice({ why: 'into the guild hall', expect: hall }));
    steps.push(hallPhase());

    // ---------------------------------------------------------------- SHOPS: herbs, emeralds
    const topUp = (room, seller, item, rx, target) => [
      { ...walk(room, { why: `${item} from ${seller}` }), optional: true },
      { ...verify(async ({ call }) => {
        const have = count(await call('inventory', { agent }, 60_000).catch(() => null), rx);
        const want = Math.max(0, Number(target) - have);
        if (!want) return true;
        const r = await buyByName(agent, seller, [{ item, amount: want }]);
        console.log(`  ${agent}: bought ${r[item] ?? 0} of ${want} ${item}${r.why?.[item] ? ` (${r.why[item]})` : ''}`);
        return true;
      }, `top ${item} up to ${target}`), optional: true },
    ];
    if (has.hospice) steps.push(...topUp(Number(p.herbShop), p.herbSeller, 'herbs', RX.herb, p.herbs));
    steps.push(...topUp(Number(p.emeraldShop), p.emeraldSeller, 'emerald', RX.emerald, p.emeralds));

    // ---------------------------------------------------------------- ICKY: orc teeth
    if (has.identify) {
      const toothDeadline = { at: 0 };
      steps.push({ ...walk(Number(p.toothRoom), { why: 'orc teeth' }), optional: true });
      steps.push({ ...verify(async ({ state }) => { toothDeadline.at = Date.now() + 25 * 60_000; state.teethDone = false; return true; }, 'start the tooth clock'), optional: true });
      const enough = async (call, state) => {
        const l = await call('look', { agent }, 60_000).catch(() => null);
        for (const t of (l?.objects ?? []).filter(x => RX.tooth.test(String(x.name ?? '')) && (x.can ?? []).includes('get')))
          await call('act', { agent, verb: 'get', target: t.id }, 60_000).catch(() => null);
        const n = count(await call('inventory', { agent }, 60_000).catch(() => null), RX.tooth);
        state.teeth = n;
        state.teethDone = n >= Number(p.teeth) || Date.now() > toothDeadline.at;
        return n;
      };
      for (let k = 0; k < 20; k++) {
        steps.push({ ...fight(st => (st.teethDone ? null : 'orc'), { rounds: Number(p.toothRounds), abortBelow: 0.5 }), optional: true });
        steps.push({ ...verify(async ({ call, state }) => {
          if (state.teethDone) return true;
          const n = await enough(call, state);
          if (k % 4 === 3 || state.teethDone) console.log(`  ${agent}: ${n} orc teeth`);
          return true;
        }, 'count the teeth, pick up any on the floor'), optional: true });
      }
    }

    // ---------------------------------------------------------------- SERVE: the farmers' room
    steps.push({ ...walk(Number(p.serve), { why: 'the farmers' }), optional: true });
    steps.push({ ...verify(async ({ call, state }) => {
      const serve = Number(p.serve), until = Date.now() + Number(p.serveMin) * 60_000;
      const named = String(p.farmers ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const trainees = String(p.agents ?? agent).split(',').map(s => s.trim());
      const done = new Set(), tally = { hospice: 0, identify: 0, picked: 0, taken: 0, uncurse: 0, fire: 0 };
      const cursorNow = () => call('wait_for_event', { agent, kinds: ['message'], timeout_ms: 1 }, 30_000).then(w => w?.cursor ?? 0).catch(() => 0);
      const prose = async (since, ms = 6000) => {
        const w = await call('wait_for_event', { agent, since, kinds: ['message'], timeout_ms: ms }, 60_000).catch(() => null);
        return (w?.events ?? []).map(e => String(e?.text ?? '')).filter(Boolean);
      };
      const cast = (spell, target) => call('cast', { agent, spell, ...(target != null ? { target } : {}) }, 90_000).catch(e => ({ error: e.message }));
      const identify = async (id, what) => {
        const c0 = await cursorNow();
        const r = await cast('identify', id);
        if (r?.error || r?.ok === false) return null;
        tally.identify++;
        const seen = readIdentify(await prose(c0));
        if (seen.fire) { tally.fire++; console.log(`  ${agent}: FIRE on ${what}: ${seen.text}`); }
        if (seen.cursed && has.uncurse) { await cast('remove curse', agent); tally.uncurse++; }
        return seen;
      };
      let lastTake = 0;
      for (let pass = 0; Date.now() < until; pass++) {
        const [st, inv, fleet, look] = await Promise.all([
          call('status', { agent }, 60_000).catch(() => null), call('inventory', { agent }, 60_000).catch(() => null),
          call('fleet', {}, 60_000).catch(() => null), call('look', { agent }, 60_000).catch(() => null)]);
        if (Number(st?.room?.num ?? st?.room_num) !== serve) { console.log(`  ${agent}: no longer in ${serve} -- ending the service`); break; }
        const hp = Number(st?.hp?.value ?? NaN), max = Number(st?.hp?.max ?? NaN);
        const mana = Number(st?.mana?.value ?? NaN);
        if (Number.isFinite(hp) && Number.isFinite(max) && hp / max < Number(p.leaveBelow)) { console.log(`  ${agent}: ${hp}/${max} -- leaving`); break; }
        const herbs = count(inv, RX.herb), teeth = count(inv, RX.tooth), ems = count(inv, RX.emerald);
        if ((!has.hospice || herbs < 3) && (!has.identify || teeth < 1)) { console.log(`  ${agent}: out of herbs and teeth -- going home`); break; }
        if (has.rescue && ems <= Number(p.emeraldReserve) - 1) { console.log(`  ${agent}: down to the Rescue emeralds -- going home`); break; }
        // No mana is held back for Rescue: a trainee's pool is ~27, so a reserve would leave one cast. The
        // Rescue step waits for its own 16 instead.
        const manaFor = c => !Number.isFinite(mana) || mana >= c;

        // 1. HOSPICE: a hurt fleet-mate here, worst first. Never a stranger.
        if (has.hospice && herbs >= 3 && manaFor(10)) {
          const rows = (fleet?.fleet ?? []).filter(r => !named.length || named.includes(r.agent));
          const self = Number.isFinite(hp) && hp / max < Number(p.hurtBelow) ? [{ agent, name: agent, frac: hp / max }] : [];
          const who = [...self, ...hurtAllies(rows, { room: serve, below: Number(p.hurtBelow), exclude: trainees })][0];
          if (who) { const r = await cast('hospice', who.agent === agent ? agent : who.name); if (!r?.error && r?.ok !== false) tally.hospice++; continue; }
        }
        // 2. IDENTIFY on the floor: rings and unidentified things, each once. Pick a ring up after.
        if (has.identify && teeth >= 1 && manaFor(10)) {
          const floor = (look?.objects ?? []).filter(x => !x.is_player && (x.can ?? []).includes('get') && !done.has(x.id) &&
            (RX.ring.test(String(x.name ?? '')) || RX.engine.test(String(x.name ?? '')) || Number(x.appearance?.rarity) === 100));
          if (floor.length) {
            const it = floor.sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0];
            done.add(it.id);
            await identify(it.id, `${it.name} on the floor`);
            if (RX.valuable.test(String(it.name ?? '')) || RX.engine.test(String(it.name ?? ''))) {
              if ((it.distance ?? 0) > 2) await call('walk_to', { agent, col: it.col, row: it.row }, 120_000).catch(() => null);
              const g = await call('act', { agent, verb: 'get', target: it.id }, 60_000).catch(() => null);
              if (g && !g.error) tally.picked++;
            }
            continue;
          }
          // ... and in the trainee's own pack (what the farmers handed over): the practice that never runs dry.
          const mine = (inv?.items ?? []).filter(i => !done.has(i.id) && (RX.ring.test(String(i.name ?? '')) || Number(i.rarity) === 100));
          if (mine.length) { done.add(mine[0].id); await identify(mine[0].id, `${mine[0].name} in the pack`); continue; }
        }
        // 3. COLLECT the farmers' diamonds and rings, every few minutes.
        if (Date.now() - lastTake > 4 * 60_000) {
          lastTake = Date.now();
          const here = (fleet?.fleet ?? []).filter(r => Number(r.room_num) === serve && !trainees.includes(r.agent) && (!named.length || named.includes(r.agent)));
          for (const f of here) {
            const fi = await call('inventory', { agent: f.agent }, 60_000).catch(() => null);
            const goods = [...new Set((fi?.items ?? []).filter(i => RX.valuable.test(String(i.name ?? ''))).map(i => String(i.name)))];
            for (const g of goods) {
              const r = await call('supply', { from: f.agent, to: agent, what: g, who_travels: 'neither' }, 180_000).catch(() => null);
              if (r?.supplied) tally.taken++;
            }
          }
          continue;
        }
        // 4. Nothing to do: stay near the farmers and wait a beat.
        const mates = (look?.objects ?? []).filter(x => x.is_player && fleetNames.has(lc(x.name)) && !trainees.some(t => lc(t) === lc(x.name)));
        const near = mates.sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0];
        if (near && (near.distance ?? 0) > 6) await call('walk_to', { agent, col: near.col, row: near.row, arrive_within: 3 }, 120_000).catch(() => null);
        await sleep(15_000);
      }
      state.served = tally;
      console.log(`  ${agent}: served -- ${JSON.stringify(tally)}`);
      return true;
    }, 'serve the farmers: hospice, identify, collect'), optional: true });

    // ---------------------------------------------------------------- RESCUE home
    if (has.rescue) steps.push({ ...verify(async ({ call }) => {
      const room = async () => Number((await call('status', { agent }, 30_000).catch(() => null))?.room?.num ?? NaN);
      for (let tries = 0; tries < 3; tries++) {
        for (let w = 0; w < 30; w++) {   // up to 7.5 min for 16 mana
          const m = Number((await call('status', { agent }, 30_000).catch(() => null))?.mana?.value ?? 99);
          if (m >= 16) break;
          await sleep(15_000);
        }
        await call('cast', { agent, spell: 'rescue' }, 90_000).catch(() => null);
        await sleep(35_000);
        const r = await room();
        if (r === hall || r === Number(p.home) || r !== Number(p.serve)) { console.log(`  ${agent}: Rescue landed in ${r}`); return true; }
      }
      return { ok: false, why: 'Rescue did not take three times' };
    }, 'Rescue home'), optional: true });
    // In the hall: put the haul in the chests now, not next lap. Then home, which is where the keeper lives.
    steps.push(hallPhase());
    steps.push({ ...walk(Number(p.home), { why: 'home' }), always: true });
    return steps;
  },
};
