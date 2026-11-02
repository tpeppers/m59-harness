// DO PARRIN'S JALA PUPIL QUEST (THE VOCAL AUDITION), THEN BUY EVERY LEVEL-1 JALA SONG.
//
// PUBLIC. The derivation, with line citations, is `m59-research/reports/jala-pupil-quests.md`
// (pinned to Meridian59 fe93b6c6). The short version:
//
//   THE GATE. Parrin Aragone sells truth, mirth and melancholy only to a character whose quest
//   history has QST_ID_TRUTH_SPELL succeeded (minstrel.kod:94-106). Before that they are simply
//   ABSENT from his shop list -- not refused. The fourth level-1 song, invigorate, is sold by
//   D'Franco at the Cibilo Creek Inn (Cor Noth, 153) only to someone who already knows ANY Jala
//   spell (cninnk.kod:64-93). So this quest is the only door into the school. 500 shillings a
//   song (spell.kod:350-363: 250 * 2^level).
//
//   THE QUEST, four nodes (questengine.kod:2801-2903), no karma, no PK gate, no fighting:
//     25  say "pupil" within 5 squares of Parrin.  He names ONE NPC, once, in a private line.
//     26  say anything CONTAINING "sings" to that NPC (2 days).  Six candidates, all in or near
//         Barloque except Rook in Cor Noth -- see SINGERS.
//     27  show up at Parrin again (2 hours) -- say anything.
//     28  he asks "Good or bad?" -- say "bad".  "good" starts a dead-end side branch (node 30)
//         that grants nothing; node 28 still waits for "bad".
//
//   THE HARD PART IS HIM. He jumps between five rooms every 30-90 min; a player in his room holds
//   him. The search is m59-wanderers.mjs's (fleet world book, then his rooms in search order), the
//   same one prism-quest.mjs uses.
//
// WHY A SWEEP AND NOT A GUESS when his line is missed: saying "sings" to the WRONG candidate does
// nothing at all, and all six stand in towns. So an unheard destination is not a lost quest, as it
// is in prism-quest -- the sing leg simply visits every candidate until one answers.
//
// THE PROBE IS FREE AND COMES FIRST. If any of the three songs is on his shop list the quest is
// already done (or not needed), and saying "pupil" again would be silence that looks like failure.
//
// RESUMABLE. An open quest (destination named, or sung and owed a visit) is written to
// substrate/jala-pupil-open-<agent>.json; a re-run picks up the leg it stopped on.
//
// NOT DONE HERE: an instrument. No Jala song casts without one (jala.kod:81-83). Parrin's lute quest
// (say "instrument") or Wulfgang zax'Ak at 2101 (10 000) -- see the report.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { walk, verify, walkTo, crawlTo, learn, carryAtLeast } from '../m59-fleetscript.mjs';
import { findNpc } from './disciple-quest.mjs';
import { WANDERERS, recordView, whereIs, searchOrder } from '../m59-wanderers.mjs';
import { postureStep, restorePostureStep } from '../m59-errand-posture.mjs';

// ---------------------------------------------------------------- the world, as data

const KEY = 'parrin';
const PARRIN = WANDERERS[KEY];                         // { npc: 'Parrin Aragone', rooms: [952,150,371,103,852] }
const TEACHER = 'Parrin';                              // the broker resolves sellers by substring

// questengine.kod:327-349. Matched on fragments that survive the client's ~I markup.
export const LINES = Object.freeze({
  assigned: /truly ready to learn the magic of songs of Jala/i,     // truthquest_assign_2
  sung: /that is awful/i,                                           // truthquest_success_2
  asked: /good or bad/i,                                            // truthquest_assign_4
  passed: /we shall work on that|open your mind to the ways of Jala/i, // truthquest_success_4
  honest: /being entirely honest with yourself/i,                   // truthquest_success_5 (the "good" dead end)
});
export const TRIGGER = 'pupil';                        // truthquest_trigger_1
// Node 26's cargo is "sings" and the match is a case-insensitive substring (questnode.kod:679), so
// the word must appear WITH the s. Kept free of every other trigger the candidates hold: Joguer
// answers "pupil" and "formula" for his Fade quest (questengine.kod:238-243).
export const SING_TEXT = 'La la la, the bard sings!';
const ANSWER = 'bad';                                  // truthquest_trigger_4. Never "good".
const GREETING = 'Greetings.';                         // no trigger of any Parrin quest

