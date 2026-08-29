#!/usr/bin/env node
// m59-proxymutate-test.mjs — THE PICTURE CLIENT COULD NOT ACT, AND EIGHT TOOLS DIED ON IT.
//
//   node tools/m59-proxymutate-test.mjs
//
// Offline. Opens no socket, starts no broker, touches no roster.
//
// ======================== WHAT THIS PINS ========================
//
// `KeeperProxy.need()` hands the emulated client to every MCP tool that ACTS on something.
// That object implemented the reading side only — state, vitals, equipment, inventory,
// room, self — so every mutation threw a TypeError in the broker before a byte reached the
// wire:
//
//     TypeError: c.roomContents is not a function     fight, escape_underworld
//     TypeError: c.attack is not a function           attack
//     TypeError: c.cast is not a function             cast
//     TypeError: c.buy is not a function              shop
//     TypeError: c.apply is not a function            act eat
//     TypeError: c.stand is not a function            rest
//     TypeError: c.look is not a function             faction_status
//
// Measured over roughly four hours of supervised play on one keeper-driven character: no
// usable mutation path at all — combat, resting, casting, shopping and item use were
// unavailable, and the character stayed alive only on its own keeper's autopilot. Every
// character in a running fleet is keeper-driven, so this was the whole fleet.
//
// The fix is the arrangement the movement tools have used since the keeper split: the
// broker never touches the wire, the order crosses as an `/action` name, and the process
// that owns the socket executes it. Three things had to exist for that to work:
//
//   1. the mutation methods themselves, forwarding to `/action`;
//   2. an EVENT WINDOW, because in this game sending the packet is never the whole of a
//      tool — a merchant refusal is a sentence spoken to the room, not an error on the
//      wire — and `waitFor` used to answer "there is no event stream here";
//   3. a REAL self object id, because `apply(food, selfId)` is how eating works
//      (food.kod:56) and `selfId` was the placeholder -1, a number the server has never
//      heard of. That was harmless only for as long as this client could not act.

import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};

const BROKER = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
const KEEPER = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');
const SKILLS = readFileSync(new URL('./m59-skills.mjs', import.meta.url), 'utf8');
const CLIENT = readFileSync(new URL('./m59-client.mjs', import.meta.url), 'utf8');

// The emulated client is the object literal inside `get client()`. Slicing to it keeps
// these assertions off the REAL Session's methods, which have always existed.
const PROXY = BROKER.slice(BROKER.indexOf('class KeeperProxy'),
                           BROKER.indexOf('function makeKeeperProxy'));
const EMULATED = PROXY.slice(PROXY.indexOf('get client()'), PROXY.indexOf('get world()'));

// ------------------------------------------------------------------ 1. the methods

console.log('\nevery verb a tool calls on `c` now exists on the picture client');
{
  // One row per line of the issue's table, plus the neighbours in the same `act` verb set.
  // The name on the left is what the broker or m59-skills.mjs calls; the name on the right
  // is the `/action` verb the keeper answers to.
  const wired = {
    attack: 'attack', cast: 'cast', buy: 'shop', buyItems: 'buyitem',
    apply: 'apply', use: 'use', unuse: 'unuse', get: 'pickup', drop: 'drop',
    activate: 'activate', stand: 'stand', rest: 'rest', look: 'look',
    face: 'face', roomContents: 'room_contents',
  };
  for (const [method, verb] of Object.entries(wired)) {
    ok(`c.${method} exists and goes to /action ${verb}`,
       new RegExp(`\\b${method}: \\(?[^\\n]*=>[\\s\\S]{0,900}?act\\('${verb}'`).test(EMULATED));
  }
  ok('and they all go through one helper, so none of them can touch the wire directly',
     /const act = \(name, args\) => keeperAction\(proxy\.name, proxy\._index, name, args\);/.test(PROXY));
  ok('the helper is bound to the PROXY, not to the client literal `this`',
     /const proxy = this;/.test(PROXY));

  // Every verb the client is wired to must be one the keeper actually answers, or the call
  // succeeds, returns `unknown action`, and reports no error to anybody.
  for (const verb of new Set(Object.values(wired))) {
    ok(`the keeper has a case for '${verb}'`,
       new RegExp(`case '${verb}':`).test(KEEPER));
  }
}

