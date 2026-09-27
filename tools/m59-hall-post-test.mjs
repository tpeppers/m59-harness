#!/usr/bin/env node
// Offline: the vault broker's posts in the Bookmaker's hall — which squares are the booth pocket,
// and that no post is ever reached through the main door.
//
//   node tools/m59-hall-post-test.mjs
import { inBoothPocket, hallPost, guildSection, BOOTH, COUNTER } from './m59-guild-passage.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, detail = '') => { if (cond) { passed++; console.log(`  ok   ${what}`); }
  else { failed++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); } };

console.log('\nthe booth pocket (closed-door geometry)');
ok('the booth itself', inBoothPocket(...BOOTH));
ok('the counter strip east of door 58', inBoothPocket(2, 22));
ok('the booth-side trigger (2,21)', inBoothPocket(...COUNTER.east));
ok('the section-3-side trigger (2,19) is NOT the pocket', !inBoothPocket(...COUNTER.west));
ok('and (2,19) is section 3, the room between booth and chests', guildSection(...COUNTER.west) === 3);
ok('the chest side is not the pocket', !inBoothPocket(18, 4));

console.log('\nnever through the main door');
const walked = [];
const stub = (row, col) => ({ s: { need: () => ({ self: { row, col } }),
  walkTo: async (...a) => walked.push(a), pacer: { submit: async () => {} } }, note: () => {} });
{
  const r = await hallPost(stub(2, 32), 'booth');
  ok('from the foyer the booth is refused', r.ok === false && /main door/.test(r.why), JSON.stringify(r));
  const c = await hallPost(stub(2, 32), 'chests');
  ok('and so are the chests', c.ok === false && /main door/.test(c.why));
  ok('without a single step taken', walked.length === 0);
  const u = await hallPost(stub(18, 4), 'attic');
  ok('an unknown post is refused', u.ok === false && /unknown post/.test(u.why));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
