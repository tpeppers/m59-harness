#!/usr/bin/env node
// Offline. Pins tools/m59-victory-taunt.mjs: who speaks after a won battle, and when nobody does.
// Battles come from the real pvpReport over injected rows, so the seam between the PvP reader and
// the taunt is crossed rather than faked.
import { pvpReport } from './m59-pvp.mjs';
import { parseTaunts, pendingWins, lastKiller, speakerOrder, broadcastCost, broadcastWent, pickLine, round } from './m59-victory-taunt.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };

const T0 = Date.parse('2026-10-17T17:28:24Z');
const death = (at, victim, killer, side) => ({ kind: 'death', at, observer: side === 'killer' ? killer : victim,
  victim, killer, how: 'guild combat', our_side: side, room: 38 });
const OURS = ['Floyd', 'Kermit', 'Piggy', 'Gonzo', 'Loial the Ogier'];
const report = (log, now = T0 + 120_000) => pvpReport({ now, days: 1, characters: OURS, log, ledger: [], alarms: [],
  reconstructed: [], members: {}, aliases: new Map() });

const taunts = parseTaunts(JSON.stringify({
  settings: { broadcast_mana_percent: 50 },
  characters: { Floyd: ['f1', 'f2'], Kermit: ['k1', 'k2', 'k3'], Piggy: ['p1'], Gonzo: ['g1'], _note: 'ignored' },
}));
ok(taunts.lines.size === 4, 'four characters with lines; underscore keys ignored');
ok(taunts.settings.max_attempts === 3, 'unset settings keep their defaults');

const fleetRow = (agent, character, level, mana, hp = '100/100', extra = {}) =>
  ({ agent, character, level, mana, health: hp, room_num: 38, piloted: null, ...extra });
const FLEET = [fleetRow('t16', 'Floyd', 60, '30/30'), fleetRow('t1', 'Kermit', 78, '21/21'),
  fleetRow('t14', 'Piggy', 78, '40/40', '120/120'), fleetRow('t18', 'Gonzo', 90, '5/40'),
  fleetRow('hk1', 'Loial the Ogier', 99, '99/99')];

// --- the Morpheus fight: one kill by Floyd, no deaths of ours
const won = report([death(T0, 'Morpheus', 'Floyd', 'killer')]);
ok(won.battles.length === 1 && won.battles[0].result === 'won', 'one kill, no losses reads as won');
ok(lastKiller(won.battles[0]) === 'Floyd', 'the last killer is named from the death row');

// two kills: the later one speaks
const two = report([death(T0, 'Morpheus', 'Kermit', 'killer'), death(T0 + 5000, 'Neo', 'Floyd', 'killer')]);
ok(lastKiller(two.battles[0]) === 'Floyd', 'the LAST kill is the one that counts');

// --- settling
ok(pendingWins(won.battles, new Map(), { now: T0 + 30_000 }).length === 0, 'an unsettled win waits');
ok(pendingWins(won.battles, new Map(), { now: T0 + 61_000 }).length === 1, 'a settled win is pending');
ok(pendingWins(won.battles, new Map([[won.battles[0].id, {}]]), { now: T0 + 61_000 }).length === 0, 'an answered win is not');
ok(pendingWins(won.battles, new Map(), { now: T0 + 31 * 60_000 }).length === 0, 'a stale win is never taunted');
const traded = report([death(T0, 'Morpheus', 'Floyd', 'killer'), death(T0 + 3000, 'Kermit', 'Morpheus', 'victim')]);
ok(pendingWins(traded.battles, new Map(), { now: T0 + 120_000 }).length === 0, 'a traded battle is not a win');

// --- who speaks
ok(broadcastCost(30, 50) === 16 && broadcastCost(21, 50) === 11 && broadcastCost(1, 50) === 1, 'cost is max*pct/100+1 (player.kod:3194)');
let o = speakerOrder({ killer: 'Floyd', fleet: FLEET, lines: taunts.lines });
ok(o.order[0].character === 'Floyd' && o.order[0].why === 'last kill', 'the killer speaks first when he can afford it');
ok(!o.order.some(c => c.character === 'Loial the Ogier'), 'a character with no lines never speaks');
ok(!o.order.some(c => c.character === 'Gonzo'), 'a character below the broadcast cost never speaks');
ok(o.order[1].character === 'Piggy' && o.order[2].character === 'Kermit', 'fallbacks strongest first: level, then max health');

