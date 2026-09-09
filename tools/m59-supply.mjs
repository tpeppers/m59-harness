#!/usr/bin/env node
// Moving supplies from whoever has them to whoever needs them, in one call, between two
// characters one broker is driving.
//
// `trade` is a two-sided protocol and both sides here are ours. Doing it by hand is four
// calls that must interleave correctly across two sessions — offer, counter, accept, and a
// read to prove it landed — and getting the order wrong is logged by the server as
// cheating. Worse, a half-finished trade is SILENT: the goods sit on the table looking
// handed over. This drives both ends and verifies the receiver actually holds them
// afterwards.
//
// WHY THIS IS ITS OWN FILE. It used to be two functions at the bottom of m59-broker.mjs,
// and m59-broker.mjs cannot be imported without starting a broker — it takes the fleet lock
// and starts rejoin timers — so nothing written in it can be tested offline. That is the
// same argument m59-render-projection.mjs was split out on, and the same one that let a
// hold sit here doing nothing for as long as it did: there was no way to ask it a question
// without a live fleet.
//
// `node tools/m59-supply-test.mjs` is that test. Everything the exchange needs from the
// broker — how to look a session up, whether that session is keeper-backed, and where the
// in-process keepers live — arrives as arguments, so the test hands it fakes and the
// broker hands it the real thing.
import { OF, dropSpec } from './m59-parse.mjs';
import * as skills from './m59-skills.mjs';

const num = (v, d) => (v === undefined || v === null ? d : Number(v));

// An in-process keeper has no token of its own — the hold IS `Autopilot.inert`, which is a
// single slot with no owner recorded. This stands in for one so that the renew path can tell
// "the hold we took" from "a hold somebody else took", which is the only distinction it
// needs. A keeper process issues a real one; see `holdReport` in m59-keeper-process.mjs.
const IN_PROCESS_HOLD = 'in-process';

