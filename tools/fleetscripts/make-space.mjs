// MAKE SPACE, IN PLACE: drop what the character was going to sell, until N bulk/weight is free.
//
// PUBLIC. Operator, 2026-11-05: "A more general harness fix for anytime anyone needs up to maybe
// 400 bulk/weight space: just drop items planned to be sold, it's fine.. (maybe have a fleetscript
// for it or something?? TryMakeSpace [amount] ?)". Rizzo (t19) was unarmed at 97% bulk, 60 free
// against the 70 a conjured weapon needs, and refusing every journey that could have emptied him.
//
//   node tools/m59-fleet-repl.mjs  ->  run make-space agents=t19 bulk=70
//   node tools/m59-fleet-repl.mjs  ->  run make-space agents=t3,t4 weight=200
//
// No walking. Each agent's keeper drops ONLY rows of its own sale plan (`sale_plan` shows them,
// `droppable: true`), least valuable per unit of the short dimension first, by exact id and
// amount, re-reading the pack after every drop. `bulk`/`weight` are FREE SPACE WANTED AFTERWARDS,
// not amounts to drop, each capped at 400. When the plan cannot cover it the run says `short_by`
// and still counts as done: nothing outside the plan is ever dropped to make up the difference.
import { verify } from '../m59-fleetscript.mjs';
import { MAKE_SPACE_MAX } from '../m59-make-space.mjs';

export const script = {
  name: 'make-space',
  describe: 'Free up to 400 bulk/weight in place by dropping the character\'s own sale-plan items, cheapest first.',
  recipe: {
    effect: 'Each agent ends with at least `bulk`/`weight` free, or says how short its sale plan left it.',
    run: 'make-space agents=<a,b> bulk=70 [weight=0]',
    needs: ['a keeper with the make_space op (deployed with it, and restarted since)'],
    cost: { time: 'a few seconds per drop', risk: 'the dropped items are gone (they were going to be sold)' },
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'who needs the room' },
    bulk: { type: 'number', default: 0, describe: `free bulk wanted afterwards, 0..${MAKE_SPACE_MAX}` },
    weight: { type: 'number', default: 0, describe: `free weight wanted afterwards, 0..${MAKE_SPACE_MAX}` },
  },

  async steps(p, agentArg) {
    const agent = p.agent ?? agentArg;
    const bulk = Number(p.bulk) || 0, weight = Number(p.weight) || 0;
    if (!(bulk > 0) && !(weight > 0)) throw new Error('make-space: give bulk= and/or weight= (1..400)');
    if (bulk > MAKE_SPACE_MAX || weight > MAKE_SPACE_MAX)
      throw new Error(`make-space: at most ${MAKE_SPACE_MAX} of each (asked bulk=${bulk} weight=${weight})`);
    return [
      verify(async ({ call }) => {
        const r = await call('make_space', { agent, ...(bulk > 0 ? { bulk } : {}), ...(weight > 0 ? { weight } : {}),
                                             why: 'make-space fleetscript' }, 180_000);
        const list = (r?.dropped ?? []).map(d => `${d.amount} ${d.name}`).join(', ') || 'nothing';
        const short = r?.short_by && (r.short_by.bulk || r.short_by.weight)
          ? `  SHORT bulk ${r.short_by.bulk} weight ${r.short_by.weight}` : '';
        console.log(`  ${agent} dropped ${list}; freed bulk ${r?.freed?.bulk ?? 0} weight ${r?.freed?.weight ?? 0}${short}` +
                    (r?.refused ? `  REFUSED: ${r.refused} (${r.why ?? ''})` : '') + (r?.note ? `  NOTE: ${r.note}` : ''));
        if (r?.refused || r?.error) throw new Error(`make_space: ${r.refused ?? r.error}: ${r.why ?? ''}`);
        return true;
      }, 'drop sale-plan items until the room is free, read back off the pack'),
    ];
  },
};
