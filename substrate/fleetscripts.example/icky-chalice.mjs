// CLEAR THE ICKY CAVE OF ORCS, DISPEL THE ILLUSION, TAKE THE CHALICE OF THE RAIN.
//
// THE SHAPE of a local errand (substrate/fleetscripts/ is this machine's and gitignored; this copy
// sits BESIDE it so the REPL does not list it twice). Copy it there to run it:
//
//   node tools/m59-fleet-repl.mjs
//   > dry icky-chalice agents=t9,t16
//   > icky-chalice agents=t9,t16 caster=t9
//
// The operator, 2026-10-02: "clear all the orcs from the cave, and specifically leave the spiders
// alive even if they attack our characters ... Camilla will come through to cast Dispel Illusion and
// take the chalice, but first we have to clear all orcs from the room, which is most easily done by
// killing all the orcs and letting the spiders spawn until there are 10 spiders, so that they fill
// the full spawn capacity for the map and no orcs can spawn".
// And 2026-10-04: "for the dispel illusion, Camilla or whoever with dispel illusion may have to get a
// cast worth of reagents from the guild chest or vault in Barloque before going to icky caves to
// cast, if the reagents aren't on their person but are in either of those places".
//
// WHAT THE KOD SAYS (M59_ROOT, kod/):
//   * object/active/holder/room/monsroom/objroom/cave2.kod — "A Deep, Dark, Spooky, Icky Cave",
//     RID_CAVE2 = room 27. Constructed: plMonsters [[&Orc,50],[&Spider,50]]; the cap is monsroom.kod
//     piMonster_count_max = 10. CreateObjectGeneration: [&Chalice, GEN_ONE, 0, 23, 11, 16, 48] — ONE
//     chalice at r23c11 (fine 16,48), regenerated on piGen_Object_Time 1200000 (~20 min) once taken.
//     DispelIllusions() lowers sectors 1-5 to height 24 and sets ptIllusionResetTimer for 30000 ms;
//     ReplaceIllusions() puts them back. OkayToGetChalice() is FALSE while that timer is nil (the
//     illusion stands) and FALSE while ANY object in plActive isClass &orc.
//   * object/item/passitem/chalice.kod — "Chalice of the Rain", GETTABLE_YES. Taken by an ordinary
//     GET from the floor: ReqNewOwner refuses with "You try to pick up the chalice, but it
//     mystically clings to the stone altar." while OkayToGetChalice is false (only for the one at
//     r23c11 in RID_CAVE2). It ALSO refuses, silently, a user already holding a FULL chalice with as
//     many max hits; and NewOwner MERGES a new one into a partly drunk one the user holds (the new
//     object is deleted). So a caster carrying a chalice is refused up front here. CanBeStoredInVault
//     is FALSE.
//   * object/active/holder/nomoveon/battler/player/user.kod UserGet — the get is refused past a
//     MANHATTAN distance of 7 squares; the server is 2D, so the raised altar does not matter to the
//     get. viTeleport_row/col 23/16 is five squares from the chalice, which is where the caster stands.
//   * object/passive/spell/dispillu.kod — "dispel illusion": Kraanan (SS_KRAANAN), level 4, viMana 20,
//     viSpellExertion 15, GetNumSpellTargets 0 (no target: the ROOM is dispelled). Reagents:
//     1 dragonfly eye, 1 uncut seraphym, 2 solagh ("vial of solagh" in the pack and the chests). The
//     caster is told "You cross your eyes momentarily to make the illusions in the area fade away."
//     cave2's DispelIllusions ignores the spell-power chance, so a cast that lands always opens it.
//
// THE STEPS. Every agent but the caster is a CLEARER:
//   clearer: walk to 27 (every walk guarantee), take the posture — mode farm, farm_strategy
//            icky-cave-orc-clear (kill every orc, spare every spider, confined to 27) — and END, which
//            hands the lease back so the keeper and the strategy do the fighting. The strategy yields
//            every key to whoever holds a faculty, so a clearer this script still held would idle.
//   caster:  1. ready   — knows dispel illusion, mana max >= 20, carries no chalice already;
//            2. source  — one cast's reagents (x `casts`) in the pack? else the hall chests (714,
//                         hall_withdraw: rank sir+ and 30+ max hp), else the Barloque vault (Obert
//                         Cair'bre, 114 — a withdrawal is a purchase off his list), decided from the
//                         cached readings (m59-storage StorageCache, what m59-hall-chests.mjs prints);
//                         refused with the reason when neither has them;
//            3. walk to the source and draw EXACTLY the shortfall, read back off the pack; a short hall
//               falls back to the vault;
//            4. wait, outside, until a clearer standing in 27 sees the room HELD: no orc, and the room
//               at its cap of ten (so nothing at all can spawn) — bounded by `waitMin`;
//            5. spare spiders on the caster too (a reflex swing that kills one reopens a slot an orc
//               can take), walk to 27, stand at r23c16;
//            6. cast dispel illusion, judged by the server's sentence and the reagents leaving, then
//               take the chalice inside the 30 s window, judged by the PACK gaining it; one retry of
//               the cast if the window was missed and the room is (again) held;
//            7. always: the caster's spare list back as it was, the clearers released per `then`, and
//               the caster walked `home` (0 stays).
//
// IDs ARE HANDLES (CLAUDE.md): nothing here holds an object id across a step. The chalice is found by
// name and taken by name (`loot only`), the vaultman's row ids are read in the same step that buys.
import { walk, walkTo, verify, castVerified, knownCharacters, observe } from '../../tools/m59-fleetscript.mjs';
import { ordersFromStatus } from '../../tools/m59-strategy-engine.mjs';
import { StorageCache } from '../../tools/m59-storage.mjs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ------------------------------------------------------------------ the game's own numbers
export const CAVE = Object.freeze({ room: 27, cap: 10, chalice: { row: 23, col: 11 }, stand: { row: 23, col: 16 },
  windowMs: 30_000, getReach: 7, regenMin: 20 });