// ONE EXCHANGE, TWO KINDS OF SESSION.
//
// Everything below was written when the broker WAS the keeper and the pacer and the
// socket: one process, one event loop, one live client per character sitting in a Map. It
// is not that any more. Production runs a keeper process per character and the broker holds
// a two-second-old snapshot of each — see `KeeperProxy` in m59-broker.mjs — and
// every step of this exchange reached straight through the snapshot for something only the
// socket's owner has.
//
// It did not fail loudly, which is why it went unnoticed:
//
//   THE HOLD WAS A NO-OP. `autopilotIfAny(name)` answers `undefined` for a keeper-backed
//   character — `resumeFleet` calls `dropAutopilot` on every one of them — so `holdStill`
//   found nothing to stop, put nothing on the restore list, and reported no problem. Both
//   keepers then drove their characters straight through a four-step handshake that any
//   one of their actions cancels. That is precisely the failure the hold was added for.
//
//   `waitFor` RESOLVED null, so the first thing the handshake read off it threw.
//
//   `roomContents` WAS NOT A FUNCTION AT ALL, so the arrival check threw before the walk.
//
//   `offer`, `counterOffer`, `acceptOffer` and `cancelOffer` are packets, and the emulated
//   client is a picture. None of them existed.
//
//   `travelExclusive` RETURNED THE JOB WRAPPER rather than the journey's result, so
//   `t.arrived` was `undefined` on every attempt and a walk that worked read as a refusal.
//
// So the SEQUENCING stays here — the broker is the only thing that can see both characters
// — and every STEP is now asked of whichever process owns the body. `supplyOps` names the
// steps once; the keeper's side of them is the `hold`, `release`, `room_contents` and
// `trade` cases in m59-keeper-process.mjs.
//
// AND THE HOLD IS NO LONGER TAKEN FOR THE WALK. The old code held BOTH keepers inert for
// the whole exchange, travel included, and `goInert` switches the survival ladder off —
// which is exactly how Cccc was walked out of a sanctuary at 27% health and eaten in
// twenty-two seconds (docs/m59-routing.md, correction 2026-08-21). It does not need to any
// more: `travelJob` takes the job slot and `goTravelling`, so the walker is already
// protected from its own keeper AND still allowed to run from a fight it is losing. What
// still needs an errand hold is the character standing still waiting to be met — otherwise
// its keeper walks it back to its hunting ground and the mover chases it — and both ends
// for the handshake itself, which is seconds rather than minutes.
export function supplyOps(sess, { isProxied, autopilotIfAny }) {
  const proxied = !!isProxied(sess);
  // RE-READ, NEVER CAPTURE. `KeeperProxy.client` is rebuilt from each snapshot and the old
  // object is thrown away, so a `const c = sess.need()` taken before a refresh is a picture
  // of the past that goes on answering questions about the present.
  const c = () => sess.need();
  const shape = o => ({ id: o.id, name: o.name ?? null, flags: o.flags ?? 0,
                        col: o.col ?? null, row: o.row ?? null });
  return {
    proxied,
    session: sess,
    client: c,
    name: () => { try { return c().me?.name ?? sess.name; } catch { return sess.name; } },
    room: () => sess.world?.room?.num ?? null,

    // The pacer forces a fresh snapshot out of the keeper before running the callback, so
    // the same three lines are right for both kinds of session — as long as the client is
    // re-read afterwards rather than reused.
    async inventory() {
      await sess.pacer.submit('read', () => c().requestInventory());
      await c().waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
      return c().inventory || [];
    },

    // ASKED, NOT REMEMBERED. A room object list that nobody has requested describes
    // wherever the client last happened to be told about, which after a walk is the room
    // we left.
    async seeRoom() {
      if (proxied) {
        const r = await sess.roomContents({ timeout_ms: 2500 });
        if (r?.error) return { room: sess.world?.room?.num ?? null, objects: [], why: r.error };
        return { room: r.room ?? null, objects: (r.objects ?? []).map(shape) };
      }
      await sess.pacer.submit('read', () => c().roomContents());
      await c().waitFor({ kinds: ['room-contents'], timeoutMs: 2500 }).catch(() => {});
      const cl = c();
      return { room: sess.world?.room?.num ?? null,
               objects: [...cl.room.objects.values()]
                 .map(o => shape({ id: o.id, name: cl.rsc.get(o.nameRsc), flags: o.flags,
                                   col: o.col, row: o.row })) };
    },

    // STAND STILL. `hold` answers `{held}` — false when somebody else already has it,
    // which is left alone rather than stolen: reviving another errand's hold is how a
    // character ends up driven by two things at once.
    // `token` renews a hold this exchange already took, for an errand that has outlasted
    // the deadline it asked for. A hold that lapses mid-errand is not a tidy no-op: the
    // keeper wakes up and starts driving a character something else is in the middle of,
    // which is the contention the hold exists to prevent, reached by the one path the
    // deadline was supposed to protect.
    async hold(why, maxMs = 180_000, token = null) {
      if (proxied) {
        const r = await sess.holdStill(why, maxMs, token);
        if (r?.error) return { held: false, reason: r.error };
        return { held: !!r?.held, token: r?.hold?.token ?? null,
                 renewed: !!r?.renewed, reason: r?.reason };
      }
      const p = autopilotIfAny(sess.name);
      if (!p?.running) return { held: false, reason: 'no keeper is running' };
      // OURS ALREADY: renew it. `goInert` returns early when the keeper is already inert,
      // so its own `INERT_MAX_MS` deadline is moved in place rather than re-taken. Without
      // this the branch below would read our own hold as somebody else's and refuse it.
      if (token === IN_PROCESS_HOLD && p.inert) {
        p.inert.at = Date.now();
        if (maxMs) p.inert.maxMs = maxMs;
        return { held: true, renewed: true, token: IN_PROCESS_HOLD };
      }
      // ALREADY HELD BY SOMEBODY ELSE. `running` stays true while a keeper is inert, so
      // without this a trade nested inside another errand would revive a hold it never
      // took, and hand the character back mid-way through someone else's walk.
      if (p.inert) return { held: false, reason: 'already held by another errand' };
      // Named, so the outage this creates is not later read as a keeper fault.
      p.stop(why);
      return { held: true, token: IN_PROCESS_HOLD };
    },
    async release(why, token) {
      if (proxied) {
        const r = await sess.releaseHold(why, token);
        return { released: !!r?.released, reason: r?.reason ?? r?.error };
      }
      try { autopilotIfAny(sess.name)?.start(); return { released: true }; }
      catch (e) { return { released: false, reason: e.message }; }
    },

    // Both kinds now answer the same question — did this character arrive — because
    // `KeeperProxy.travelExclusive` was fixed to match `Session.travelExclusive` rather
    // than hand back the job wrapper.
    travelTo(dest, timeoutMs) {
      return sess.travelExclusive(dest, { maxHops: 20, timeoutMs })
                 .catch(e => ({ arrived: false, reason: e.message }));
    },

    // The four packets of the handshake, plus the stream position they have to be read
    // against. `seq` is taken BEFORE anything is sent so that a reply which lands during
    // the round trip is still inside the window the wait looks at; `waitFor`'s own default
    // is "from now", which steps over exactly that case.
    async seq() {
      if (proxied) { const r = await sess.tradeStep('seq'); return r?.seq ?? null; }
      return c().evSeq;
    },
    async cancelOffer() {
      if (proxied) return sess.tradeStep('cancel');
      return sess.pacer.submit('trade', () => c().cancelOffer()).catch(() => null);
    },
    async offer(toId, items) {
      if (proxied) return sess.tradeStep('offer', { to_id: toId, items });
      return sess.pacer.submit('trade', () => c().offer(toId, items));
    },
    async sawOffer(since, timeoutMs) {
      if (proxied) {
        const r = await sess.tradeStep('await_offer', { since, timeout_ms: timeoutMs });
        return !!r?.saw;
      }
      const w = await c().waitFor({ since, kinds: ['offered-to-us'], timeoutMs })
                         .catch(() => ({ events: [] }));
      return !!w?.events?.length;
    },
    async counterOffer(items = []) {
      if (proxied) return sess.tradeStep('counter', { items });
      return sess.pacer.submit('trade', () => c().counterOffer(items));
    },
    async sawCounter(since, timeoutMs) {
      if (proxied) {
        const r = await sess.tradeStep('await_countered', { since, timeout_ms: timeoutMs });
        return { saw: !!r?.saw, may_accept: r?.trade?.may_accept ?? null };
      }
      const w = await c().waitFor({ since, kinds: ['countered'], timeoutMs })
                         .catch(() => ({ events: [] }));
      return { saw: !!w?.events?.length, may_accept: c().trade?.mayAccept ?? null };
    },
    async acceptOffer() {
      if (proxied) return sess.tradeStep('accept');
      return sess.pacer.submit('trade', () => c().acceptOffer());
    },
    // EVERYTHING THE SERVER SAID TO THIS SIDE SINCE `since`.
    //
    // Both sides are read, because the offer failures are addressed to different people:
    // the GIVER is told "<name> can't carry all the items you have offered" and the
    // RECEIVER is told "You can't carry all the items that <name> has offered you"
    // (user.kod:178-181). Reading only one side would miss half the diagnoses.
    async saidSince(since, timeoutMs = 1200) {
      if (proxied) {
        const r = await sess.tradeStep('said', { since, timeout_ms: timeoutMs })
                            .catch(() => null);
        return [].concat(r?.said ?? []);
      }
      const w = await c().waitFor({ since, kinds: ['message', 'said'], timeoutMs })
                         .catch(() => ({ events: [] }));
      return (w?.events ?? []).map(e => e.text).filter(Boolean);
    },
  };
}

