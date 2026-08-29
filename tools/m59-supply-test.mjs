#!/usr/bin/env node
// MOVING SUPPLIES BETWEEN TWO CHARACTERS ONE BROKER IS DRIVING.
//
//   node tools/m59-supply-test.mjs
//
// Offline. No socket, no broker, no roster — safe any time.
//
// ============================ WHAT THIS IS BUILT FROM ============================
//
// `supplyBetween` was written when the broker WAS the keeper and the pacer and the socket.
// Production has run per-character keeper processes since the split, and on that
// architecture the exchange could not move a single item — while reporting, in each case,
// something that sounded like the game's fault rather than ours:
//
//   the hold did nothing        `autopilotIfAny(name)` answers undefined for a
//                               keeper-backed character (`resumeFleet` drops the
//                               in-process autopilot for every one of them), so the call
//                               that was supposed to stop both keeper loops found nothing
//                               to stop, put nothing on the restore list, and reported no
//                               problem. Both keepers then drove straight through a
//                               four-step handshake that any one of their actions cancels.
//   `waitFor` resolved null     so the first read off it threw
//   `roomContents` was absent   so the arrival check threw before anything walked
//   the four trade packets      were absent — the emulated client is a picture, not a wire
//   `travelExclusive` returned  the JOB WRAPPER rather than the journey's result, so
//                               `t.arrived` was undefined and a walk that worked read as a
//                               refusal
//
// Every one of those is silent or misattributed, which is why this test exists at all and
// why m59-supply.mjs is a separate file: m59-broker.mjs cannot be imported without starting
// a broker, so for as long as the exchange lived in it nothing could ask it a question
// without a live fleet.
//
// The fakes below are the two kinds of session — a live one with a client in hand, and a
// keeper-backed one that answers only through named steps — and the assertions are about
// what the exchange DOES to each of them, in what order.
//
// It should fail the day the exchange starts trusting a room number, offers a stack by its
// bare id, calls a delivery successful without an arithmetic difference on the receiver, or
// leaves a keeper held after it is finished with it.

import { supplyBetween, supplyOps } from './m59-supply.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};
const section = t => console.log('\n' + t);

const PLAYER = 0x0004;

// ---------------------------------------------------------------- the fakes
//
// A keeper-backed session, as `KeeperProxy` presents one: a snapshot that is refreshed by
// the pacer, an emulated client rebuilt from it, and named steps that reach the process
// holding the socket. Every step is recorded, because the ORDER is most of what is being
// tested — an accept before the counteroffer is what the server logs as cheating.
function fakeKeeperSession(name, opts = {}) {
  const s = {
    name,
    character: opts.character ?? name,
    room: opts.room ?? 100,
    items: (opts.items ?? []).map(o => ({ ...o })),
    others: opts.others ?? [],          // who else is in the room, as the wire reports them
    log: [],
    held: null,
    holdSeq: 0,
    _evSeq: 0,
    _client: null,
  };
  s.rebuild = () => {
    s._client = {
      me: { name: s.character },
      rsc: { get: k => (typeof k === 'string' && k.length ? k : null) },
      // The shape `KeeperProxy` builds from a keeper snapshot. `amount` is what the WIRE
      // reported, which for anything that is not a stack is ZERO — the distinction the
      // offer encoding turns on. `tag` is the server's own answer to the same question.
      inventory: s.items.map(o => ({ id: o.id, nameRsc: o.name, amount: o.amount ?? 0,
                                     tag: o.tag ?? null, flags: 0 })),
      waitFor: async () => ({ events: [], seq: null, timedOut: true, no_event_stream: true }),
      requestInventory: () => null,
    };
    return s._client;
  };
  s.rebuild();
  const proxy = {
    name,
    get world() { return { room: { num: s.room } }; },
    pacer: { submit: async (kind, fn) => { s.log.push('refresh'); s.rebuild(); return fn ? fn() : null; } },
    need: () => s._client,
    async roomContents() {
      s.log.push('room_contents');
      return { room: s.room, answered: true,
               objects: s.others.filter(o => o.room === s.room)
                                .map(o => ({ id: o.id, name: o.name, flags: PLAYER })) };
    },
    async holdStill(why, maxMs, token) {
      s.log.push('hold');
      // Presenting the token in force RENEWS it. See holdKeeper/renewHold in
      // m59-keeper-process.mjs: an errand that outlasts the deadline it asked for has to
      // be able to say so, or the keeper wakes up mid-trade.
      if (s.held && token && token === s.held.token) {
        s.renewals = (s.renewals ?? 0) + 1;
        return { held: true, renewed: true, hold: { token: s.held.token } };
      }
      if (s.held) return { held: false, reason: `already held: ${s.held.why}` };
      s.held = { why, token: `tok-${name}-${++s.holdSeq}` };
      return { held: true, hold: { token: s.held.token } };
    },
    async releaseHold(why, token) {
      s.log.push('release:' + token);
      if (!s.held) return { released: false, reason: 'nothing was holding this character' };
      if (token && token !== s.held.token) return { released: false, reason: 'not the hold in force' };
      s.held = null;
      return { released: true };
    },
    async tradeStep(op, args = {}) {
      s.log.push('trade:' + op);
      if (op === 'seq') return { seq: s._evSeq };
      if (op === 'cancel') return { cancelled: true };
      if (op === 'offer') { s.lastOffer = args; return { sent: true, since: s._evSeq }; }
      if (op === 'await_offer') return { saw: s.willSeeOffer !== false, since: args.since };
      if (op === 'counter') return { sent: true };
      if (op === 'await_countered') return { saw: s.willSeeCounter !== false,
                                             trade: { may_accept: s.willSeeCounter !== false } };
      if (op === 'accept') { if (s.onAccept) s.onAccept(); return { sent: true }; }
      return { error: 'unknown op ' + op };
    },
    async travelExclusive(dest) {
      s.log.push('travel:' + dest);
      if (s.travelFails) return { arrived: false, reason: 'blocked' };
      s.room = dest;
      return { arrived: true, room: dest };
    },
    _fake: s,
  };
  return proxy;
}

