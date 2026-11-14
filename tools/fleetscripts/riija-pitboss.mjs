// THE ORC PIT BOSS HEAD, FOR THE SWORD OF RIIJA: a team of four solves the pit chamber puzzle in the
// Orc Caves, kills the orc pit boss AND the body it leaves, picks up the "orc pit boss head", and
// deposits it in the island guild hall (713) where riija-quester draws it.
//
// PUBLIC, parameterised; the team is `agents`, in order -- no character is named here. Data and the
// puzzle arithmetic are tools/m59-riija.mjs (PIT, pitRoles); usage is docs/m59-riija-sword.md.
//
// THE PUZZLE (orcpitb.kod:199-245, orcpita.kod NumInChamber): somebody in chamber B of Brog's
// Antechamber (2508) pulls the lever at r48c29 (range 3, lever.kod:58-80). It solves when the users
// standing in chamber A of Grog's Antechamber (2507) and chamber B satisfy A*3 = B, A*2 = B or
// A*2 = B*3. Four bodies are 1 in A and 3 in B. The solve moves both chambers' floors for 60 s and
// resets the lever. EVERY user counts, strangers too.
//
// THE BOSS (orcboss.kod): level 115, difficulty 7, two strikes per swing, hyperaggressive, two orc
// wizard henchmen (orcpit1.kod SetupBossTemplates). Killing it leaves an OrcPitBossBody, a second,
// motionless, non-fighting monster of 100 hp (BossBody.kod); killing THAT drops the head on its square
// (CreateTreasure). The keeper's quarry match is a substring, and both are named "...orc pit boss",
// so one farm posture on "orc pit boss" covers both kills. The boss's own treasure table also holds a
// mystic sword -- the evil Wulfgang table's row -- so it is stowed too when it drops.
//
// WHY FARM POSTURE AND NOT A FIGHT STEP: a sequence cannot farm (m59-fleetscript.mjs, `harvest`); the
// keeper is the thing with the one-second clock. The posture is set, the body handed back, and the
// goal predicate is "the holder has the head".
//
// WHAT A LIVE TRIAL MUST CONFIRM BEFORE THIS IS TRUSTED -- none of it is in our map yet:
//   * that the chamber squares in m59-riija.mjs PIT are standable (they are inside the kod's bounds);
//     which floor heights let a body out is now MEASURED offline (m59-orc-pit-floors-test.mjs:
//     B leaves at 0/100/250, A only at 600 or 750 -- 'plain' strands A) and baked as door states
//     (m59-ceiling-doors.json), but the live floor packet and the fine exit are unconfirmed;
//   * that the keeper's engagement rules will fight a level-115 quarry at all (threat ceiling);
//   * that `loot` picks the head off the floor (it is an ordinary item with "get", bosshead.kod).
// Every one of those fails LOUDLY here (a refused walk, a harvest that times out, a pack without the
// head) and marks `abort`, so the rest of the team stops waiting instead of standing in a chamber.
import { walk, walkTo, crawlTo, verify, harvest } from '../m59-fleetscript.mjs';
import { depositWithRecovery } from '../m59-hall-access.mjs';
import { postureStep, restorePostureStep } from '../m59-errand-posture.mjs';
import { ROOMS, PIT, ITEMS, pitRoles, inChamber, onMarked, teamMark, teamRead, teamWait, teamForget } from '../m59-riija.mjs';
import { enterGrogsAntechamber, ordinaryHop } from '../m59-island-route.mjs';
import { readIslandFinePosition } from '../m59-island-finewalk.mjs';
import { leaveChamber, approachChamber, chamberReachers } from '../m59-orc-pit-exit.mjs';

// Every room on the way back to a chamber (approachChamber); a start anywhere else walks to 2501 first.
const APPROACH_ROOMS = [2500, 2501, 2502, 2506, 2507, 2508, 2509];
// orcpit1.kod:61 viBossResetTime = 20000 (overriding bossroom.kod's 30 min): once the boss is dead,
// the LAST user leaving 2506 starts a 20 s timer and the FIRST user entering after it resets the boss
// (bossroom.kod LastUserLeft / FirstUserEntered). Plus a margin for the clocks.
export const BOSS_RESET_WAIT_MS = 30_000;

