// Copy into substrate/fleetscratch/ and adjust the import to ../../tools/.
// Pin to the scratchpad board before `combat run ambush-player ...`.
// Coordinates are parameters: this example does not claim a particular tile is safe.
import { ambushPlayer } from '../tools/m59-fleetscript.mjs';

export const script = {
  name: 'ambush-player',
  mode: 'combat',
  describe: 'Take a position, wait for an exact player to enter, then attack.',
  params: {
    agents: { type: 'agents', required: true },
    player: { type: 'string', required: true },
    map: { type: 'number', required: true },
    row: { type: 'number', required: true },
    col: { type: 'number', required: true },
  },
  steps: p => [ambushPlayer(p.player, Number(p.map), { row: Number(p.row), col: Number(p.col) }, {
    ttl_ms: 600_000,
    sequence: [{ do: 'attack', swings: 1 }],
  })],
};
