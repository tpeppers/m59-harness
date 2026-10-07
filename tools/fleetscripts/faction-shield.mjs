// JOIN A FACTION (IF NEED BE), THEN EARN ITS SOLDIER SHIELD.
//
//   faction-shield agents=t5 faction=duke|princess|jonas            both halves
//   faction-shield agents=t5 faction=duke only=shield               the shield half only
//   faction-shield agents=t5 faction=duke resume=2                  stage 2 of the shield, after a death
//
// Operator's request, 2026-10-07. Everything below is read from the server source
// (Meridian59/kod, util/questengine.kod unless a file is named); `m59-factions.mjs` holds the
// tables and the sentence parsers, so this file is the ERRAND and nothing else.
//
// HALF ONE — JOIN. Quest templates 1/2 (Duke), 3/4 (Princess), 199/200 (Jonas).
//
//   * The trigger is the word "join", said within FIVE squares of the liege
//     (`duke_join1_trigger`; QN_TYPE_MESSAGE matches with StringContain; Q_NPC_CLOSE_ENOUGH 5).
//   * Eligibility, all silent when it fails: faction NEUTRAL, "intriguing" (PK-enabled and base
//     max health >= 40, player.kod PlayerIsIntriguing/PlayerIsHPIntrigue), and not tried in the
//     last 24h of LOGGED-IN time (Q_PLAYER_NOTTRIED_RECENTLY). Anyone this script is meant for
//     (>75 health) is intriguing; the 24h lockout is the one that bites a second attempt.
//   * The liege answers with ONE of a fixed list, inside the hour (`#timelimit = 3600`):
//       Duke Akardius (952)   bring me a sapphire | ruby | emerald | diamond   (QN_TYPE_ITEMFINDCLASS)
//       Jonas D'Accor (371)   bring me plate armor | helm | knight's shield | gauntlets |
//                             mystic sword | scimitar                          (same)
//       Princess (852)        she HANDS you a letter (QN_TYPE_ITEM, questnode.kod Assign gives
//                             pCargo to the quester) for Priestess Xiana (48), Lady Aftyn (205)
//                             or Herbutte (109). Alzahakar and Esseldi are commented out of the
//                             JOIN list and only appear in the loyalty quest.
//   * The hand-over is an OFFER to the NPC, within five squares, of exactly that class — or, for
//     the letter, exactly THAT letter object (`item_offered <> pCargo`). Success is the server's
//     own sentence "Your name is entered on the roll of membership" (player.kod:152).
//
// HALF TWO — THE SHIELD. Templates 208-216, `[[ Q_R2_HAS_HEALTH_LEVEL, 75 ], [ no shield yet ]]`.
//
//   * Say "soldier" to your own liege. The order is FIXED per liege, not rolled:
//       Duke      rebel soldier, then soldier of the Princess' army  -> shield of the duke's army
//       Princess  soldier of the Duke's army, then rebel soldier     -> shield of the princess' army
//       Jonas     soldier of the Princess' army, then soldier of the Duke's army
//                                                                    -> shield of the rebel militia
//   * Each kill is QN_TYPE_MONSTER with a three-hour clock. `MonsterKilled` compares the CLASS and
//     requires `killing_player = oQuester` — the killing blow must be this character's.
//   * After each kill the node waits IN_PROGRESS for the character to come back within five
//     squares of the liege and say ANYTHING (CheckCompletionCriteria only tests the text for
//     MESSAGE nodes). The report line here deliberately contains none of the trigger words
//     ("join", "soldier", "loyalty", "tax"), so it cannot be read as asking for something else.
//
// WHERE SOLDIERS ARE. Troops spawn only at a flagpole their own faction currently holds, at most
// four a room, about twelve an hour (m59-prefarm-lib.mjs). Holdings change in the territory game,
// so this hunts the starting-holdings rooms first and then widens to every wilderness flag room,
// nearest first by `travel_estimate`, scouting each with a look before fighting.
//
// THE DANGER, SAID PLAINLY. Soldiers are level 70-145 (troop.kod SetEquipment on base 80/50),
// and they are NOT neutral to a faction member: `IsAlly` is false and `SpecialHatredBehavior` is
// +30 for any opposing faction. So the moment this character has joined, every enemy troop in a
// flag room is hostile, and there can be four. The keeper's survival ladder stays armed for the
// whole run (fleetscript holds work/movement/economy only), the fight step gives up at
// `abortBelow`, and a death simply ends the run — re-run it with `resume=` to pick up the stage.
//
// WHY THE HAND-OVER GOES STRAIGHT TO THE KEEPER. The broker's `faction_join`/`faction_soldier`
// tools and its `trade` tool read `c.room.objects` and `c.eventsSince`, and on a keeper-backed
// character (all of prod) the proxy has neither — `eventsSince` is a stub returning [] and there
// is no `room`. So the liege's answer was never parsed and an NPC offer threw. The keeper's own
// `/action trade {op:'offer', to_id}` is the path that holds the socket; the NPC id comes from a
// fresh `look` immediately before (an object id is a handle, never kept).
import { walk, say, shop, fight, verify, walkTo, crawlTo, gate, ungate, observe }
  from '../m59-fleetscript.mjs';