export const DISPEL = Object.freeze({
  spell: 'dispel illusion', mana: 20,
  // Names as the pack and the chest readings spell them; the regexes take plurals too.
  reagents: Object.freeze([
    { item: 'dragonfly eye', per: 1, rx: /^dragonfly eyes?$/i },
    { item: 'uncut seraphym', per: 1, rx: /^uncut seraphyms?$/i },
    { item: 'vial of solagh', per: 2, rx: /^(vials? of )?solagh$/i },
  ]),
  said: /cross your eyes momentarily/i,
});
export const CHALICE_RX = /chalice/i;
export const CLINGS_RX = /mystically clings to the stone altar/i;
export const HALL = 714, VAULT_ROOM = 114, VAULTMAN = "Obert Cair'bre";
export const STRATEGY = 'icky-cave-orc-clear';

// ------------------------------------------------------------------ pure helpers (tested offline)
const amountOf = i => Number(i?.amount) || 1;
/** How many of a reagent a list of {name, amount} rows holds. */
export function countOf(items = [], rx) {
  return (items ?? []).filter(i => rx.test(String(i?.name ?? '').trim())).reduce((n, i) => n + amountOf(i), 0);
}
/** Whole casts the list pays for. */
export function castsIn(items = []) {
  return Math.min(...DISPEL.reagents.map(r => Math.floor(countOf(items, r.rx) / r.per)));
}
/** What is missing for `casts` casts: [{item, amount}] (empty when the list already pays). */
export function shortfall(items = [], casts = 1) {
  return DISPEL.reagents.map(r => ({ item: r.item, amount: Math.max(0, r.per * casts - countOf(items, r.rx)) }))
    .filter(w => w.amount > 0);
}

/**
 * WHERE THE REAGENTS COME FROM. The pack first; then the guild chests (the readings summed over every
 * chest anyone has opened); then the caster's own vault reading. A source is chosen only if it covers
 * the WHOLE shortfall on its own; failing that, hall then vault for the remainder. A reading is not the
 * container (somebody may have taken since), which is why the steps read the pack back after every
 * draw and fall back.
 *   -> { from: 'pack' | 'hall' | 'vault' | 'hall+vault' | null, short, hall: [wants], vault: [wants], why }
 */