console.log('\nand the argument names match on both sides of the wire');
{
  // A NAME MISMATCH HERE IS INVISIBLE. The keeper's own `travel` case records what that
  // costs: the proxy sent `toRoomNum`, the keeper read `to`, and every journey answered
  // "no route from 586 to undefined" — which reads as bad terrain, not as bad wiring, and
  // was blamed on the terrain.
  // NAMED EVERY WAY THE KEEPER HAS EVER READ IT. These verbs have gone through more than
  // one spelling; a keeper takes the names it knows and ignores the rest, so sending all of
  // them costs nothing and cannot be silently wrong.
  ok('opening a shop names the seller by every id key in use',
     /act\('shop', \{ op: 'list', id: sellerId, seller_id: sellerId \}\)/.test(EMULATED));
  ok('and the keeper reads one of them', /args\.id \?\? args\.object/.test(KEEPER));
  // A BARE ID BUYS NOTHING AND SAYS NOTHING. encodeIdList writes it as four plain bytes
  // with no tag nibble, so the server's number_list arrives empty and UserBuyItems has no
  // quantity to pair with the item.
  ok('a buy carries {id, amount} specs, passed through rather than re-derived',
     /act\('buyitem', \{ seller: sellerId, seller_id: sellerId, items: list,/.test(EMULATED));
  ok('and the keeper takes the list rather than exactly one id',
     /const wanted = \[\]\.concat\(args\.items \?\? args\.itemId \?\? args\.item \?\? \[\]\)/.test(KEEPER));
  ok('and hands the specs to the client untouched',
     /c\.buyItems\(sellerId, wanted\)/.test(KEEPER));
  ok('attack sends `target`, which is the first thing the keeper looks for',
     /attack: \(id\) => act\('attack', \{ target: id \}\)/.test(EMULATED) &&
     /const targetId = args\.target \?\? args\.id;/.test(KEEPER));
  // The callers hold a runtime OBJECT id because that is what BP_REQ_CAST wants; the
  // keeper matches by name off its own spell list. Resolving on this side means the keeper
  // never has to guess which namespace a bare number belongs to.
  ok('cast resolves the spell id to a name before sending it',
     /const sp = \(s\.spells \?\? \[\]\)\.find\(x => x\.id === spellId\);/.test(EMULATED));
  ok('and still sends the id, so a keeper that would rather have one can take it',
     /spell_id: spellId,/.test(EMULATED));
}

// ------------------------------------------------------------------ 2. the event window

console.log('\nthe reading half, without which a sent packet is not an answer');
{
  ok('waitFor asks the keeper for a window rather than declaring it has none',
     /keeperAction\(proxy\.name, proxy\._index, 'events'/.test(PROXY));
  ok('the keeper serves that window off its own client',
     /case 'events': \{[\s\S]{0,900}await c\.waitFor\(\{/.test(KEEPER));
  ok('and bounds the wait, because a caller would otherwise hold a keeper that has a body to drive',
     /timeoutMs: Math\.min\(20000, Math\.max\(0, Number\(args\.timeout_ms\) \|\| 4000\)\),/.test(KEEPER));
  ok('the window is anchored on a mark the snapshot carries',
     /ev_seq: session\.client\?\.evSeq \?\? null,/.test(KEEPER) &&
     /evSeq: s\.ev_seq \?\? null,/.test(EMULATED));
  // FAIL SOFT AND SAY SO. An older keeper has no `events` case; answering `{events: []}`
  // silently would put back the exact bug this fixes, one release later.
  ok('a keeper that cannot serve one still answers in the shape callers destructure',
     /return \{ events: \[\], seq: null, timedOut: true, no_event_stream: true,/.test(PROXY));
  ok('and says why, so "nothing was said" and "nobody could hear" stay different answers',
     /why: r\?\.error \?\? 'this keeper does not serve an event window'/.test(PROXY));
  ok('a single kind is accepted as well as a list — callers pass both',
     /Array\.isArray\(kinds\) \? kinds : \[kinds\]/.test(PROXY));
}

// ------------------------------------------------------------------ 3. the self id

console.log('\nself is an object id now, because eating aims at it');
{
  // EAT IS NOT USE. Food sends ReqEatSomething to the APPLY TARGET, so `use` on a loaf does
  // nothing at all — no message, no error, no vigor — and vigor above 80 can only be eaten.
  ok('the keeper has an apply case distinct from use/equip',
     /case 'apply': \{/.test(KEEPER) && /case 'use':\n {10}case 'equip': \{/.test(KEEPER));
  ok('and the broker routes eating through it rather than through use',
     /apply: \(id, onto\) => act\('apply', \{ id, on: onto \}\)/.test(EMULATED));
  ok('the real client agrees that apply takes two objects',
     /apply\(what, onWhat\) \{/.test(CLIENT));

  ok('the keeper publishes the character\'s own object id',
     /return me \? \{ id: c\.selfId \?\? null, col: me\.col/.test(KEEPER));
  ok('and the emulated client uses it instead of the -1 placeholder',
     /selfId: s\.you \? \(s\.you\.id \?\? -1\) : null,/.test(EMULATED));
  ok('falling back to -1 only for a keeper too old to publish one',
     /id: s\.you\.id \?\? -1, flags: 0/.test(EMULATED));
  // AND THE OLD PLACEHOLDER MUST NOT BE FORWARDED. A -1 from an older broker would apply
  // the food to an object that does not exist, and report no error, because nothing here
  // reports an error.
  ok('the keeper treats a negative target as "self" rather than sending it',
     /\(asked == null \|\| Number\(asked\) < 0\) \? session\.client\?\.selfId : asked/.test(KEEPER));

  // The faction read used to degrade on "does c.look exist". It exists now, so the guard
  // had to move to the thing that actually decides whether a self-look can work.
  // The guard is about the ID, not about the method: `c.look` exists on a keeper-backed
  // client now, so testing for the function would send a look at object -1 and read the
  // empty answer as "the self-profile did not answer".
  ok('the faction self-look degrades on the ID rather than on the method',
     /!\(c\.selfId > 0\)/.test(BROKER));
  ok('and says which it is, so an old keeper is not reported as an unknown faction',
     /no self object id on this session/.test(BROKER) ||
     /faction read from the pack/.test(BROKER));
}

// ------------------------------------------------------------------ 4. the callers

console.log('\nthe call sites the issue listed are reachable again');
{
  // These are the exact expressions from the issue's table. They are asserted to still be
  // there — the fix is that the client now answers them, not that the callers changed.
  const sites = [
    ['attack',            /return c\.attack\(t\.id\);/,                    BROKER],
    ['cast',              /return c\.cast\(mine\.id, targets\);/,          BROKER],
    ['shop browse',       /return c\.buy\(t\.id\)|c\.buy\(targetExpected\.id\)/, BROKER],
    ['act eat',           /eat: \(\) => c\.apply\(wireTarget, c\.selfId\)/, BROKER],
    ['rest / stand',      /return a\.stand \? c\.stand\(\) : c\.rest\(\);/,  BROKER],
    ['faction self-look', /c\.look\(c\.selfId\)/,                          BROKER],
    ['fight',             /c\.roomContents\(\)/,                           SKILLS],
    ['escape_underworld', /c\.look\(rip\.id\)/,                            SKILLS],
  ];
  for (const [what, re, src] of sites)
    ok(`${what} still calls through the emulated client`, re.test(src));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
