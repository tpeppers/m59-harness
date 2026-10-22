// FIND A WANDERER, OR KEEP HIM: ONE BODY PER ROOM OF HIS LIST, CLOSEST FIRST.
//
// PUBLIC. The mechanism and every number are `m59-research/reports/wandering-npcs.md`; the
// module that does the work is `tools/m59-wanderers.mjs`. In one paragraph: each wanderer has a
// fixed list of 4-5 rooms and jumps to a random other one every 30-90 min, with no schedule. A
// player standing in his room holds him there for up to 6 of those ticks (3-9 h). So:
//
//   mode=find  The N closest bodies fan out, one to a room (fewer bodies than rooms: the rest of
//              the list becomes short sweep routes). The first body to see him writes it to
//              the fleet world book and every other body stops where it is. The
//              finder stays put -- it is now holding him -- for `holdMin`, so whoever was sent
//              for him has time to arrive.
//   mode=post  The same posting, kept for `hours`. Whoever he lands on holds him; when the forced
//              move comes he lands on another of ours. The ledger is then always fresh, which is
//              what prism-quest.mjs and anything else that needs him reads.
//
// Sightings go to the fleet's WORLD BOOK (m59-worldbook.mjs), which every keeper also writes the
// NPCs it sees to; a quester walking to him reads `whereIs` from the same book instead of sweeping.
import { verify } from '../m59-fleetscript.mjs';
import { call as fsCall } from '../m59-fleetscript.mjs';
import { asAgents } from '../m59-fleetlib.mjs';
import { postureStep, restorePostureStep } from '../m59-errand-posture.mjs';
import { WANDERERS, wandererKey, assignPosts, watchSteps, bodiesOf, planOnce, whereIs, recordView } from '../m59-wanderers.mjs';

const RUNS = new Map();           // sig -> { found } shared by every body of one run

export const script = {
  name: 'find-wanderer',
  describe: "Fan the closest bodies out over a wanderer's rooms, one per room; find him, or post them and hold him.",
  provenance: {
    pinned: '0203c2a2', verified: '2026-10-20',
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-wanderers.mjs', 'tools/m59-worldbook.mjs', 'tools/m59-errand-posture.mjs', 'tools/m59-broker.mjs'],
    refuseOnDrift: false,          // costs walking, not money
  },
  recipe: {
    effect: 'The wanderer\'s room is written to the fleet world book, and (post) kept fresh while bodies stand on his rooms.',
    run: 'find-wanderer agents=<a,b,c,...> npc=maleval|parrin|miriana|tendrath|izzio[,..] [mode=find|post] [count=N] [hours=24]',
    needs: ['bodies that can stand in his rooms: Maleval and Parrin are towns, temples and the Duke\'s keep; ' +
            'Miriana and Tendrath are outdoors (Tendrath\'s Ukgoth is a troll room)'],
    cost: { money: 'none', time: 'one walk per body, then standing', risk: 'whatever lives in his rooms; town rooms are safe' },
    scales: 'Bodies beyond the number of rooms add nothing. Maleval + Parrin together is 9 rooms (952 is on both lists).',
    notes: ['Rooms the router cannot reach (802 lift, 48 no door) may refuse at the walk; that body then reports and the others carry on.'],
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'the bodies to pick from' },
    npc: { required: true, describe: 'wanderer(s), comma-separated: maleval, parrin (perrin), miriana, tendrath, izzio' },
    mode: { default: 'find', options: ['find', 'post'], describe: 'find (stop at the first sighting) | post (keep every room watched for `hours`)' },
    count: { type: 'number', default: 0, describe: 'use only the N closest bodies (0 = all of them)' },
    hours: { type: 'number', default: 24, describe: 'post mode: how long to keep the posts. find mode: give up after this' },
    holdMin: { type: 'number', default: 30, describe: 'find mode: how long the finder stays to hold him once seen' },
    pollS: { type: 'number', default: 30, describe: 'seconds between looks while standing' },
    minHealth: { type: 'number', default: 0.7, describe: 'health fraction required to set out' },
    fleeBelow: { type: 'number', default: 0.3, describe: 'keeper flee point while posted (restored afterwards)' },
    restBelow: { type: 'number', default: 0.4, describe: 'keeper rest point while posted (restored afterwards)' },
  },

  async steps(p) {
    const keys = String(p.npc).split(',').map(s => s.trim()).filter(Boolean).map(wandererKey);
    const rooms = [...new Set(keys.flatMap(k => WANDERERS[k].rooms))];
    const agents = asAgents(p.agents);
    const sig = `${keys.join('+')}|${agents.join(',')}|${p.mode}`;
    const plan = await planOnce(sig, async () =>
      assignPosts(rooms, await bodiesOf(fsCall, agents), { count: Number(p.count) > 0 ? Number(p.count) : Infinity }));
    const route = plan.get(p.agent);
    if (!route) return [verify(async () => ({ ok: true, skipped: 'not among the closest bodies -- not needed' }), 'stand down')];
    const run = RUNS.get(sig) && Date.now() - RUNS.get(sig).at < 60_000 ? RUNS.get(sig) : { at: Date.now(), found: null };
    RUNS.set(sig, run);
    const until = Date.now() + Number(p.hours) * 3600_000;
    // The keeper pointed at the post first (survive, no confinement, no town trips), and put back
    // at the end: a keeper still stationed elsewhere walks a scout off its post (m59-errand-posture.mjs).
    const steps = [postureStep('find-wanderer', route[0], { fleeBelow: p.fleeBelow, restBelow: p.restBelow }, `post ${route[0]}`),
      ...watchSteps({ keys, route, mode: p.mode === 'post' ? 'post' : 'find', until, pollS: Number(p.pollS),
                      shared: run, label: `post ${route.join('>')}` })];
    if (p.mode !== 'post') {
      // The finder holds him; everybody else is done.
      steps.push(verify(async ({ agent, call, state }) => {
        const f = run.found ?? null;
        if (!f || f.by !== agent) {
          const w = keys.map(k => ({ npc: WANDERERS[k].npc, ...whereIs(k) }));
          return { ok: true, found: f, ledger: w };
        }
        const hold = Date.now() + Number(p.holdMin) * 60_000;
        // Keep looking, so the ledger stays fresh for whoever is walking here.
        while (Date.now() < hold) {
          await new Promise(r => setTimeout(r, Number(p.pollS) * 1000));
          const v = await call('look', { agent }, 30_000).catch(() => null);
          if (!recordView(v, agent).includes(f.key)) return { ok: true, held: f, left_after_min: Math.round((Date.now() - f.at) / 60_000) };
        }
        return { ok: true, held: f, for_min: Number(p.holdMin), here: state.watch?.here };
      }, 'hold him for whoever is coming'));
    }
    steps.push(restorePostureStep('find-wanderer'));
    return steps;
  },
};