const deps = (sessions) => ({
  session: n => { if (!sessions[n]) throw new Error(`no session ${n}`); return sessions[n]; },
  isProxied: () => true,
  autopilotIfAny: () => undefined,
});

// A hand-over that is going to work: both in room 100, giver holds a stack of each reagent.
function twoInOneRoom(extra = {}) {
  const giver = fakeKeeperSession('g', {
    character: 'Sweetums', room: 100,
    items: [{ id: 11, name: 'elderberry', amount: 46 }, { id: 12, name: 'herbs', amount: 118 }],
    others: [{ id: 99, name: 'Zoot', room: 100 }],
    ...(extra.giver ?? {}),
  });
  const recv = fakeKeeperSession('r', {
    character: 'Zoot', room: 100,
    items: [{ id: 21, name: 'herbs', amount: 1 }],
    others: [{ id: 98, name: 'Sweetums', room: 100 }],
    ...(extra.recv ?? {}),
  });
  // The accept is what moves the goods. Modelled here so the arithmetic check has
  // something true to find; a test whose fake always succeeds cannot fail the way
  // production did.
  giver._fake.onAccept = () => {
    if (extra.nothingMoves) return;
    const per = extra.per ?? 2;
    for (const [gid, rid, nm] of [[11, 21.1, 'elderberry'], [12, 21, 'herbs']]) {
      const src = giver._fake.items.find(o => o.id === gid);
      if (!src) continue;
      src.amount -= per;
      const dst = recv._fake.items.find(o => o.name === nm);
      if (dst) dst.amount += per;
      else recv._fake.items.push({ id: rid, name: nm, amount: per });
    }
  };
  return { giver, recv };
}

// ---------------------------------------------------------------- the exchange
section('A HAND-OVER IN ONE ROOM, WHICH IS THE CASE EVERY OTHER ONE REDUCES TO');
{
  const { giver, recv } = twoInOneRoom();
  const out = await supplyBetween({ from: 'g', to: 'r', what: 'reagents', amount: 2,
                                    who_travels: 'neither' }, deps({ g: giver, r: recv }));
  ok('the delivery lands', out.supplied === true, JSON.stringify(out));
  ok('and names both characters, not their agent slots',
     out.from === 'Sweetums' && out.to === 'Zoot');
  ok('both reagents moved', out.handed_over.sort().join(',') === 'elderberry,herbs');
  ok('two of each, not the whole stack',
     out.amounts.every(m => m.asked === 2 && m.received === 2), JSON.stringify(out.amounts));
  ok('the giver lost exactly what the receiver gained',
     out.amounts.every(m => m.giver_lost === m.received));
  ok('nobody travelled', out.travelled === null);

  const g = giver._fake.log, r = recv._fake.log;
  ok('the giver was held for the handshake', g.includes('hold'));
  ok('so was the receiver', r.includes('hold'));
  ok('and both were released afterwards',
     g.some(l => l.startsWith('release:')) && r.some(l => l.startsWith('release:')));
  ok('released with the token they were held under',
     g.find(l => l.startsWith('release:')) === 'release:tok-g-1');
  ok('the giver asked the room who was in it rather than trusting the snapshot',
     g.includes('room_contents'));
  ok('both sides cancelled any stale trade before starting',
     g.includes('trade:cancel') && r.includes('trade:cancel'));

  // THE ORDER IS THE PART THAT IS EASY TO GET WRONG. Accepting before the counteroffer
  // has arrived is logged by the server as cheating and cancels the trade.
  const order = [...g, ...r].filter(l => l.startsWith('trade:'));
  const gTrade = g.filter(l => l.startsWith('trade:'));
  const rTrade = r.filter(l => l.startsWith('trade:'));
  ok('the receiver is asked where its stream is BEFORE the offer goes out',
     rTrade.indexOf('trade:seq') < rTrade.indexOf('trade:await_offer') &&
     rTrade.indexOf('trade:seq') >= 0);
  ok('the giver offers, then the receiver counters, then the giver accepts',
     gTrade.indexOf('trade:offer') >= 0 &&
     rTrade.indexOf('trade:counter') >= 0 &&
     gTrade.indexOf('trade:accept') > gTrade.indexOf('trade:offer'));
  ok('the accept comes after the giver has seen the counteroffer',
     gTrade.indexOf('trade:await_countered') < gTrade.indexOf('trade:accept'));
  ok('and there is exactly one accept', order.filter(l => l === 'trade:accept').length === 1);
}

