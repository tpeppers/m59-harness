#!/usr/bin/env node
// m59-accept-settle-test.mjs — offline. The accepting side of a trade is told nothing on success (OFFER_CANCELED goes
// to the other side), so M59Client.acceptOffer settles its own trade after ACCEPT_SETTLE_MS. Pins: the trade is still
// readable right after the accept (callers read c.trade.theirs a beat later); settle closes it and emits trade-ended;
// a settle from an older accept never closes a newer trade. 2026-11-13: make_space refused "a trade is open" on two
// characters with no trade anywhere.
import { M59Client, ACCEPT_SETTLE_MS } from './m59-client.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const fake = () => { const c = Object.create(M59Client.prototype); c.sent = []; c.events = [];
  c.send = op => c.sent.push(op); c.emit = (k, d) => c.events.push(k); c.tradeRevision = 3; return c; };

ok(ACCEPT_SETTLE_MS >= 5000, 'settle waits long enough for the server to cancel a failed accept');
const c = fake();
c.trade = { withName: 'Rowlf', theirs: [{ id: 1 }] };
c.acceptOffer();
ok(c.sent.length === 1, 'the accept is sent');
ok(c.trade?.theirs?.length === 1 && c.trade.acceptedAt, 'still readable right after the accept');
c.settleAccepted(3);
ok(c.trade === null, 'settle closes an accepted trade the server never closed');
ok(c.events.includes('trade-ended') && c.lastTradeWith?.name === 'Rowlf', 'and says so');

const d = fake();
d.trade = { withName: 'X' }; d.acceptOffer(); d.tradeRevision++; d.trade = { withName: 'Y' };
d.settleAccepted(3);
ok(d.trade?.withName === 'Y', 'an old settle never closes a newer trade');

const e = fake(); e.trade = null; e.acceptOffer();
ok(e.trade === null && e.sent.length === 1, 'accept with no trade is just the send');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