// WHY A HAND-OVER FAILED, FROM THE SERVER'S OWN WORDS RATHER THAN FROM A GUESS.
//
// Every line here is a message resource in kod/object/active/holder/nomoveon/battler/
// player/user.kod:157-181, and each is sent at a single site with the trade cancelled
// immediately afterwards. That makes them DEFINITIVE: if the text is on the wire, that is
// the reason, and no inference about pack percentages is needed or wanted.
//
// The `%s%s` in the resources is a definite article plus a name, so every pattern here is
// anchored on the invariant half of the sentence and tolerant of whatever is spliced in.
//
// This exists because the honest-but-hedged version cost real time: the note used to read
// "a receiver that can give but not receive is NEARLY ALWAYS full", a caller read the first
// two fields of the JSON, concluded the giver was refusing to release the item, and spent
// an hour building a theory about keeper ownership while six hand-overs failed for want of
// pack space. A hedge invites a theory; a fact ends one.
const OFFER_FAILURES = [
  { re: /can'?t carry all the items you have offered/i,
    code: 'receiver_full',
    why: 'the receiver cannot hold it — the server refused the offer on weight or bulk ' +
         'and cancelled the trade. Free space on the RECEIVER and retry' },
  { re: /you can'?t carry all the items that .* offered you/i,
    code: 'receiver_full',
    why: 'the receiver cannot hold it — the server refused the offer on weight or bulk ' +
         'and cancelled the trade. Free space on the RECEIVER and retry' },
  { re: /doesn'?t seem to want to be given/i,
    code: 'item_refuses_to_leave',
    why: 'the item itself refused to be handed over — a cursed weapon in the use list ' +
         'does exactly this, and no amount of retrying will move it' },
  { re: /didn'?t have everything offered/i,
    code: 'giver_no_longer_has_it',
    why: 'the giver no longer had everything offered when the trade closed' },
  { re: /can'?t deal with you now/i,
    code: 'counterparty_busy',
    why: 'the counterparty was busy with another trade or dialogue' },
  { re: /is no longer here/i,
    code: 'counterparty_left',
    why: 'the counterparty left the room before the offer completed' },
  { re: /is not online to accept/i,
    code: 'counterparty_offline',
    why: 'the counterparty is not online' },
  { re: /can'?t offer that many/i,
    code: 'amount_refused',
    why: 'the server refused the quantity offered' },
];

/** The first definitive reason present in anything either side was told, or null. */
export function offerFailureFrom(lines = []) {
  for (const line of [].concat(lines)) {
    const hit = OFFER_FAILURES.find(f => f.re.test(String(line || '')));
    if (hit) return { code: hit.code, why: hit.why, said: String(line) };
  }
  return null;
}

