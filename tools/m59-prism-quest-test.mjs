// THE GUARD FOR fleetscripts/prism-quest.mjs — offline, opens no socket, drives no character.
//
//   node tools/m59-prism-quest-test.mjs
//
// It compiles a real quester's plan and replays the RUNNER'S OWN SKIP RULE over it (m59-fleetscript.mjs, `step.optional`
// after a skipped walk: every following step up to the next walk is skipped too, unless it is `anywhere`). Two incidents,
// both on 2026-10-31 with Raphael (hk3) questing for Parrin:
//
//   * A WALK TO NULL IS "NOT GOING", AND IT TOOK THE QUEST WITH IT. The plan says "not going" by walking to null (already
//     beside him, or not this phase), the runner skips that walk as optional, and with it the ask, the delivery and the
//     collection that followed. Run 1 found Parrin in 852 and finished all 50 cycles in one second, 948 skipped walks.
//   * A NULL SQUARE IS r0c0. Once the cycle steps were `anywhere`, closeOn's walk_to / crawl_to ran with nobody to
//     approach: Number(null) is 0, so they crawled toward the corner of the Temple of Kraanan for minutes
//     ("crawl_to: E -> r46c42 (46 from rnullcnull)"). They sit behind a gate walk to the room the NPC was seen in.
process.env.M59_FLEET ??= 'prism-quest-test';
const { script } = await import('./fleetscripts/prism-quest.mjs');

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${what}`); } };

const params = { agent: 'hk3', agents: 'hk3', questers: 'hk3:parrin', npc: 'maleval', hours: 2, stopOnPrism: 'false',
                 opportunistic: 'false', scoutCount: 0, askWaitMin: 20, cooldownMin: 61, searchSlots: 8, pollS: 30,
                 minHealth: 0.7, fleeBelow: 0.3, restBelow: 0.4 };
const plan = await script.steps(params);
const why = s => String(s.why ?? s.label ?? '');
const QUEST = /ask the wanderer for a courier job|give the letter to the priestess|collect from the wanderer|what is open/;

// The runner's rule, verbatim in shape: a skipped optional walk takes every following step up to the next walk,
// stopping at the first `anywhere` one.
const skippedAfter = i => {
  const out = [];
  for (let j = i + 1; j < plan.length && plan[j].do !== 'walk' && !plan[j].anywhere; j++) out.push(j);
  return out;
};

{
  const quest = plan.map((s, i) => [s, i]).filter(([s]) => s.do === 'verify' && QUEST.test(why(s)));
  ok(quest.length >= 4, `the plan carries the quest's own steps (found ${quest.length})`);
  const walks = plan.map((s, i) => [s, i]).filter(([s]) => s.do === 'walk' && s.optional);
  ok(walks.length > 10, `the plan has the optional walks a cycle says "not going" with (found ${walks.length})`);
  const taken = new Set();
  for (const [, i] of walks) for (const j of skippedAfter(i)) if (QUEST.test(why(plan[j]))) taken.add(`${j}: ${why(plan[j])}`);
  ok(taken.size === 0, `no skipped walk takes an ask, a delivery or a collection with it -- would take: ${[...taken].slice(0, 3).join(' | ')}`);
}

{
  // Every approach step stands behind a walk, so "nobody to approach" (a walk to null) skips it instead of running it
  // toward r0c0. walk_to / crawl_to are the steps that must NOT be `anywhere`.
  const approaches = plan.map((s, i) => [s, i]).filter(([s]) => (s.do === 'walk_to' || s.do === 'crawl_to') && !s.lift);
  ok(approaches.length > 0, `the plan approaches NPCs (found ${approaches.length} walk_to/crawl_to)`);
  ok(approaches.every(([s]) => !s.anywhere), 'walk_to / crawl_to stay bound to the walk before them');
  const gated = approaches.filter(([s, i]) => {
    for (let j = i - 1; j >= 0; j--) {
      if (plan[j].do === 'walk') return true;
      if (plan[j].do !== 'walk_to' && plan[j].do !== 'crawl_to') return false;
    }
    return false;
  });
  ok(gated.length === approaches.length,
     `every walk_to/crawl_to follows a gate walk with nothing between but the approach itself (${gated.length}/${approaches.length})`);
  // The gate resolves to null without a sighting, and to the sighting's room with one.
  const gate = plan[approaches[0][1] - 1];
  const to = typeof gate?.to === 'function' ? gate.to : () => undefined;
  ok(gate?.do === 'walk' && typeof gate.to === 'function' && to({}) == null, 'the gate walk is a walk to null when nobody was found');
  ok(to({ near: { room: 801, row: 13, col: 20 } }) === 801, 'and a walk to the room the NPC was seen in when one was');
}

{
  // The lift legs to Zuxana (802) keep the old rule: they belong to the temple walk before them.
  const lift = plan.filter(s => s.lift);
  ok(lift.length > 0, `the 802 lift legs are marked (found ${lift.length})`);
  ok(lift.every(s => !s.anywhere), 'and none of them is `anywhere`');
}

console.log(`\nm59-prism-quest: ${pass} assertion(s) passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