import { QUEST_NPC_RADIUS } from '../m59-sayrange.mjs';
import { fleetName } from '../m59-fleetpath.mjs';
import { scanKeepers } from '../m59-keeper.mjs';
import { saveRun, runId } from '../m59-questbook.mjs';
import { findNpc } from './disciple-quest.mjs';
import { factionJoinSpec, factionAssignment, factionJoinConfirmed, FACTION_SOLDIER,
         soldierAssignment, soldierFromInventory, factionFromProfile,
         WILDERNESS_FLAG_ROOMS } from '../m59-factions.mjs';

const lower = s => String(s ?? '').trim().toLowerCase();

// ---------------------------------------------------------------- the pure half (tested offline)

/** duke | princess | rebel, from what an operator is likely to type. */
export function factionKey(value) {
  return factionJoinSpec(value)?.id ?? null;
}

// WHERE A JOIN ITEM CAN BE BOUGHT, when the pack does not already hold it. Only counters that
// assemble their list on demand (cannot run dry) and do not wander. The Duke stands in Tos, so
// Skivlat (Tos, 54) is first; Herbutte (Barloque, 109) is the fallback. RUBY HAS NO SELLER, and
// nothing on Jonas's list has a reliable one (Izzio's helm is finite stock and he walks a circuit),
// so those have to be in the pack before the word is said.
export const JOIN_SELLERS = Object.freeze({
  sapphire: Object.freeze([{ seller: 'Skivlat', room: 54 }, { seller: 'Herbutte', room: 109 }]),
  emerald: Object.freeze([{ seller: 'Skivlat', room: 54 }, { seller: 'Herbutte', room: 109 }]),
  diamond: Object.freeze([{ seller: 'Skivlat', room: 54 }, { seller: 'Herbutte', room: 109 }]),
});

/** Every item this liege could ask for (empty for the Princess, whose cargo is handed to you). */
export function joinCandidates(faction) {
  const spec = factionJoinSpec(faction);
  if (!spec || spec.id === 'princess') return [];
  return [...new Set(spec.assignments.map(a => a.item))];
}

/**
 * CAN EVERY POSSIBLE ASK BE ANSWERED, BEFORE ANYTHING IS SAID?
 *
 * Asking starts a one-hour clock and, win or lose, spends the 24h "tried recently" allowance, so
 * an ask this run cannot satisfy costs a day. Covered = in the pack, or buyable at a counter that
 * cannot run out. `missing` is what the operator has to put in the pack (or accept as a gamble).
 */
export function joinCoverage(faction, packNames = []) {
  const held = new Set(packNames.map(lower));
  const out = { held: [], buyable: [], missing: [] };
  for (const item of joinCandidates(faction)) {
    if (held.has(item)) out.held.push(item);
    else if (JOIN_SELLERS[item]) out.buyable.push(item);
    else out.missing.push(item);
  }
  return out;
}

/** The liege's reply to "join", as {item, target, room} — or null for a sentence not recognised. */
export function readJoinAsk(faction, lines = []) {
  return factionAssignment(faction, lines);
}

/** The liege's reply to "soldier" (or to a report), as {target, rooms, stage_index} or null. */
export function readSoldierAsk(faction, lines = []) {
  return soldierAssignment(faction, lines);
}

/** True when this reply is the promotion itself — the third hint, or the shield in the pack. */
export function readPromoted(faction, lines = [], packNames = []) {
  if (soldierFromInventory(faction, packNames.map(name => ({ name })))) return true;
  return /You have done well, my soldier|It is good that we can count you as an ally|I knew you were a fit soldier/i
    .test(lines.join('\n'));
}

/** A silent "soldier" — the reasons the quest engine gives none of. */
export const SOLDIER_SILENCE =
  'the liege said nothing the soldier quest says. The quest engine is silent when: maximum ' +
  'health is under 75 (Q_R2_HAS_HEALTH_LEVEL), the character already holds the shield, it ' +
  'tried this quest in the last 24h of logged-in time (Q_PLAYER_NOTTRIED_RECENTLY — which is ' +
  'also the case MID-QUEST: re-run with resume=1 or resume=2), no soldier quest node is ' +
  'currently waiting on the liege, or the word was spoken from more than five squares away';

export const JOIN_SILENCE =
  'the liege said nothing the join quest says. The quest engine is silent when: the character ' +
  'is already in a faction, it tried a join in the last 24h of logged-in time ' +
  '(Q_PLAYER_NOTTRIED_RECENTLY — also true MID-QUEST: re-run with join_ask=<item or recipient>), ' +
  'it is not PK-enabled or under 40 base health (not "intriguing"), no join node is waiting on ' +
  'the liege, or the word was spoken from more than five squares away';

/**
 * WHERE TO LOOK FOR ONE TROOP, IN ORDER. The starting holdings first (the best single guess),
 * then every other wilderness flag room, nearest first. `etaMs` maps room -> estimated ms from
 * where the hunt sets out; unknown sorts last.
 */