// Node 26's NPC list (questengine.kod:2812-2846) after SetQuestNodeNPCList drops MOB_NOQUEST
// (questengine.kod:6371-6377), which removes Obert Cair'bre the vaultman (bqvaultm.kod:51).
// Ordered as a sweep: the Barloque cluster first, Cor Noth last.
export const SINGERS = Object.freeze([
  { npc: 'Herbutte', room: 109, where: 'Barloque merchant' },
  { npc: 'Joguer', room: 104, where: 'Barloque apothecary' },
  { npc: 'Caramo', room: 970, where: 'Barloque court (clerk)' },
  { npc: 'Frular', room: 700, where: "Guild Masters' hall" },
  { npc: 'Madelia', room: 856, where: 'tailor, castle2e' },
  { npc: 'Rook', room: 154, where: 'Cor Noth weapon master' },
]);
const SING_ROOMS = SINGERS.map(s => s.room);

// Level-1 Jala (hinder/truth.kod:39, mirth.kod:40, melcholy.kod:40, invigor.kod:35).
export const PARRIN_SONGS = Object.freeze(['truth', 'mirth', 'melancholy']);
export const INVIGORATE = Object.freeze({ song: 'invigorate', teacher: "D'Franco", room: 153 });
export const SONG_PRICE = 500;

const SING_MS = 2 * 24 * 3600_000;                    // node 26, questengine.kod:2843
const REPORT_MS = 2 * 3600_000;                        // node 27, questengine.kod:2858
const NEAR_NPC = 3;                                    // chebyshev 3 is squared <= 18, inside the node's 25
const GATE_ROOMS = [...new Set([...PARRIN.rooms, ...SING_ROOMS, INVIGORATE.room])];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lower = s => String(s ?? '').toLowerCase().trim();
const roomOf = v => Number(v?.room?.num ?? v?.room ?? NaN);
const look = (call, agent) => call('look', { agent }, 30_000).catch(() => null);
const asList = x => (Array.isArray(x) ? x : String(x ?? '').split(',')).map(s => lower(s)).filter(Boolean);
const truthy = v => /^(1|true|yes|on)$/i.test(String(v ?? ''));

/** Which candidate a line names, or null. */
export const singerIn = lines => {
  for (const l of lines) for (const s of SINGERS) if (lower(l).includes(lower(s.npc))) return s;
  return null;
};

// ---------------------------------------------------------------- on disk

const safe = s => String(s).replace(/[^a-z0-9]+/gi, '_');
const openFile = agent => join(process.cwd(), 'substrate', `jala-pupil-open-${safe(agent)}.json`);
const OPEN = {
  get: agent => { try { return JSON.parse(readFileSync(openFile(agent), 'utf8')); } catch { return null; } },
  set: (agent, rec) => { try { writeFileSync(openFile(agent), JSON.stringify({ ...rec, saved: new Date().toISOString() }, null, 1)); } catch {} },
  clear: agent => { try { unlinkSync(openFile(agent)); } catch {} },
};

// ---------------------------------------------------------------- world-facing helpers

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

/** Say `text` and return what came back within `ms`. */
async function sayAndHear(call, agent, text, ms = 8000) {
  const cursor = await cursorNow(call, agent);
  await call('say', { agent, text }, 30_000).catch(() => null);
  return (await proseSince(call, agent, cursor, ms)).lines;
}