section('A STACK IS OFFERED WITH ITS QUANTITY, BECAUSE A BARE ID MEANS ONE');
{
  const { giver, recv } = twoInOneRoom();
  await supplyBetween({ from: 'g', to: 'r', what: 'reagents', amount: 2,
                        who_travels: 'neither' }, deps({ g: giver, r: recv }));
  const items = giver._fake.lastOffer.items;
  ok('the offer carries {id, amount} rather than a bare id',
     items.every(i => i && typeof i === 'object' && i.amount === 2), JSON.stringify(items));
  ok('and it is addressed to the receiver object seen in the room',
     giver._fake.lastOffer.to_id === 99);
}
{
  // The other half of the same rule: asked for the WHOLE stack by id, the amount is the
  // stack, not a slice of it.
  const { giver, recv } = twoInOneRoom({ per: 46 });
  await supplyBetween({ from: 'g', to: 'r', what: [11], who_travels: 'neither' },
                      deps({ g: giver, r: recv }));
  ok('a bare id in `what` means the whole stack',
     giver._fake.lastOffer.items[0].amount === 46, JSON.stringify(giver._fake.lastOffer));
}
{
  const { giver, recv } = twoInOneRoom({ per: 5 });
  await supplyBetween({ from: 'g', to: 'r', what: [{ id: 11, amount: 5 }], who_travels: 'neither' },
                      deps({ g: giver, r: recv }));
  ok('and {id, amount} means part of one — lending the price of a meal is not emptying a purse',
     giver._fake.lastOffer.items[0].amount === 5);
}
{
  // THE TEST IS THE TAG, NOT WHETHER THERE IS MORE THAN ONE. A stack with ONE left carries
  // amount 1, and an `amount > 1` test sent it as a bare id — which contributes nothing to
  // the parallel number list the server pairs POSITIONALLY against the ids it thinks are
  // NumberItems. So one untagged stack slides every count after it onto the wrong item and
  // the whole offer moves nothing. Measured on shadow: Hhhh, carrying one elderberry and
  // one herb, could hand Jjjj neither, in either direction, with the handshake completing
  // and `may_accept` true both times. Nobody was full. See dropSpec in m59-parse.mjs.
  const { giver, recv } = twoInOneRoom({ per: 1 });
  giver._fake.items = [{ id: 11, name: 'elderberry', amount: 1 },
                       { id: 12, name: 'herbs', amount: 1 }];
  giver._fake.rebuild();
  await supplyBetween({ from: 'g', to: 'r', what: 'reagents', amount: 2,
                        who_travels: 'neither' }, deps({ g: giver, r: recv }));
  const items = giver._fake.lastOffer.items;
  ok('a stack with ONE left still goes out with its count',
     items.length === 2 && items.every(i => i && typeof i === 'object' && i.amount === 1),
     JSON.stringify(items));
}
{
  // And the other side of the same rule: an ordinary item is NOT a NumberItem, so tagging
  // it would insert a count the server never reads for it and misalign everything after.
  // The wire reports amount 0 for those, which is why the keeper must publish 0 and not 1.
  const { giver, recv } = twoInOneRoom({ per: 0 });
  giver._fake.items = [{ id: 31, name: 'short sword', amount: 0 },
                       { id: 12, name: 'herbs', amount: 9 }];
  giver._fake.rebuild();
  await supplyBetween({ from: 'g', to: 'r', what: [31, 12], who_travels: 'neither' },
                      deps({ g: giver, r: recv }));
  const items = giver._fake.lastOffer.items;
  ok('an item that is not a stack goes out as a bare id',
     items[0] === 31, JSON.stringify(items));
  ok('and the stack beside it still carries its count',
     items[1] && typeof items[1] === 'object' && items[1].amount === 9, JSON.stringify(items));
}
{
  // AND THE REPORT HAS TO SURVIVE AN HONEST ZERO. A non-stack carries amount 0 now, which
  // is the point of publishing the wire's answer — but `asked: o.amount ?? 1` does not
  // catch a zero, so the first mixed offer that worked on shadow reported a hammer as
  // `asked: 0, received: 1`. The delivery was fine and the arithmetic was nonsense, which
  // is the kind of line that gets believed.
  const { giver, recv } = twoInOneRoom({ nothingMoves: true });
  giver._fake.items = [{ id: 31, name: 'short sword', amount: 0 }];
  giver._fake.rebuild();
  giver._fake.onAccept = () => {
    giver._fake.items = [];
    recv._fake.items.push({ id: 41, name: 'short sword', amount: 0 });
  };
  const out = await supplyBetween({ from: 'g', to: 'r', what: [31], who_travels: 'neither' },
                                  deps({ g: giver, r: recv }));
  ok('one of a thing that does not stack is asked for as one, not as zero',
     out.amounts[0]?.asked === 1 && out.amounts[0]?.received === 1, JSON.stringify(out.amounts));
}

