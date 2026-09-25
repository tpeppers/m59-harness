// OFFLINE. The broker half of the human desk: what a person tells a bot about services.
//
// Both directions, against a real ChaliceStore in a temp directory — the same file the keepers
// read — with the reply and the ledger captured. What is pinned is that each sentence does
// exactly one thing to the store, that anything else falls through to the fleet controls, and
// that every command leaves a row.
//
// No socket, no broker. `node tools/m59-desk-chat-test.mjs`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChaliceStore, deskMenu, normalizeChalice } from './m59-chalice.mjs';
import { DeskChat, FOL_DONE_MS } from './m59-desk-chat.mjs';
import { summarise } from './m59-desk-report.mjs';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) { pass++; console.log('  ok  ', what); } else { fail++; console.log('  FAIL', what); } };
const section = (s) => console.log(`\n${s}`);

const FLEET = new Set(['Loial the Ogier', 'Bunsen', 'Kermit', 'Pepe', 'Scooter']);
const dir = mkdtempSync(join(tmpdir(), 'desk-chat-'));
try {
  const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, post_room: 2, fol_room: 38 });
  const fresh = (ns) => {
    const store = new ChaliceStore({ directory: dir, namespace: ns });
    const replies = [], rows = [];
    let t = 1_790_000_000_000;
    const desk = new DeskChat({ store, cfg,
      reply: async (bot, speaker, text) => { replies.push({ bot, speaker, text }); },
      record: (character, detail) => rows.push({ character, ...detail }),
      roomName: (n) => ({ 2: 'Outside Castle Victoria', 38: 'Castle Victoria' })[n] ?? null,
      isFleetmate: (n) => FLEET.has(n),
      now: () => t });
    return { store, desk, replies, rows, tick: (ms) => { t += ms; }, now: () => t };
  };
  const menu = deskMenu({ cfg, have: { emerald: 20, 'orc tooth': 1 }, floor: { emerald: 3 }, casts: 5, cup: true });

  // -------------------------------------------------------------------------------------
  section('a person playing Bunsen asks bot Loial what he offers, and for one of them');
  {
    const { store, desk, replies, rows, now } = fresh('ask');
    store.setDesk('Loial the Ogier', { menu, room: 2, fol_room: 38, limits: { ticket_ttl_ms: 300_000 } }, now());
    const say = (text) => desk.handle({ bot: 'hk1', botName: 'Loial the Ogier', from: 'Bunsen', speaker: 4471, text });

    ok(await say('services?'), '"services?" is the desk\'s');
    ok(replies.at(-1)?.text === '~B~k[Service] ~b Remove Curse, Reveal ~r(-Req. reagents)~k, Chalice, Forces of Light — tell me one',
       `the menu, in the operator's format (${replies.at(-1)?.text})`);
    ok(replies.at(-1)?.bot === 'hk1' && replies.at(-1)?.speaker === 4471, 'told back privately, as Loial, to the speaker');

    ok(await say('Remove Curse'), '"Remove Curse" is a request');
    const t = store.read().tickets.find(x => x.traveller === 'Bunsen' && x.kind === 'uncurse');
    ok(t?.human === true && t.status === 'open' && t.room === 2, 'filed as a person\'s uncurse at the station');
    ok(/queued — come and stand by me at Outside Castle Victoria \(2\)/.test(replies.at(-1)?.text ?? ''),
       `and told where to go (${replies.at(-1)?.text})`);
    ok(rows.some(r => r.what === 'desk_request' && r.service === 'uncurse' && r.server === 'Loial the Ogier'), 'on the ledger');

    await say('remove curse');
    ok(store.read().tickets.filter(x => x.kind === 'uncurse').length === 1, 'asking twice files once');
    ok(/already queued/.test(replies.at(-1)?.text ?? ''), 'and says so');

    await say('Reveal');
    ok(!store.read().tickets.some(x => x.kind === 'reveal'), 'an unavailable service files nothing');
    ok(/Reveal is unavailable: Req\. reagents/.test(replies.at(-1)?.text ?? ''), 'and says why');
    ok(rows.some(r => r.what === 'desk_refused'), 'refusals are rows too');

    await say('Forces of Light');
    const fol = store.read().tickets.find(x => x.kind === 'fol');
    ok(fol?.room === 38 && fol.human, 'forces of light is filed for the fol room');

    await say('cancel');
    ok(store.read().tickets.every(x => x.status === 'abandoned'), 'cancel withdraws everything Bunsen asked for');

    ok(!(await say('control')), '"control" falls through to the fleet controls');
    ok(!(await say('hi Loial')), 'and so does chat');
  }

  // -------------------------------------------------------------------------------------
  section('a person playing Loial answers a bot that asked him for the chalice');
  {
    const { store, desk, replies, rows, now, tick } = fresh('answer');
    store.setDesk('Loial the Ogier', { menu, room: 2, limits: { human_hold_ms: 120_000, human_max_wait_ms: 300_000 } }, now());
    const ride = store.request('Kermit', { room: 2, server: 'Loial the Ogier' }, now());
    const say = (bot, botName, text) => desk.handle({ bot, botName, from: 'Loial the Ogier', speaker: 7408, text });

    tick(10_000);
    ok(await say('t1', 'Kermit', 'hold on'), '"hold on" to the bot that is waiting');
    ok(store.ticket(ride.id).hold_until === now() + 120_000, 'buys the published two minutes');
    ok(/waiting for you — 2m more/.test(replies.at(-1)?.text ?? ''), `and the bot says so (${replies.at(-1)?.text})`);
    ok(rows.some(r => r.what === 'desk_hold' && r.character === 'Kermit'), 'on the ledger, against the bot that waited');

    ok(!(await say('t2', 'Pepe', 'hold on')), 'a bot that asked for nothing is not answered by the desk');

    ok(await say('t1', 'Kermit', 'not now'), '"not now"');
    ok(store.ticket(ride.id).status === 'abandoned' && store.ticket(ride.id).closed_by === 'Loial the Ogier',
       'closes it, in the person\'s name, so the bot walks at once');
    ok(rows.some(r => r.what === 'desk_declined'), 'on the ledger');

    const light = store.request('Scooter', { kind: 'fol', room: 38, server: 'Loial the Ogier' }, now());
    ok(await say('t3', 'Scooter', 'done'), '"done" after casting forces of light');
    ok(store.ticket(light.id).status === 'done', 'closes the request');
    ok(store.fol().until === now() + FOL_DONE_MS && store.fol().by === 'Loial the Ogier', 'and lights the shared clock for a minute');
  }

  // -------------------------------------------------------------------------------------
  section('nothing here speaks for a character to itself');
  {
    const { desk } = fresh('self');
    ok(!(await desk.handle({ bot: 'hk1', botName: 'Loial the Ogier', from: 'Loial the Ogier', speaker: 1, text: 'services?' })),
       'a person cannot ask the body they are playing');
  }
  // -------------------------------------------------------------------------------------
  section('fleetmates only: an NPC or a stranger is never the desk business');
  {
    const { store, desk, replies, now } = fresh('strangers');
    store.setDesk('Loial the Ogier', { menu, room: 2 }, now());
    store.request('Kermit', { room: 2, server: 'Loial the Ogier' }, now());
    const before = JSON.stringify(store.read().tickets);
    ok(!(await desk.handle({ bot: 'hk1', botName: 'Loial the Ogier', from: 'Grimbold the Stranger', speaker: 9, text: 'services?' })),
       'a non-fleetmate asking for the menu falls through');
    ok(!(await desk.handle({ bot: 'hk1', botName: 'Loial the Ogier', from: 'Frular', speaker: 9, text: 'Remove Curse' })),
       'an NPC name files nothing');
    ok(!(await desk.handle({ bot: 't1', botName: 'Kermit', from: 'Grimbold the Stranger', speaker: 9, text: 'not now' })),
       'and cannot release a traveller');
    ok(!(await desk.handle({ bot: 'x', botName: 'Somebody Else', from: 'Bunsen', speaker: 9, text: 'services?' })),
       'a hearer that is not ours is not a desk either');
    ok(JSON.stringify(store.read().tickets) === before && replies.length === 0, 'the store is untouched and nobody was answered');
    const bare = new DeskChat({ store });
    ok(!(await bare.handle({ bot: 'hk1', botName: 'Loial the Ogier', from: 'Bunsen', speaker: 1, text: 'services?' })),
       'a desk wired without a roster serves nobody');
  }

  // -------------------------------------------------------------------------------------
  section('the report: a person who timed a bot out blocked it; a person who said "not now" did not');
  {
    const T = 1_790_000_000_000, m = 60_000;
    const r = (min, character, what, extra = {}) => ({ t: T + min * m, iso: new Date(T + min * m).toISOString(),
      character, kind: 'chalice', what, ...extra });
    const s = summarise([
      r(0, 'Loial the Ogier', 'desk_human_on', { human: true }),
      r(1, 'Kermit', 'requested', { human: true }),
      r(2, 'Kermit', 'received', { human: true, waited_ms: 40_000 }),
      r(3, 'Zoot', 'requested', { human: true }),
      r(4, 'Zoot', 'ride_skipped', { human: true, why: 'did not hand the chalice over in 60s' }),
      r(5, 'Pepe', 'requested', { human: true }),
      r(5, 'Pepe', 'ride_skipped', { human: true, declined: true, why: 'Loial the Ogier said not now' }),
      r(6, 'Gonzo', 'ride_declined', { why: 'nobody is on chalice duty right now' }),
      r(9, 'Loial the Ogier', 'desk_human_off', { played_ms: 9 * m, human: true }),
      r(20, 'Clifford', 'ride_declined', { why: 'nobody is on chalice duty right now' }),
    ], { at: T + 30 * m });
    ok(s.sessions.length === 1 && s.sessions[0].minutes === 9, 'one nine-minute session');
    ok(s.bots_asking_a_person.handed_over === 1 && s.bots_asking_a_person.wait_ms.median === 40_000, 'one hand-over, 40s');
    ok(s.bots_asking_a_person.timed_out === 1, 'Zoot timed out');
    ok(s.bots_asking_a_person.declined_fast === 1, 'Pepe was declined, which is not blocking');
    ok(s.old_failure_while_playing === 1 && s.nobody_on_duty_any === 2, 'the old failure is counted inside the session only');
    ok(s.blocked === 2, `blocked: Zoot and Gonzo (${s.blocked})`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
