#!/usr/bin/env node
// EVERY WIRE VERB THE CLIENT CAN SPEAK, THE BROKER'S PROXY CAN FORWARD.
//
//   node tools/m59-keeperproxy-test.mjs
//
// Offline and static: it reads the two files as text. It must NOT import m59-broker.mjs —
// importing runs it, taking the fleet lock and starting rejoin timers (see CLAUDE.md), so
// the one check that would be easiest is the one nobody may run.
//
// WHAT THIS EXISTS FOR. Since the keeper-process migration the World lives in the KEEPER and
// the broker holds a SNAPSHOT. A snapshot can answer questions; it cannot send a packet. So
// every mutation has to be forwarded to the process that owns the socket, and when one is
// not, the failure is this:
//
//     guild action=status  ->  "c.requestGuildInfo is not a function"
//
// That was the state of the ENTIRE guild surface on 2026-09-10: seventeen verbs, every one
// called straight on the snapshot, so founding a guild was impossible fleet-wide — and
// nothing said so until somebody tried it. `M59Client` had all seventeen the whole time
// (m59-client.mjs:1238-1292). The capability was never missing; it was on the wrong side of
// a process boundary.
//
// IT IS THE THIRD TIME. `sellOne` was missing the same way (sell_all failed keeper-backed),
// and `buyItems` before that — "this fleet has zero successful purchases in its recorded
// history while selling always worked." A class of bug that has recurred three times with no
// guard is the definition of one worth a test.
//
// AND IT CANNOT BE CAUGHT BY RUNNING THINGS. A missing forward is a TypeError at the moment
// of use, on a live fleet, in a verb nobody exercises often — guild founding happens once.
// The offline suites drive fakes, and a fake has whatever methods the test gave it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(TOOLS, f), 'utf8');

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};

const client = read('m59-client.mjs');
const broker = read('m59-broker.mjs');

// The proxy's class body, taken by brace-matching from `class KeeperProxy {` so a later
// class in the file cannot leak methods into this set.
function classBody(src, name) {
  const start = src.indexOf(`class ${name} {`);
  if (start < 0) return null;
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(i + 1, j); }
  }
  return null;
}

const proxyBody = classBody(broker, 'KeeperProxy');
ok('KeeperProxy is still a class in m59-broker.mjs', !!proxyBody,
   'the brace matcher found nothing — this test is blind until that is fixed');

// THE OBJECT UNDER TEST IS THE CLIENT LITERAL, NOT THE SESSION, and getting that wrong is
// the whole reason this comment exists. `KeeperProxy` is the SESSION; `c` — what every tool
// in the broker calls its wire methods on — is the plain object literal built inside it,
// whose own comment says "the literal below is a plain object, so `this` inside its methods
// is the CLIENT".
//
// The first version of this test checked the SESSION. It went green, I deployed, and prod
// answered `c.requestGuildInfo is not a function` exactly as before. A test that names the
// wrong object is worse than no test: it answers the question you meant to ask with a
// different one, in the affirmative.
const literalStart = broker.indexOf('const client = {');
const literalBody = literalStart < 0 ? null
  : broker.slice(literalStart, broker.indexOf('\n    };', literalStart));
ok('the emulated client literal is still findable', !!literalBody,
   "no `const client = {` in m59-broker.mjs — this test is blind until that is fixed");