async function spellsKnown(call, agent) {
  const a = await call('abilities', { agent, kind: 'both', refresh: true }, 60_000).catch(() => null);
  return new Set((a?.spells ?? []).map(s => lower(s?.name)));
}

/** The free probe: the three gated songs on his list mean the quest is done. */
async function parrinOffers(call, agent) {
  const r = await call('shop', { agent, seller: TEACHER }, 60_000).catch(() => null);
  return (r?.items ?? []).map(i => lower(i.name)).filter(n => PARRIN_SONGS.includes(n));
}

// ---------------------------------------------------------------- the steps

const phaseIn = (st, ...ps) => ps.includes(st.q?.phase);

/** Look, then close to within NEAR_NPC of `who(state)`; nothing to approach = a walk to null, skipped. */
const closeOn = (who, label) => [
  { ...verify(async ({ agent, call, state }) => {
    state.near = null;
    const name = who(state);
    if (!name) return { ok: true, skipped: 'nobody to approach' };
    const view = await look(call, agent);
    recordView(view, agent);
    const at = findNpc(view, name);
    if (at.missing) return { ok: true, missing: name, saw: at.saw };
    state.near = { ...at, room: roomOf(view) };
    return { ok: true, at: `r${at.row}c${at.col}` };
  }, `find ${label}`), anywhere: true },
  // The gate for the approach (prism-quest.mjs, 2026-10-31): a null square is r0c0 to walk_to.
  { ...walk(st => st.near?.room ?? null, { candidates: GATE_ROOMS }), optional: true },
  { ...walkTo(st => st.near?.col ?? null, st => st.near?.row ?? null, { within: NEAR_NPC, deadlineMs: 90_000, stallMs: 20_000 }),
    room: st => st.near?.room ?? null, optional: true },
  crawlTo(st => st.near?.col ?? null, st => st.near?.row ?? null,
          { within: NEAR_NPC, optional: true, maxSteps: 90, deadlineMs: 480_000, room: st => st.near?.room ?? null }),
];

const parrinTarget = st => {
  const f = whereIs(KEY);
  if (f.fresh && f.room) return f.room;
  const order = searchOrder(KEY, { from: st.q?.here });
  return order.find(r => !(st.q?.visited ?? []).includes(r)) ?? order[0];
};

/** `slots` walk+look pairs toward Parrin, while the phase is one of `phases` and `need(state)` holds. */
function reachParrin(phases, slots, need = () => true) {
  const going = st => phases.includes(st.q?.phase) && need(st);
  const active = st => going(st) && !st.q?.withHim;
  const steps = [{ ...verify(async ({ state }) => {
    if (state.q && going(state)) { state.q.withHim = false; state.q.visited = []; }
    return { ok: true };
  }, 'set out for Parrin'), anywhere: true }];
  for (let i = 0; i < slots; i++) {
    steps.push({ ...walk(st => (active(st) ? parrinTarget(st) : null), { candidates: PARRIN.rooms }), optional: true });
    steps.push({ ...verify(async ({ agent, call, state }) => {
      if (!active(state)) return { ok: true, skipped: true };
      const v = await look(call, agent);
      state.q.here = roomOf(v);
      if (recordView(v, agent).includes(KEY)) { state.q.withHim = true; return { ok: true, with: PARRIN.npc, room: state.q.here }; }
      state.q.visited.push(state.q.here);
      if (state.q.visited.length >= PARRIN.rooms.length) state.q.visited = [];
      return { ok: true, not_here: state.q.here };
    }, 'is Parrin here?'), optional: true, anywhere: true });
  }
  return steps;
}

const stuck = (q, why) => { q.phase = 'stuck'; q.why = why; return { ok: true, stuck: why }; };