section('A NAME CANNOT ANSWER "DID THIS TRADE HAPPEN". AN AMOUNT CAN');
{
  // The receiver already holds herbs. The old check asked whether its inventory CONTAINED
  // the name afterwards, which is trivially true — so a delivery that moved nothing
  // reported success. 1,498 shillings handed to somebody holding 10,261 did exactly this.
  const { giver, recv } = twoInOneRoom({ nothingMoves: true });
  const out = await supplyBetween({ from: 'g', to: 'r', what: 'reagents', amount: 2,
                                    who_travels: 'neither' }, deps({ g: giver, r: recv }));
  ok('nothing moved is reported as nothing moved', out.supplied === false);
  ok('and the receiver still carrying the name does not count as evidence',
     out.handed_over.length === 0, JSON.stringify(out.handed_over));
  ok('the failure says what to look at next',
     /pack\.percent/.test(out.note), out.note);
  ok('and both keepers were let go anyway',
     giver._fake.held === null && recv._fake.held === null);
}

section('SUPPLIED MEANS ALL OF IT');
{
  // Only the herbs move. The almoner cooks straight after a delivery, and a half-filled
  // one makes it cast a spell that fails silently for want of the other half.
  const { giver, recv } = twoInOneRoom({ nothingMoves: true });
  giver._fake.onAccept = () => {
    giver._fake.items.find(o => o.id === 12).amount -= 2;
    recv._fake.items.find(o => o.name === 'herbs').amount += 2;
  };
  const out = await supplyBetween({ from: 'g', to: 'r', what: 'reagents', amount: 2,
                                    who_travels: 'neither' }, deps({ g: giver, r: recv }));
  ok('a half-filled delivery is not supplied', out.supplied === false);
  ok('but it is marked partial', out.partial === true);
  ok('and it says which half did not arrive',
     out.not_received.length === 1 && out.not_received[0].name === 'elderberry',
     JSON.stringify(out.not_received));
}

section('A COUNTEROFFER THAT NEVER ARRIVES MEANS THE ACCEPT ENDED THE TRADE');
{
  const { giver, recv } = twoInOneRoom({ nothingMoves: true });
  giver._fake.willSeeCounter = false;
  const out = await supplyBetween({ from: 'g', to: 'r', what: 'reagents', amount: 2,
                                    who_travels: 'neither' }, deps({ g: giver, r: recv }));
  ok('the failure names the counteroffer rather than blaming the pack',
     /counteroffer never arrived/.test(out.note), out.note);
  ok('and reports may_accept, which is the field that says so on the wire',
     out.may_accept === false);
}
{
  const { giver, recv } = twoInOneRoom();
  recv._fake.willSeeOffer = false;
  const out = await supplyBetween({ from: 'g', to: 'r', what: 'reagents', amount: 2,
                                    who_travels: 'neither' }, deps({ g: giver, r: recv }));
  ok('an offer that never reaches them stops there', out.supplied === false);
  ok('and says so', out.reason === 'the offer never reached them');
  ok('a half-finished trade is not left holding the goods',
     giver._fake.log.filter(l => l === 'trade:cancel').length >= 2,
     JSON.stringify(giver._fake.log));
  ok('and the keepers are still handed back',
     giver._fake.held === null && recv._fake.held === null);
}