export function huntOrder(target, etaMs = {}, { rooms = null, max = 8 } = {}) {
  const stage = Object.values(FACTION_SOLDIER).flatMap(f => f.stages)
    .find(s => lower(s.target) === lower(target));
  const defaults = rooms ?? stage?.rooms ?? [];
  const eta = r => (Number.isFinite(etaMs[r]) ? etaMs[r] : Infinity);
  const rest = (rooms ? [] : WILDERNESS_FLAG_ROOMS.filter(r => !defaults.includes(r)))
    .slice().sort((a, b) => eta(a) - eta(b));
  const first = [...defaults].sort((a, b) => eta(a) - eta(b));
  return [...first, ...rest].slice(0, Math.max(1, max));
}

/** The one letter the Princess just handed over: the id that was not in the pack before. */
export function newLetter(before = [], after = []) {
  const had = new Set(before.filter(i => lower(i.name) === 'letter').map(i => i.id));
  return after.find(i => lower(i.name) === 'letter' && !had.has(i.id)) ?? null;
}

// ---------------------------------------------------------------- the world-facing helpers

/** Every `message`/`said` line since `cursor`, plus the cursor to carry on from. */
async function proseSince(call, agent, cursor, ms) {
  const out = [], until = Date.now() + ms;
  let at = cursor;
  while (Date.now() < until) {
    const w = await call('wait_for_event',
      { agent, since: at, kinds: ['message', 'said'], timeout_ms: Math.min(4000, until - Date.now()) },
      60_000).catch(() => null);
    if (!w) break;
    if (w.cursor !== undefined) at = w.cursor;
    for (const e of (w.events ?? [])) if (e?.text) out.push(String(e.text));
    if (out.length && w.timed_out) break;
  }
  return { lines: out, cursor: at };
}

const cursorNow = (call, agent) =>
  call('wait_for_event', { agent, kinds: ['message'], timeout_ms: 1 }, 30_000)
    .then(w => w?.cursor ?? 0).catch(() => 0);

const packOf = async (call, agent) => {
  let r = await call('inventory', { agent }, 60_000).catch(() => null);
  // A pack read whose ids a save has just renumbered is not one to hand anything over from.
  for (let i = 0; i < 2 && r?.ids_stale === true; i++) {
    await new Promise(res => setTimeout(res, 2000));
    r = await call('inventory', { agent }, 60_000).catch(() => null);
  }
  return (r?.items ?? []).map(i => ({ id: i.id, name: String(i.name ?? ''), amount: i.amount ?? 1,
                                      in_use: i.in_use ?? i.equipped ?? false }));
};

/** Membership, read off the character's own profile. 'unknown' when nothing answered. */
async function membership(call, agent) {
  const r = await call('faction_status', { agent, refresh: true }, 40_000).catch(() => null);
  if (r?.faction && r.faction !== 'unknown') return { faction: r.faction, soldier: !!r.soldier, via: 'faction_status' };
  // The keeper-backed fallback: look at yourself and read the faction line the server appends.
  const me = await call('status', { agent }, 40_000).catch(() => null);
  const name = me?.name ?? me?.character ?? null;
  if (name) {
    const look = await call('look_at', { agent, target: name }, 30_000).catch(() => null);
    const text = [look?.extra, look?.description, look?.text].filter(Boolean).join('\n');
    if (text) return { faction: factionFromProfile(text), soldier: false, via: 'look_at' };
  }
  return { faction: 'unknown', soldier: false, via: null };
}

async function keeperAction(agent, name, args, timeoutMs = 20_000) {
  const keepers = await scanKeepers({ fleet: fleetName() });
  const who = keepers.get(agent);
  if (!who) return { error: `no keeper answered for ${agent} on this fleet's band` };
  const r = await fetch(`http://127.0.0.1:${who.port}/action`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, agent, character: who.character, keeper_pid: who.pid, args }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(e => ({ json: async () => ({ error: e.message }) }));
  return r.json().catch(() => ({ error: 'unreadable keeper reply' }));
}

/**
 * OFFER ONE ITEM TO ONE NPC AND PROVE IT LEFT THE PACK.
 *
 * Both ids resolved immediately before the send — the NPC from a fresh look, the item from a
 * fresh pack read (or the exact id handed in, for the Princess's letter). Accepted means the id
 * is GONE afterwards, read twice; a quest NPC that does not want it leaves a trade window open,
 * which is cancelled so the next merchant trip does not inherit it.
 */
