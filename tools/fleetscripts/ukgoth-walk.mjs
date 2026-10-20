// WALK TO A SQUARE INSIDE UKGOTH (599) ON A CHECKED FINE CUT, NOT ON THE SQUARE WALKER.
//
// Operator, 2026-10-20: "let's continue doing 599 instead of 38 for our lockdowns" / "Northeast 599 is accessible from
// the room 2 entrance" / "Make it into a reusable fleetscript for movement in the ukgoth zone". The red-alert recall
// lands everyone on r2c27, the room-2 entrance square on the north edge, and the square walker cannot be trusted from
// there (it stepped Rowlf back into room 2) or across this room (Kermit never left r5c13). This cuts a fine walk from
// the body's exact position with every edge proved (planFineCutWalk, tools/m59-fine-cut-walk.mjs), dry-runs it through
// fineclimb, then follows it. The default target is the lockdown post at the NE corner, two squares off the 598 door.
//
//   ukgoth-walk agents=t13 expectedGame=<host:port>                 the NE-corner lockdown post (r4c61)
//   ukgoth-walk agents=t13 to=r9c35 expectedGame=<host:port>        any square in the room
//
// ONE CHARACTER AT A TIME. Bodies block (monster collision is height-agnostic): from a stack of fleet-mates on one
// square, walk the FRONT of the stack first (Sweetums, r3c27, walked in 131 s; Rowlf behind him was object_blocked at
// waypoint 2 by the bodies in his path). Measured 2026-10-20 on prod, deploy-2026-10-20-3.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verify } from '../m59-fleetscript.mjs';
import { asAgents } from '../m59-fleetlib.mjs';
import { roomGeometry } from '../m59-ground.mjs';
import { tourPosition } from '../m59-node-tour.mjs';
import { planFineCutWalk, parseSquare, cutRailFile } from '../m59-fine-cut-walk.mjs';
import { resolveControlUrl } from '../m59-fleetpath.mjs';

export const UKGOTH = 599;
export const NE_POST = 'r4c61';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const near = (p, to, within) => Math.max(Math.abs(p.row - to.row), Math.abs(p.col - to.col)) <= within;

export const script = {
  name: 'ukgoth-walk',
  describe: 'Walk one character to a square inside Ukgoth (599) on a checked fine cut followed by fineclimb (default: the NE-corner lockdown post).',
  recipe: { run: 'ukgoth-walk agents=<one> [to=rNcM] expectedGame=<host:port>',
    needs: ['the character already in Ukgoth (599)', 'expectedGame on a remote server: fineclimb refuses remote_requires_exact_expected_game without it'] },
  params: {
    agents: { type: 'agents', required: true, describe: 'one character, already in 599' },
    to: { type: 'string', default: NE_POST, describe: 'target square rNcM (default the NE-corner lockdown post)' },
    within: { type: 'number', default: 3, describe: 'arrived when this many squares (Chebyshev) from the target' },
    expectedGame: { type: 'string', describe: 'host:port of the game server' },
    evidenceDir: { type: 'string', default: 'substrate/scratch/ukgoth-walk' },
  },
  async steps(p) {
    if (asAgents(p.agents).length !== 1) throw Error('ukgoth-walk takes one character at a time: bodies on one cut block each other');
    const to = parseSquare(p.to);   // refuses a malformed target at load, before anything walks
    return [verify(async ({ agent, call }) => {
      const at = tourPosition(await call('look', { agent }));
      if (at.room !== UKGOTH) { console.log(`  ${agent} is in ${at.room}, not Ukgoth (${UKGOTH})`); return false; }
      if (near(at, to, p.within)) { console.log(`  ${agent} already at r${at.row}c${at.col}, within ${p.within} of r${to.row}c${to.col}`); return true; }
      const plan = planFineCutWalk(roomGeometry(UKGOTH), { x: at.x_client, y: at.y_client }, to, { room: UKGOTH });
      if (!plan.ok) { console.log(`  ${agent}: no checked cut from r${at.row}c${at.col}: ${plan.why}`); return false; }
      const dir = `${ROOT}${p.evidenceDir}/`; mkdirSync(dir, { recursive: true });
      const file = `${dir}${agent}-rail.json`; writeFileSync(file, JSON.stringify(cutRailFile(UKGOTH, plan.route)));
      // The broker the fleetscript itself was proved against (guarantee 11), and the fleet it holds.
      const control = resolveControlUrl(); if (!control.url) throw Error('no broker named: ' + control.why);
      const health = await (await fetch(new URL('health', control.url))).json();
      const args = ['tools/m59-fineclimb.mjs', '--fleet', health.fleet, '--port', String(new URL(control.url).port), '--agent', agent, '--rail', 'cut', '--rail-file', file,
        '--direction', 'to_node', '--no-hop', ...(p.expectedGame ? ['--expected-game', p.expectedGame] : [])];
      for (const dry of [true, false]) {
        const r = spawnSync(process.execPath, [...args, ...(dry ? ['--dry-run'] : ['--receipt', `${dir}${agent}-commands.jsonl`])],
          { cwd: ROOT, encoding: 'utf8', timeout: 600_000, maxBuffer: 8_000_000 });
        writeFileSync(`${dir}${agent}-${dry ? 'dry' : 'follow'}.txt`, `${r.stdout ?? ''}\n${r.stderr ?? ''}`);
        console.log((r.stdout ?? '').slice(-500));
        if (r.status !== 0) { console.log(`  ${agent}: fineclimb ${dry ? 'refused the dry run' : 'stopped'} (exit ${r.status})`); return false; }
      }
      const end = tourPosition(await call('look', { agent }));
      console.log(`  ${agent} now r${end.row}c${end.col} in ${end.room}`);
      return end.room === UKGOTH && near(end, to, p.within);
    }, 'not at the target square in Ukgoth')];
  },
};