function probe() {
  return verify(async ({ agent, call, state }) => {
    const q = state.q;
    if (q.phase !== 'probe') return { ok: true, skipped: `phase is ${q.phase}` };
    if (!q.withHim) return stuck(q, `${PARRIN.npc} was not found in ${PARRIN.rooms.join(', ')} this run -- re-run, or post a body with find-wanderer first`);
    // Done = one of the gated songs is on his list, or already known (it can only have come from him).
    const offered = await parrinOffers(call, agent);
    if (offered.length || PARRIN_SONGS.some(s => q.known.has(s))) { q.phase = 'buy'; return { ok: true, quest: 'already done', offered }; }
    q.phase = 'ask';
    return { ok: true, quest: 'needed', offered };
  }, 'probe: is the quest already done?');
}

function ask({ askWaitMin }) {
  return verify(async ({ agent, call, state }) => {
    const q = state.q;
    if (q.phase !== 'ask') return { ok: true, skipped: `phase is ${q.phase}` };
    const stillHere = async () => recordView(await look(call, agent), agent).includes(KEY);
    const until = Date.now() + Number(askWaitMin) * 60_000;
    for (let tries = 1; Date.now() < until; tries++) {
      const lines = await sayAndHear(call, agent, TRIGGER);
      if (lines.some(l => LINES.assigned.test(l))) {
        const dest = singerIn(lines);
        q.open = { phase: 'sing', dest, assigned_at: Date.now(), line: lines.find(l => LINES.assigned.test(l)) };
        OPEN.set(agent, q.open);
        q.phase = 'sing';
        return { ok: true, tries, dest: dest?.npc ?? 'UNHEARD -- every candidate will be tried', room: dest?.room ?? null };
      }
      await sleep(tries < 3 ? 30_000 : 150_000);
      if (!(await stillHere())) return stuck(q, `${PARRIN.npc} left while we asked -- re-run`);
    }
    return stuck(q, `${PARRIN.npc} assigned nothing in ${askWaitMin} min. Silence means: failed within the last hour ` +
                    'of LOGGED-IN time, anonymous or morphed, or (rarely) no audition waiting. Not "already done": the probe ruled that out.');
  }, 'say "pupil"');
}

/** One candidate's leg of the sing sweep. Runs only while singing and only for the named NPC (or all, if unheard). */
function singAt(s) {
  const mine = st => phaseIn(st, 'sing') && (!st.q.open?.dest || st.q.open.dest.npc === s.npc)
                     && !(st.q.tried ?? []).includes(s.npc);
  return [
    { ...walk(st => (mine(st) ? s.room : null), { candidates: SING_ROOMS }), optional: true },
    ...closeOn(st => (mine(st) ? s.npc : null), s.npc),
    { ...verify(async ({ agent, call, state }) => {
      const q = state.q;
      if (!mine(state)) return { ok: true, skipped: true };
      (q.tried ??= []).push(s.npc);
      if (Date.now() > q.open.assigned_at + SING_MS) { OPEN.clear(agent); return stuck(q, 'the 2-day deadline to sing passed -- an hour of logged-in lockout follows'); }
      if (!state.near) return { ok: true, missing: s.npc, note: `${s.npc} is not in room ${s.room}` };
      const lines = await sayAndHear(call, agent, SING_TEXT);
      if (!lines.some(l => LINES.sung.test(l))) return { ok: true, sung: false, to: s.npc, heard: lines.slice(0, 3) };
      q.open = { ...q.open, phase: 'report', dest: s, sung_at: Date.now() };
      OPEN.set(agent, q.open);
      q.phase = 'report';
      return { ok: true, sung: true, to: s.npc, next: `back to ${PARRIN.npc} within 2 hours` };
    }, `sing to ${s.npc}`), anywhere: true },
  ];
}