const TAG = 'riija-pitboss';
const A = s => ({ ...s, anywhere: true });
const roomOf = v => Number(v?.room?.num ?? v?.room);
const list = v => [].concat(v ?? []).flatMap(a => String(a).split(/[\s,]+/)).map(s => s.trim()).filter(Boolean);
const count = (items, match) => (items ?? []).filter(i => match.test(String(i.name ?? ''))).reduce((n, i) => n + (Number(i.amount) || 1), 0);
// The boss area of 2506 is the north half: its east/west edges below row 42 lead to the antechambers,
// above it to the cave exits (orcpit1.kod CreateStandardExits); the boss stands at r24c41.
export const inBossArea = v => roomOf(v) === ROOMS.pit && Number(v?.you?.row) < 42;

export const script = {
  name: 'riija-pitboss',
  describe: 'A team of 3-5 solves the orc-pit chamber puzzle, kills the orc pit boss and its body, and stows the head in hall 713.',
  provenance: { pinned: '019bf448', verified: '2026-11-13', refuseOnDrift: false,
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-hall-access.mjs', 'tools/m59-riija.mjs', 'tools/m59-errand-posture.mjs',
      'tools/m59-island-route.mjs', 'tools/m59-island-finewalk.mjs', 'tools/m59-orc-pit-exit.mjs',
      'substrate/m59-ceiling-doors.json'] },
  recipe: {
    effect: 'An "orc pit boss head" in the holder\'s pack, then in the chests of hall 713 (and a mystic sword if one dropped).',
    run: 'riija-pitboss agents=<a>,<b1>,<b2>,<b3> [lever=<b1>] [holder=<a>] [stow=hall]',
    needs: ['four fighters able to survive a level-115 boss with two orc wizards (three or five also solve the ratio)',
      'no stranger standing in either chamber -- every user counts toward the ratio',
      'the holder: a member (rank sir+) of the guild that owns hall 713, or an ally, when stow=hall'],
    cost: { time: 'cave walk + puzzle + fight; the floors stay moved 60 s', risk: 'a boss fight; no live completion measured yet' },
    notes: ['The first agent stands in chamber A (2507), the rest in chamber B (2508).',
      'solution=squares (default) or plain -- plain raises chamber A to 900, which strands A (see PIT in tools/m59-riija.mjs).'],
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'the team, in order: the first goes to chamber A, the rest to chamber B' },
    lever: { type: 'string', default: '', describe: 'who pulls the lever (must be in chamber B; default the first B member)' },
    holder: { type: 'string', default: '', describe: 'who picks up and stows the head (default the first agent)' },
    solution: { type: 'string', default: 'squares', options: ['squares', 'plain'], describe: 'which chamber heights to ask for (squares: A 600 / B 250, both chambers reach 2506)' },
    stow: { type: 'string', default: 'hall', options: ['hall', 'carry'], describe: 'deposit the head in the hall, or keep it in the pack' },
    hall: { type: 'room', default: ROOMS.hall, describe: 'the hall to stow it in' },
    alsoStow: { type: 'string', default: 'mystic sword', describe: 'other boss loot to pick up and stow (comma list of names)' },
    waitMin: { type: 'number', default: 15, describe: 'how long a body waits at a barrier for the rest of the team' },
    fightMin: { type: 'number', default: 20, describe: 'minutes of farm posture on the boss' },
    mode: { type: 'string', default: 'puzzle', options: ['puzzle', 'reenter'], describe: 'puzzle: solve the chambers; reenter: from the lair or an antechamber north body, step out, wait for the boss reset, step back in' },
    after: { type: 'string', default: 'stay', options: ['stay', 'restore'], describe: 'stay: a body in 2506 at the end keeps its posture there (mode=reenter takes the next head); restore: put the old posture back' },
    resetWaitMs: { type: 'number', default: 30_000, describe: 'how long after the last body leaves 2506 to re-enter (boss reset is 20 s, orcpit1.kod:61)' },
    home: { type: 'room', default: 0, describe: 'where non-holders (and the holder, after stowing) walk afterwards (0 = stay)' },
    minHealth: { type: 'number', default: 0.9 },
    fleeBelow: { type: 'number', default: 0.3 }, restBelow: { type: 'number', default: 0.4 },
  },

  async steps(p) {
    const team = list(p.agents);
    const me = p.agent ?? team[0];
    const reenter = (p.mode ?? 'puzzle') === 'reenter';
    // Re-entry solves nothing, so any team size will do; every body steps out to 2507's north body.
    // room is where the posture holds the body while it waits OUT of the lair: 2507's north body.
    const roles = reenter ? team.map((agent, i) => ({ agent, side: 'A', room: ROOMS.pitA, row: 0, col: 0, lever: i === 0 }))
      : pitRoles(team, { lever: p.lever || null, solution: p.solution ?? 'squares' });
    const role = roles.find(r => r.agent === me);
    if (!role) throw Error(`${me} is not on the team ${team.join(',')}`);
    const puller = roles.find(r => r.lever).agent;
    const holder = p.holder || team[0];
    if (!team.includes(holder)) throw Error(`holder ${holder} is not on the team`);
    const key = `riija-pitboss:${team.join(',')}`;
    const waitMs = Number(p.waitMin) * 60_000;
    const extras = String(p.alsoStow ?? '').split(',').map(s => s.trim()).filter(Boolean);   // names have spaces: commas only
    const abort = (agent, why) => { teamMark(key, agent, 'abort', { why }); return { ok: false, why }; };
    const isHolder = me === holder;

    const steps = [
      A(verify(async ({ agent, state }) => {
        teamForget(key, agent);
        state.pitSince = teamMark(key, agent, 'start').at;
        return { ok: true, role: `${role.side === 'A' ? 'chamber A (2507)' : 'chamber B (2508)'} r${role.row}c${role.col}` +
          (role.lever ? ', pulls the lever' : '') + (isHolder ? ', holds the head' : '') };
      }, 'take a place on the team')),
      A(postureStep(TAG, role.room, { fleeBelow: p.fleeBelow, restBelow: p.restBelow, fightBack: true }, 'the pit chamber')),
      ...(reenter ? [
      // RE-ENTRY: the boss resets on the first entry 20 s after the last user left (orcpit1.kod:61),
      // and 2507's north body is one edge away and back (2506 west below row 42 / 2507 east). So no
      // puzzle: everyone steps out there, waits out the clock together, and walks back in.
      A(verify(async ctx => {
        const { agent, call } = ctx;
        const v = await call('look', { agent }, 30_000).catch(() => null);
        const room = roomOf(v), at = v?.you ?? {};
        const hop = ctx.pitHop ?? (to => ordinaryHop(ctx, to, { budgetMs: 120_000, recoverAtEntry: true }));
        if (room === ROOMS.pit) {
          const leg = await hop(ROOMS.pitA).catch(e => ({ ok: false, reason: e.message }));
          if (leg?.ok === false) return abort(agent, `out of the lair: ${leg.reason ?? 'hop failed'}`);
        } else if (![ROOMS.pitA, ROOMS.pitB].includes(room) ||
                   chamberReachers(room === ROOMS.pitA ? 'A' : 'B').has(`${at.row},${at.col}`))
          return abort(agent, `mode=reenter starts in 2506 or an antechamber's north body, not ${room} r${at.row}c${at.col}`);
        teamMark(key, agent, 'out');
        return { ok: true, out: 'of the lair' };
      }, 'out of the lair, so the boss can reset')),
      A(verify(async ({ agent, state }) => {
        const r = await teamWait(key, team, 'out', { since: state.pitSince ?? 0, budgetMs: waitMs });
        if (!r.ok) return abort(agent, r.why);
        const last = Math.max(...team.map(a => teamRead(key, a, 'out')?.at ?? 0));
        const wait = last + Number(p.resetWaitMs ?? BOSS_RESET_WAIT_MS) - Date.now();
        if (wait > 0) await new Promise(res => setTimeout(res, wait));
        return { ok: true, waited_ms: Math.max(0, wait) };
      }, 'the whole team out, then the boss reset clock')),
      walk(ROOMS.pit, { why: 'back into the lair; the first entry resets the boss' }),
      ] : [
      // BACK TO THE CHAMBER FROM WHEREVER THE LAST RUN LEFT THE BODY. Both antechambers drain into a
      // north body that reaches only the lair, and the lair's own exits drain to the caves, so the way
      // back is 2506 -> 2509 -> 2500 -> 2501, then 2501's north edge (B) or the Hollows transit (A).
      // `walk(2507)` from the lair landed Zoot in 2507's north body at r35c27 (2026-11-14), where no
      // walk reaches r83c25. approachChamber hops one room at a time until the body can walk there.
      walk(st => APPROACH_ROOMS.includes(st.startRoom) ? st.startRoom : 2501,
        { candidates: [2501, ...APPROACH_ROOMS], why: 'the way back to a chamber starts in the Orc Caves' }),
      verify(async ctx => {
        try {
          return await (ctx.pitApproach ?? approachChamber)(ctx, role.side, {
            look: () => ctx.call('look', { agent: ctx.agent }, 30_000),
            hop: to => ordinaryHop(ctx, to, { budgetMs: 240_000, recoverAtEntry: true }),
            transit: () => enterGrogsAntechamber(ctx, { budgetMs: 240_000, transit: ctx.hollowsTransit }) });   // undefined: the real admitted transit
        } catch (e) { return abort(ctx.agent, `back to chamber ${role.side}: ${e.message}`); }
      }, 'to a square that can walk to the chamber'),
      { ...walkTo(role.col, role.row, { within: 0, arriveWithin: 0, deadlineMs: 180_000, stallMs: 25_000 }), room: role.room, optional: true },
      crawlTo(role.col, role.row, { within: 0, optional: true, maxSteps: 40, deadlineMs: 240_000, room: role.room }),
      A(verify(async ({ agent, call }) => {
        const v = await call('look', { agent }, 30_000).catch(() => null);
        const at = v?.you;
        if (roomOf(v) !== role.room || !inChamber(at, role.side))
          return abort(agent, `not inside chamber ${role.side} of ${role.room} (at ${roomOf(v)} r${at?.row}c${at?.col})`);
        const wantMarked = PIT[role.side].marked.some(([r, c]) => r === role.row && c === role.col);
        if (wantMarked && !onMarked(at, role.side)) return abort(agent, `not on the marked square r${role.row}c${role.col}`);
        if ((p.solution ?? 'squares') === 'plain' && onMarked(at, role.side))
          return abort(agent, `standing on a marked square r${at.row}c${at.col}, which changes the solution`);
        teamMark(key, agent, 'ready', { row: at.row, col: at.col });
        return { ok: true, in_chamber: role.side, at: `r${at.row}c${at.col}` };
      }, 'in the chamber, on the planned square')),
      A(verify(async ({ agent, state }) => {
        const r = await teamWait(key, team, 'ready', { since: state.pitSince ?? 0, budgetMs: waitMs });
        return r.ok ? { ok: true, team: 'all in place' } : abort(agent, r.why);
      }, 'wait for the whole team to be in place')),
      // THE LEVER. Only the puller acts; the rest wait for its mark (and its receipt).
      A(verify(async ({ agent, call, state }) => {
        if (agent !== puller) {
          const r = await teamWait(key, [puller], 'lever', { since: state.pitSince ?? 0, budgetMs: waitMs });
          return r.ok ? { ok: true, lever: 'pulled' } : abort(agent, r.why);
        }
        const v = await call('look', { agent }, 30_000).catch(() => null);
        const lever = (v?.objects ?? []).find(o => /^lever$/i.test(String(o.name ?? '')));
        if (!lever) return abort(agent, 'no lever in sight in 2508');
        const cursor = (await call('wait_for_event', { agent, kinds: ['message'], timeout_ms: 1 }, 30_000).catch(() => null))?.cursor;
        await call('act', { agent, verb: 'activate', target: lever.id }, 30_000).catch(() => null);
        const got = cursor == null ? null : await call('wait_for_event', { agent, since: cursor, kinds: ['message'], timeout_ms: 5000 }, 30_000).catch(() => null);
        const lines = (got?.events ?? []).map(e => String(e.text ?? ''));
        // lever.kod: lever_changed / lever_not_in_range / lever_stuck (and DontInterfere for a body that cannot advance).
        if (!lines.some(l => /you switch the lever/i.test(l)))
          return abort(agent, `the lever did not switch: ${lines.slice(0, 2).join(' | ') || 'no reply'}`);
        teamMark(key, agent, 'lever');
        return { ok: true, lever: 'switched' };
      }, 'pull the lever (the puller), or wait for it')),
      // THROUGH, while the floors are moved (60 s, ResetPuzzle). Only leaving the chamber is on the
      // clock: wait for the server's floor packet, walk the fine chords planned on the solved floor
      // onto the spoke (tools/m59-orc-pit-exit.mjs), then an ordinary walk to 2506 from fixed floor.
      // Before 2026-11-14 this was `walk(2506)` alone, planned on the shipped chamber -- a pocket --
      // so every body walked out the long way and failed (live run 08:11Z).
      A(verify(async ctx => {
        try {
          return await (ctx.pitExit ?? leaveChamber)(ctx, role.side, p.solution ?? 'squares',
            { read: ctx.readFine ?? (() => readIslandFinePosition(ctx)) });
        } catch (e) { return abort(ctx.agent, `off chamber ${role.side}: ${e.message}`); }
      }, 'off the chamber onto its spoke while the floor is moved')),
      walk(ROOMS.pit, { why: 'the Lair of the Orc Pit Boss, from the spoke' }),
      ]),
      A(verify(async ({ agent, call, state }) => {
        const v = await call('look', { agent }, 30_000).catch(() => null);
        if (!inBossArea(v)) return abort(agent, `not in the boss area of 2506 (at ${roomOf(v)} r${v?.you?.row}c${v?.you?.col})`);
        teamMark(key, agent, 'inside');
        const r = await teamWait(key, team, 'inside', { since: state.pitSince ?? 0, budgetMs: 3 * 60_000 });
        return r.ok ? { ok: true, team: 'all inside' } : abort(agent, r.why);
      }, 'in the boss area, together')),
      // POINT THE KEEPER AT THE LAIR. Its posture still named the chamber's room, so whatever ran after
      // the fight -- the harvest handing the body back, a survive posture -- walked it 'home' to 2507,
      // which from here is the north body (Zoot at r35c27, 2026-11-14 09:58Z).
      A(postureStep(TAG, ROOMS.pit, { fleeBelow: p.fleeBelow, restBelow: p.restBelow, fightBack: true }, 'the boss lair')),
      // THE FIGHT: one posture covers the boss and the body it leaves ("...orc pit boss" both).
      { ...harvest({ quarry: ['orc pit boss'], room: ROOMS.pit, forMs: Number(p.fightMin) * 60_000,
        until: async ({ agent, call, state }) => {
          if ((teamRead(key, holder, 'head')?.at ?? -1) >= (state.pitSince ?? 0)) return { done: true };
          if (agent !== holder) return { done: false, note: 'waiting for the holder to pick up the head' };
          const pack = (await call('inventory', { agent }, 60_000).catch(() => null))?.items ?? [];
          if (count(pack, ITEMS.head.match)) { teamMark(key, agent, 'head'); return { done: true }; }
          const v = await call('look', { agent }, 30_000).catch(() => null);
          const head = (v?.objects ?? []).find(o => ITEMS.head.match.test(String(o.name ?? '')));
          if (head) await call('loot', { agent, ids: [head.id] }, 60_000).catch(() => null);
          return { done: false, note: head ? 'the head is on the floor; picking it up' : 'no head yet' };
        } }) },
      A(verify(async ({ agent, call }) => {
        if (!isHolder) return { ok: true, skipped: 'not the holder' };
        const v = await call('look', { agent }, 30_000).catch(() => null);
        for (const name of extras) {
          const it = (v?.objects ?? []).find(o => String(o.name ?? '').toLowerCase() === name.toLowerCase());
          if (it) await call('loot', { agent, ids: [it.id] }, 60_000).catch(() => null);
        }
        const pack = (await call('inventory', { agent }, 60_000).catch(() => null))?.items ?? [];
        const heads = count(pack, ITEMS.head.match);
        return heads ? { ok: true, head: heads, extras: extras.filter(n => count(pack, new RegExp(`^${n}$`, 'i'))) }
          : abort(agent, 'the boss posture ended and no orc pit boss head is in the holder\'s pack');
      }, 'the head (and any listed boss loot) is in the holder\'s pack')),
      A(verify(async ({ state }) => { state.postureRoom = null; return { ok: true }; }, 'the farm posture is over')),
    ];
    if (isHolder && p.stow !== 'carry') {
      const hall = Number(p.hall) || ROOMS.hall;
      steps.push(walk(hall, { why: 'stow the head where the quester draws it' }),
        A(verify(async ({ agent, call }) => {
          const r = await depositWithRecovery(call, agent, [ITEMS.head.name, ...extras]);
          const left = r.left ?? 0;
          return r.ok && left >= 1 ? { ok: true, stowed: left, hall } : { ok: false, why: `deposit in ${hall}: ${r.why ?? 'nothing left the pack'}` };
        }, 'deposit the head in the hall chests')));
    }
    // The marks are NOT forgotten here: an abort has to stay visible to bodies still waiting on it.
    // The next run's own start clears this agent, and `since` ignores everything older than that.
    // STAY OR RESTORE. A body still in the lair keeps the posture that holds it there (after=stay),
    // because the posture it came with may name a room it can only reach by a long walk, or never
    // (a chamber's room from here is its north body). mode=reenter then takes the next head.
    const restore = restorePostureStep(TAG);
    steps.push({ ...verify(async ctx => {
      if ((p.after ?? 'stay') === 'stay') {
        const v = await ctx.call('look', { agent: ctx.agent }, 30_000).catch(() => null);
        if (roomOf(v) === ROOMS.pit) return { ok: true, stayed: 'in the lair, posture held on 2506; mode=reenter takes the next head' };
      }
      return restore.fn(ctx);
    }, "could not put the keeper's posture back"), always: true });
    if (Number(p.home) > 0) steps.push({ ...walk(Number(p.home)), always: true });
    return steps;
  },
};
