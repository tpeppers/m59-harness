// RUN UP TO FOUR FLEETSCRIPTS IN A ROW, AS ONE ERRAND.
//
// PUBLIC, 2026-10-21. Operator: "chain-able FleetScripts" -- e.g. find Maleval with the fleet, then
// buy from him, then walk home. Each stage is any other script with its own params (the MANAGE tab
// configures each in a nested form; at the REPL it is JSON with %20 for spaces):
//
//   chain agents=t9,t10 first=buy firstParams={"seller":"Maleval","item":"learn:curse%20weapon"} second=come-home secondParams={"home":52}
//
// ONE DRIVER, ONE LEASE, NO NESTED RUNNER: the stages' steps are concatenated (composeTask in
// m59-fleetlib.mjs, as island-trip composes its task). So the outer run owns the bodies and keeps
// its health floors; a stage cannot name other agents or waive a guarantee. EVERY STAGE COMPILES
// BEFORE ANYBODY MOVES -- a bad param in stage three refuses the chain at the start, not after the
// first two stages have walked across the map. A failed step stops the chain where it failed, as
// it would stop the stage on its own; stages after it do not run.
import { verify } from '../m59-fleetscript.mjs';
import { composeTask } from '../m59-fleetlib.mjs';

const STAGES = ['first', 'second', 'third', 'fourth'];
const EXCLUDE = ['chain'];

export const script = {
  name: 'chain',
  describe: 'Run up to four FleetScripts back to back as one errand, every stage compiled before anyone moves.',
  params: {
    agents: { type: 'agents', required: true, describe: 'who runs every stage' },
    ...Object.fromEntries(STAGES.flatMap((k, i) => [
      [k, { type: 'script', paramsIn: `${k}Params`, required: i === 0, default: '', exclude: EXCLUDE, describe: `stage ${i + 1}` }],
      [`${k}Params`, { type: 'string', default: '{}' }]])),
    minHealth: { type: 'number', default: 0.5, describe: 'health fraction required to set out (every stage inherits it)' },
  },
  async steps(p) {
    const out = [];
    for (const [i, k] of STAGES.entries()) {
      if (!p[k]) continue;
      const steps = await composeTask(p[k], p[`${k}Params`], p, { exclude: EXCLUDE, what: `stage ${i + 1} (${p[k]})` });
      out.push(verify(() => { console.log(`  ${p.agent}: stage ${i + 1}: ${p[k]}`); return true; }, `stage ${i + 1}: ${p[k]}`), ...steps);
    }
    if (!out.length) throw Error('a chain needs at least one stage');
    return out;
  },
};