section('WHOEVER IS STANDING STILL IS HELD; THE WALKER IS NOT');
{
  const { giver, recv } = twoInOneRoom();
  recv._fake.room = 200;
  recv._fake.others = [];              // the giver is not with it yet
  giver._fake.others = [{ id: 99, name: 'Zoot', room: 200 }];
  const out = await supplyBetween({ from: 'g', to: 'r', what: 'reagents', amount: 2,
                                    who_travels: 'from' }, deps({ g: giver, r: recv }));
  ok('the giver walked to the receiver', giver._fake.log.includes('travel:200'));
  ok('and the delivery landed', out.supplied === true, JSON.stringify(out));
  ok('it reports which end travelled', out.travelled === 'from');

  // A JOURNEY IS NOT AN ERRAND. The old code held BOTH keepers inert for the whole
  // exchange, walk included, and `goInert` switches the survival ladder off — which is how
  // Cccc was walked out of a sanctuary at 27% health and eaten in twenty-two seconds.
  // `travelJob` already stops the walker's keeper driving and leaves it able to defend
  // itself, so the walker must not be held before it sets out.
  const g = giver._fake.log;
  ok('the walker is not held before it sets out',
     g.indexOf('travel:200') < g.indexOf('hold'), JSON.stringify(g));
  const r = recv._fake.log;
  ok('the one standing still IS held before the walk starts',
     r.indexOf('hold') >= 0 && r.indexOf('hold') < r.filter(x => true).length);
  ok('and the walker is held once for the handshake, not before',
     g.filter(l => l === 'hold').length === 1);
  // AN INERT KEEPER WAKES ON A DEADLINE, and the hold taken before a five-minute walk can
  // lapse in the seconds between arriving and offering. So the one standing still is asked
  // a second time — with the token it was given, which RENEWS rather than being refused as
  // "already held" by us and then left to expire mid-handshake.
  ok('the one standing still is re-asserted before the handshake',
     r.filter(l => l === 'hold').length === 2, JSON.stringify(r));
  ok('and that second ask renewed the hold rather than taking a new one',
     recv._fake.renewals === 1 && recv._fake.holdSeq === 1);
  ok('and both are released exactly once',
     g.filter(l => l.startsWith('release:')).length === 1 &&
     r.filter(l => l.startsWith('release:')).length === 1);
}

section('ARRIVAL IS SEEING THEM, NOT MATCHING A ROOM NUMBER');
{
  // Both readings say 300 and they are not in the same room — which happens all the time,
  // because both characters are being driven and the two snapshots are on different clocks.
  // Clifford reported arrival while it was in 584 and Waldorf in 586.
  const { giver, recv } = twoInOneRoom();
  giver._fake.room = 300; recv._fake.room = 300;
  giver._fake.others = [];             // the giver can see nobody
  const out = await supplyBetween({ from: 'g', to: 'r', what: 'reagents', amount: 2,
                                    who_travels: 'neither' }, deps({ g: giver, r: recv }));
  ok('agreeing room numbers do not make a handover', out.supplied === false);
  ok('and the refusal names the two rooms it read',
     out.reason.includes('is not in the room with'), out.reason);
  ok('it lists who the giver COULD see, which is what makes this diagnosable',
     Array.isArray(out.players_the_giver_can_see));
}
{
  // A walk that never gets there is a failure, and it is reported as one — not as a
  // trade problem.
  const { giver, recv } = twoInOneRoom();
  recv._fake.room = 200; recv._fake.others = []; giver._fake.others = [];
  giver._fake.travelFails = true;
  const out = await supplyBetween({ from: 'g', to: 'r', what: 'reagents', amount: 2,
                                    who_travels: 'from' }, deps({ g: giver, r: recv }));
  ok('a walk that does not arrive stops the exchange', out.supplied === false);
  ok('and it is attributed to the walk', /could not get there/.test(out.reason), out.reason);
  ok('the walk is retried while the room keeps changing and abandoned when it does not',
     giver._fake.log.filter(l => l.startsWith('travel:')).length === 3,
     JSON.stringify(giver._fake.log.filter(l => l.startsWith('travel:'))));
  ok('and the character that was standing still is let go',
     recv._fake.held === null);
}

section('WHAT TO HAND OVER IS DECIDED AGAINST THE PACK AS IT IS NOW');
{
  // The selection made before a cross-map walk describes a pack that has been fought,
  // looted and eaten out of since. Offering an id it no longer holds is not an error on
  // the wire — the offer just carries less than it says.
  const { giver, recv } = twoInOneRoom();
  recv._fake.room = 200; recv._fake.others = [];
  giver._fake.others = [{ id: 99, name: 'Zoot', room: 200 }];
  const originalTravel = giver.travelExclusive;
  giver.travelExclusive = async (dest) => {
    // eaten en route
    giver._fake.items = giver._fake.items.filter(o => o.name !== 'elderberry');
    return originalTravel.call(giver, dest);
  };
  const out = await supplyBetween({ from: 'g', to: 'r', what: 'reagents', amount: 2,
                                    who_travels: 'from' }, deps({ g: giver, r: recv }));
  ok('what was eaten on the road is not offered',
     giver._fake.lastOffer.items.length === 1, JSON.stringify(giver._fake.lastOffer));
  ok('and the delivery is judged on what was actually asked for', out.supplied === true,
     JSON.stringify(out));
}
{
  const giver = fakeKeeperSession('g', { character: 'Sweetums', room: 100, items: [] });
  const recv = fakeKeeperSession('r', { character: 'Zoot', room: 100 });
  const out = await supplyBetween({ from: 'g', to: 'r', what: 'reagents',
                                    who_travels: 'from' }, deps({ g: giver, r: recv }));
  ok('a donor with nothing to give does not send anybody on a journey',
     out.supplied === false && !giver._fake.log.some(l => l.startsWith('travel:')));
  ok('and it says what it was looking for', /nothing matching reagents/.test(out.reason));
}

