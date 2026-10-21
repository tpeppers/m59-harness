// FARM PRISMS FROM THE WANDERERS' COURIER QUESTS: ASK, DELIVER, COME BACK, REPEAT FOR HOURS.
//
// PUBLIC. The derivation, with line citations, is
// `m59-research/reports/prism-and-necromancer-warning-quests.md` (pinned to Meridian59 d9d78a6e).
// The short version:
//
//   THE QUEST. Maleval (QST_ID_NECRO_WARNING, karma <= -10) or Parrin Aragone
//   (QST_ID_NECRO_WARNING_2, karma >= +10); both need a PK-enabled (non-newbie) character and an
//   hour of LOGGED-IN time since the last success or failure. Say "need a courier" within 5
//   squares of him. He hands over a letter (Maleval: "sinister parchment", Parrin: "letter") and
//   names ONE of four priestesses, once, in a private line. Give her THAT letter within 2 hours.
//   Then show up at the SAME wanderer, wherever he has moved to, within 4 hours -- say anything
//   within 5 squares -- and the prize is drawn there: 1 in 9 a prism (Maleval), 1 in 8 (Parrin);
//   otherwise shillings, silver arrows, or a wand of vampiric shock.
//
//   THE HARD PART IS HIM, NOT THE QUEST. He jumps between five rooms every 30-90 min. A player in
//   his room holds him for up to six of those ticks (3-9 h). So this script has two roles:
//
//     scouts    stand one to a room of his list (tools/m59-wanderers.mjs, closest first), which
//               keeps him held and the sightings ledger fresh for the whole run;
//     questers  loop: walk to wherever the ledger says he is (sweeping his rooms if nobody knows),
//               ask, deliver, come back, collect, then wait out the hour BESIDE him -- which also
//               holds him -- and ask again.
//
//   opportunistic=true makes a scout that is standing with him ask too, and run the quest itself
//   if he hands it one -- "whichever body is already in the room". It goes back to its post after.
//
//   With no scouts the questers sweep for themselves; it works, it is just slower on the return.
//   Every keeper on the fleet writes the NPCs it sees to the world book (m59-worldbook.mjs), so a
//   body that walks past him on another errand tells the questers too.
//
// THE KEEPER'S POSTURE is saved once, pointed at each leg's room, and put back at the end
// (m59-errand-posture.mjs), so no keeper walks a scout off its post or a quester out of a temple.
//
// RESUMABLE. An open quest (letter in the pack, priestess named, or delivered and owed a prize) is
// written to substrate/prism-quest-open-<agent>.json the moment it changes, and every cycle starts
// by reading it -- a stopped run, re-run, picks up where it was. Results append to
// substrate/prism-quest-results.jsonl, one line per prize.
import { readFileSync, writeFileSync, unlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { walk, verify, walkTo, crawlTo, call as fsCall } from '../m59-fleetscript.mjs';
import { scanKeepers } from '../m59-keeper.mjs';
import { asAgents } from '../m59-fleetlib.mjs';
import { fleetName } from '../m59-fleetpath.mjs';
import { findNpc, toTemple } from './disciple-quest.mjs';
import { WANDERERS, wandererKey, recordView, whereIs, searchOrder, assignPosts, watchSteps, bodiesOf, planOnce }
  from '../m59-wanderers.mjs';
import { postureStep, restorePostureStep } from '../m59-errand-posture.mjs';

// ---------------------------------------------------------------- the world, as data

// questengine.kod:661 (trigger), 725-737 and 898-911 (lines), 4581-4630 and 5124-5170 (nodes).
export const QUESTS = Object.freeze({
  maleval: {
    key: 'maleval', karma: 'evil (<= -10)', letter: 'sinister parchment',    // neclettr.kod:19
    assigned: /have need of a messenger/i,                                     // necrowarning_assign_2
    delivered: /tool of an unsound person/i,                                   // necrowarning_success_2
    paid: /returned to collect your reward/i,                                  // necrowarning_success_3
    pPrism: 1 / 9,
  },
  parrin: {
    key: 'parrin', karma: 'good (>= +10)', letter: 'letter',                  // ncwrnlet.kod:19
    assigned: /news of great urgency/i,                                        // necrowarning2_assign_2
    delivered: /rantings of a poor soul/i,                                     // necrowarning2_success_2
    paid: /She listens not/i,                                                  // necrowarning2_success_3
    pPrism: 1 / 8,
  },
});
const TRIGGER = 'need a courier';
const GREETING = 'Greetings.';             // contains no trigger of any quest on either wanderer

// The four priestess classes, one instance each (questengine.kod:4597-4603; rooms tempkra.kod:151,
// badland1.kod:56, temple.kod:116, tempqor.kod:140). The wanderer's line carries the NAME only.
export const PRIESTESSES = Object.freeze([
  { npc: "Qerti'nya", room: 801, where: 'Temple of Kraanan' },
  { npc: "Tenuv'vyal", room: 45, where: 'the Badlands -- a monster room' },
  { npc: 'Xiana', room: 48, where: "Temple of Shal'ille -- no door; the router's way in" },
  { npc: 'Zuxana', room: 802, where: 'Temple of Qor -- the lift from 598, door alternating every 10 min' },
]);
const PRIESTESS_ROOMS = PRIESTESSES.map(p => p.room);

const DELIVER_MS = 2 * 3600_000;           // questengine.kod:4597 / 5139 timelimit
const COLLECT_MS = 4 * 3600_000;           // :4624 / :5165
const NEAR_NPC = 3;                        // chebyshev 3 is squared <= 18, inside the node's 25

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lower = s => String(s ?? '').toLowerCase().trim();
const note = (agent, msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${agent} ${msg}`);
const roomOf = v => Number(v?.room?.num ?? v?.room ?? NaN);
const look = (call, agent) => call('look', { agent }, 30_000).catch(() => null);
const asList = x => (Array.isArray(x) ? x : String(x ?? '').split(',')).map(s => String(s).trim()).filter(Boolean);

// ---------------------------------------------------------------- on disk

const safe = s => String(s).replace(/[^a-z0-9]+/gi, '_');
const openFile = agent => join(process.cwd(), 'substrate', `prism-quest-open-${safe(agent)}.json`);
const OPEN = {
  get: agent => { try { return JSON.parse(readFileSync(openFile(agent), 'utf8')); } catch { return null; } },
  set: (agent, rec) => { try { writeFileSync(openFile(agent), JSON.stringify({ ...rec, saved: new Date().toISOString() }, null, 1)); } catch {} },
  clear: agent => { try { unlinkSync(openFile(agent)); } catch {} },
};
const RESULTS = () => join(process.cwd(), 'substrate', 'prism-quest-results.jsonl');
const logResult = row => { try { appendFileSync(RESULTS(), JSON.stringify(row) + '\n'); } catch {} };

// ---------------------------------------------------------------- world-facing helpers

async function packOf(call, agent) {
  let r = await call('inventory', { agent }, 60_000).catch(() => null);
  for (let i = 0; i < 2 && r?.ids_stale === true; i++) {
    await sleep(2000);
    r = await call('inventory', { agent }, 60_000).catch(() => null);
  }
  return (r?.items ?? []).map(i => ({ id: i.id, name: String(i.name ?? ''), amount: Number(i.amount ?? 1) || 1 }));
}
const tally = pack => pack.reduce((m, i) => m.set(lower(i.name), (m.get(lower(i.name)) ?? 0) + i.amount), new Map());
/** What `after` holds that `before` did not, by name and amount. */
function gained(before, after) {
  const a = tally(before), out = {};
  for (const [n, k] of tally(after)) if (k > (a.get(n) ?? 0)) out[n] = k - (a.get(n) ?? 0);
  return out;
}

async function proseSince(call, agent, cursor, ms) {
  const out = [], until = Date.now() + ms;
  let at = cursor;
  while (Date.now() < until) {
    const w = await call('wait_for_event',
      { agent, since: at, kinds: ['message', 'said'], timeout_ms: Math.min(4000, until - Date.now()) }, 60_000).catch(() => null);
    if (!w) break;
    if (w.cursor !== undefined) at = w.cursor;
    for (const e of (w.events ?? [])) if (e?.text) out.push(String(e.text));
    if (out.length && w.timed_out) break;
  }
  return { lines: out, cursor: at };
}
const cursorNow = (call, agent) =>
  call('wait_for_event', { agent, kinds: ['message'], timeout_ms: 1 }, 30_000).then(w => w?.cursor ?? 0).catch(() => 0);

// The broker's trade tool does not reach NPCs; the keeper's does (disciple-robes.mjs handIn).
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

/** Which priestess a line names, or null. Matched on her name anywhere in it (%NPC carries a title). */
const priestessIn = lines => {
  for (const l of lines) for (const p of PRIESTESSES) if (lower(l).includes(lower(p.npc))) return p;
  return null;
};

// ---------------------------------------------------------------- the steps
//
// WHICH QUEST IS A RUN-TIME FACT. A quester's is fixed by `questers`; an opportunist scout's is
// whichever wanderer walked into its room. So every builder below reads `state.q.key` rather
// than closing over one, and the walks name every room either wanderer could be in.

const Qof = st => QUESTS[st.q?.key] ?? null;
const Wof = st => WANDERERS[st.q?.key] ?? null;
const nameOf = st => Wof(st)?.npc ?? null;

/** Look, then close to within NEAR_NPC of `who(state)` -- skipped (optional) when it returns null. */
const closeOn = (who, label) => [
  verify(async ({ agent, call, state }) => {
    state.near = null;
    const name = who(state);
    if (!name) return { ok: true, skipped: 'nobody to approach' };
    const view = await look(call, agent);
    recordView(view, agent);
    const at = findNpc(view, name);
    if (at.missing) return { ok: true, missing: name, saw: at.saw };
    state.near = { ...at, room: roomOf(view) };
    return { ok: true, at: `r${at.row}c${at.col}` };
  }, `find ${label}`),
  { ...walkTo(st => st.near?.col ?? null, st => st.near?.row ?? null, { within: NEAR_NPC, deadlineMs: 90_000, stallMs: 20_000 }),
    room: st => st.near?.room ?? null, optional: true },
  crawlTo(st => st.near?.col ?? null, st => st.near?.row ?? null,
          { within: NEAR_NPC, optional: true, maxSteps: 40, deadlineMs: 120_000, room: st => st.near?.room ?? null }),
];

/** Where the next leg toward him starts: the fresh room, else the best room to search first. */
const wandererTarget = st => {
  if (!st.q?.key) return null;
  const f = whereIs(st.q.key);
  if (f.fresh && f.room) return f.room;
  const order = searchOrder(st.q.key, { from: st.q.here });
  return order.find(r => !(st.q.visited ?? []).includes(r)) ?? order[0];
};

/**
 * GET TO HIM. `slots` walk+look pairs: walk to where the world book says he is (fresh), else the
 * next room in search order not yet looked in on this leg. Stops walking once he is in view.
 * Only runs while `state.q.phase` is in `phases`.
 */
function reachWanderer(phases, slots, allRooms) {
  const active = st => phases.includes(st.q?.phase) && !st.q?.withHim;
  const steps = [verify(async ({ state }) => {
    if (state.q && phases.includes(state.q.phase)) { state.q.withHim = false; state.q.visited = []; }
    return { ok: true };
  }, 'set out for the wanderer')];
  for (let i = 0; i < slots; i++) {
    steps.push({ ...walk(st => (active(st) ? wandererTarget(st) : st.q?.here ?? null), { candidates: allRooms }), optional: true });
    steps.push({ ...verify(async ({ agent, call, state }) => {
      if (!active(state)) return { ok: true, skipped: true };
      const v = await look(call, agent);
      state.q.here = roomOf(v);
      const seen = recordView(v, agent);
      if (seen.includes(state.q.key)) { state.q.withHim = true; return { ok: true, with: nameOf(state), room: state.q.here }; }
      state.q.visited.push(state.q.here);
      if (state.q.visited.length >= Wof(state).rooms.length) state.q.visited = [];   // a full lap: start over
      return { ok: true, not_here: state.q.here };
    }, 'is he here?'), optional: true });
  }
  return steps;
}

const lastOf = agent => OPEN.get(`${agent}-last`)?.at ?? 0;

/** Wait out the cooldown beside him, then say the trigger until a quest is assigned. */
function ask({ askWaitMin, cooldownMin }) {
  return verify(async ({ agent, call, state }) => {
    const q = state.q;
    if (q.phase !== 'ask') return { ok: true, skipped: `phase is ${q.phase}` };
    const Q = Qof(state), npc = nameOf(state);
    if (!q.withHim) { q.phase = 'retry'; return { ok: true, retry: `${npc} not found this cycle` }; }
    const stillHere = async () => recordView(await look(call, agent), agent).includes(q.key);
    // THE HOUR. Logged-in time, which for a body online the whole run is wall time. Waiting here
    // also holds him (wanderer.kod:66-74).
    while (Date.now() < lastOf(agent) + cooldownMin * 60_000) {
      await sleep(30_000);
      if (!(await stillHere())) { q.phase = 'retry'; return { ok: true, retry: `${npc} left during the cooldown` }; }
    }
    const waitMin = q.opportunist ? Math.min(askWaitMin, 3) : askWaitMin;
    const until = Date.now() + waitMin * 60_000;
    let tries = 0;
    while (Date.now() < until) {
      tries++;
      const before = await packOf(call, agent);
      const cursor = await cursorNow(call, agent);
      await call('say', { agent, text: TRIGGER }, 30_000).catch(() => null);
      const { lines } = await proseSince(call, agent, cursor, 8000);
      const after = await packOf(call, agent);
      const letter = after.find(i => lower(i.name) === Q.letter && !before.some(b => b.id === i.id));
      if (letter || lines.some(l => Q.assigned.test(l))) {
        const dest = priestessIn(lines);
        q.phase = 'deliver';
        q.open = { phase: 'deliver', key: q.key, dest, letterId: letter?.id ?? null, assigned_at: Date.now(),
                   line: lines.find(l => Q.assigned.test(l)) ?? null };
        OPEN.set(agent, q.open);
        note(agent, `ASSIGNED by ${npc}: deliver to ${dest?.npc ?? 'UNHEARD priestess'} (${dest?.room ?? '?'})`);
        if (!dest) {
          // The name is said once. Without it the delivery is a guess over four temples; give up
          // this one rather than walk all four inside two hours. It fails at the deadline.
          q.phase = 'retry';
          return { ok: true, assigned: true, heard: lines.slice(0, 4),
                   why: 'the priestess name was not heard -- this quest will fail at its 2-hour deadline' };
        }
        return { ok: true, tries, dest: dest.npc, room: dest.room };
      }
      // Silence: still on cooldown, ineligible (karma, newbie), no waiting quest, or (Maleval, a
      // Hold-75 character) the Spore Burst learn quest took the sentence. Speak again later.
      await sleep(tries < 3 ? 30_000 : 150_000);
      if (!(await stillHere())) { q.phase = 'retry'; return { ok: true, retry: `${npc} left while we asked`, tries }; }
    }
    q.phase = 'retry';
    // An opportunist that is refused stops asking THIS wanderer for an hour -- it may simply not
    // qualify, and a scout that asks every poll is noise in his room.
    if (q.opportunist) (state.optOut ??= {})[q.key] = Date.now() + 61 * 60_000;
    return { ok: true, abandoned: true, tries,
             why: `${npc} assigned nothing in ${waitMin} min -- karma must be ${Q.karma}, the character must be PK-enabled, ` +
                  'and an hour of logged-in time must have passed since its last success or failure' };
  }, 'ask the wanderer for a courier job');
}

/** The leg to the priestess: a walk for three of them, the Qor lift for Zuxana. */
function toPriestess() {
  const going = st => st.q?.phase === 'deliver' && st.q.open?.dest;
  const steps = [{ ...walk(st => (going(st) && st.q.open.dest.room !== 802 ? st.q.open.dest.room : st.q?.here ?? null),
                           { candidates: PRIESTESS_ROOMS }), optional: true }];
  // toTemple(802), each step made conditional on actually going there.
  const to802 = st => going(st) && st.q.open.dest.room === 802;
  for (const s of toTemple(802)) {
    if (s.do === 'walk') steps.push({ ...s, to: st => (to802(st) ? 802 : st.q?.here ?? null), candidates: [802], optional: true });
    else if (s.do === 'verify') steps.push({ ...s, optional: true, fn: async (ctx) => (to802(ctx.state) ? s.fn(ctx) : { ok: true, skipped: true }) });
    else steps.push({ ...s, optional: true, ...(s.room != null ? { room: st => (to802(st) ? s.room : -1) } : {}) });
  }
  steps.push({ ...verify(async ({ agent, call, state }) => {
    if (!going(state)) return { ok: true, skipped: true };
    const v = await look(call, agent);
    state.q.here = roomOf(v);
    recordView(v, agent);
    return { ok: true, here: state.q.here };
  }, 'where am I'), optional: true });
  return steps;
}

function deliver() {
  return verify(async ({ agent, call, state }) => {
    const q = state.q;
    if (q.phase !== 'deliver') return { ok: true, skipped: `phase is ${q.phase}` };
    const Q = Qof(state), o = q.open;
    if (Date.now() > o.assigned_at + DELIVER_MS) {
      OPEN.clear(agent); OPEN.set(`${agent}-last`, { at: Date.now(), failed: 'delivery deadline' });
      q.phase = 'retry';
      return { ok: true, failed: 'the 2-hour delivery deadline passed -- an hour of lockout follows' };
    }
    const view = await look(call, agent);
    const npc = (view?.objects ?? []).find(x => lower(x.name).includes(lower(o.dest.npc)));
    if (!npc?.id) { q.phase = 'retry'; return { ok: true, retry: `${o.dest.npc} is not in room ${roomOf(view)} -- the open quest is kept; the next cycle tries again` }; }
    const pack = await packOf(call, agent);
    const item = pack.find(i => i.id === o.letterId) ?? pack.find(i => lower(i.name) === Q.letter);
    if (!item) { OPEN.clear(agent); q.phase = 'retry'; return { ok: true, failed: `no ${Q.letter} in the pack -- the quest cannot be finished` }; }
    const cursor = await cursorNow(call, agent);
    const sent = await keeperAction(agent, 'trade', { op: 'offer', to_id: npc.id, items: [item.id] });
    if (sent?.error) { q.phase = 'retry'; return { ok: true, retry: `the keeper refused the offer: ${sent.error}` }; }
    const { lines } = await proseSince(call, agent, cursor, 8000);
    await sleep(1500);
    const gone = !(await packOf(call, agent)).some(i => i.id === item.id);
    if (!gone) await keeperAction(agent, 'trade', { op: 'cancel' }).catch(() => null);
    if (!gone && !lines.some(l => Q.delivered.test(l))) {
      q.phase = 'retry';
      return { ok: true, retry: `${o.dest.npc} did not take the ${Q.letter}`, heard: lines.slice(0, 4) };
    }
    q.phase = 'collect';
    q.open = { ...o, phase: 'collect', delivered_at: Date.now() };
    OPEN.set(agent, q.open);
    note(agent, `DELIVERED to ${o.dest.npc}; back to ${nameOf(state)} within 4 h`);
    return { ok: true, delivered: o.dest.npc, line: lines.find(l => Q.delivered.test(l)) ?? null };
  }, 'give the letter to the priestess');
}

function collect(RUN) {
  return verify(async ({ agent, call, state }) => {
    const q = state.q;
    if (q.phase !== 'collect') return { ok: true, skipped: `phase is ${q.phase}` };
    const Q = Qof(state), npc = nameOf(state);
    if (Date.now() > (q.open.delivered_at ?? q.open.assigned_at) + COLLECT_MS) {
      OPEN.clear(agent); OPEN.set(`${agent}-last`, { at: Date.now(), failed: 'collect deadline' });
      q.phase = 'retry';
      return { ok: true, failed: `${npc} was not reached within 4 hours of the delivery` };
    }
    if (!q.withHim) return { ok: true, retry: `${npc} not found yet; the next cycle looks again` };
    for (let i = 0; i < 3; i++) {
      const before = await packOf(call, agent);
      const cursor = await cursorNow(call, agent);
      await call('say', { agent, text: GREETING }, 30_000).catch(() => null);
      const { lines } = await proseSince(call, agent, cursor, 8000);
      await sleep(1500);
      const prize = gained(before, await packOf(call, agent));
      if (Object.keys(prize).length || lines.some(l => Q.paid.test(l))) {
        const prism = Object.keys(prize).some(n => /\bprism\b/.test(n));
        OPEN.clear(agent); OPEN.set(`${agent}-last`, { at: Date.now(), prize });
        q.phase = 'done';
        RUN.completions++; if (prism) RUN.prisms++;
        logResult({ at: new Date().toISOString(), agent, wanderer: npc, priestess: q.open.dest?.npc, prize, prism,
                    opportunist: !!q.opportunist });
        note(agent, `${prism ? '*** PRISM ***' : 'PAID'} by ${npc}: ${JSON.stringify(prize)} (run: ${RUN.prisms} prism(s) in ${RUN.completions})`);
        return { ok: true, prize, prism, run_prisms: RUN.prisms, run_completions: RUN.completions };
      }
      await sleep(5000);
    }
    return { ok: true, retry: `${npc} paid nothing yet -- the quest stays open and the next cycle tries again` };
  }, 'collect from the wanderer');
}

/**
 * ONE CYCLE: ask -> deliver -> collect, each leg skipped unless the phase says so, and the
 * keeper's posture pointed at each leg's room first. `begin` decides the cycle's quest and phase.
 */
function cycleSteps({ begin, p, RUN, allRooms }) {
  const slots = Number(p.searchSlots);
  const pose = (roomOf, label) => postureStep(TAG, roomOf, { fleeBelow: p.fleeBelow, restBelow: p.restBelow }, label);
  return [
    begin,
    pose(st => (st.q?.phase === 'ask' ? wandererTarget(st) : null), 'the wanderer (ask)'),
    ...reachWanderer(['ask'], slots, allRooms),
    ...closeOn(st => (st.q?.phase === 'ask' && st.q.withHim ? nameOf(st) : null), 'the wanderer'),
    ask(p),
    pose(st => (st.q?.phase === 'deliver' ? st.q.open?.dest?.room ?? null : null), 'the priestess'),
    ...toPriestess(),
    ...closeOn(st => (st.q?.phase === 'deliver' ? st.q.open?.dest?.npc ?? null : null), 'the priestess'),
    deliver(),
    pose(st => (st.q?.phase === 'collect' ? wandererTarget(st) : null), 'the wanderer (collect)'),
    ...reachWanderer(['collect'], slots, allRooms),
    ...closeOn(st => (st.q?.phase === 'collect' && st.q.withHim ? nameOf(st) : null), 'the wanderer'),
    collect(RUN),
  ];
}

// ---------------------------------------------------------------- the script

const TAG = 'prism-quest';
const RUNS = new Map();
const runRecord = sig => {
  const old = RUNS.get(sig);
  if (!old || Date.now() - old.at > 60_000) RUNS.set(sig, { at: Date.now(), prisms: 0, completions: 0 });
  return RUNS.get(sig);
};
const truthy = v => /^(1|true|yes|on)$/i.test(String(v ?? ''));

/** "a:maleval,b:parrin,c" -> Map agent -> key (no suffix = the `npc` param). */
function parseQuesters(text, fallback) {
  const out = new Map();
  for (const s of asList(text)) {
    const [agent, npc] = s.split(':').map(x => x.trim());
    out.set(agent, wandererKey(npc || fallback));
  }
  for (const k of out.values()) if (!QUESTS[k]) throw new Error(`${k} gives no prism quest -- maleval or parrin`);
  return out;
}

export const script = {
  name: 'prism-quest',
  describe: "Loop Maleval's / Parrin's courier quest for hours: scouts hold the wanderer, questers ask, deliver and collect.",
  provenance: {
    pinned: '0203c2a2', verified: '2026-10-20',
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-broker.mjs', 'tools/m59-keeper-process.mjs',
              'tools/m59-wanderers.mjs', 'tools/m59-worldbook.mjs', 'tools/m59-errand-posture.mjs',
              'tools/fleetscripts/disciple-quest.mjs'],
    refuseOnDrift: false,          // free quest: a drifted run costs walking and an hour of lockout, not money
  },
  recipe: {
    effect: 'Each completion puts one prize in the quester\'s pack: a prism 1 in 9 (Maleval) or 1 in 8 (Parrin), ' +
            'otherwise 800-1600 shillings, silver arrows or a wand of vampiric shock. Prizes are logged to substrate/prism-quest-results.jsonl.',
    run: 'prism-quest agents=<q1,q2,s1,s2,...> questers=<q1:maleval,q2:parrin> [npc=maleval] [hours=24] ' +
         '[opportunistic=true] [stopOnPrism=false]',
    needs: ['quester: PK-enabled (guild, or base max health 30+), karma <= -10 for Maleval or >= +10 for Parrin',
            'scouts: any bodies -- every agent not named in questers is a scout and stands on the wanderer\'s rooms',
            'opportunistic=true: a scout standing with him asks too, and does the quest itself if he gives it one',
            'the questers\' walks reach the Temple of Kraanan, the Badlands (45), the Temple of Shal\'ille (48) and the Qor lift (802)'],
    cost: { money: 'none',
            time: 'one completion per quester per (60 min + about 15-40 min)',
            risk: 'the Badlands priestess stands in a monster room; the Assembly Chamber (852) has Princess guards; ' +
                  'Maleval fails a missed delivery with -2 Intellect for a day' },
    scales: 'Each quester adds about 12-16 completions a day; supply (20 waiting, one new per 5 min) never binds. ' +
            'One quester for 24 h: ~85% chance of at least one prism; 48 h: ~98%.',
    notes: ['The wanderer names the priestess once. If that line is lost the quest is left to fail rather than guessed.',
            'A character cannot do both: the karma gates are on opposite sides of zero.',
            'Every keeper writes the NPCs it sees to the fleet world book, so a quester also finds him through bodies not in this run.'],
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'every quester and scout' },
    questers: { required: true, describe: 'agent[:maleval|parrin], comma-separated; the rest of agents are scouts' },
    npc: { default: 'maleval', describe: 'the wanderer for questers named without one' },
    hours: { type: 'number', default: 24, describe: 'how long to keep cycling' },
    // No boolean param type in the loader: these arrive as STRINGS, and "false" is truthy.
    stopOnPrism: { default: 'false', describe: 'true = end every loop after the first prism of the run' },
    opportunistic: { default: 'false', describe: 'true = a scout standing with the wanderer takes the quest itself when he offers one' },
    scoutCount: { type: 'number', default: 0, describe: 'use only the N closest scouts (0 = all)' },
    askWaitMin: { type: 'number', default: 20, describe: 'per cycle, after the cooldown: how long a quester keeps asking (an opportunist: 3)' },
    cooldownMin: { type: 'number', default: 61, describe: 'minutes after a success or failure before asking again' },
    searchSlots: { type: 'number', default: 8, describe: 'rooms a quester may visit per search leg' },
    pollS: { type: 'number', default: 30, describe: 'scouts: seconds between looks' },
    minHealth: { type: 'number', default: 0.7, describe: 'health fraction required to set out on a walk' },
    fleeBelow: { type: 'number', default: 0.3, describe: "keeper flee point during the run (restored afterwards)" },
    restBelow: { type: 'number', default: 0.4, describe: "keeper rest point during the run (restored afterwards)" },
  },

  async steps(p) {
    const { agent } = p;
    const agents = asAgents(p.agents);
    const questers = parseQuesters(p.questers, p.npc);
    for (const q of questers.keys()) if (!agents.includes(q)) throw new Error(`quester ${q} is not in agents`);
    const keys = [...new Set(questers.values())];
    const allRooms = [...new Set(keys.flatMap(k => WANDERERS[k].rooms))];
    const sig = `prism|${agents.join(',')}|${p.questers}`;
    const RUN = runRecord(sig);
    const end = Date.now() + Number(p.hours) * 3600_000;
    const stopOnPrism = truthy(p.stopOnPrism);
    const over = () => Date.now() > end || (stopOnPrism && RUN.prisms > 0);
    const cycles = Math.min(200, Math.ceil(Number(p.hours)) + 2);
    const steps = [];

    // ---- a scout: stand on the wanderer(s)' rooms for the whole run.
    if (!questers.has(agent)) {
      const scouts = agents.filter(a => !questers.has(a));
      const plan = await planOnce(`${sig}|posts`, async () =>
        assignPosts(allRooms, await bodiesOf(fsCall, scouts), { count: Number(p.scoutCount) > 0 ? Number(p.scoutCount) : Infinity }));
      const route = plan.get(agent);
      if (!route) return [verify(async () => ({ ok: true, skipped: 'not among the closest scouts -- not needed' }), 'stand down')];
      steps.push(postureStep(TAG, route[0], { fleeBelow: p.fleeBelow, restBelow: p.restBelow }, `post ${route[0]}`));
      if (!truthy(p.opportunistic)) {
        steps.push(...watchSteps({ keys, route, mode: 'post', until: end, pollS: Number(p.pollS), label: `scout ${route.join('>')}` }));
        steps.push(restorePostureStep(TAG));
        return steps;
      }
      // OPPORTUNIST: post, and when he is standing here and this body is free to ask him, hand
      // off to one quest cycle; then back to the post. Rounds rather than one long watch, because
      // the steps are compiled up front.
      const ready = async ({ seen, state }) => {
        if (over()) return null;
        if (Date.now() < lastOf(agent) + Number(p.cooldownMin) * 60_000) return null;
        return seen.find(k => QUESTS[k] && !((state.optOut ?? {})[k] > Date.now())) ?? null;
      };
      for (let r = 1; r <= cycles; r++) {
        steps.push(postureStep(TAG, route[0], { fleeBelow: p.fleeBelow, restBelow: p.restBelow }, `post ${route[0]}`));
        steps.push(...watchSteps({ keys, route: [route[0]], mode: 'post', until: end, pollS: Number(p.pollS),
                                   label: `scout ${route[0]} (round ${r})`, breakWhen: ready }));
        steps.push(...cycleSteps({ p, RUN, allRooms, begin: verify(async ({ agent: me, call, state }) => {
          const open = OPEN.get(me);
          const handoff = state.watch?.handoff ?? null;
          if (state.watch) state.watch.handoff = null;
          const key = open?.key ?? handoff;
          state.q = { cycle: r, here: roomOf(await look(call, me)), open, key, withHim: false, visited: [], opportunist: true,
                      phase: over() || !key ? 'skip' : open?.phase ?? 'ask' };
          return { ok: true, round: r, phase: state.q.phase, ...(key ? { wanderer: WANDERERS[key].npc } : {}) };
        }, `round ${r}: did he come?`) }));
      }
      steps.push(restorePostureStep(TAG));
      return steps;
    }

    // ---- a quester: cycles of ask -> deliver -> collect.
    const key = questers.get(agent);
    for (let c = 1; c <= cycles; c++) {
      steps.push(...cycleSteps({ p, RUN, allRooms, begin: verify(async ({ agent: me, call, state }) => {
        const here = roomOf(await look(call, me));
        const open = OPEN.get(me);
        state.q = { cycle: c, here, open, key, withHim: false, visited: [],
                    phase: over() ? 'skip' : open?.phase && open.key === key ? open.phase : 'ask' };
        if (open && open.key !== key) return { ok: false, why: `${me} has an open ${open.key} quest -- run it as ${me}:${open.key}` };
        return { ok: true, cycle: c, phase: state.q.phase, ...(open ? { resumed: open.phase, dest: open.dest?.npc } : {}) };
      }, `cycle ${c}: what is open`) }));
    }
    steps.push({ ...verify(async ({ agent: me }) => {
      let rows = [];
      try { rows = readFileSync(RESULTS(), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.agent === me); } catch {}
      return { ok: true, run_prisms: RUN.prisms, run_completions: RUN.completions,
               lifetime: { completions: rows.length, prisms: rows.filter(r => r.prism).length }, open: OPEN.get(me) };
    }, 'tally'), always: true });
    steps.push(restorePostureStep(TAG));
    return steps;
  },
};