o = speakerOrder({ killer: 'Floyd', fleet: FLEET.map(r => r.character === 'Floyd' ? { ...r, mana: '3/30' } : r), lines: taunts.lines });
ok(o.order[0].character === 'Piggy' && /mana 3\/30/.test(o.skipped.why), 'a killer short of mana is passed over, and says why');
o = speakerOrder({ killer: 'Floyd', fleet: FLEET.map(r => r.character === 'Floyd' ? { ...r, piloted: { by: 'human' } } : r), lines: taunts.lines });
ok(o.order[0].character === 'Piggy' && o.skipped.why === 'human-piloted', 'a human-piloted killer is never puppeted');
o = speakerOrder({ killer: 'Loial the Ogier', fleet: FLEET, lines: taunts.lines });
ok(o.order[0].character === 'Piggy' && o.skipped.why === 'has no lines', 'a killer without lines hands over to the strongest');
o = speakerOrder({ killer: null, fleet: FLEET, lines: taunts.lines });
ok(o.order[0].character === 'Piggy' && /no killer/.test(o.order[0].why), 'no killer named: the strongest with mana');
o = speakerOrder({ killer: null, fleet: FLEET.map(r => ({ ...r, room_num: null, room: null })), lines: taunts.lines });
ok(o.order.length === 0, 'nobody in the game: nobody speaks');

// --- replies
ok(broadcastWent({ spoken: 'x', echoed: 'x', messages: [] }), 'an echoed broadcast went out');
ok(!broadcastWent({ spoken: 'x', echoed: null, messages: ["You can't broadcast a message--you don't have enough mana."] }), 'the mana refusal is read');
ok(!broadcastWent({ spoken: 'x', echoed: null, messages: ['You are prevented from broadcasting messages for now.'] }), 'the squelch is read');
ok(!broadcastWent({ error: 'busy' }), 'an error did not go out');

// --- lines
const seq = [0.0, 0.99, 0.5];
let li = pickLine(['a', 'b', 'c'], 0, () => seq.shift());
ok(li.index !== 0, 'never the line it used last time');
ok(pickLine(['a'], 0).text === 'a', 'one line is always that line');

// --- a whole round: Floyd's mana refused, Piggy speaks; the win is answered once
{
  const calls = [];
  const call = async (name, args) => {
    calls.push([name, args]);
    if (name === 'fleet') return { fleet: FLEET };
    if (name === 'say' && args.agent === 't16') return { spoken: args.text, echoed: null, messages: ["You can't broadcast a message--you don't have enough mana."] };
    if (name === 'say') return { spoken: args.text, echoed: args.text, messages: [] };
  };
  const state = { answered: new Map(), last_line: {} };
  const now = T0 + 120_000;
  const done = await round({ call, report: () => won, fullReport: () => won, taunts, state, now, rand: () => 0 });
  const says = calls.filter(c => c[0] === 'say');
  ok(says.length === 2 && says[0][1].agent === 't16' && says[0][1].type === 'broadcast', 'Floyd tries first, on broadcast');
  ok(says[1][1].agent === 't14' && says[1][1].text === 'p1', 'a refusal hands over to the next, with HER own line');
  ok(done[0].spoke.character === 'Piggy' && state.answered.has(won.battles[0].id), 'the win is answered');
  const again = await round({ call, report: () => won, fullReport: () => won, taunts, state, now: now + 15_000 });
  ok(again.length === 0, 'and never taunted twice');
}

// --- the full report overrules the cheap one: a death the log missed spoils the win
{
  const calls = [];
  const call = async (name, args) => { calls.push(name); return name === 'fleet' ? { fleet: FLEET } : { echoed: 'x' }; };
  const state = { answered: new Map(), last_line: {} };
  const full = pvpReport({ now: T0 + 120_000, days: 1, characters: OURS, log: [death(T0, 'Morpheus', 'Floyd', 'killer')],
    ledger: [{ kind: 'death', source: 'ledger', at: T0 + 2000, victim: 'Kermit', killer: 'Morpheus', our_side: 'victim', how: 'guild combat', room: 38 }],
    alarms: [], reconstructed: [], members: {}, aliases: new Map() });
  const done = await round({ call, report: () => won, fullReport: () => full, taunts, state, now: T0 + 120_000 });
  ok(!calls.includes('say') && done[0].spoke === null, 'a win the ledger turns into a trade is not taunted');
}

// --- dry run speaks to nobody
{
  const calls = [];
  const call = async (name) => { calls.push(name); return { fleet: FLEET }; };
  const done = await round({ call, report: () => won, fullReport: () => won, taunts, state: { answered: new Map(), last_line: {} }, now: T0 + 120_000, dryRun: true });
  ok(!calls.includes('say') && done[0].spoke.character === 'Floyd', 'a dry run names the speaker and sends nothing');
}
// --- no lines, no work
ok((await round({ call: async () => { throw new Error('called'); }, report: () => won, fullReport: () => won,
  taunts: parseTaunts('{}'), state: { answered: new Map(), last_line: {} }, now: T0 + 120_000 })).length === 0, 'an empty book does nothing');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