async function offerToNpc({ agent, call }, { npcNames, itemName = null, itemId = null, cursor }) {
  const view = await call('look', { agent }, 30_000).catch(() => null);
  const wanted = npcNames.map(lower);
  const npc = (view?.objects ?? []).find(o => wanted.includes(lower(o.name)));
  if (!npc?.id) return { ok: false, why: `${npcNames[0]} is not in room ${view?.room?.num ?? '?'}` };
  const pack = await packOf(call, agent);
  const item = itemId != null
    ? pack.find(i => i.id === itemId)
    : (pack.find(i => lower(i.name) === lower(itemName) && !i.in_use) ??
       pack.find(i => lower(i.name) === lower(itemName)));
  if (!item) return { ok: false, why: `no ${itemName ?? `object ${itemId}`} in the pack to hand over` };
  if (item.in_use) return { ok: false, why: `the only ${item.name} is worn or wielded — take it off first ` +
                            `(and never if it is cursed)` };
  const sent = await keeperAction(agent, 'trade', { op: 'offer', to_id: npc.id, items: [item.id] });
  if (sent?.error) return { ok: false, why: `the keeper refused the offer: ${sent.error}` };
  const { lines, cursor: next } = await proseSince(call, agent, cursor, 6000);
  // A GEM IS A STACK. A bare id offers ONE of it (the keeper's trade note: the server reads a
  // quantity from the tag alone), and the quest node takes one with RemoveNumberItemFromPossession,
  // so the id survives with one fewer. Gone OR fewer is accepted.
  let gone = false;
  for (let i = 0; i < 3 && !gone; i++) {
    await new Promise(res => setTimeout(res, 1500));
    const still = (await packOf(call, agent)).find(i2 => i2.id === item.id);
    gone = !still || (Number(still.amount) || 1) < (Number(item.amount) || 1);
  }
  if (!gone) await keeperAction(agent, 'trade', { op: 'cancel' }).catch(() => null);
  return { ok: gone, item: item.name, item_id: item.id, to: npc.name, lines, cursor: next,
           why: gone ? undefined : `${npc.name} did not take the ${item.name}` };
}

// ---------------------------------------------------------------- the errand

const NEAR_NPC = 3;   // chebyshev 3 is squared <= 18, inside the quest node's 25 (disciple-quest.mjs)
const REPORT_LINE = 'It is done, my liege.';   // contains no trigger word, on purpose

