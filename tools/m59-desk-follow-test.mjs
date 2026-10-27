#!/usr/bin/env node
// A DESK THAT FOLLOWS ITS SERVER, AND THE CHALICE DESK THAT IS THE FIRST ONE -- offline, no socket, no roster.
//
//   node tools/m59-desk-follow-test.mjs
//
// What this pins (tools/m59-desk-follow.mjs, the follows_holder half of m59-chalice.mjs):
//   * a following desk is wherever its server stands; everyone else reads the server's own record, and a stale or
//     missing record is "no desk known", never the last room it was seen in; a fixed desk is unchanged;
//   * chalice station_room 'holder' sets follows_holder and is not refused for being outside a refill room;
//   * THE CUP IS RATIONED: outside a Shal'ille room a ride needs a known count that leaves cup_reserve behind (the last
//     sip deletes it), unknown is a no, a refill room is always a yes; a ride takes one sip, a refill resets to 3;
//   * the keeper binds it: the station resolves live, ride claims are gated, the cup's count is kept on pickup, a
//     holder tops the cup up in a refill room with no stranger present, and a following desk is never "away";
//   * three spells whose reagents are a list literal in the kod read their reagents (they read none before).
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};

const { deskRoom, isFollowing } = await import('./m59-desk-follow.mjs');
const C = await import('./m59-chalice.mjs');

console.log('where a desk is');
const now = 5_000_000;
ok('a fixed desk is its room', deskRoom({ fixed: 2, now }) === 2);
ok('a following desk is the server\'s own room, to the server', deskRoom({ follows: true, isServer: true, here: 370, now }) === 370);
ok('to anyone else, the server\'s published room', deskRoom({ follows: true, record: { room: 370, at: now - 10_000 }, now }) === 370);
ok('a stale record is no desk known, not the old room', deskRoom({ follows: true, record: { room: 370, at: now - 10 * 60_000 }, now }) === null);
ok('no record is no desk known', deskRoom({ follows: true, now }) === null);
ok('"holder", "server", "follow" all mean follow', ['holder', 'Server', ' follow '].every(isFollowing) && !isFollowing(2));

console.log('the chalice config');
const cfg = C.normalizeChalice({ holder: 'Loial the Ogier', station_room: 'holder' });
ok('station_room "holder" follows, and is not refused for being outside a refill room',
   cfg.follows_holder === true && cfg.station_room === null && cfg.enabled === true && !cfg.problems.some(p => /refill/.test(p)), JSON.stringify(cfg.problems));
ok('a fixed station outside a refill room is still refused', C.normalizeChalice({ holder: 'X', station_room: 370 }).enabled === false);
ok('a fixed station is unchanged', C.normalizeChalice({ holder: 'X', station_room: 2 }).follows_holder === false);
ok('cup_reserve defaults to 1', cfg.cup_reserve === 1);

console.log('the cup is rationed');
ok('a refill room is always a yes, sips unknown or not', C.rideBudget({ room: 2, sips: null }).ok === true);
ok('UNKNOWN sips outside a refill room is a no (the last sip deletes the cup)', C.rideBudget({ room: 370, sips: null }).ok === false);
ok('3 sips: a ride (leaves 2)', C.rideBudget({ room: 370, sips: 3, reserve: 1 }).ok === true);
ok('2 sips: a ride (leaves 1, the reserve)', C.rideBudget({ room: 370, sips: 2, reserve: 1 }).ok === true);
ok('1 sip: no ride, and it says why', C.rideBudget({ room: 370, sips: 1, reserve: 1 }).ok === false
   && /last sip deletes it/.test(C.rideBudget({ room: 370, sips: 1, reserve: 1 }).why));
ok('a ride in a refill room refills to 3', C.sipsAfterRide(1, 2) === C.CUP_MIN_SIPS && C.CUP_MIN_SIPS === 3);
ok('a ride elsewhere takes one; unknown stays unknown', C.sipsAfterRide(3, 370) === 2 && C.sipsAfterRide(null, 370) === null);
{
  const store = C.chaliceStoreFor({ fleet: 'test', directory: mkdtempSync(join(tmpdir(), 'm59-desk-follow-')) });
  ok('the store starts with no count', store.cup().sips === undefined);
  store.setCup(3, 'refilled');
  ok('and keeps one', store.cup().sips === 3 && store.cup().why === 'refilled');
}

