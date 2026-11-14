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
//   * that the chamber squares in m59-riija.mjs PIT are standable (they are inside the kod's bounds;
//     walkability is unmeasured), and which floor heights let a body walk on to 2506 -- the moving
//     SOLUTIONSECTOR is not baked into substrate/m59-variable-sectors.json, so `walk(2506)` from a
//     chamber may be refused by the router even while the floor is up;
//   * that the keeper's engagement rules will fight a level-115 quarry at all (threat ceiling);
//   * that `loot` picks the head off the floor (it is an ordinary item with "get", bosshead.kod).
// Every one of those fails LOUDLY here (a refused walk, a harvest that times out, a pack without the
// head) and marks `abort`, so the rest of the team stops waiting instead of standing in a chamber.
import { walk, walkTo, crawlTo, verify, harvest } from '../m59-fleetscript.mjs';
import { depositWithRecovery } from '../m59-hall-access.mjs';
import { postureStep, restorePostureStep } from '../m59-errand-posture.mjs';
import { ROOMS, PIT, ITEMS, pitRoles, inChamber, onMarked, teamMark, teamRead, teamWait, teamForget } from '../m59-riija.mjs';
import { enterGrogsAntechamber } from '../m59-island-route.mjs';

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
      'tools/m59-island-route.mjs', 'tools/m59-island-finewalk.mjs'] },
  recipe: {
    effect: 'An "orc pit boss head" in the holder\'s pack, then in the chests of hall 713 (and a mystic sword if one dropped).',
    run: 'riija-pitboss agents=<a>,<b1>,<b2>,<b3> [lever=<b1>] [holder=<a>] [stow=hall]',
    needs: ['four fighters able to survive a level-115 boss with two orc wizards (three or five also solve the ratio)',
      'no stranger standing in either chamber -- every user counts toward the ratio',
      'the holder: a member (rank sir+) of the guild that owns hall 713, or an ally, when stow=hall'],
    cost: { time: 'cave walk + puzzle + fight; the floors stay moved 60 s', risk: 'a boss fight; no live completion measured yet' },
    notes: ['The first agent stands in chamber A (2507), the rest in chamber B (2508).',
      'solution=plain (default) or squares -- see PIT in tools/m59-riija.mjs for what each moves.'],
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'the team, in order: the first goes to chamber A, the rest to chamber B' },
    lever: { type: 'string', default: '', describe: 'who pulls the lever (must be in chamber B; default the first B member)' },
    holder: { type: 'string', default: '', describe: 'who picks up and stows the head (default the first agent)' },
    solution: { type: 'string', default: 'plain', options: ['plain', 'squares'], describe: 'which chamber heights to ask for' },
    stow: { type: 'string', default: 'hall', options: ['hall', 'carry'], describe: 'deposit the head in the hall, or keep it in the pack' },
    hall: { type: 'room', default: ROOMS.hall, describe: 'the hall to stow it in' },
    alsoStow: { type: 'string', default: 'mystic sword', describe: 'other boss loot to pick up and stow (comma list of names)' },
    waitMin: { type: 'number', default: 15, describe: 'how long a body waits at a barrier for the rest of the team' },
    fightMin: { type: 'number', default: 20, describe: 'minutes of farm posture on the boss' },
    home: { type: 'room', default: 0, describe: 'where non-holders (and the holder, after stowing) walk afterwards (0 = stay)' },
    minHealth: { type: 'number', default: 0.9 },
    fleeBelow: { type: 'number', default: 0.3 }, restBelow: { type: 'number', default: 0.4 },
  },

  async steps(p) {
    const team = list(p.agents);
    const me = p.agent ?? team[0];
    const roles = pitRoles(team, { lever: p.lever || null, solution: p.solution ?? 'plain' });
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
      // Chamber A's room has one cave-side door, the Archaic Hollows' NORTH edge, on an upper shelf
      // `travel` cannot plan to from the lower Hollows (it bounced 25 hops, 2026-11-14). The island's
      // admitted Hollows transit takes it: tools/m59-island-route.mjs enterGrogsAntechamber.
      ...(role.side === 'A' ? [
        walk(st => [2502, ROOMS.pitA].includes(st.startRoom) ? st.startRoom : 2501,
          { candidates: [2501, 2502, ROOMS.pitA], why: 'the Hollows transit starts in 2501 or 2502' }),
        verify(async ctx => {
          try { return await enterGrogsAntechamber(ctx, { budgetMs: 240_000, transit: ctx.hollowsTransit }); }   // undefined: the real admitted transit
          catch (e) { return abort(ctx.agent, `Hollows north transit to ${ROOMS.pitA}: ${e.message}`); }
        }, "over the Hollows' north edge"),
      ] : []),
      walk(role.room, { why: `the ${role.side === 'A' ? "Grog's" : "Brog's"} Antechamber` }),
      { ...walkTo(role.col, role.row, { within: 0, arriveWithin: 0, deadlineMs: 180_000, stallMs: 25_000 }), room: role.room, optional: true },
      crawlTo(role.col, role.row, { within: 0, optional: true, maxSteps: 40, deadlineMs: 240_000, room: role.room }),
      A(verify(async ({ agent, call }) => {
        const v = await call('look', { agent }, 30_000).catch(() => null);
        const at = v?.you;
        if (roomOf(v) !== role.room || !inChamber(at, role.side))
          return abort(agent, `not inside chamber ${role.side} of ${role.room} (at ${roomOf(v)} r${at?.row}c${at?.col})`);
        const wantMarked = PIT[role.side].marked.some(([r, c]) => r === role.row && c === role.col);
        if (wantMarked && !onMarked(at, role.side)) return abort(agent, `not on the marked square r${role.row}c${role.col}`);
        if ((p.solution ?? 'plain') === 'plain' && onMarked(at, role.side))
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
      // THROUGH, while the floors are moved (60 s, ResetPuzzle).
      walk(ROOMS.pit, { why: 'the Lair of the Orc Pit Boss, while the chamber floors are moved' }),
      A(verify(async ({ agent, call, state }) => {
        const v = await call('look', { agent }, 30_000).catch(() => null);
        if (!inBossArea(v)) return abort(agent, `not in the boss area of 2506 (at ${roomOf(v)} r${v?.you?.row}c${v?.you?.col})`);
        teamMark(key, agent, 'inside');
        const r = await teamWait(key, team, 'inside', { since: state.pitSince ?? 0, budgetMs: 3 * 60_000 });
        return r.ok ? { ok: true, team: 'all inside' } : abort(agent, r.why);
      }, 'in the boss area, together')),
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
    steps.push(restorePostureStep(TAG));
    if (Number(p.home) > 0) steps.push({ ...walk(Number(p.home)), always: true });
    return steps;
  },
};