export const script = {
  name: 'faction-shield',
  describe: "Join a faction if the character is neutral (doing the liege's join quest), then earn " +
            "its soldier shield by killing one soldier of each other army in the liege's order.",
  recipe: {
    effect: 'The character is a member of the chosen faction and carries its soldier shield ' +
            "(shield of the duke's army / princess' army / rebel militia).",
    run: 'faction-shield agents=<a> faction=duke|princess|jonas [only=shield] [resume=1|2] ' +
         '[join_ask=<item|recipient>] [home=<room>]',
    needs: ['maximum health of at least 75 (Q_R2_HAS_HEALTH_LEVEL — the game sets the floor)',
            'to JOIN as the Duke: a ruby in the pack (nobody sells one) — sapphire, emerald and ' +
              'diamond are bought if missing. As Jonas: every one of plate armor, helm, knight\'s ' +
              'shield, gauntlets, mystic sword and scimitar in the pack (none has a reliable ' +
              'seller). Or pass gamble=true to ask with partial cover. The Princess needs nothing',
            'shillings for one gem, if the Duke asks for one the pack lacks'],
    cost: {
      money: 'at most one gem (Duke). Nothing else',
      time: 'join: the liege, possibly a shop or a letter recipient, and back. Shield: two hunts ' +
            'across flag rooms and two returns to the liege',
      risk: 'SOLDIERS ARE LEVEL 70-145 AND HOSTILE TO ANY FACTION MEMBER, up to four a flag room. ' +
            'Plus ordinary road risk. A failed or abandoned quest locks a retry for 24h of ' +
            'logged-in time',
    },
    scales: 'One character at a time per liege (a gate): a quest node belongs to the first speaker.',
  },

  provenance: {
    pinned: 'b45576cd',
    verified: '2026-10-07 (offline only)',
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-factions.mjs', 'tools/m59-keeper-process.mjs',
              'tools/m59-broker.mjs'],
    refuseOnDrift: false,
  },

  params: {
    agents: { type: 'agents', required: true, describe: 'who joins / earns the shield' },
    faction: { required: true, describe: 'duke | princess | jonas (rebel)' },
    only: { default: 'all', describe: 'all = join if neutral, then the shield; shield = shield only' },
    resume: { type: 'number', describe: '1 or 2: skip saying "soldier" and hunt that stage — for a ' +
              'run that died or stopped mid-quest (the quest stays open 3h per stage)' },
    join_ask: { describe: 'resume a join already asked: the item the liege named (duke/jonas) or ' +
                'the letter recipient (princess)' },
    member: { describe: 'neutral | duke | princess | jonas — what the operator KNOWS the character is, ' +
              'used only when the profile read comes back empty' },
    gamble: { type: 'boolean', default: false, describe: 'ask to join even when not every possible ' +
              'ask is covered by the pack or a shop' },
    min_max_health: { type: 'number', default: 75, describe: 'refuse below this maximum health (Q_R2_HAS_HEALTH_LEVEL 75, the game sets it)' },
    max_rooms: { type: 'number', default: 8, describe: 'flag rooms to scout per soldier before giving up' },
    rooms: { describe: 'comma list of flag rooms to hunt in, overriding the search' },
    fights: { type: 'number', default: 4, describe: 'fight bursts per room before moving on' },
    rounds: { type: 'number', default: 40, describe: 'swings per fight burst' },
    abortBelow: { type: 'number', default: 0.5, describe: 'health fraction at which a fight gives up' },
    home: { type: 'number', describe: 'room to return to afterwards; omit to stay at the liege' },
    minHealth: { type: 'number', default: 0.6, describe: 'health fraction required to set out on a walk' },
    fleet: { default: null, describe: 'questbook to write into; defaults to the running fleet' },
  },

  async steps({ faction, only, resume, join_ask: joinAskArg, member: memberArg, gamble, min_max_health: minMax,
                max_rooms: maxRooms, rooms: roomsArg, fights, rounds, abortBelow, home,
                fleet: fleetArg }) {
    const key = factionKey(faction);
    if (!key) throw new Error(`faction-shield: unknown faction "${faction}" — duke, princess or jonas`);
    const spec = factionJoinSpec(key);
    const soldier = FACTION_SOLDIER[key];
    const fleet = fleetArg || fleetName();
    const shieldOnly = lower(only) === 'shield';
    const truthy = v => v === true || v === 'true';
    const resumeStage = Number(resume) === 1 || Number(resume) === 2 ? Number(resume) : null;
    const huntRoomsOverride = roomsArg
      ? String(roomsArg).split(',').map(Number).filter(Number.isFinite) : null;
    const maxR = Math.max(1, Number(maxRooms) || 8);
    const fightsPerRoom = Math.max(1, Number(fights) || 4);
    const minMaxHealth = Number(minMax) || 75;

    // EVERY ROOM ANY LEG COULD CHOOSE, declared up front so trapCheck sees the whole set.
    const huntRooms = huntRoomsOverride ?? [...new Set([
      ...soldier.stages.flatMap(s => s.rooms), ...WILDERNESS_FLAG_ROOMS])];
    const joinRooms = [...new Set(spec.assignments.map(a => a.room))];
    const shopRooms = [...new Set(Object.values(JOIN_SELLERS).flat().map(s => s.room))];
    const candidates = [...new Set([spec.room, ...joinRooms, ...shopRooms, ...huntRooms])];
    const liegeGate = `liege:${spec.room}`;

    // LOOK, THEN WALK, THEN CRAWL — the same ladder disciple-quest.mjs measured, for the same
    // reason: the node is deaf beyond five squares and `walk_to` alone wedges in big rooms.
    const closeOn = (who, label) => [
      verify(async ({ agent: me, call, state }) => {
        const want = who(state);
        state.near = null;
        if (!want) return { ok: true, skipped: `nothing to approach for ${label}` };
        const view = await call('look', { agent: me }, 30_000).catch(() => null);
        const at = findNpc(view, want);
        if (at.missing) return { ok: false, why: `${want} is not in room ${view?.room?.num ?? '?'} ` +
          `(saw: ${at.saw.join(', ') || 'nobody'})` };
        state.near = { ...at, room: Number(view?.room?.num ?? NaN) };
        return { ok: true, approaching: want, at: `r${at.row}c${at.col}` };
      }, `could not find the ${label}`),
      { ...walkTo(st => st.near?.col ?? null, st => st.near?.row ?? null,
                  { within: NEAR_NPC, deadlineMs: 120_000, stallMs: 25_000 }),
        room: st => st.near?.room ?? null, optional: true },
      crawlTo(st => st.near?.col ?? null, st => st.near?.row ?? null,
              { within: NEAR_NPC, optional: true, maxSteps: 60, deadlineMs: 180_000,
                room: st => st.near?.room ?? null }),
    ];

    const mark = verify(async ({ agent: me, call, state }) => {
      state.cursor = await cursorNow(call, me);
      return true;
    }, 'could not mark the message stream');

    const hear = async (call, me, state, ms) => {
      const { lines, cursor } = await proseSince(call, me, state.cursor ?? 0, ms);
      state.cursor = cursor;
      (state.heard ??= []).push(...lines);
      return lines;
    };

    const startedAt = Date.now();
    const transcript = (state, outcome, extra = {}) => {
      state.runId ??= runId({ agent: state.agent, quest: `faction-shield-${key}`, at: startedAt });
      try {
        return saveRun({ id: state.runId, at: new Date(startedAt).toISOString(), fleet,
          agent: state.agent, quest: `faction-shield-${key}`, faction: key, liege: spec.leader,
          member_before: state.memberBefore ?? null, join_ask: state.joinAsk ?? null,
          joined: state.joined ?? null, stages: state.stages ?? [], promoted: state.promoted ?? null,
          heard: (state.heard ?? []).slice(-80),
          steps: Object.entries(state.results ?? {}).map(([at, r]) => ({
            at, ok: r?.ok ?? null, why: r?.why ? String(r.why).slice(0, 300) : undefined })),
          outcome, ...extra }, { fleet });
      } catch (e) { return `UNWRITTEN (${e.message})`; }
    };

    // ------------------------------------------------------------ preflight
    const preflight = verify(async ({ agent: me, call, state }) => {
      state.agent = me;
      const o = await observe(me);
      state.here = o.room;
      if (!(o.maxHealth >= minMaxHealth))
        return { ok: false, why: `maximum health ${o.maxHealth ?? 'unreadable'} is under ${minMaxHealth} ` +
                 `(the soldier quest's own floor, Q_R2_HAS_HEALTH_LEVEL 75)` };
      const pack = await packOf(call, me);
      const names = pack.map(i => i.name);
      const m = await membership(call, me);
      if (m.faction === 'unknown' && memberArg)
        Object.assign(m, { faction: lower(memberArg) === 'neutral' ? 'neutral' : factionKey(memberArg) ?? 'unknown',
                           via: 'member= (operator)' });
      state.memberBefore = m.faction;
      state.hasShield = soldierFromInventory(key, pack);
      if (state.hasShield) return { ok: true, done: true, note: `already carries ${soldier.shield}` };
      if (['duke', 'princess', 'rebel'].includes(m.faction) && m.faction !== key)
        return { ok: false, why: `this character is already in the ${m.faction} faction — leaving one ` +
                 'is not something this script does' };
      if (m.faction === 'unknown')
        return { ok: false, why: 'could not read this character\'s faction (faction_status and a ' +
                 'self look both came back empty) — refusing rather than guessing. Pass member=neutral (or ' +
                 'the faction) if you know it' };
      state.needJoin = m.faction === 'neutral';
      if (state.needJoin && shieldOnly)
        return { ok: false, why: `only=shield, but the profile says neutral — join ${spec.title} first` };
      state.needShield = true;   // set only past the has-shield return above

      if (state.needJoin && joinAskArg) {
        // A join already asked: take the liege's answer from the operator rather than asking again.
        state.joinAsk = key === 'princess'
          ? spec.assignments.find(a => [a.target, ...(a.aliases ?? [])].some(n => lower(n) === lower(joinAskArg)))
          : spec.assignments.find(a => lower(a.item) === lower(joinAskArg));
        if (!state.joinAsk) return { ok: false, why: `join_ask "${joinAskArg}" is not something ${spec.leader} asks for` };
        state.resumedJoin = true;
      } else if (state.needJoin) {
        const cover = joinCoverage(key, names);
        state.cover = cover;
        if (cover.missing.length && !truthy(gamble))
          return { ok: false, cover, why: `${spec.leader} may ask for ${cover.missing.join(', ')}, which ` +
                   'the pack does not hold and no reliable shop sells. Asking and failing costs 24h of ' +
                   'logged-in time. Put them in the pack, or pass gamble=true' };
      }
      return { ok: true, member: m.faction, via: m.via, join: state.needJoin,
               ...(state.cover ? { cover: state.cover } : {}) };
    }, 'preflight');

    // ------------------------------------------------------------ half one: join
    // Already a soldier: every leg below resolves to nothing — a walk to where the body stands,
    // a gate with no key, a say with no text.
    const active = st => st.hasShield !== true;
    const stay = st => (active(st) ? spec.room : (st.here ?? spec.room));
    const needJoin = st => st.needJoin === true && !st.hasShield;
    const joinSteps = [
      // Everyone starts at the liege: the join asks there, and the shield asks there too. A
      // character that already carries the shield resolves every leg to where it stands.
      walk(stay, { candidates }),
      gate(st => (active(st) ? liegeGate : null), { timeoutMs: 20 * 60_000 }),
      ...closeOn(st => (needJoin(st) && !st.resumedJoin ? spec.leader : null), 'liege'),
      verify(async ({ agent: me, call, state }) => {
        state.lettersBefore = key === 'princess' ? await packOf(call, me) : [];
        state.cursor = await cursorNow(call, me);
        return true;
      }, 'could not mark the message stream'),
      say(st => (needJoin(st) && !st.resumedJoin ? 'join' : ''),
          { to: spec.leader, radius: QUEST_NPC_RADIUS, listenMs: 6000, optional: true }),
      verify(async ({ agent: me, call, state }) => {
        if (!needJoin(state)) return { ok: true, skipped: 'already a member' };
        if (state.resumedJoin) return { ok: true, resumed: state.joinAsk };
        const lines = await hear(call, me, state, 8000);
        state.joinAsk = readJoinAsk(key, lines);
        if (key === 'princess' && state.joinAsk) {
          const letter = newLetter(state.lettersBefore ?? [], await packOf(call, me));
          state.letterId = letter?.id ?? null;
        }
        state.transcript = transcript(state, 'in_progress');
        if (!state.joinAsk) return { ok: false, heard: lines.slice(0, 6), why: JOIN_SILENCE };
        return { ok: true, ask: state.joinAsk.item, to: state.joinAsk.target, room: state.joinAsk.room,
                 deadline: '1 hour' };
      }, 'could not read what the liege asked for'),
      ungate(liegeGate),

      // BUY IT, only when the pack lacks it and a counter sells it. Resolved to the liege's own
      // room (a no-op walk) whenever there is nothing to buy.
      verify(async ({ agent: me, call, state }) => {
        state.buy = null;
        if (!needJoin(state) || key === 'princess') return { ok: true, skipped: 'nothing to buy' };
        const item = state.joinAsk.item;
        if ((await packOf(call, me)).some(i => lower(i.name) === item && !i.in_use))
          return { ok: true, holding: item };
        const seller = JOIN_SELLERS[item]?.[0];
        if (!seller) return { ok: false, why: `${spec.leader} asked for ${item}, the pack has none and ` +
                              'nobody reliable sells one. The hour runs out on its own' };
        state.buy = { ...seller, item };
        return { ok: true, buy: item, at: `${seller.seller} (${seller.room})` };
      }, 'could not decide where to get the join item'),
      walk(st => st.buy?.room ?? stay(st), { candidates }),
      shop(st => st.buy?.seller ?? null,
           st => (st.buy ? [{ match: new RegExp(`^${st.buy.item}$`, 'i'), amount: 1 }] : []),
           { optional: true }),

      // HAND IT OVER — to the liege (duke, jonas) or to the letter's recipient (princess).
      walk(st => (needJoin(st) ? st.joinAsk?.room : null) ?? stay(st), { candidates }),
      gate(st => (needJoin(st) ? `npc:${st.joinAsk?.target ?? spec.leader}` : null), { timeoutMs: 20 * 60_000 }),
      ...closeOn(st => (needJoin(st) ? st.joinAsk?.target : null), 'join recipient'),
      mark,
      verify(async (ctx) => {
        const { state } = ctx;
        if (!needJoin(state)) return { ok: true, skipped: 'already a member' };
        const ask = state.joinAsk;
        const r = await offerToNpc(ctx, {
          npcNames: [ask.target, ...(ask.aliases ?? [])],
          ...(key === 'princess'
            ? (state.letterId != null ? { itemId: state.letterId } : { itemName: 'letter' })
            : { itemName: ask.item }),
          cursor: state.cursor,
        });
        state.cursor = r.cursor ?? state.cursor;
        (state.heard ??= []).push(...(r.lines ?? []));
        state.joined = r.ok && factionJoinConfirmed(r.lines ?? []);
        state.transcript = transcript(state, 'in_progress');
        if (!r.ok) return { ok: false, why: r.why };
        return { ok: true, handed: r.item, to: r.to, confirmed: state.joined };
      }, 'the join item was not accepted'),
      ungate(st => (needJoin(st) ? `npc:${st.joinAsk?.target ?? spec.leader}` : null)),

      // AND MEASURE IT. The membership sentence can be missed; the profile cannot lie about it.
      verify(async ({ agent: me, call, state }) => {
        if (!needJoin(state)) return { ok: true, skipped: 'already a member' };
        const m = await membership(call, me);
        if (m.faction !== key && !state.joined)
          return { ok: false, profile: m.faction, why: `the item was taken but the profile still ` +
                   `says ${m.faction} and no membership sentence was heard` };
        state.needJoin = false;
        return { ok: true, member: key, via: state.joined ? 'membership sentence' : m.via };
      }, 'not a member after the hand-over'),
    ];

    // ------------------------------------------------------------ half two: the shield
    const hunting = (st, n) => st.needShield && !st.promoted && st.stage?.n === n && !st.stage.killed;

    const huntStage = (n) => {
      const out = [
        verify(async ({ agent: me, call, state }) => {
          if (!(state.needShield && !state.promoted && state.stage?.n === n)) return { ok: true, skipped: true };
          const from = (await observe(me)).room ?? spec.room;
          const eta = {};
          for (const r of (huntRoomsOverride ?? huntRooms)) {
            const e = await call('travel_estimate', { from, to: r }, 15_000).catch(() => null);
            if (Number.isFinite(e?.ms)) eta[r] = e.ms;
          }
          state.stage.order = huntOrder(state.stage.target, eta, { rooms: huntRoomsOverride, max: maxR });
          return { ok: true, hunting: state.stage.target, order: state.stage.order };
        }, 'could not plan the hunt'),
      ];
      for (let i = 0; i < maxR; i++) {
        out.push(
          walk(st => (hunting(st, n) && st.stage.order?.[i]) || st.here || spec.room,
               { candidates, optional: true }),
          // SCOUT. A room is worth fighting in only when the exact troop is standing in it.
          verify(async ({ agent: me, call, state }) => {
            const view = await call('look', { agent: me }, 30_000).catch(() => null);
            state.here = Number(view?.room?.num ?? state.here);
            if (!hunting(state, n) || !state.stage.order?.[i]) { state.present = false; return { ok: true, skipped: true }; }
            const want = lower(state.stage.target);
            const count = (view?.objects ?? []).filter(o => lower(o.name) === want).length;
            state.present = count > 0;
            return { ok: true, room: state.here, [state.stage.target]: count };
          }, 'could not look around the flag room'),
        );
        for (let f = 0; f < fightsPerRoom; f++) {
          out.push(
            fight(st => (hunting(st, n) && st.present ? st.stage.target : null),
                  { rounds: Number(rounds) || 40, abortBelow: Number(abortBelow) || 0.5, optional: true }),
            // THE CORPSE, BY EXACT NAME. The keeper picks quarry by substring — "dead rebel soldier"
            // contains "rebel soldier" — and the quest compares the CLASS, so only an exact name counts.
            verify(async ({ state }) => {
              if (!(hunting(state, n) && state.present)) return { ok: true, skipped: true };
              const r = Object.entries(state.results).filter(([k]) => k.endsWith(':fight'))
                .map(([, v]) => v).pop()?.result ?? {};
              if (r.killed && lower(r.target_name) === lower(state.stage.target)) {
                state.stage.killed = true;
                (state.stages ??= []).push({ n, target: state.stage.target, room: state.here, at: Date.now() });
                return { ok: true, killed: state.stage.target, room: state.here };
              }
              if (!r.engaged && /nothing here matches/i.test(String(r.why ?? ''))) state.present = false;
              return { ok: true, killed: false, note: r.why ?? 'not dead yet' };
            }, 'could not read the fight'),
          );
        }
      }
      out.push(verify(async ({ state }) => {
        if (!(state.needShield && !state.promoted && state.stage?.n === n)) return { ok: true, skipped: true };
        if (state.stage.killed) return true;
        return { ok: false, why: `no ${state.stage.target} killed in ${state.stage.order?.length ?? 0} flag ` +
                 `room(s): ${state.stage.order?.join(', ')}. The stage stays open for 3h — re-run with ` +
                 `resume=${n}${huntRoomsOverride ? '' : ' and rooms=<flag rooms you know it holds>'}` };
      }, `stage ${n}: no soldier killed`));
      return out;
    };

    // Report to the liege and read what comes next: the second target, or the shield.
    const reportStage = (n) => {
      // Only the stage that has just been killed reports — a resume=2 run skips stage 1's report.
      const due = st => st.needShield && !st.promoted && st.stage?.n === n && st.stage.killed === true;
      return [
      walk(st => (due(st) ? spec.room : (st.here ?? spec.room)), { candidates }),
      gate(st => (due(st) ? liegeGate : null), { timeoutMs: 20 * 60_000 }),
      ...closeOn(st => (due(st) ? spec.leader : null), 'liege'),
      mark,
      say(st => (due(st) ? REPORT_LINE : ''),
          { to: spec.leader, radius: QUEST_NPC_RADIUS, listenMs: 6000, optional: true }),
      verify(async ({ agent: me, call, state }) => {
        if (!due(state)) return { ok: true, skipped: true };
        const lines = await hear(call, me, state, 8000);
        const pack = await packOf(call, me);
        if (readPromoted(key, lines, pack.map(i => i.name))) {
          state.promoted = soldierFromInventory(key, pack) || true;
          return { ok: true, promoted: true, shield: soldier.shield };
        }
        const next = readSoldierAsk(key, lines);
        if (n === 1 && next && next.stage_index === 1) {
          state.stage = { n: 2, target: next.target };
          return { ok: true, next: next.target };
        }
        return { ok: false, heard: lines.slice(0, 6), why: n === 1
          ? `${spec.leader} did not name the second soldier. If the kill was not by this character's ` +
            'own hand (or was a corpse, not the class), the stage is still open — re-run with resume=1'
          : `${spec.leader} did not hand over the shield — re-run with resume=2 if the kill stands` };
      }, `stage ${n}: the liege did not move the quest on`),
      ungate(liegeGate),
    ];
    };

    const shieldSteps = [
      walk(stay, { candidates }),
      gate(st => (active(st) ? liegeGate : null), { timeoutMs: 20 * 60_000 }),
      ...closeOn(st => (st.needShield && !st.promoted && !resumeStage ? spec.leader : null), 'liege'),
      mark,
      say(st => (st.needShield && !st.promoted && !resumeStage ? 'soldier' : ''),
          { to: spec.leader, radius: QUEST_NPC_RADIUS, listenMs: 6000, optional: true }),
      verify(async ({ agent: me, call, state }) => {
        if (!state.needShield) return { ok: true, skipped: 'already a soldier' };
        if (resumeStage) {
          state.stage = { n: resumeStage, target: soldier.stages[resumeStage - 1].target };
          return { ok: true, resumed: resumeStage, hunting: state.stage.target };
        }
        const lines = await hear(call, me, state, 8000);
        const ask = readSoldierAsk(key, lines);
        state.transcript = transcript(state, 'in_progress');
        if (!ask) return { ok: false, heard: lines.slice(0, 6), why: SOLDIER_SILENCE };
        state.stage = { n: ask.stage_index + 1, target: ask.target };
        return { ok: true, first: ask.target, then: soldier.stages[1].target, deadline: '3 hours per kill' };
      }, 'could not read what the liege asked for'),
      ungate(liegeGate),
      ...huntStage(1),
      ...reportStage(1),
      ...huntStage(2),
      ...reportStage(2),
      verify(async ({ agent: me, call, state }) => {
        if (!state.needShield) return true;
        const pack = await packOf(call, me);
        if (!soldierFromInventory(key, pack))
          return { ok: false, why: `the liege answered, but ${soldier.shield} is not in the pack` };
        return { ok: true, shield: soldier.shield };
      }, 'no shield in the pack'),
    ];

    return [
      preflight,
      ...joinSteps,
      ...shieldSteps,
      { ...ungate(liegeGate), always: true },
      ...(home === undefined || home === null ? [] : [{ ...walk(Number(home)), always: true }]),
      { ...verify(async ({ state }) => {
          const failed = Object.values(state.results ?? {}).find(r => r && r.ok === false);
          const outcome = state.hasShield || state.promoted ? 'ok' : failed ? 'failed' : 'unfinished';
          return { ok: true, outcome, transcript: transcript(state, outcome,
            failed?.why ? { why: String(failed.why).slice(0, 400) } : {}) };
        }, 'could not write the run transcript'), always: true },
    ];
  },
};