function report() {
  return verify(async ({ agent, call, state }) => {
    const q = state.q;
    if (q.phase !== 'report') return { ok: true, skipped: `phase is ${q.phase}` };
    if (Date.now() > q.open.sung_at + REPORT_MS) { OPEN.clear(agent); return stuck(q, `${PARRIN.npc} was not reached within 2 hours of singing -- the audition failed`); }
    if (!q.withHim) return stuck(q, `${PARRIN.npc} not found yet; ${Math.round((q.open.sung_at + REPORT_MS - Date.now()) / 60_000)} min left -- re-run to resume`);
    const heard = [];
    for (let i = 0; i < 3; i++) {
      // Node 27 completes on any speech (or on walking in); node 28 is then assigned and wants "bad".
      heard.push(...await sayAndHear(call, agent, GREETING, 5000));
      heard.push(...await sayAndHear(call, agent, ANSWER, 8000));
      if (heard.some(l => LINES.passed.test(l))) break;
      await sleep(5000);
    }
    const passed = heard.some(l => LINES.passed.test(l)) || (await parrinOffers(call, agent)).length > 0;
    if (!passed) return stuck(q, `${PARRIN.npc} did not accept the report; the open quest is kept -- re-run to try again`);
    OPEN.clear(agent);
    q.phase = 'buy';
    return { ok: true, passed: true };
  }, 'report back: "bad"');
}

// ---------------------------------------------------------------- the script

const TAG = 'jala-pupil';