// TWO OBJECTS, TWO SETS, AND THE DIFFERENCE IS NOT COSMETIC. Some capabilities are called
// on the SESSION (`s.walkTo(...)`, `s.shopList(...)`) and some on the CLIENT
// (`c.guildCreate(...)`, `c.attack(...)`). Checking a name against the wrong one is how the
// first version of this test passed while prod was broken, so they are kept apart and each
// assertion below names which it means.
const clientMethods = new Set();          // the literal: what `c.foo()` reaches
if (literalBody)
  for (const m of literalBody.matchAll(/^\s{6}(?:get\s+)?([A-Za-z_$][\w$]*)\s*[:(]/gm))
    clientMethods.add(m[1]);

const sessionMethods = new Set();         // the class: what `s.foo()` reaches
if (proxyBody)
  for (const m of proxyBody.matchAll(/^\s{2}(?:async\s+)?(?:get\s+)?([A-Za-z_$][\w$]*)\s*\(/gm))
    sessionMethods.add(m[1]);

console.log('\nthe guild surface — seventeen verbs, all of which were unreachable');
{
  // Taken from the CLIENT, not from a hand-written list: if somebody adds a guild verb to
  // m59-client.mjs and does not forward it, this fails the day they add it rather than the
  // day somebody tries to use it on prod.
  const clientGuild = new Set();
  for (const m of client.matchAll(/^\s{2}(?:async\s+)?((?:guild|requestGuild)[A-Za-z]*)\s*\(/gm))
    clientGuild.add(m[1]);

  ok('the client still declares a guild surface to forward',
     clientGuild.size >= 15, `found ${clientGuild.size}`);

  const missing = [...clientGuild].filter(n => !clientMethods.has(n)).sort();
  ok(`all ${clientGuild.size} guild verb(s) are forwarded by the client literal`,
     missing.length === 0,
     missing.length
       ? `NOT forwarded, so each throws "c.<name> is not a function" on a keeper-backed `
         + `session: ${missing.join(', ')}`
       : '');

  // `c.guild` is read by the tool after every round trip; a forward that cannot answer it
  // would report every character guildless, which reads as a clean "no guild" rather than
  // as a fault.
  ok('and the roster itself is exposed, so `c.guild` is not silently undefined',
     clientMethods.has('guild'), 'the client literal needs a `guild` getter');
}

console.log('\nthe verbs that had this bug BEFORE, kept as regressions');
{
  // Each of these was the same failure discovered the expensive way. They pass today; they
  // are here so that a refactor which drops one is caught by a test rather than by a fleet.
  for (const [name, incident] of [
    ['shopList',   'buyItems: "zero successful purchases in its recorded history"'],
    ['shopBuy',    'the same, on the mutation half'],
    ['walkTo',     'movement has always had to be keeper-side'],
    ['fight',      'as has fighting'],
    ['travel',     'and journeys'],
  ]) ok(`${name} is forwarded by the SESSION (${incident})`, sessionMethods.has(name));
}

console.log('\nthe forward has to REACH the keeper, not merely exist');
{
  // The literal's forwards delegate to the proxy's `_guildAct`, which is the ONE function
  // that crosses the process boundary. A forward that returned a plausible object without
  // reaching it would satisfy every name check above, send no packet, and report success —
  // this same bug one level down.
  ok('the client forwards delegate to the proxy', /proxy\._guildAct\(/.test(literalBody || ''),
     'the client literal must call proxy._guildAct, not fake a reply locally');
  const act = proxyBody?.match(/_guildAct\s*\([\s\S]{0,600}?keeperAction\(/);
  ok('and _guildAct reaches the keeper', !!act,
     '_guildAct must call keeperAction — a local stub would send nothing and report success');

  // And the keeper must actually implement the op it is sent.
  const keeper = read('m59-keeper-process.mjs');
  ok("the keeper's /action handles a 'guild' case", /case 'guild':/.test(keeper),
     "m59-keeper-process.mjs has no `case 'guild':`, so every forward would 404");

  // THE HALL LIST, WHICH WAS MISSING AT ALL THREE LEVELS AT ONCE AND SO COULD NOT BE NOTICED
  // BY ANY ONE OF THEM. `askFrular` was absent from the client literal, `halls` was absent
  // from the keeper's guild ops, and `guildHalls` was absent from the proxy — so
  // `guild action=halls` answered `c.askFrular is not a function` and buying a guild hall was
  // impossible for every character this fleet has. Measured 2026-09-11: Gonzo carried 33,330
  // shillings across the world for a 25,000 hall and was refused at the counter.
  //
  // It is a SHOPPING request and not a guild request — there is no UC_GUILD_HALLS to send
  // (gcreator.kod:250) — which is exactly why it was the one guild verb nobody forwarded.
  ok('askFrular is forwarded by the client literal',
     /askFrular\s*:/.test(literalBody || ''),
     'the emulated client has no askFrular, so `guild action=halls` throws and no hall can be bought');
  ok('and it goes through _guildAct like every other guild verb',
     /askFrular\s*:\s*\([\s\S]{0,120}?proxy\._guildAct\(/.test(literalBody || ''),
     'askFrular must cross the process boundary, not fake a list locally');
  ok("the keeper implements the 'halls' op it is sent",
     /case 'halls':/.test(keeper),
     "m59-keeper-process.mjs has no `case 'halls':`, so the forward 404s and the list never arrives");
  ok('the keeper answers with the parsed hall list',
     /guild_halls\s*:/.test(keeper),
     'the keeper must return guild_halls, or the broker has nothing to populate c.guildHalls from');
  ok('and the proxy holds it, because the client literal is rebuilt per read',
     /_guildHalls/.test(proxyBody || '') || /_guildHalls/.test(read('m59-broker.mjs')),
     'the hall list must live on the proxy like the roster does, or it dies with the literal');

  // SILENCE IS THE REFUSAL HERE, so the reply must always carry what was said. A guild
  // command the caller lacks the bit for produces no message, no packet, and only a
  // Debug() line in the SERVER log (user.kod:4848) — so a caller that reads "no error" as
  // "it worked" is wrong fourteen different ways.
  const guildCase = keeper.slice(keeper.indexOf("case 'guild':"),
                                 keeper.indexOf("case 'guild':") + 4000);
  ok('and it returns `said`, because a guild refusal IS silence',
     /said:/.test(guildCase));
  ok('and the roster, so the broker can populate c.guild',
     /guild:\s*c\.guild/.test(guildCase));
}

// SPEECH — THE FOURTH TIME, and the one that switched a whole feature off.
//
// `M59Client.say` has existed all along (m59-client.mjs:941). The proxy had no method for it,
// so `c.say(...)` threw "c.say is not a function" on every keeper-backed session — which is
// every character in this fleet. Measured on prod 2026-09-12: Rowlf standing in room 700 with
// Frular in the room, `tithe action=status` -> "c.say is not a function".
//
// WHAT IT COST IS NOT A BROKEN VERB. `askRent` asks Frular for the guild's rent by SAYING
// "rent" to him. It could never work, so `rent.json` could never be written, so
// `guildStoreAvailable` refused the entire guild stockpile with "nobody has asked Frular about
// the guild yet" — on all 21 characters, indefinitely, while every one of them had
// `guildWants: {enabled: true}`. A missing one-line forward, presenting as a feature that
// merely declines.
{
  const keeperSrc = read('m59-keeper-process.mjs');
  ok('say is forwarded by the client literal',
     /(^|[^.\w])say\s*:/m.test(literalBody || ''),
     'the emulated client has no say, so anything that talks to an NPC throws on every ' +
     'keeper-backed session — which is the whole fleet');
  ok('and it crosses the process boundary rather than pretending locally',
     /say\s*:\s*\([\s\S]{0,160}?act\(\s*'say'/.test(literalBody || ''),
     'say must be sent to the process holding the socket; a snapshot cannot speak');
  ok("the keeper implements the 'say' op it is sent",
     /case 'say':/.test(keeperSrc),
     "m59-keeper-process.mjs has no `case 'say':`, so the forward 404s");
  // ORDINARY SPEECH, NOT AN EMOTE. The guild hall's secret door opens only on
  // `type <> SAY_EMOTE` (ghall.kod:967), and SayRangeCheck governs whether a monster hears it
  // at all — so a forward that quietly sent an emote would open no door and answer no
  // question, in silence, which is this game's whole failure mode.
  ok('and it defaults to ordinary speech rather than an emote',
     /say\s*:\s*\(text,\s*type\s*=\s*1\)/.test(literalBody || ''),
     'kind 1 is speech; an emote is refused by the secret door and unheard by Frular');
}

// THE SWEEP, BECAUSE NAMING THEM ONE AT A TIME FOUND SIX AND MISSED ELEVEN.
//
// Every assertion above this line was written after an errand died on a specific verb. That is
// six separate incidents — requestGuildInfo, sellOne, buyItems, askFrular, say, offer — each
// found by a character doing the expensive part of a job and failing at the end of it. Robin
// and Floyd withdrew 35,000 each and carried it across the road before `c.offer` turned out to
// be missing.
//
// So this asks the question wholesale: of every `c.<verb>(` called by the modules that run
// against a Session, which are absent from the proxy literal? The first run answered
// SEVENTEEN.
//
// IT IS A RATCHET, NOT A WALL. Some of the remainder are legitimately absent — a verb with no
// keeper op behind it should be missing LOUDLY rather than forwarded to nothing, and a couple
// are not client methods at all. Failing the suite on those would make the test something
// people delete. So the known set is pinned: anything new fails, and shrinking the list is
// always allowed and asks you to update it.
{
  const literal = literalBody || '';
  const hasVerb = (v) => new RegExp('(^|[^.a-zA-Z_$])' + v + '\\s*[:(]', 'm').test(literal);

  // Modules whose code runs with a Session's client on the production path.
  const MODULES = ['m59-tithe.mjs', 'm59-skills.mjs', 'm59-autopilot.mjs',
                   'm59-guild.mjs', 'm59-supply.mjs'];

  // KNOWN ABSENT, and each is a decision rather than an oversight. `buy`, `buyItems`,
  // `deposit`, `withdraw` and `depositItems` have keeper ops under other names (shop,
  // buyitem, bank, vault) and want a wrapper that maps the arguments, not a blind forward.
  // `players`, `tell`, `armed` and `nudge` have no keeper op at all.
  const KNOWN_ABSENT = new Set(['armed', 'buy', 'buyItems', 'deposit', 'depositItems',
                                'nudge', 'players', 'tell', 'withdraw']);

  const found = new Set();
  for (const m of MODULES) {
    let src;
    try { src = read(m); } catch { continue; }
    for (const hit of src.matchAll(/\bc\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g))
      if (!hasVerb(hit[1])) found.add(hit[1]);
  }

  const surprises = [...found].filter(v => !KNOWN_ABSENT.has(v)).sort();
  ok('no NEW client verb is called without the proxy forwarding it',
     surprises.length === 0,
     `these are called on a client and the proxy has no method for them: ${surprises.join(', ')}. ` +
     'On a keeper-backed session — which is every character in a running fleet — each throws ' +
     '"c.<verb> is not a function" at whatever point the errand reaches it. Forward it to a ' +
     'keeper op, or add it to KNOWN_ABSENT with a reason.');

  // AND THE LIST MUST NOT ROT. A name that has since been forwarded, or deleted from the
  // callers, should come out — otherwise the exemption list slowly becomes the answer.
  const stale = [...KNOWN_ABSENT].filter(v => !found.has(v)).sort();
  ok('the known-absent list carries nothing that is no longer absent',
     stale.length === 0,
     `KNOWN_ABSENT still lists ${stale.join(', ')}, which no caller needs or which the proxy ` +
     'now forwards. Remove them: an exemption nobody rechecks is how the sweep stops working.');
}

// THE PRIVATE FIELDS THE WEAPON RANKING READS, 2026-09-27. `weaponRanking` breaks a tie toward
// `c._magicWeaponIds`; the keeper sets it on its own client and this rebuild did not, so
// `equip_best` through the broker kept a mundane long sword in Animal's hand with an enchanted
// twin in his pack, and the troll crew stood at the stage room "not ready". Any of these the
// ranking reads must be assigned on the proxy's client too, from the keeper's own readings.
{
  const skills = read('m59-skills.mjs');
  const start = skills.indexOf('export function weaponRanking');
  const end = start < 0 ? -1 : skills.indexOf('\nexport ', start + 10);
  const ranking = start < 0 ? '' : skills.slice(start, end < 0 ? undefined : end);
  const fields = [...new Set([...ranking.matchAll(/\bc\._(magicWeaponIds|madeItemIds)\b/g)].map(m => m[1]))];
  ok('weaponRanking was found and reads the magic set', fields.includes('magicWeaponIds'));
  for (const f of fields)
    ok(`the proxy's rebuilt client carries _${f}`, proxyBody.includes(`client._${f} =`),
       `weaponRanking reads c._${f}; KeeperProxy's client getter never assigns it, so every ` +
       'keeper-backed equip_best ranks without it.');
  ok('the magic set is taken from the keeper, not re-derived',
     /autopilot_status\?\.weapon_magic/.test(proxyBody));
}

// AND NOTHING MAY WIPE IT, 2026-09-27. The Autopilot constructor installs `session.beforeEquip`,
// which rebuilds the magic set from ITS OWN reading book, and the broker builds an Autopilot around
// this proxy the first time the `autopilot` tool is called — with an empty book. So equipBest ran
// the hook and ranked with an empty set on every call. The proxy must refuse the hook.
{
  const auto = read('m59-autopilot.mjs');
  ok('the Autopilot still installs a beforeEquip hook on its session (so the refusal matters)',
     /session\.beforeEquip\s*=/.test(auto));
  ok('the proxy answers no beforeEquip', /get beforeEquip\(\)\s*\{\s*return undefined;\s*\}/.test(proxyBody));
  ok('and assigning one to it stores nothing', /set beforeEquip\(_\)\s*\{\s*\/\*[^*]*\*\/\s*\}/.test(proxyBody));
}

// THE ID GENERATION CROSSES ALL THREE FILES, 2026-10-04. Every server save renumbers every object
// id; the client records which save its ids belong to, the keeper publishes it in /state, and the
// proxy's REBUILD has to carry it — the rebuild names each field explicitly, so a field the keeper
// sends and this omits is absent on every prod character (CLAUDE.md, the three-file rule). Each
// field is checked on all three sides, so adding one to two of them fails here.
{
  const keeper = read('m59-keeper-process.mjs');
  for (const [clientField, wire, proxyField] of [
    ['idsAsOf()', 'ids_as_of', 'idsAsOf'],
    ['this.idGenerations', 'id_generations', 'idGenerations'],
    ['this.saveHistory', 'saves', 'saveHistory'],
  ]) {
    ok(`the client keeps ${clientField}`, client.includes(clientField));
    ok(`the keeper publishes ${wire} in /state`, new RegExp(`\\b${wire}:\\s*c\\?\\.`).test(keeper));
    ok(`the proxy's rebuilt client carries ${proxyField} from s.${wire}`,
       new RegExp(`${proxyField}:[^\\n]*s\\.${wire}`).test(proxyBody),
       `KeeperProxy's client getter must map s.${wire} to ${proxyField}, or keeper-backed replies ` +
       'cannot say which save their ids belong to');
  }
  ok('the keeper\'s /live carries the saves the broker\'s clock is fed from',
     /saves:\s*session\.client\?\.saveHistory/.test(keeper));
  ok('the proxy feeds the save clock from each /state snapshot', /saveClock\.observeAll\(candidate\.saves/.test(proxyBody));
  ok('and from each /live poll', /saveClock\.observeAll\(reply\.value\.saves/.test(proxyBody));
  ok('the broker stamps replies at its one door', /stampReply\(out,/.test(broker) && /judgeArgs\(args,/.test(broker));
}

// Evaluate the actual keeper option object: a broker request must retain the
// precise endpoint guard across the process boundary, in both wire spellings.
{
  const keeper = read('m59-keeper-process.mjs');
  const options = keeper.match(/session\.walkFine\(Number\(args\.x\), Number\(args\.y\), \{([\s\S]*?)\n\s*\}\)\)/);
  ok('fine-walk keeper options can be inspected', !!options);
  if (options) {
    const forwarded = new Function('args', `return ({${options[1]}});`);
    for (const args of [{exactArrival:true,arriveWithin:3}, {exact_arrival:true,arrive_within:3}]) {
      const actual = forwarded(args);
      ok('exact fine arrival and its distance survive keeper forwarding', actual.exactArrival===true && actual.arriveWithin===3);
    }
    ok('legacy fine walks keep their default endpoint behavior', forwarded({}).exactArrival===false);
  }
}

console.log(`\nkeeper proxy: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