console.log('the keeper');
{
  const { readToolSource } = await import('./autopilot/source.mjs');
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('the station resolves live for a following desk', /if \(!cfg\?\.follows_holder\) return cfg;[\s\S]{0,900}deskRoom\(\{ follows: true, isServer, here, record, now \}\)/.test(src));
  ok('a ride the cup cannot afford is not claimed', /const t = budget\.ok \? this\.chaliceFleetOnly\(store\.claimNext\(me, \{ kind: 'ride'/.test(src));
  ok('the cup\'s count is kept on every pickup', /store\.setCup\(sipsAfterRide\(store\.cup\(\)\?\.sips, this\.hereRoom\(\)\)/.test(src));
  ok('the holder tops up in a refill room, never with a stranger present',
     /async chaliceTopUp[\s\S]{0,800}REFILL_ROOMS\.has\(here\)[\s\S]{0,700}!party\.isFleetmate/.test(src));
  ok('the top-up runs before the next job is picked', src.indexOf('if (await this.chaliceTopUp(cfg, role, cup, store, now)) return true;')
     < src.indexOf('st = this.chaliceNextJob(cfg, role, cup, store, me, now);') && src.includes('chaliceTopUp(cfg, role, cup, store, now)'));
  ok('the desk is republished when the holder changes room', /const moved = cfg\.follows_holder && this\._chaliceDeskSaidRoom !== this\.hereRoom\(\)/.test(src));
  const ride = readFileSync(new URL('./m59-chalice-ride.mjs', import.meta.url), 'utf8');
  ok('a following desk is never "holder_away"', /if \(!cfg\.follows_holder && desk && !desk\.human/.test(ride));
}

console.log('refilling between uses: the default risk profile, overridable');
{
  const spawns = { rooms: { 568: [{ creature: 'centipede', level: 30 }, { creature: 'baby spider', level: 25 }],
                            547: [{ creature: 'living tree', level: 50 }], 535: [{ creature: 'giant rat', level: 30 }] } };
  const hops = { 2: 9, 568: 3, 547: 1, 535: 5 };
  const cands = C.refillCandidates({ refill: { rooms: [2, 568, 547, 535] }, spawns, hopsTo: r => hops[r] ?? null });
  ok('the default profile: nothing spawning over level 30 (the Lake of Jala\'s Song qualifies)', cands.some(c => c.room === 568) && !cands.some(c => c.room === 547),
     JSON.stringify(cands.map(c => c.room)));
  ok('nearest first: 568 (3 hops), 535 (5), room 2 outside Castle Victoria (9)', cands.map(c => c.room).join() === '568,535,2');
  const bolder = C.refillCandidates({ refill: { rooms: [2, 568, 547], max_spawn_level: 50 }, spawns, hopsTo: r => hops[r] ?? null });
  ok('a bolder desk overrides it, and the 1-hop room 547 comes first', bolder[0]?.room === 547, JSON.stringify(bolder.map(c => c.room)));
  ok('max_hops bounds the search', C.refillCandidates({ refill: { rooms: [2, 568], max_hops: 4 }, spawns, hopsTo: r => hops[r] ?? null }).map(c => c.room).join() === '568');
  ok('avoid takes a room out', !C.refillCandidates({ refill: { rooms: [2, 568], avoid: [568] }, spawns, hopsTo: r => hops[r] ?? null }).some(c => c.room === 568));
  ok('a room that is not a refill room is never a candidate', C.refillCandidates({ refill: { rooms: [370] }, spawns, hopsTo: () => 1 }).length === 0);
  ok('due when short and nothing it can serve is waiting', C.refillDue({ sips: 2 }).due === true && C.refillDue({ sips: null }).due === true);
  ok('not due when full', C.refillDue({ sips: 3 }).due === false);
  ok('a waiting ride it can serve goes first', C.refillDue({ sips: 2, pendingRides: 1, budgetOk: true }).due === false);
  ok('a waiting ride it cannot serve does not stop the refill', C.refillDue({ sips: 1, pendingRides: 1, budgetOk: false }).due === true);
  const f = C.normalizeChalice({ holder: 'L', station_room: 'holder' });
  ok('a following desk refills by default (level 30, 12 hops, returns to its post)', f.refill?.roam === true && f.refill.max_spawn_level === 30
     && f.refill.max_hops === 12 && f.refill.return === true);
  const g = C.normalizeChalice({ holder: 'L', station_room: 'holder', refill: { max_spawn_level: 50, rooms: [2, 568] } });
  ok('and takes the desk\'s own risk profile', g.refill.max_spawn_level === 50 && g.refill.rooms.join() === '2,568' && !g.problems.length, JSON.stringify(g.problems));
  ok('refill: false keeps it home', C.normalizeChalice({ holder: 'L', station_room: 'holder', refill: false }).refill.roam === false);
  ok('a disabled desk is declined by travellers instead of waited on',
     C.shouldRide({ cfg: { ...f, enabled: true, desk_disabled: 'no refill room' }, role: 'traveller', stationHops: 0 }).code === 'desk_disabled');
  // allow_exit_confinement_for_refresh (operator: "true (for anywhere) or a number (room #, like 2)")
  const inn = { refill: { rooms: [2, 568, 535] }, spawns, hopsTo: r => hops[r] ?? null, confine: [370] };
  ok('confined, not allowed out: no refill room', C.refillCandidates({ ...inn, allowExit: null }).length === 0);
  ok('allowed out anywhere (true): every room in the profile', C.refillCandidates({ ...inn, allowExit: true }).map(c => c.room).join() === '568,535,2');
  ok('allowed out to room 2 only', C.refillCandidates({ ...inn, allowExit: [2] }).map(c => c.room).join() === '2');
  ok('a refill room inside the confinement needs no permission', C.refillCandidates({ ...inn, confine: [370, 568], allowExit: null }).map(c => c.room).join() === '568');
  ok('the config takes true, a number, or a list', C.normalizeChalice({ holder: 'L', station_room: 'holder', allow_exit_confinement_for_refresh: true }).allow_exit_confinement_for_refresh === true
     && C.normalizeChalice({ holder: 'L', station_room: 'holder', allow_exit_confinement_for_refresh: 2 }).allow_exit_confinement_for_refresh.join() === '2'
     && C.normalizeChalice({ holder: 'L', station_room: 'holder' }).allow_exit_confinement_for_refresh === null);
  const { readToolSource } = await import('./autopilot/source.mjs');
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('the trip out names its one room to travel\'s chalice exception', /leaves \? \{ chalice: true, chaliceRoom: target\.room \}/.test(src));
  ok('the refill trip runs between uses, after the in-room top-up', src.indexOf('if (await this.chaliceRefillTrip(cfg, role, cup, store, now)) return true;')
     > src.indexOf('if (await this.chaliceTopUp(cfg, role, cup, store, now)) return true;'));
  ok('a confinement disables the desk at once rather than being walked through', /if \(went\?\.confined\) \{[\s\S]{0,300}disable\(/.test(src));
  ok('no safe room in reach disables it until the retry', /if \(!cands\.length\) \{\s*disable\(/.test(src));
}

console.log('reagents written as a list literal');
{
  const d = JSON.parse(readFileSync(new URL('../substrate/m59-spells.json', import.meta.url), 'utf8'));
  const all = Object.values(d).flat().filter(r => r && typeof r === 'object' && r.name);
  const by = n => JSON.stringify(all.find(r => r.name === n)?.reagents ?? null);
  ok('resist poison: herbs 2, red mushroom 1', by('resist poison') === '[{"item":"Herbs","count":2},{"item":"RedMushroom","count":1}]', by('resist poison'));
  ok('umbrella: emerald 2, polished seraphym 1', by('umbrella') === '[{"item":"Emerald","count":2},{"item":"PolishedSeraphym","count":1}]', by('umbrella'));
  ok('detect invisible: solagh 2', by('detect invisible') === '[{"item":"Solagh","count":2}]', by('detect invisible'));
  const spells = readFileSync(new URL('./m59-spells.mjs', import.meta.url), 'utf8');
  ok('the extractor reads both spellings', /matchAll\(\/\\\[\\s\*&\(\\w\+\)/.test(spells));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