export const script = {
  name: 'jala-pupil',
  describe: "Do Parrin's Jala pupil quest (the vocal audition), then buy the level-1 Jala songs from him and D'Franco.",
  provenance: {
    pinned: 'f2346136', verified: '2026-11-01',
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-broker.mjs', 'tools/m59-keeper-process.mjs',
              'tools/m59-wanderers.mjs', 'tools/m59-worldbook.mjs', 'tools/m59-errand-posture.mjs',
              'tools/fleetscripts/disciple-quest.mjs'],
    refuseOnDrift: false,          // the quest is free; the buys go through `learn`, which guards the money itself
  },
  recipe: {
    effect: 'The character passes QST_ID_TRUTH_SPELL (permanently) and holds truth, mirth, melancholy and invigorate.',
    run: 'jala-pupil agents=<a> [songs=truth,mirth,melancholy] [invigorate=true] [home=<room>] [bankRoom=54]',
    needs: ['500 shillings per song not already known (2000 for all four); withdrawn at bankRoom only when short',
            'one free learn point per song (16 + 2*int/5 total) -- a full budget leaves the song off the list',
            'walks to Parrin (952, 150, 371, 103, 852), Barloque (109, 104, 970, 700), 856, Cor Noth (154, 153)'],
    cost: { money: `${SONG_PRICE} per song`, time: 'find Parrin + one Barloque/Cor Noth round trip; most of it is the search',
            risk: 'town rooms only; the Assembly Chamber (852) has Princess guards' },
    scales: 'Once per character, ever. Bodies already posted on Parrin (find-wanderer mode=post) make the search instant.',
    notes: ['Never answers "good": that branch grants nothing.',
            'The songs need an instrument to cast (jala.kod:81-83); this does not get one.'],
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'who learns' },
    songs: { default: PARRIN_SONGS.join(','), describe: "Parrin's songs to buy: any of truth, mirth, melancholy (empty = quest only)" },
    invigorate: { default: 'true', describe: "true = also buy invigorate from D'Franco in Cor Noth (153)" },
    home: { type: 'number', default: 0, describe: 'room to walk back to at the end (0 = stay)' },
    bankRoom: { type: 'number', default: 54, describe: 'bank to withdraw from if the purse is short' },
    askWaitMin: { type: 'number', default: 10, describe: 'how long to keep saying "pupil" before giving up' },
    searchSlots: { type: 'number', default: 8, describe: 'rooms visited per search for Parrin' },
    minHealth: { type: 'number', default: 0.7, describe: 'health fraction required to set out on a walk' },
    fleeBelow: { type: 'number', default: 0.3, describe: 'keeper flee point during the run (restored afterwards)' },
    restBelow: { type: 'number', default: 0.4, describe: 'keeper rest point during the run (restored afterwards)' },
  },

  async steps(p) {
    const songs = asList(p.songs);
    for (const s of songs) if (!PARRIN_SONGS.includes(s)) throw new Error(`Parrin does not sell "${s}" at level 1 -- ${PARRIN_SONGS.join(', ')}`);
    const wantInvigorate = truthy(p.invigorate);
    const slots = Number(p.searchSlots);
    const bankRoom = Number(p.bankRoom);
    const fullCost = SONG_PRICE * (songs.length + (wantInvigorate ? 1 : 0));
    const pose = (to, label) => postureStep(TAG, to, { fleeBelow: p.fleeBelow, restBelow: p.restBelow }, label);
    const atParrin = st => (phaseIn(st, 'probe', 'ask', 'report') ? parrinTarget(st) : null);
    const buyHere = st => phaseIn(st, 'buy') && songs.some(s => !st.q.known.has(s));

    const steps = [
      // ---- what is already true: songs known, an open quest on disk.
      { ...verify(async ({ agent, call, state }) => {
        const known = await spellsKnown(call, agent);
        let open = OPEN.get(agent);
        if (open?.phase === 'sing' && Date.now() > open.assigned_at + SING_MS) { OPEN.clear(agent); open = null; }
        if (open?.phase === 'report' && Date.now() > open.sung_at + REPORT_MS) { OPEN.clear(agent); open = null; }
        const wanted = [...songs, ...(wantInvigorate ? [INVIGORATE.song] : [])];
        // Knowing any of Parrin's three proves the audition is passed; nothing else does.
        const phase = open?.phase
          ?? (wanted.length && wanted.every(s => known.has(s)) ? 'done'
            : PARRIN_SONGS.some(s => known.has(s)) ? 'buy' : 'probe');
        state.q = { key: KEY, songs, known, open, withHim: false, visited: [], here: roomOf(await look(call, agent)), phase };
        return { ok: true, phase, known: [...PARRIN_SONGS, INVIGORATE.song].filter(s => known.has(s)),
                 ...(open ? { resumed: open.phase, dest: open.dest?.npc ?? null } : {}) };
      }, 'what is already done'), anywhere: true },

      // ---- Parrin: probe, then "pupil".
      pose(atParrin, PARRIN.npc),
      ...reachParrin(['probe'], slots),
      ...closeOn(st => (phaseIn(st, 'probe') && st.q.withHim ? PARRIN.npc : null), PARRIN.npc),
      { ...probe(), anywhere: true },
      { ...ask(p), anywhere: true },

      // ---- the named NPC (or, unheard, each candidate in turn): "...sings...".
      pose(st => (phaseIn(st, 'sing') ? st.q.open?.dest?.room ?? SING_ROOMS[0] : null), 'the audience'),
      ...SINGERS.flatMap(singAt),
      { ...verify(async ({ state }) => {
        if (!phaseIn(state, 'sing')) return { ok: true, skipped: true };
        return stuck(state.q, `nobody of ${(state.q.tried ?? []).join(', ')} answered "${SING_TEXT}" -- the open quest is kept; re-run to retry`);
      }, 'did anybody hear the song?'), anywhere: true },

      // ---- back to Parrin: any speech, then "bad".
      pose(atParrin, `${PARRIN.npc} (report)`),
      ...reachParrin(['report'], slots),
      ...closeOn(st => (phaseIn(st, 'report') && st.q.withHim ? PARRIN.npc : null), PARRIN.npc),
      { ...report(), anywhere: true },

      // ---- money, only when short. The walk is the gate: no bank trip, no withdrawal.
      { ...verify(async ({ agent, call, state }) => {
        state.bank = false;
        if (!phaseIn(state, 'buy')) return { ok: true, skipped: true };
        const inv = await call('inventory', { agent }, 60_000).catch(() => null);
        const purse = (inv?.items ?? []).filter(i => /shilling/i.test(String(i.name))).reduce((n, i) => n + (Number(i.amount) || 0), 0);
        const owed = SONG_PRICE * (songs.filter(s => !state.q.known.has(s)).length
                                   + (wantInvigorate && !state.q.known.has(INVIGORATE.song) ? 1 : 0));
        state.bank = purse < owed;
        return { ok: true, purse, owed, bank: state.bank };
      }, 'enough money?'), anywhere: true },
      { ...walk(st => (phaseIn(st, 'buy') && st.bank ? bankRoom : null), { candidates: [bankRoom] }), optional: true },
      carryAtLeast(fullCost),

      // ---- buy from Parrin. The gate walk is to the room he was just found in; not buying = null = skipped,
      // and every `learn` behind it with it.
      pose(st => (buyHere(st) ? parrinTarget(st) : null), `${PARRIN.npc} (buy)`),
      ...reachParrin(['buy'], slots, buyHere),
      ...closeOn(st => (buyHere(st) && st.q.withHim ? PARRIN.npc : null), PARRIN.npc),
      { ...walk(st => (buyHere(st) && st.near ? st.near.room : null), { candidates: PARRIN.rooms }), optional: true },
      ...songs.map(s => learn(TEACHER, s)),

      // ---- invigorate: D'Franco teaches it to anyone who now knows a Jala song.
      { ...verify(async ({ agent, call, state }) => {
        if (!phaseIn(state, 'buy')) return { ok: true, skipped: true };
        state.q.known = await spellsKnown(call, agent);
        state.q.invigorate = wantInvigorate && !state.q.known.has(INVIGORATE.song)
          && PARRIN_SONGS.some(s => state.q.known.has(s));
        return { ok: true, invigorate: state.q.invigorate };
      }, 'invigorate next?'), anywhere: true },
      ...(wantInvigorate ? [
        { ...walk(st => (st.q?.invigorate ? INVIGORATE.room : null), { candidates: [INVIGORATE.room] }), optional: true },
        learn(INVIGORATE.teacher, INVIGORATE.song),
      ] : []),

      // ---- the answer, whatever happened.
      { ...verify(async ({ agent, call, state }) => {
        const q = state.q ?? {};
        const known = await spellsKnown(call, agent);
        const wanted = [...songs, ...(wantInvigorate ? [INVIGORATE.song] : [])];
        const missing = wanted.filter(s => !known.has(s));
        if (q.phase === 'stuck') return { ok: false, why: q.why, open: OPEN.get(agent) };
        if (missing.length) return { ok: false, phase: q.phase,
          why: `still missing ${missing.join(', ')}` +
               (q.phase === 'buy' && songs.some(s => missing.includes(s)) && !q.withHim ? ` -- ${PARRIN.npc} was not found to buy from` : '') +
               (missing.includes(INVIGORATE.song) && !PARRIN_SONGS.some(s => known.has(s)) ? " -- D'Franco teaches invigorate only to a character who already knows a Jala song" : '') };
        return { ok: true, learned: wanted };
      }, 'the pupil quest or the purchases did not finish'), always: true },
      restorePostureStep(TAG),
    ];
    if (Number(p.home) > 0) steps.push({ ...walk(Number(p.home)), always: true });
    // THE RUNNER'S SKIP RULE: an optional walk that is skipped takes every following step up to the
    // next walk unless it is `anywhere` (m59-fleetscript.mjs). Every step here gates itself on
    // `state.q`, so all of them are `anywhere` EXCEPT the ones that must stand in the room of the walk
    // before them: the approaches, the bank withdrawal, and the purchases.
    const BOUND = ['walk', 'walk_to', 'crawl_to', 'learn', 'carry_at_least'];
    return steps.map(s => (BOUND.includes(s.do) ? s : { ...s, anywhere: true }));
  },
};
