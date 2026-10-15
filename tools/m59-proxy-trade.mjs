// THE PERSON'S HALF OF A TRADE, DONE BY THE PROXY ("Automated Courier: Full Auto").
//
// m59-human-handoff.mjs lets the courier own its half of a trade with a piloted character.
// The person still had to work the trade window. This module does their half too, from
// the one place that can: the proxy carrying their connection. It does two things, both
// asked for explicitly and both bounded:
//
//   acceptFrom(id, ttl)   while live, an offer FROM that object id is answered with an
//                         empty counteroffer (= "I accept your gift"); the counterparty's
//                         accept closes it. The client never sees the offer, so no window.
//   give(to, items, ttl)  offer these items TO that object id; when their counteroffer
//                         arrives, accept. Cancelled at the deadline if they never counter.
//
// Every server->client trade packet belonging to an automated trade is swallowed (the
// client would otherwise pop a trade window for a trade it never started). Inventory
// add/remove packets are NOT swallowed, so the person sees items arrive and leave.
//
// It never acts while the person has a trade of their own open (any client-originated
// offer, counter or accept until the server closes it): a human in the middle of a trade
// window always wins.
//
// Injection needs the proxy to own the stream, the same precondition as the control gate
// (calibrated, gateable). session.injectOwned() enforces it.
//
// Opcodes: include/proto.h. Client->server REQ_OFFER 120, ACCEPT_OFFER 121, CANCEL_OFFER
// 122, REQ_COUNTEROFFER 123. Server->client OFFER 211, OFFER_CANCELED 212, OFFERED 213,
// COUNTEROFFER 214, COUNTEROFFERED 215.

import { parseOffer, encodeIdList, objId } from './m59-parse.mjs';

export const OP = { REQ_OFFER: 120, ACCEPT: 121, CANCEL: 122, COUNTER: 123,
                    OFFER: 211, CANCELED: 212, OFFERED: 213, COUNTEROFFER: 214, COUNTEROFFERED: 215 };
const CLIENT_TRADE = new Set([OP.REQ_OFFER, OP.ACCEPT, OP.COUNTER]);

export function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

export class ProxyTrade {
  constructor(session, { now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
                        offerFrom = body => parseOffer(body).from.id } = {}) {
    this.s = session; this.offerFrom = offerFrom; this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.acceptFromIds = new Map();   // objId -> expires
    this.active = null;               // { kind: 'receive'|'give', with, since, phase, items? }
    this.humanTradeAt = 0;            // last client-originated trade packet
    this.results = [];                // newest last, bounded
    this.timer = null;
  }

  // The person's own trade can end with NO packet to them (the accepting side is told
  // nothing), so 'trading' is a window after their last trade packet, not a latch.
  get humanTrading() { return this.humanTradeAt > 0 && this.now() - this.humanTradeAt < 120_000; }

  note(r) { this.results.push({ at: this.now(), ...r }); if (this.results.length > 20) this.results.shift(); }

  acceptFrom(id, ttlMs = 20_000) {
    const ttl = Math.max(1000, Math.min(Number(ttlMs) || 20_000, 300_000));
    this.acceptFromIds.set(objId(Number(id)), this.now() + ttl);
    return { ok: true, from: objId(Number(id)), until: this.now() + ttl };
  }

  give(to, items, ttlMs = 60_000) {
    if (this.active) return { ok: false, why: `an automated ${this.active.kind} is already open` };
    if (this.humanTrading) return { ok: false, why: 'the person has a trade window of their own open' };
    if (!Array.isArray(items) || !items.length) return { ok: false, why: 'nothing to give' };
    const r = this.s.injectOwned(Buffer.concat([Buffer.from([OP.REQ_OFFER]), u32(objId(Number(to))), encodeIdList(items)]));
    if (!r.sent) return { ok: false, why: r.why };
    this.active = { kind: 'give', with: objId(Number(to)), since: this.now(), phase: 'offered', items };
    const ttl = Math.max(5000, Math.min(Number(ttlMs) || 60_000, 300_000));
    this.timer = this.setTimer(() => {
      if (this.active?.kind === 'give' && this.active.phase === 'offered') {
        this.s.injectOwned(Buffer.from([OP.CANCEL]));
        this.active.phase = 'cancelling';
        this.note({ kind: 'give', with: this.active.with, outcome: 'cancelled: no counteroffer before the deadline' });
      }
    }, ttl);
    return { ok: true, offered_to: this.active.with };
  }

  // Client -> server. Returns nothing; only watches.
  onClient(payload) {
    if (CLIENT_TRADE.has(payload[0])) this.humanTradeAt = this.now();
  }

  // Server -> client. Returns true when the packet belongs to an automated trade and must
  // NOT reach the client.
  onServer(payload) {
    const op = payload[0];
    if (op === OP.OFFER) {
      let from = null;
      try { from = objId(this.offerFrom(payload.subarray(1))); } catch { return false; }
      const until = this.acceptFromIds.get(from);
      if (this.active || this.humanTrading || !until || this.now() > until) return false;
      const r = this.s.injectOwned(Buffer.from([OP.COUNTER, 0, 0]));   // empty list: u16 count 0
      if (!r.sent) { this.note({ kind: 'receive', with: from, outcome: `could not counter: ${r.why}` }); return false; }
      this.active = { kind: 'receive', with: from, since: this.now(), phase: 'countered' };
      return true;
    }
    if (!this.active) {
      if (op === OP.CANCELED) this.humanTradeAt = 0;   // the person's own trade ended
      return false;
    }
    if (op === OP.OFFERED && this.active.kind === 'give') return true;
    if (op === OP.COUNTEROFFERED && this.active.kind === 'receive') return true;
    if (op === OP.COUNTEROFFER && this.active.kind === 'give' && this.active.phase === 'offered') {
      const r = this.s.injectOwned(Buffer.from([OP.ACCEPT]));
      this.active.phase = r.sent ? 'accepted' : 'accept-failed';
      // The accepting side is told nothing on success; the trade is over once we accept.
      this.note({ kind: 'give', with: this.active.with, outcome: r.sent ? 'accepted' : `accept failed: ${r.why}` });
      if (this.timer) this.clearTimer(this.timer);
      if (r.sent) this.active = null;
      return true;
    }
    if (op === OP.CANCELED) {
      const a = this.active; this.active = null;
      if (this.timer) this.clearTimer(this.timer);
      if (a.kind === 'receive') this.note({ kind: 'receive', with: a.with, outcome: 'closed after our counter (accepted by them, or cancelled)' });
      else if (a.phase !== 'cancelling') this.note({ kind: 'give', with: a.with, outcome: 'cancelled by the other side' });
      return true;
    }
    return false;
  }

  view() {
    const now = this.now();
    return { accept_from: [...this.acceptFromIds].filter(([, t]) => t > now).map(([id, until]) => ({ id, until })),
             active: this.active, human_trading: this.humanTrading, results: this.results.slice(-5) };
  }
  destroy() { if (this.timer) this.clearTimer(this.timer); }
}
