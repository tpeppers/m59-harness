#!/usr/bin/env node
// Review retained incoming fleet communication by UTC date, player/NPC source and recipient.
// node tools/m59-communications-report.mjs --fleet prod --date 2026-09-29 --source player
// --recipient NAME --sender TEXT --channel group --q TEXT --offset 200; JSON output.
import { resolveFleet } from './m59-fleetpath.mjs';
import { communicationsReport } from './m59-communications-page.mjs';
const args = process.argv.slice(2);
const params = new URLSearchParams();
for (let i = 0; i < args.length; i += 2) {
  const key = args[i].replace(/^--/, '');
  if (!['fleet', 'date', 'source', 'recipient', 'sender', 'channel', 'q', 'offset'].includes(key) || args[i + 1] == null)
    throw new Error('Use --fleet NAME --date YYYY-MM-DD --source all|player|npc|system|unknown; optional --recipient, --sender, --channel, --q, --offset');
  if (key !== 'fleet') params.set(key, args[i + 1]);
}
const { stateFile } = resolveFleet();
try { console.log(JSON.stringify(await communicationsReport({ stateFile, params }), null, 2)); }
catch (e) { console.error(e.message); process.exitCode = 1; }