// The whole hand-over, driven from both ends, because both ends are ours.
//
// Shared by the `supply` tool and by the quartermaster resupply pass. It is one
// function because the ORDER is the part that is easy to get wrong: accepting before a
// counteroffer has arrived is logged by the server as cheating and cancels the trade,
// and a trade that never completed looks exactly like one that did unless somebody
// reads the receiver's inventory afterwards.
export async function supplyBetween(a, deps) {
  const { session, isProxied, autopilotIfAny } = deps;
  const gs = session(a.from), rs = session(a.to);
  gs.need(); rs.need();
  if (a.from === a.to) throw new Error('a character cannot supply itself');
  const give = supplyOps(gs, deps), recv = supplyOps(rs, deps);
  const giverName = give.name(), receiverName = recv.name();

  // What to hand over. Reagents are matched by name because the server gives us
  // names, not classes, and the two the creation spells need are the only ones
  // worth naming here.
  //
  // A FUNCTION, BECAUSE THE PACK IS RE-READ AFTER THE WALK. This was worked out once, at
  // the top, and then offered minutes later at the far end of a cross-map journey — during
  // which the giver is still fighting, looting and eating, because a journey deliberately
  // leaves it able to. Offering an id it no longer holds is not an error on the wire; the
  // offer simply carries less than it says, and the amount check at the bottom then reports
  // a partial delivery with no explanation for it.
  const nameOf = o => give.client().rsc.get(o.nameRsc) || '';
  const pick = (inventory) => {
    if (Array.isArray(a.what)) {
      // Entries may be a bare id — meaning the WHOLE stack — or {id, amount} for part
      // of one. The distinction is not cosmetic: lending a character the price of a
      // meal and emptying its purse are different acts, and without this the second
      // was the only one on offer. Waldorf lent Rizzo its entire 1,311 and was left
      // with nothing and no food, which is the problem moved rather than solved.
      const want = new Map(a.what.map(w => typeof w === 'object' && w
        ? [Number(w.id), Number(w.amount)] : [Number(w), null]));
      return inventory.filter(o => want.has(o.id)).map(o => {
        const cap = want.get(o.id);
        if (cap == null || !(o.amount > 0)) return o;
        return { ...o, amount: Math.max(1, Math.min(o.amount, cap)) };
      });
    }
    if (a.what === 'all') return [...inventory];
    if (a.what === 'food') return skills.larderOf(give.client()).map(x => x.o);
    // `amount` IS A QUANTITY OF REAGENTS, NOT A NUMBER OF PACK ENTRIES.
    //
    // This was `.slice(0, per)`, which caps how many inventory ENTRIES are taken —
    // and reagents stack, so elderberry is one entry however many it holds. Asking
    // for 10 handed over the whole stack: the almoner planned "Sweetums -> Zoot, 10
    // of each" and delivered 46 elderberry and 118 herbs, everything Sweetums had.
    // The next character in the same run got "carrying nothing matching reagents"
    // and the nine after that got "nobody left with a share to give" — one donor
    // could feed exactly one caster per pass, which is why 11 characters could not
    // cast create food while the fleet held reagents in abundance.
    //
    // The {id, amount} partial-stack form a few lines above is the mechanism that
    // already exists for this; the reagent path simply was not using it.
    const per = num(a.amount, 2);
    const take = re => inventory.filter(o => re.test(nameOf(o)))
      .map(o => (o.amount > 0 ? { ...o, amount: Math.max(1, Math.min(o.amount, per)) } : o));

    // `what` NAMES A REAGENT. IT USED TO BE IGNORED.
    //
    // Everything that was not an id list, `all` or `food` fell through to the two lines
    // below — elderberry and herb, the create-food pair — and the caller was told
    // `supplied: true` with those two handed over. So `supply --what sapphire` reported
    // success and delivered an elderberry and a herb, which is the worst possible answer:
    // it is a receipt for a thing that did not happen.
    //
    // Measured 2026-09-09 trying to get Camilla the sapphires bless needs (2 mushroom +
    // 2 sapphire per cast): three separate attempts each came back
    // `handed_over: ["elderberry","herb"]` and I read them as a partial success twice
    // before looking at the names.
    //
    // The default is UNCHANGED. No `what` still means the casting pair, so every caller
    // that relies on that — the almoner, the resupply errand — behaves exactly as it did.
    // A named `what` is matched against the item name as a whole word, so `sapphire` does
    // not also take `sapphire ring` by accident and `orc tooth` matches with any spacing.
    if (typeof a.what === 'string' && a.what.trim() &&
        !/^(reagents?|casting)$/i.test(a.what.trim())) {
      // Compared as NAMES, not as a built regex. The first version of this line built one
      // from the argument and lost its escapes to the template literal - `` inside a
      // backtick string is a backspace character, not a word boundary - so `sapphire`
      // compiled to /(^|)sapphires?(|$)/ and matched nothing. A plain comparison cannot
      // have that bug, and this is a short list of short names.
      const wanted = a.what.trim().toLowerCase().replace(/\s+/g, ' ');
      const hit = (o) => {
        const n = nameOf(o).toLowerCase().replace(/\s+/g, ' ').trim();
        return n === wanted || n === `${wanted}s` || `${n}s` === wanted;
      };
      return inventory.filter(hit).map(o => (o.amount > 0
        ? { ...o, amount: Math.max(1, Math.min(o.amount, per)) } : o));
    }
    return [...take(/elder\s*berry/i), ...take(/herb/i)];
  };
  const nothingMatching = (inventory) => ({
    supplied: false,
    reason: `${giverName} is carrying nothing matching ` +
            `${Array.isArray(a.what) ? 'those ids' : (a.what || 'reagents')}`,
    carrying: inventory.map(nameOf),
  });

  // Asked before anything walks anywhere: a donor with nothing to give should not send
  // somebody on a journey to prove it.
  const inventory = await give.inventory();
  let items = pick(inventory);
  if (!items.length) return nothingMatching(inventory);

  const who = a.who_travels || 'from';
  const mover = who === 'to' ? recv : give;
  const stander = who === 'to' ? give : recv;
  // THE HOLDS, AND WHICH ONE IS TAKEN WHEN. See the note over `supplyOps`: the walker is
  // protected by the job slot and `goTravelling` and must keep its survival ladder; the
  // one standing still is on an errand and needs its keeper stopped or it wanders off.
  const holds = [];
  const takeHold = async (ops, why, maxMs) => {
    // RENEW OURS RATHER THAN ASK FOR A SECOND ONE. A hold this exchange already took is
    // re-asserted by presenting its token, which moves the keeper's deadline instead of
    // being refused as "already held" — by us — and then left to lapse in the middle of
    // the trade it was taken for.
    const mine = holds.find(h => h.ops === ops);
    const h = await ops.hold(why, maxMs, mine?.token ?? null);
    if (h.held && !mine) holds.push({ ops, token: h.token });
    return h;
  };
  const notes = [];

  try {
    // TWO UNKNOWNS ARE NOT THE SAME ROOM.
    //
    // This compared the two room numbers directly, and `undefined !== undefined` is
    // FALSE — so whenever either side's room could not be read, the walk was skipped
    // on the grounds that they were already together, and the handover then failed
    // with "X is not in the room with Y" having never taken a step. Clifford stood
    // one hop from Waldorf and reported that, with no travel attempt in the log at
    // all, which is what gave it away.
    //
    // Unknown means travel: walking to where we think they are is recoverable, and
    // deciding they are next to us on the strength of two nulls is not.
    const myRoom = give.room(), theirRoom = recv.room();
    const apart = myRoom == null || theirRoom == null || myRoom !== theirRoom;
    if (who !== 'neither' && apart) {
      // Hold the one being walked TO, for the length of the walk. Without it its keeper
      // takes it back to its hunting ground every pass and the mover chases a moving
      // target — Zoot was steered across four rooms in twenty-five attempts and never
      // arrived. The mover is deliberately NOT held; `travelJob` already stops its keeper
      // driving and leaves it able to defend itself.
      // Longer than the walk it is covering, with room for the handshake at the end of
      // it — a hold that expires exactly when it is needed is the same as no hold.
      const sh = await takeHold(stander, 'standing still for a supply exchange',
                                num(a.walk_ms, 300_000) + 120_000);
      if (!sh.held) notes.push(`could not hold ${stander.name()} still: ${sh.reason}`);

      // ARRIVAL IS SEEING THEM, NOT MATCHING A ROOM NUMBER.
      //
      // This treated "our room number equals theirs" as arrival and broke out of the
      // loop without moving. Both characters are being driven around by the
      // supervisor, so those two readings flicker into agreement all the time —
      // Clifford reported arrival while it was in 584 and Waldorf in 586, and the
      // handover then failed with the two of them rooms apart and no travel ever
      // attempted. A room number is a stale scalar; the recipient being in our own
      // room contents is the thing the offer actually needs.
      const wantName = () => (stander.name() || '').toLowerCase();
      const canSeeThem = async () => {
        const seen = await mover.seeRoom();
        return seen.objects.some(o => (o.flags & OF.PLAYER) &&
                                      (o.name || '').toLowerCase() === wantName());
      };
      // JUDGE THE WALK ON WHETHER THE ROOM CHANGED, not on how many tries are left.
      //
      // A fixed six is both too few and too many. Rooms are not adjacent the way the
      // route suggests — an edge you can route through is not necessarily one you can
      // step through from the square the router picked — so a walk that returns
      // arrived:false has usually still moved, and the next attempt carries on from
      // there. One character took FOUR attempts for a five-hop trip and each of the
      // first three "failed". But a walk that is genuinely blocked repeats the same
      // room for ever, and spending six turns proving it wastes the minutes the
      // errand needed for somebody else.
      //
      // So: keep going while the room keeps changing, stop after three attempts that
      // do not move. This is the same rule m59-feed.mjs uses to reach a shop.
      //
      // AND IT IS BOUNDED IN WALL CLOCK, not only in attempts. Twelve attempts of a walk
      // that each wait for a journey to finish is up to three quarters of an hour on one
      // call — which is not a slow delivery, it is a tool that never returns. The first
      // measured run of this hit exactly that: the caller gave up at five minutes and the
      // exchange carried on holding a character nobody was waiting for any more. So the
      // whole walk gets a deadline, each attempt gets whatever is left of it, and running
      // out is reported as running out rather than as a blocked route.
      const walkDeadline = Date.now() + num(a.walk_ms, 300_000);
      const left = () => walkDeadline - Date.now();
      let arrived = await canSeeThem(), why = null;
      let stuck = 0, wasIn = mover.room(), tries = 0;
      for (let i = 0; i < 12 && !arrived && stuck < 3 && left() > 15_000; i++) {
        // Re-read the destination each time: the other one may itself have moved,
        // and chasing where it WAS is how this used to end up in the wrong room.
        const dest = stander.room();
        if (dest == null) { why = 'cannot see which room the other one is in'; break; }
        tries++;
        const t = await mover.travelTo(dest, Math.min(180_000, left()));
        why = t.arrived ? null : t.reason;
        arrived = await canSeeThem();
        const nowIn = mover.room();
        if (nowIn === wasIn) stuck++; else { stuck = 0; wasIn = nowIn; }
      }
      if (!arrived && left() <= 15_000)
        why = `still walking after ${Math.round(num(a.walk_ms, 300_000) / 1000)}s ` +
              `(${tries} attempt(s)); last: ${why ?? 'no reason given'}`;
      if (!arrived)
        return { supplied: false,
                 reason: `${mover.name()} could not get there: ${why}`,
                 giver_in: give.room(), receiver_in: recv.room(),
                 notes: notes.length ? notes : undefined,
                 attempts: tries,
                 note: 'travel is resumable, so this kept going while the room kept ' +
                       'changing and stopped after three attempts that did not move, or ' +
                       'when the walk ran out of its deadline — `walk_ms` moves that' };
    }

    // HOLD BOTH ENDS FOR THE HANDSHAKE, WHATEVER HAPPENED ABOVE.
    //
    // A trade is four interleaved steps across two sessions and any action by either
    // keeper cancels it. Fozzie and four hungry characters were standing in the same
    // room; the first offer went out, the receiver's keeper cancelled it, and the food
    // was left sitting in a dead trade window — the next three deliveries then reported
    // "carrying nothing matching food", because it was no longer in the pack.
    //
    // RE-ASSERTED HERE, INCLUDING THE ONE ALREADY HELD FOR THE WALK. An inert keeper WAKES
    // ON A DEADLINE, and the hold taken before a five-minute walk can lapse in the seconds
    // between arriving and offering — at which point its keeper starts driving a character
    // that is mid-trade, which is the contention the hold exists to prevent, reached
    // through the one path the deadline was meant to protect. The broker's travel tool has
    // the same note and watched it happen. `takeHold` presents the token, so this renews
    // ours and takes a new one for the other end.
    for (const ops of [give, recv]) {
      const h = await takeHold(ops, 'a supply exchange owns this character', 120_000);
      if (!h.held) notes.push(`could not hold ${ops.name()} for the trade: ${h.reason}`);
    }

    // The receiver has to be visible to the giver for the offer to resolve — and the
    // giver's picture of the room may be minutes old.
    //
    // BP_ROOM_CONTENTS is what fills this map, and nothing had asked for it since
    // before the walk. So the handover looked for the recipient in a snapshot taken
    // somewhere else and reported "X is not in the room with Y" while the two were
    // standing together. It is the same failure as the room-number comparison above,
    // one step later: acting on a stale reading rather than asking.
    const here = await give.seeRoom();
    const wanted = (receiverName || '').toLowerCase();
    const them = here.objects.find(o => (o.flags & OF.PLAYER) &&
                                        (o.name || '').toLowerCase() === wanted);
    if (!them)
      return { supplied: false,
               reason: `${receiverName} is not in the room with ${giverName}`,
               giver_in: give.room(), receiver_in: recv.room(),
               notes: notes.length ? notes : undefined,
               players_the_giver_can_see: here.objects
                 .filter(o => o.flags & OF.PLAYER).map(o => o.name).slice(0, 6) };

    // A HALF-FINISHED TRADE HOLDS THE GOODS. Clearing both sides first is cheap and
    // stops one failed delivery from eating the larder for every delivery after it.
    await give.cancelOffer();
    await recv.cancelOffer();
    await new Promise(x => setTimeout(x, 400));

    // WHAT EACH SIDE HELD BEFORE, BY QUANTITY.
    //
    // The check at the bottom of this function used to ask whether the receiver's
    // inventory CONTAINED A NAME, which is trivially true for anything it already
    // carries. So handing 1,498 shillings to a character holding 10,261 of them
    // reported `supplied: true` with nothing moved; so did every reagent delivery to
    // somebody who already had one herb. A name cannot answer "did this trade happen",
    // and an amount can. Snapshot both sides here and diff them after the accept.
    const countsOf = (rows, rsc) => {
      const m = new Map();
      for (const o of rows) {
        const n = rsc(o);
        m.set(n, (m.get(n) || 0) + (o.amount || 1));
      }
      return m;
    };
    const recvRows = await recv.inventory();
    const recvName = o => recv.client().rsc.get(o.nameRsc) || '';
    const recvBefore = countsOf(recvRows, recvName);
    const giverRows = await give.inventory();
    const giveBefore = countsOf(giverRows, nameOf);
    // RE-PICKED AGAINST THE PACK AS IT IS NOW. See `pick` above: the selection made
    // before the walk describes a pack that has been fought, looted and eaten out of
    // since. This read has to happen anyway for the before-count, so the re-pick is free.
    items = pick(giverRows);
    if (!items.length) return nothingMatching(giverRows);
    const before = recvRows.length;

    // WHERE THE RECEIVER'S STREAM IS BEFORE THE OFFER GOES OUT. Read after, the wait
    // starts from a point the offer may already be behind — `waitFor` defaults `since` to
    // "now" — and a delivery that landed reports "the offer never reached them".
    const recvSeq = await recv.seq();

    // offer -> counter with NOTHING (that is how a gift is accepted, and it is what
    // grants the giver permission to accept) -> giver accepts.
    // OFFER THE WHOLE STACK, NOT ONE OF IT.
    //
    // Mapping to bare ids throws the quantity away, and the server reads "is there a
    // quantity here" from the tag nibble alone — so a bare id means ONE. Clifford
    // handed Waldorf a single shilling out of 1647 and the transfer reported complete,
    // because it was: one shilling is what was offered. encodeIdList has taken
    // {id, amount} all along.
    //
    // AND THE TEST IS THE TAG, NOT WHETHER THERE IS MORE THAN ONE. This read
    // `(o.amount ?? 1) > 1`, which is the exact mistake `dropSpec`'s note in m59-parse.mjs
    // was written about: a stack with ONE left carries amount 1, went out as a bare id, and
    // moved nothing. Worse than nothing — `UserDropItems` pairs a PARALLEL number list
    // against the ids the SERVER thinks are NumberItems, POSITIONALLY, so one untagged
    // stack slides every count after it onto the wrong item and the whole offer fails.
    // Measured on shadow: Hhhh (1 elderberry, 1 herb) could hand Jjjj neither, in either
    // direction, with the handshake completing and `may_accept` true each time. Nobody was
    // full. The packet was wrong.
    //
    // `dropSpec` is the one place that question is answered, and it answers it from the
    // server's own tag with the quantity only as a fallback.
    const offered = items.map(o => dropSpec(o, o.amount ?? null));
    await give.offer(them.id, offered);
    if (!await recv.sawOffer(recvSeq, 6000)) {
      await give.cancelOffer();
      return { supplied: false, reason: 'the offer never reached them',
               notes: notes.length ? notes : undefined };
    }
    const giveSeq = await give.seq();
    await recv.counterOffer([]);
    const countered = await give.sawCounter(giveSeq, 6000);
    // Mark the stream on BOTH sides before the accept, so the failure messages the server
    // sends as it cancels are inside the window we later read.
    const saidFromGive = await give.seq();
    const saidFromRecv = await recv.seq();
    await give.acceptOffer();

    // Prove it. A trade that did not complete looks exactly like one that did.
    await new Promise(x => setTimeout(x, 1400));
    const recvAfterRows = await recv.inventory();
    const now = recvAfterRows.map(recvName);
    // READ THE GIVER BACK TOO. The receiver alone is not proof: a character that is
    // farming picks shillings and gems off the floor between the offer and this check,
    // so its totals rise for reasons that have nothing to do with this trade. The giver
    // LOSING the stack is the corroborating half, and it costs one read.
    const recvAfter = countsOf(recvAfterRows, recvName);
    const giveAfter = countsOf(await give.inventory(), nameOf);
    // The server tells the two sides DIFFERENT sentences about the same failure, so both
    // are read and pooled before classifying.
    const heard = [...await give.saidSince(saidFromGive), ...await recv.saidSince(saidFromRecv)];
    const failure = offerFailureFrom(heard);

    // ONE VERDICT PER ITEM, ON ARITHMETIC. `asked` is what this call tried to move,
    // `received` is what the receiver's own count rose by, `giver_lost` is what left the
    // giver. The two can disagree honestly — the giver may be eating reagents while we
    // look — so the receiver's gain decides and the giver's loss is reported beside it
    // rather than folded into the verdict.
    const moved = [], missed = [];
    for (const o of items) {
      const n = nameOf(o);
      const received = (recvAfter.get(n) || 0) - (recvBefore.get(n) || 0);
      const giver_lost = (giveBefore.get(n) || 0) - (giveAfter.get(n) || 0);
      // `|| 1`, NOT `?? 1`. A non-stack honestly carries amount 0 now — that is the whole
      // point of publishing the wire's answer — and `?? 1` does not catch a zero, so a
      // hammer that moved reported `asked: 0, received: 1`. Measured on shadow the first
      // time a mixed offer worked. Nothing was wrong with the delivery; the report was
      // arithmetic nonsense, which is the kind of thing that gets believed.
      (received > 0 ? moved : missed).push({ name: n, asked: o.amount || 1, received, giver_lost });
    }
    // SUPPLIED MEANS ALL OF IT. A partial hand-over is something the caller has to know
    // about and retry: the almoner cooks immediately after a delivery, and a half-filled
    // one makes it cast a spell that fails silently for want of the other half. So
    // anything short of everything asked for is false, with `partial` saying which.
    const allMoved = items.length > 0 && missed.length === 0;
    // REASON FIRST, AND IN EVERY RESPONSE.
    //
    // A caller that reads one field reads the first one. This used to be `supplied: false`
    // followed by five fields of arithmetic, with the explanation last under `note` — and
    // the explanation was the only part that told anyone what to DO. Leading with it costs
    // nothing and removes the failure mode where a true answer goes unread.
    const reason = allMoved
      ? "delivered: every item asked for rose in the receiver's own count"
      : failure ? `${failure.code}: ${failure.why}`
      : moved.length ? 'partial: some items moved and some did not — see not_received'
      : countered.saw === false
        ? 'no_counteroffer: the counteroffer never arrived, so the accept ended the trade ' +
          'rather than completing it'
        : 'unexplained: no count rose on the receiver and the server said nothing this ' +
          'side recognises. Check pack.percent and pack.binding on the RECEIVER first — ' +
          'that is the usual cause when the wire is silent';
    return {
      reason,
      // The machine-readable half of `reason`, present only when the server actually said
      // something we recognise. Absent means "not established", never "fine".
      ...(failure ? { reason_code: failure.code, server_said: failure.said } : {}),
      supplied: allMoved,
      partial: moved.length > 0 && missed.length > 0,
      from: giverName, to: receiverName,
      handed_over: moved.map(m => m.name),
      amounts: moved,
      not_received: missed,
      receiver_carrying: now.length, was_carrying: before,
      travelled: who !== 'neither' ? who : null,
      notes: notes.length ? notes : undefined,
      // WHY AN ACCEPT CAN LAND AND MOVE NOTHING. `may_accept` goes true on the offerer's
      // side only when the counteroffer has arrived; false means this accept ENDED the
      // trade instead of completing it, which is otherwise indistinguishable from a
      // receiver that is simply too full to take anything.
      ...(allMoved ? {} : { counteroffer_seen: countered.saw, may_accept: countered.may_accept }),
      note: allMoved
        ? 'verified BY AMOUNT: every item asked for rose in the receiver\'s own count'
        : moved.length
          ? 'PARTIAL — some items moved and some did not; see not_received'
          : countered.saw === false
            ? 'the counteroffer never arrived, so the accept ended the trade rather than ' +
              'completing it'
            : 'the trade did not complete — no count rose on the receiver. A receiver that ' +
              'can give but not receive is nearly always full: read pack.percent and ' +
              'pack.binding, not carrying',
    };
  } finally {
    // PUT THE KEEPERS BACK, on every path out — the returns above, and any throw.
    // A keeper left stopped is a character that quietly stops earning, and the
    // errand-runner is the last thing anyone thinks to check. Two were found
    // stopped this afternoon for exactly this reason, one of them for half an hour.
    // Only ever OURS: a hold we failed to take belongs to somebody else's errand, and
    // reviving it is how a character gets driven by two things at once again.
    for (const h of holds) {
      try { await h.ops.release('supply exchange finished', h.token); }
      catch { /* every one of them gets a go */ }
    }
  }
}
