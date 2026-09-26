// RAID-PLACE — PUT EACH CLONE WHERE A RECORDED RUN HAD IT, AND NOTHING ELSE. LAB ONLY.
//
// The first phase of a raid REPLAY (m59-ghostraid replay --run <dir>): the shadow fleet has been
// re-dressed from the run's fleet-state.json, and this stands every raider back on the square it
// held at the moment the run checkpointed before the door. Then ghost-raid runs from there — the
// fight without the hour of muster, hall trips and dedication in front of it.
//
// DM powers are used for the placement and only for it, on a loopback server (assertLabFleet);
// the fight itself is unassisted, as in any rehearsal.
//
//   raid-place agents=<shadow raiders> positions='{"shadow01":{"room":2,"row":5,"col":44}, ...}'
import { verify, call, observe, assertLabFleet } from '../m59-fleetscript.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export const script = {
  name: 'raid-place',
  describe: 'LAB: place each clone where a recorded raid run had it (the start of a raid replay).',
  params: {
    agents: { type: 'agents', required: true },
    positions: { type: 'string', required: true, describe: 'JSON {agent: {room, row, col}}' },
  },

  async steps(p, agentArg) {
    const agent = p.agent ?? agentArg;
    const pos = (() => { try { return JSON.parse(String(p.positions || '{}'))[agent] ?? null; } catch { return null; } })();
    return [verify(async () => {
      if (!pos) { console.log(`  ${agent}: no recorded position — left where it stands`); return true; }
      assertLabFleet('raid-place');
      const dm = await import('../m59-dm.mjs');
      const who = (await call('status', { agent, brief: true }, 30_000).catch(() => null))?.character;
      if (!who) return { ok: false, why: 'no character name to place' };
      const r = await dm.relocate([who], Number(pos.room), { row: pos.row, col: pos.col, verify: true });
      // Wait for the keeper's picture to catch up before anything reads the body.
      const until = Date.now() + 30_000;
      while (Date.now() < until && Number((await observe(agent)).room) !== Number(pos.room)) await sleep(1500);
      console.log(`  ${agent} placed as recorded: room ${pos.room} r${pos.row ?? '?'}c${pos.col ?? '?'} (${r?.moved?.[who] ?? '?'})`);
      return true;
    }, 'the recorded position could not be restored', 'replay.place')];
  },
};