section('A CHARACTER CANNOT SUPPLY ITSELF');
{
  const giver = fakeKeeperSession('g', { character: 'Sweetums' });
  let threw = null;
  await supplyBetween({ from: 'g', to: 'g' }, deps({ g: giver })).catch(e => { threw = e.message; });
  ok('asking is refused rather than answered', /cannot supply itself/.test(threw ?? ''), threw);
}

section('A HOLD SOMEBODY ELSE IS ALREADY KEEPING IS LEFT ALONE');
{
  // `running` stays true while a keeper is inert, so without this a trade nested inside
  // another errand would revive a hold it never took, and hand the character back mid-way
  // through someone else's walk.
  const { giver, recv } = twoInOneRoom();
  recv._fake.held = { why: 'an outfit errand owns this character', token: 'someone-else' };
  const out = await supplyBetween({ from: 'g', to: 'r', what: 'reagents', amount: 2,
                                    who_travels: 'neither' }, deps({ g: giver, r: recv }));
  ok('the exchange still runs', out.supplied === true, JSON.stringify(out));
  ok('and says it could not take the hold', (out.notes ?? []).some(n => /could not hold/.test(n)),
     JSON.stringify(out.notes));
  ok('the other errand keeps its hold', recv._fake.held?.token === 'someone-else');
  ok('nothing released it', !recv._fake.log.some(l => l.startsWith('release:')));
}

section('THE LIVE-SESSION PATH STILL EXISTS AND IS A DIFFERENT PATH');
{
  // A session with a client in hand does not go through the keeper's named steps. The
  // point of `supplyOps` is that both are written once; the point of this assertion is
  // that choosing between them is not left to a truthy accident.
  const calls = [];
  const client = {
    me: { name: 'Rowlf' },
    rsc: { get: k => k },
    inventory: [],
    evSeq: 7,
    room: { objects: new Map([[42, { id: 42, nameRsc: 'Fozzie', flags: PLAYER, col: 3, row: 4 }]]) },
    requestInventory: () => calls.push('requestInventory'),
    roomContents: () => calls.push('roomContents'),
    waitFor: async () => ({ events: [] }),
    cancelOffer: () => calls.push('cancelOffer'),
  };
  const live = {
    name: 'live',
    world: { room: { num: 5 } },
    pacer: { submit: async (kind, fn) => fn() },
    need: () => client,
  };
  let started = 0, stopped = 0;
  const keeper = { running: true, inert: null, stop: () => stopped++, start: () => started++ };
  const ops = supplyOps(live, { isProxied: () => false, autopilotIfAny: () => keeper });
  ok('a live session is not treated as proxied', ops.proxied === false);
  const h = await ops.hold('a supply exchange owns this character');
  ok('holding it stops the in-process keeper', h.held === true && stopped === 1);
  await ops.release('done');
  ok('and releasing it starts the keeper again', started === 1);
  await ops.seeRoom();
  ok('the room is asked for over the wire', calls.includes('roomContents'));
  ok('the stream position comes off the client', await ops.seq() === 7);
  // OURS, RE-ASSERTED. `goInert` returns early when the keeper is already inert, so its own
  // deadline has to be moved in place — and without the token this would read our own hold
  // as somebody else's and refuse it.
  const held = await ops.hold('a supply exchange owns this character');
  keeper.inert = { why: 'a supply exchange owns this character', at: 1, maxMs: 1000 };
  const renewed = await ops.hold('a supply exchange owns this character', 120_000, held.token);
  ok('presenting our own token renews the hold', renewed.held === true && renewed.renewed === true);
  ok('and it moves the keeper\'s own inert deadline with it',
     keeper.inert.at > 1 && keeper.inert.maxMs === 120_000);
  ok('without taking a second one', stopped === 2);

  keeper.inert = { why: 'somebody else' };
  const h2 = await ops.hold('a supply exchange owns this character');
  ok('a keeper another errand has already made inert is not taken', h2.held === false);
  ok('and stop was not called again', stopped === 2);
}