export function reagentSource({ pack = [], chests = [], vault = null, casts = 1, hallOk = true } = {}) {
  const short = shortfall(pack, casts);
  if (!short.length) return { from: 'pack', short, hall: [], vault: [], why: `the pack already pays for ${casts} cast(s)` };
  const chestItems = (chests ?? []).flatMap(c => c?.items ?? []);
  const vaultItems = vault?.items ?? [];
  const have = (items, w) => countOf(items, DISPEL.reagents.find(r => r.item === w.item).rx);
  const hallCovers = hallOk && short.every(w => have(chestItems, w) >= w.amount);
  if (hallCovers) return { from: 'hall', short, hall: short, vault: [], why: 'the guild chests (as last read) hold the shortfall' };
  const vaultCovers = short.every(w => have(vaultItems, w) >= w.amount);
  if (vaultCovers) return { from: 'vault', short, hall: [], vault: short,
    why: hallOk ? 'the chests (as last read) are short; the vault (as last read) holds it' : 'the hall is out of reach for this caster; the vault holds it' };
  if (hallOk) {
    const hall = short.map(w => ({ item: w.item, amount: Math.min(w.amount, have(chestItems, w)) })).filter(w => w.amount > 0);
    const rest = short.map(w => ({ item: w.item, amount: w.amount - Math.min(w.amount, have(chestItems, w)) })).filter(w => w.amount > 0);
    if (rest.every(w => have(vaultItems, w) >= w.amount) && hall.length)
      return { from: 'hall+vault', short, hall, vault: rest, why: 'neither alone holds it; the chests and then the vault do' };
  }
  const where = s => `${s.item} x${s.amount}`;
  return { from: null, short, hall: [], vault: [],
    why: `short ${short.map(where).join(', ')} for ${casts} cast(s), and neither the guild chests` +
         `${hallOk ? '' : ' (out of reach)'} nor the vault (as last read) hold it` +
         `${(chests ?? []).length ? '' : ' — nobody has opened a chest from this checkout'}` +
         `${vault ? '' : ' — this caster\'s vault has never been read'}` };
}

/**
 * THE ROOM, AS A LOOK SEES IT: orcs, spiders, every monster, and whether the chalice is on view.
 * HELD is no orc AND the room at its cap (nothing can spawn); OPEN is no orc below the cap (an orc may
 * still spawn); CLEARING is any orc. An empty or unreadable object list is never HELD — it is the
 * absence of a reading, and the cap is what makes "no orc" a durable fact.
 */
export function caveState(look, { room = CAVE.room, cap = CAVE.cap } = {}) {
  const num = look?.room?.num ?? look?.where?.num ?? null;
  const objects = Array.isArray(look?.objects) ? look.objects : [];
  const monsters = objects.filter(o => !o?.is_player && Array.isArray(o?.can) && o.can.includes('attack'));
  const orcs = monsters.filter(o => /\borcs?\b/i.test(String(o.name ?? ''))).length;
  const spiders = monsters.filter(o => /\bspiders?\b/i.test(String(o.name ?? ''))).length;
  const chalice = objects.some(o => !o?.is_player && CHALICE_RX.test(String(o?.name ?? '')));
  const inRoom = Number(num) === Number(room);
  const state = !inRoom ? 'elsewhere' : orcs > 0 ? 'clearing' : monsters.length >= cap ? 'held' : 'open';
  return { room: num, inRoom, orcs, spiders, monsters: monsters.length, chalice, state, held: state === 'held' };
}

