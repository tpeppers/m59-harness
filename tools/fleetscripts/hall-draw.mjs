// DRAW FROM THE GUILD CHESTS AND BRING IT BACK: the quartermaster's run before a raid.
//
// PUBLIC. On 2026-09-25 the ghost raid's prod roster carried 16 orc teeth, 51 elderberry and 50
// herbs between twenty-two characters — enough to dedicate five hammers — while the hall's
// chests held 162 teeth, 253 elderberry, 181 herbs and 75,000 shillings. Nothing in the fleet
// could take them OUT for an errand: the keeper's own `withdrawFromStockpile` travels on its
// own, reads only its own wants, and counts only elderberry and herbs. `hall_withdraw` (broker
// tool, keeper op, `Autopilot.hallWithdraw`) is the errand-shaped half, and this is its errand.
//
// THE SHAPE: ride the chalice from the stage room if its holder is standing there (it lands in
// 714), otherwise walk; take whole stacks of each want; walk home. The raid's own reagent step
// then spreads what came back, and its money pool hands the shillings to the armorers — so
// nothing downstream needs to know this run happened.
//
//   node tools/m59-fleet-repl.mjs  ->  run hall-draw agents=t3 holder=hk1
//
// WHOLE STACKS, because REQ_GET has no amount: asking for 40 teeth takes the whole 162-stack.
// Shillings weigh nothing; teeth and elderberry weigh 3 each, herbs 2 (bulk 4), so the default
// wants come to roughly 1,550 weight and 1,900 bulk — inside one pack, not inside a full one.
import { walk, verify } from '../m59-fleetscript.mjs';
import { chaliceRide } from './ghost-outfit.mjs';

const HALL = 714;
const DEFAULT_WANTS = JSON.stringify([
  { item: 'shilling', amount: 60000 },
  { item: 'orc tooth', amount: 40 },
  { item: 'elderberry', amount: 100 },
  { item: 'herb', amount: 120 },
]);

export const script = {
  name: 'hall-draw',
  describe: 'Ride (or walk) to the guild hall, take named items out of the chests, walk home.',
  recipe: {
    effect: 'The agent comes home carrying what the chests gave, and says exactly what that was.',
    run: 'hall-draw agents=<one> holder=<chalice holder> home=2',
    needs: ['guild rank SIR or better — the hall door refuses in silence',
            'a keeper that has the hall_withdraw op (deployed with it, and restarted since)'],
    cost: { time: 'ride ~30 s or road 5-10 min, hall 1-3 min, road home 5-10 min',
            risk: 'the road home crosses Ukgoth; safe-spot legs apply' },
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'the quartermaster (one)' },
    holder: { type: 'string', default: '', describe: 'who carries the Chalice of the Rain, standing with the agent' },
    home: { type: 'number', default: 2, describe: 'where to bring it' },
    wants: { type: 'string', default: DEFAULT_WANTS, describe: 'JSON [{item, amount}]' },
    minHealth: { type: 'number', default: 0.8 },
  },

  async steps(p, agentArg) {
    const agent = p.agent ?? agentArg;
    const wants = JSON.parse(String(p.wants || DEFAULT_WANTS));
    const out = {};
    return [
      verify(async () => {
        if (!p.holder) { out.ride = 'no holder named: walking'; return true; }
        const r = await chaliceRide(agent, String(p.holder), { hall: HALL });
        out.ride = r.ok ? `chalice (cup refilled: ${r.cupBack})` : `walking (${r.why})`;
        console.log(`  ${agent} ${out.ride}`);
        return true;
      }, 'the chalice ride, if the cup is here'),
      walk(HALL, { why: 'the chests are in the hall; a no-op if the chalice already landed us' }),
      verify(async ({ call }) => {
        const r = await call('hall_withdraw', { agent, wants }, 620_000).catch(e => ({ ok: false, why: e.message }));
        out.took = r?.took ?? {}; out.short = r?.short ?? {};
        console.log(`  ${agent} HALL took ${JSON.stringify(out.took)}` +
                    (Object.keys(out.short).length ? `  SHORT ${JSON.stringify(out.short)}` : '') +
                    (r?.ok ? '' : `  REFUSED: ${r?.why ?? r?.error ?? '?'}`));
        if (!r?.ok) throw new Error(`hall_withdraw: ${r?.why ?? r?.error ?? 'no answer'}`);
        return Object.values(out.took).some(n => n > 0) || 'the chests gave nothing';
      }, 'taking the wants out of the chests, read back off the pack'),
      walk(Number(p.home), { why: 'bring it to the raid' }),
    ];
  },
};