// ---------------------------------------------------------------- the other side
//
// The steps above are named in m59-supply.mjs and ANSWERED in m59-keeper-process.mjs. The
// two halves are in different processes and there is no way to import the second one — it
// joins the game as its first act — so these are source assertions. They are here because
// the failure being guarded against is a step that exists on one side and not the other,
// which reads from either end as the game refusing.
section('THE KEEPER ANSWERS EVERY STEP THE EXCHANGE ASKS FOR');
{
  const keeper = readFileSync(join(HERE, 'm59-keeper-process.mjs'), 'utf8');
  const firstSwitch = keeper.slice(keeper.indexOf("if (req.method === 'POST' && path === '/action')"),
                                   keeper.indexOf('actionFallthrough = { name, args };'));
  for (const step of ['hold', 'release', 'room_contents', 'trade'])
    ok(`\`${step}\` is in the switch that actually runs`,
       firstSwitch.includes(`case '${step}':`) || firstSwitch.includes(`case '${step}': {`));
  for (const op of ['seq', 'cancel', 'offer', 'await_offer', 'counter', 'await_countered', 'accept'])
    ok(`the trade step \`${op}\` is answered`, firstSwitch.includes(`case '${op}':`));

  // TWO `/action` HANDLERS, AND THE SECOND ONE HAD NEVER RUN. The first answered
  // `unknown action` with a 400 for everything it did not know, so `shop`, `buyitem`,
  // `equip`, `cast`, `look`, `go` and `attack` were unreachable — every one of them dead on
  // the architecture production runs.
  ok('there is only one `/action` guard left',
     keeper.split("if (req.method === 'POST' && path === '/action') {").length - 1 === 1);
  ok('the second switch is reached by falling out of the first',
     keeper.includes('if (actionFallthrough) {'));
  ok('and the first no longer refuses a name the second one knows',
     !/unknown action "\$\{name\}"` \}, 400\)/.test(firstSwitch));
  ok('the fallthrough carries the parsed body, because the request stream is spent',
     keeper.includes('const { name, args } = actionFallthrough;'));

  // The hold is a fact the fleet board has to be able to read, or a character standing
  // still on purpose is indistinguishable from one that has stalled — and m59-supervise
  // unsticks the second kind.
  // The offer encoding above can only be right if what it is encoding is right. A keeper
  // that reports every item as `amount: 1` makes a sword indistinguishable from a herb,
  // and the tag test then tags both.
  ok('the keeper publishes the amount the wire reported, zero and all',
     /amount: o\.amount \?\? 0,/.test(keeper) && !/amount: o\.amount \?\? 1,/.test(keeper));
  ok('and the server\'s own number tag beside it', /tag: o\.tag \?\? null,/.test(keeper));

  ok('the hold is published in /state', /^\s*hold: holdReport\(\),$/m.test(keeper));
  ok('a second hold is refused rather than layered', keeper.includes('already held: ${errandHold.why}'));
  ok('a release must present the hold in force',
     keeper.includes('if (token && token !== errandHold.token)'));
  ok('the hold has a deadline of its own, because `_frozen` carries none',
     /errandHold\.timer = setTimeout/.test(keeper));

  // `autopilot.stop()` in tick mode stops the loop AND the watchdog, and `start` is
  // `() => {}` — so a tick-driven character stopped that way can never be started again.
  const holdFn = keeper.slice(keeper.indexOf('function holdKeeper('), keeper.indexOf('function releaseKeeper('));
  ok('a tick-driven character is frozen, never stopped',
     holdFn.includes('loop._frozen = true') && !holdFn.includes('autopilot.stop('));
  ok('a goap keeper goes inert, which keeps it looking', holdFn.includes('autopilot.goInert?.('));
}

// ---------------------------------------------------------------- the transport
//
// Every step above travels to the keeper over a loopback port chosen as
// `KEEPER_PORT_BASE + index`, with no override — so every broker on a machine allocates
// from the same number, and one that lost a slot falls back to GUESSING it. The read path
// checked the reply's `agent` and refused; the write paths checked nothing, and the four
// verbs this file adds are write paths, one of which stops a keeper.
//
// Measured 2026-08-26 with three brokers up: an `arena` broker posted its 45s `/rejoin`
// sweep to a `shadow` fleet's keepers on two ports, and the server logged
// `ACCOUNT 64 (shadow05) in use; new connection overrides old one` every 90 seconds for as
// long as that broker lived, wrecking a set of timed tours that had nothing to do with it.
// Nothing on either side said a word.
//
// TO BE EXACT, because the alarming reading is the wrong one: `/rejoin` ignores the posted
// body and calls `join()`, which uses the keeper's OWN account and password. No credential
// crosses and nobody is logged in as somebody else. It is a forced logout and re-login of a
// stranger's character, on repeat.
section('AN ORDER ADDRESSED TO ANOTHER FLEET IS REFUSED BY THE PROCESS THAT KNOWS ITS OWN NAME');
{
  const keeper = readFileSync(join(HERE, 'm59-keeper-process.mjs'), 'utf8');
  const broker = readFileSync(join(HERE, 'm59-broker.mjs'), 'utf8');

  ok('every order carries the agent it is addressed to',
     /const keeperEnvelope = \(agent, body\)/.test(broker) &&
     /body: keeperEnvelope\(agent, \{ name, args \}\)/.test(broker));
  ok('so does the rejoin sweep, which is the one that did the damage',
     /body: keeperEnvelope\(agent, credentials\)/.test(broker));
  ok('and a read, because a chat ring and a room view are a character\'s too',
     /new URLSearchParams\(Object\.entries\(\{ \.\.\.params, agent \}\)/.test(broker));

  ok('the keeper refuses an order that names somebody else',
     keeper.includes('if (!addressedToUs(ask?.agent)) { refuseMisaddressed(ask.agent); return; }'));
  ok('and a rejoin that does', keeper.includes('if (!addressedToUs(asked?.agent))'));
  ok('and a read that does', /!addressedToUsQuery\(url\)/.test(keeper));
  // A conflict about identity, not a malformed request — and the broker turns 409 into
  // "drop the allocation and respawn" rather than retrying into the same stranger.
  ok('it answers 409, naming itself', /\}, 409\);\n\s*\};/.test(keeper) &&
     keeper.includes('this keeper is "${agent}", not "${claimed}"'));
  ok('and the broker drops the allocation rather than hammering it',
     /if \(r\.status === 409\)/.test(broker) && /keeperPorts\.delete\(agent\)/.test(broker));

  // FAILS OPEN ON AN UNADDRESSED REQUEST. An older broker sends no `agent` field, and
  // refusing those would strand every character the moment the two halves disagreed about
  // versions. Naming the wrong agent is a mistake; naming nobody is merely old.
  ok('an unaddressed order is still answered, because an older broker sends none',
     /if \(claimed === undefined \|\| claimed === null \|\| claimed === ''\) return true;/.test(keeper));
  // `/health` and `/state` NAME their own agent in the reply and the broker checks it —
  // they are how a caller discovers whose port this is. Refusing them would remove the only
  // tool that resolves the confusion.
  ok('/health and /state stay answerable, since they are how a stranger is identified',
     /path !== '\/health' && path !== '\/state'/.test(keeper));

  // THE ROOT OF THE FAMILY. This accepted any healthy reply as the keeper it had just
  // spawned and recorded that port, and `keeperPort()` prefers a recorded port over
  // everything — so a lost bind race became total confidence. `stopKeeper` posts `/stop` to
  // that recorded port without further question.
  ok('a keeper that comes up wearing another name is not adopted as ours',
     /not the keeper we spawned; not adopting it/.test(broker));
}

section('AND THE BROKER SIDE OF THE PROXY ANSWERS IN THE SHAPE THE CALLERS READ');
{
  const broker = readFileSync(join(HERE, 'm59-broker.mjs'), 'utf8');
  const proxy = broker.slice(broker.indexOf('class KeeperProxy'), broker.indexOf('function makeKeeperProxy'));
  ok('`travelExclusive` no longer hands back the job wrapper',
     !/travelExclusive\(dest, opts = \{\}\) \{ return this\.travelJob\(dest, opts\); \}/.test(proxy));
  ok('it awaits the journey and reports whether the character arrived',
     /async travelExclusive/.test(proxy) && proxy.includes('arrived: true'));
  ok('`waitFor` does not resolve null any more',
     !/waitFor: async \(\) => null,/.test(proxy));
  // IT NO LONGER ANSWERS "NOTHING WAS SEEN" EITHER, AND THAT IS THE POINT.
  //
  // Resolving `{events: []}` was honest and cost eight MCP tools: this game answers almost
  // nothing with an error — a merchant refusal is a sentence spoken to the room — so a
  // caller that cannot read the reply concludes that nothing happened. The stream is still
  // the keeper's; what crosses is a window onto it, anchored on the `ev_seq` the snapshot
  // carries. The empty shape survives as the FALLBACK, for a keeper too old to serve one,
  // and it keeps `no_event_stream` so a caller can still tell "nothing was said" from
  // "nobody could hear".
  ok('it asks the process that owns the socket rather than reporting that it cannot',
     /keeperAction\(proxy\.name, proxy\._index, 'events'/.test(proxy));
  ok('and still answers in the shape every caller destructures when it gets no window',
     /return \{ events: \[\], seq: null, timedOut: true, no_event_stream: true,/.test(proxy));
  ok('the proxy hands the amount and the tag straight through',
     /amount: o\.amount \?\? 0,/.test(proxy) && /tag: o\.tag \?\? null,/.test(proxy));
  ok('the trade steps and the room read are on the session, not the emulated client',
     /async tradeStep\(/.test(proxy) && /async roomContents\(/.test(proxy));
  ok('the errand hold is forwarded rather than taken locally',
     /async holdStill\(/.test(proxy) && /async releaseHold\(/.test(proxy));
  ok('a held character reads as inert on the board', /inert: this\._state\?\.hold/.test(proxy));
  ok('the exchange is imported rather than defined here',
     broker.includes("from './m59-supply.mjs'"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