// ------------------------------------------------------------------ run-time helpers
const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = v => String(v ?? '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the chest and vault readings live: M59_STORAGE_DIR, else the broker's own root, else here. */
async function storageDir() {
  if (process.env.M59_STORAGE_DIR) return process.env.M59_STORAGE_DIR;
  const url = (process.env.M59_CONTROL_URL || 'http://127.0.0.1:8901').replace(/\/?$/, '/');
  try {
    const h = await (await fetch(`${url}health`, { signal: AbortSignal.timeout(8000) })).json();
    if (typeof h?.root === 'string') return join(resolve(h.root), 'substrate', 'storage');
  } catch {}
  return join(HERE, '..', 'storage');
}
const packOf = async (call, agent) => (await call('inventory', { agent }, 60_000).catch(() => null))?.items ?? [];
const lookAt = (call, agent) => call('look', { agent }, 60_000).catch(() => null);

/** Wait until somebody standing in the cave sees it held. -> caveState of the last reading. */
async function waitHeld(call, lookers, { budgetMs, room, cap, requireCap, log }) {
  const until = Date.now() + budgetMs;
  let last = null, lastLine = '';
  for (;;) {
    for (const who of lookers) {
      const st = caveState(await lookAt(call, who), { room, cap });
      if (!st.inRoom) continue;
      last = st;
      if (st.held || (!requireCap && st.orcs === 0 && st.monsters > 0)) return { ...st, by: who };
    }
    const line = last ? `${last.state}: ${last.orcs} orc(s), ${last.spiders} spider(s), ${last.monsters}/${cap}`
                      : 'nobody is standing in the cave to look';
    if (line !== lastLine) { log(line); lastLine = line; }
    if (Date.now() >= until) return { ...(last ?? { state: 'unread' }), timedOut: true };
    await sleep(15_000);
  }
}

// ------------------------------------------------------------------ the script
export const script = {
  name: 'icky-chalice',
  describe: 'Hold the Icky Cave (27) orc-free with ten spiders, fetch one cast of dispel illusion reagents ' +
            'from the hall chests or the Barloque vault if needed, dispel the illusion and take the Chalice of the Rain.',
  recipe: {
    effect: 'The caster carries the Chalice of the Rain, read back off its pack.',
    run: 'icky-chalice agents=<caster>,<clearer>... caster=<caster>',
    needs: ['a caster who knows dispel illusion (Kraanan 4, 20 mana)',
            'substrate/farm-strategies/icky-cave-orc-clear.mjs on this machine (copy it from the .example dir)',
            'for the hall: guild rank sir+ and 30+ max hp; for the vault: shillings for the retrieval fee'],
    cost: { reagents: '1 dragonfly eye, 1 uncut seraphym, 2 vial of solagh per cast',
            time: 'the cave fills its cap at one spawn per 45 s at 80% (cave2 piGen_time/percent), so a fresh hold is 10-30 min' },
  },
  params: {
    agents:   { type: 'agents', required: true, describe: 'the caster AND the clearers; every one but `caster` clears' },
    caster:   { type: 'string', default: 't9', describe: 'who casts (Camilla, t9, knows dispel illusion)' },
    strategy: { type: 'string', default: STRATEGY, describe: 'the farm strategy the clearers take' },
    room:     { type: 'number', default: CAVE.room },
    cap:      { type: 'number', default: CAVE.cap, describe: 'monsroom.kod piMonster_count_max' },
    requireCap: { type: 'boolean', default: true, describe: 'false casts on "no orc right now" without the cap full' },
    waitMin:  { type: 'number', default: 45, describe: 'how long to wait for the cave to be held' },
    casts:    { type: 'number', default: 2, describe: 'reagents for this many casts (one, plus the one retry)' },
    hall:     { type: 'number', default: HALL },
    vaultRoom: { type: 'number', default: VAULT_ROOM },
    vaultman: { type: 'string', default: VAULTMAN },
    standCol: { type: 'number', default: CAVE.stand.col, describe: 'within 7 squares (Manhattan) of the chalice at r23c11' },
    standRow: { type: 'number', default: CAVE.stand.row },
    spareOnCaster: { type: 'boolean', default: true, describe: 'spare spiders on the caster while in the cave' },
    then:     { type: 'string', default: 'keep', describe: 'the clearers afterwards: keep (go on holding), unassign, ' +
                                                         'or JSON autopilot args applied with the strategy unassigned' },
    home:     { type: 'number', default: 0, describe: 'where the caster goes afterwards; 0 stays in the cave' },
    minHealth: { type: 'number', default: 0.8 },
  },

  async steps(p) {
    const agent = p.agent, room = Number(p.room), cap = Number(p.cap);
    const caster = String(p.caster || '').trim();
    const agents = list(p.agents);
    const clearers = agents.filter(a => a !== caster);
    const requireCap = p.requireCap !== false && String(p.requireCap) !== 'false';
    const spareOnCaster = p.spareOnCaster !== false && String(p.spareOnCaster) !== 'false';
    const log = (...a) => console.log(`  ${agent}:`, ...a);

    // ------------------------------------------------------------ a clearer
    if (agent !== caster) {
      if (!agents.includes(caster))
        return [verify(async () => ({ ok: false, why: `caster ${caster} is not one of agents=${agents.join(',')}` }),
                       'the caster must be one of the agents', 'caster-missing')];
      return [
        walk(room, { why: 'the cave the strategy holds' }),
        verify(async ({ call }) => {
          const r = await call('autopilot', { agent, action: 'start', mode: 'farm', farm_strategy: String(p.strategy) }, 60_000)
            .catch(e => ({ error: e.message }));
          if (r?.error || r?.started === false) return { ok: false, why: `posture refused: ${r?.error ?? r?.reason}` };
          const st = await call('autopilot', { agent, action: 'status' }, 60_000).catch(() => null);
          const fs = st?.farm_strategy ?? null;
          log(`on ${p.strategy}: ${fs?.state ?? 'not reported yet'} (the lease ends with this step; the keeper fights)`);
          if (fs?.assigned && fs.assigned !== String(p.strategy)) return { ok: false, why: `assigned ${fs.assigned}, not ${p.strategy}` };
          if (fs?.state === 'refused') return { ok: false, why: `the keeper refused the file: ${fs.refused?.why ?? '?'}` };
          return { ok: true, strategy: fs?.state ?? null };
        }, 'the clearing posture, read back', 'posture'),
      ];
    }

    // ------------------------------------------------------------ the caster
    const icky = {};    // this run's facts, filled at run time (the steps are compiled once)
    const at = s => s.icky ?? icky;
    return [
      verify(async ({ call, state }) => {
        state.icky = icky;
        const sp = await call('spells', { agent }, 60_000).catch(() => null);
        const known = (sp?.spells ?? []).find(s => String(s.name).toLowerCase() === DISPEL.spell);
        if (!known) return { ok: false, why: `${agent} does not know ${DISPEL.spell} (Kraanan 4) — pick another caster` };
        const st = await call('status', { agent }, 40_000).catch(() => null);
        const manaMax = Number(st?.mana?.max ?? st?.vitals?.mana?.max ?? NaN);
        if (Number.isFinite(manaMax) && manaMax < DISPEL.mana)
          return { ok: false, why: `max mana ${manaMax} is under the ${DISPEL.mana} the spell costs` };
        const pk = await packOf(call, agent);
        if (countOf(pk, CHALICE_RX) > 0)
          return { ok: false, why: 'the caster already carries a Chalice of the Rain: chalice.kod refuses a second ' +
                                   'while that one is full, and merges a new one into it (deleting it) while it is not' };
        const names = knownCharacters();
        icky.character = [...names].find(([k, a]) => a === agent && k !== agent.toLowerCase())?.[0] ?? null;
        icky.startRoom = (await observe(agent)).room ?? null;
        if (icky.startRoom == null) return { ok: false, why: 'cannot read which room the caster is in' };
        icky.maxHealth = Number(st?.hp?.max ?? st?.vitals?.health?.max ?? NaN);
        log(`knows ${DISPEL.spell}; mana max ${Number.isFinite(manaMax) ? manaMax : '?'}`);
        return true;
      }, 'the caster can cast it', 'ready'),

      verify(async ({ call }) => {
        const pk = await packOf(call, agent);
        const cache = new StorageCache({ dir: await storageDir() });
        const vault = icky.character
          ? cache.allVaults().find(v => String(v.character).toLowerCase() === icky.character) ?? null : null;
        const hallOk = !(Number.isFinite(icky.maxHealth) && icky.maxHealth < 30);
        const plan = reagentSource({ pack: pk, chests: cache.allChests(), vault, casts: Number(p.casts) || 1, hallOk });
        Object.assign(icky, { plan });
        icky.first = plan.from === 'hall' || plan.from === 'hall+vault' ? Number(p.hall)
                   : plan.from === 'vault' ? Number(p.vaultRoom) : icky.startRoom;
        log(`reagents: ${plan.from ?? 'NONE'} — ${plan.why}`);
        return plan.from ? { ok: true, from: plan.from } : { ok: false, why: plan.why };
      }, 'one cast of reagents, and where it comes from', 'source'),

      walk(s => at(s).first, { candidates: [Number(p.hall), Number(p.vaultRoom)],
                               why: 'the hall chests or the vault (no walk when the pack pays)' }),
      verify(async ({ call }) => {
        const plan = icky.plan;
        if (plan.from !== 'hall' && plan.from !== 'hall+vault') { icky.needVault = plan.from === 'vault'; return true; }
        const r = await call('hall_withdraw', { agent, wants: plan.hall }, 620_000).catch(e => ({ ok: false, why: e.message }));
        const left = shortfall(await packOf(call, agent), Number(p.casts) || 1);
        log(`hall: took ${JSON.stringify(r?.took ?? {})}${r?.ok === false ? ` REFUSED ${r?.why ?? r?.error ?? ''}` : ''}; ` +
            `still short ${JSON.stringify(left)}`);
        icky.needVault = left.length > 0;
        icky.vaultWants = left;
        icky.at = Number(p.hall);
        return true;              // a short hall is not the end: the vault is next
      }, 'the shortfall out of the guild chests', 'hall'),
      walk(s => (at(s).needVault ? Number(p.vaultRoom) : at(s).at ?? at(s).first), {
        candidates: [Number(p.hall), Number(p.vaultRoom)], why: 'the vault, if the chests fell short' }),
      verify(async ({ call }) => {
        if (icky.needVault) {
          const wants = icky.vaultWants ?? icky.plan.vault ?? shortfall(await packOf(call, agent), Number(p.casts) || 1);
          // A WITHDRAWAL IS A PURCHASE: the vaultman's sell list IS the caster's deposit offered back at
          // a retrieval fee (user.kod UserWithdrawalItems sends @Buy, exactly as UserBuyItems). The ids
          // are read here and spent here — never carried to another step.
          const menu = await call('shop', { agent, seller: String(p.vaultman) }, 180_000).catch(e => ({ error: e.message }));
          const buy = [];
          for (const w of wants) {
            const rx = DISPEL.reagents.find(r => r.item === w.item).rx;
            const row = (menu?.items ?? []).find(i => rx.test(String(i.name ?? '').trim()));
            if (row) buy.push({ id: row.id, amount: w.amount });
          }
          if (buy.length) {
            const r = await call('shop', { agent, seller: String(p.vaultman), buy_ids: buy }, 300_000).catch(e => ({ error: e.message }));
            if (r?.clamped?.length) log(`the vault order was cut: ${JSON.stringify(r.clamped)}`);
          }
          await sleep(3000);
        }
        const pk = await packOf(call, agent);
        const left = shortfall(pk, 1);
        log(`carrying ${castsIn(pk)} cast(s) of ${DISPEL.spell}`);
        return left.length ? { ok: false, why: `still short ${left.map(w => `${w.item} x${w.amount}`).join(', ')} ` +
                                              'for even one cast, after the chests and the vault' } : true;
      }, 'at least one cast in the pack, read back', 'reagents'),

      verify(async ({ call }) => {
        if (!clearers.length) { icky.lookers = []; return true; }
        log(`waiting up to ${p.waitMin} min for ${clearers.join(', ')} to hold room ${room}`);
        const st = await waitHeld(call, clearers, { budgetMs: Number(p.waitMin) * 60_000, room, cap, requireCap, log });
        icky.lookers = clearers;
        return st.timedOut ? { ok: false, why: `the cave was not held in ${p.waitMin} min (last: ${st.state}, ` +
                                               `${st.orcs ?? '?'} orc(s), ${st.monsters ?? '?'}/${cap})` }
                           : { ok: true, held_by: st.by, spiders: st.spiders };
      }, 'the cave held before the caster goes in', 'held'),

      ...(spareOnCaster ? [verify(async ({ call }) => {
        const st = await call('autopilot', { agent, action: 'status' }, 60_000).catch(() => null);
        icky.casterSpare = (ordersFromStatus(st) ?? st?.policy ?? {}).spareCreatures ?? null;
        icky.spareSet = true;
        const r = await call('autopilot', { agent, action: 'start', spare_creatures: ['spider'] }, 60_000)
          .catch(e => ({ error: e.message }));
        return r?.error ? { ok: false, why: `could not spare spiders on the caster: ${r.error}` } : true;
      }, 'the caster spares spiders too: one killed reopens a slot an orc can take', 'caster-spare')] : []),

      walk(room, { why: 'the Icky Cave' }),
      { ...walkTo(Number(p.standCol), Number(p.standRow), { room, within: 2, deadlineMs: 90_000,
          why: 'within reach of the altar (a get reaches 7 squares, Manhattan)' }), optional: true },

      verify(async ({ call }) => {
        const before = countOf(await packOf(call, agent), CHALICE_RX);
        const lookers = [agent, ...(icky.lookers ?? [])];
        let attempts = 0;
        const said = [];
        while (attempts < 2) {
          // Held right now, read by the caster itself, and the chalice actually on view.
          const st = await waitHeld(call, lookers, { budgetMs: attempts ? 5 * 60_000 : 60_000, room, cap, requireCap,
                                                     log });
          if (st.timedOut) return { ok: false, why: `not held at the cast (${st.state}: ${st.orcs ?? '?'} orc(s))`, attempts, said };
          const mine = caveState(await lookAt(call, agent), { room, cap });
          if (mine.inRoom && !mine.chalice)
            return { ok: false, why: `no chalice on view in ${room}: cave2.kod generates ONE (GEN_ONE) and replaces a ` +
                                     `taken one after ~${CAVE.regenMin} min — nothing was cast`, attempts, said };
          if (castsIn(await packOf(call, agent)) < 1)
            return { ok: false, why: 'out of reagents before the cast', attempts, said };
          attempts++;
          const c = await castVerified(agent, DISPEL.spell, { cost: DISPEL.mana });
          said.push(...(c.said ?? []));
          const landed = c.landed || (c.said ?? []).some(t => DISPEL.said.test(t));
          log(`cast ${attempts}: ${landed ? 'LANDED' : `did not land (${c.outcome}: ${c.why})`}`);
          if (!landed) { if (c.retryable === false) break; continue; }
          // THE 30-SECOND WINDOW. Taken by name; the keeper resolves the object off its live room.
          const t0 = Date.now();
          const got = await call('loot', { agent, only: 'chalice', max_items: 1 }, 60_000).catch(e => ({ error: e.message }));
          for (const m of [...(got?.messages ?? []), ...(got?.refused ?? []).map(String)]) said.push(String(m));
          let now = before;
          while (Date.now() - t0 < CAVE.windowMs) {
            now = countOf(await packOf(call, agent), CHALICE_RX);
            if (now > before) break;
            await sleep(2000);
          }
          if (now > before) {
            log(`THE CHALICE OF THE RAIN is in the pack (${Math.round((Date.now() - t0) / 1000)} s after the cast)`);
            icky.took = true;
            return { ok: true, attempts, chalices: now };
          }
          const clung = said.some(t => CLINGS_RX.test(t));
          log(`no chalice after the cast${clung ? ' — "it mystically clings": the window closed or an orc is in the room' : ''}` +
              `${got?.error ? ` (loot: ${got.error})` : ''}`);
        }
        return { ok: false, why: `the chalice did not reach the pack in ${attempts} cast(s)`, attempts,
                 said: said.slice(-6) };
      }, 'dispel the illusion and take the chalice inside the 30 s window, judged by the pack', 'chalice'),

      { ...verify(async ({ call }) => {
        if (!icky.spareSet) return true;
        const r = await call('autopilot', { agent, action: 'start', spare_creatures: icky.casterSpare ?? null }, 60_000)
          .catch(e => ({ error: e.message }));
        return r?.error ? { ok: false, why: `could not restore the caster's spare list: ${r.error}` } : true;
      }, "the caster's spare list back as it was", 'caster-unspare'), always: true },

      { ...verify(async ({ call }) => {
        const then = String(p.then ?? 'keep').trim();
        if (!clearers.length || then === 'keep') {
          if (clearers.length) log(`clearers ${clearers.join(', ')} stay on ${p.strategy} (then=keep): the cave stays held for the next chalice`);
          return true;
        }
        let extra = {};
        if (then !== 'unassign') {
          try { extra = JSON.parse(then); } catch { return { ok: false, why: `then must be keep, unassign or JSON autopilot args: ${then}` }; }
        }
        const out = {};
        for (const c of clearers) {
          const r = await call('autopilot', { agent: c, action: 'start', ...extra, farm_strategy: null }, 60_000)
            .catch(e => ({ error: e.message }));
          out[c] = r?.error ?? r?.reason ?? (r?.farm_strategy_released ? 'released' : 'ok');
          if (r?.farm_strategy_released?.reset_to_default && Object.keys(r.farm_strategy_released.reset_to_default).length)
            log(`${c}: cleared residue ${JSON.stringify(r.farm_strategy_released.reset_to_default)}`);
        }
        log(`clearers released: ${JSON.stringify(out)}`);
        return true;
      }, 'the clearers released per `then`', 'release'), always: true },

      ...(Number(p.home) > 0 ? [{ ...walk(Number(p.home), { why: 'home' }), always: true }] : []),
    ];
  },
};
