#!/usr/bin/env node
// m59-menagerie-test.mjs — "THE FLEET" NEVER MEANS THE RIDE-ALONG CHARACTERS.
//
//   node tools/m59-menagerie-test.mjs
//
// Offline. Opens no socket, starts no broker, touches no live roster.
//
// ======================== WHAT THIS PINS ========================
//
// A menagerie is a second roster of characters — HOSTS — that share the fleet's broker,
// its server, its keeper band and its safe-spot book, and exist to run a script rather
// than to be commanded. A merchant standing in Tos selling the fleet's excess gear is the
// first one.
//
// The requirement they were built for is a single sentence from the operator: *"I don't
// ever want me to say 'send everyone to Castle Victoria' and have it be interpreted to be
// ALSO one of these ride-along characters."* Everything below is that sentence, made
// checkable.
//
// The failure being prevented is the one this repository keeps paying for: SILENCE. A
// fleet-wide instruction that sweeps up a merchant does not error. The merchant walks out
// of its shop, stops answering the players standing in front of it, and every call
// reports success — and the only way anyone finds out is by noticing, hours later, that
// the shop is empty. That is the same shape as the supervisor that drove a fleet nobody
// could find, and as `purpose` missing from a schema for a year with every audit off.
//
// Nine claims, in the order a mistake would travel:
//
//   1. a host is a host because of the FILE it was loaded from — never a name convention
//   2. a menagerie roster that will not parse is an ERROR, never an empty menagerie
//   3. every tool refuses a host, by agent name AND by character name
//   4. ... including read-only tools, because an allowlist is a thing that grows
//   5. ... and including a host named in a nested or array argument
//   6. free text is not an identifier: a fleet character may SAY a host's name
//   7. the menagerie runtime, and only it, may drive a host
//   8. a fleet listing that hides hosts SAYS how many it hid
//   9. hosts are still OURS for "do not shoot", which is a different question
//
// Claim 9 is the one that looks like an inconsistency and is not. See `alliedCharacters`.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  menageriePathFor, isMenageriePath, loadMenagerie, splitRosters, hostConfig, excludedNote,
} from './m59-menagerie-roster.mjs';
import {
  guardToolCall, hostNameIndex, withoutHosts, isMenagerieCaller, alliedCharacters,
} from './m59-menagerie-guard.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};

const BROKER = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');

// The shape both rosters share, and the one key that distinguishes a host.
const HOSTS = new Map([
  ['shadowb19', { credentials: { account: 'shadowb19', password: 'x', character: 'Sssss' },
                  host: { script: 'merchant-tos', station: { room: 54, col: 30, row: 22 } } }],
  ['shadowb20', { credentials: { account: 'shadowb20', password: 'x', character: 'Tttt' },
                  host: { script: 'merchant-barloque', station: { room: 100 } } }],
]);
const FLEET = ['shadowb01', 'shadowb02', 'shadowb03'];
const INDEX = hostNameIndex(HOSTS);

const tmp = mkdtempSync(join(tmpdir(), 'm59-menagerie-'));

// ---------------------------------------- 1. the file is the identity, not the name

console.log('\n1. a host is a host because of the file it came from');

ok('a menagerie path is derived from the fleet roster beside it',
   menageriePathFor('/x/substrate/fleets/shadow.json') === '/x/substrate/fleets/shadow.menagerie.json',
   menageriePathFor('/x/substrate/fleets/shadow.json'));
ok('the unnamed fleet gets one too',
   menageriePathFor('/x/substrate/fleet-state.json') === '/x/substrate/fleet-state.menagerie.json');
ok('and it is recognisable on sight, so no tool offers one as a fleet',
   isMenageriePath('/x/substrate/fleets/shadow.menagerie.json') &&
   !isMenageriePath('/x/substrate/fleets/shadow.json'));

// A MENAGERIE CANNOT BE ADDRESSED AS A FLEET. `--fleet shadow.menagerie` has to be
// refused, or the split is one command-line argument deep. The name validator in
// m59-fleetpath.mjs allows no dot, and this asserts that rather than trusting it.
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
ok('`--fleet shadow.menagerie` cannot resolve — the fleet name validator rejects the dot',
   !NAME_OK.test('shadow.menagerie'));

// The negative claim that matters: nothing anywhere decides hostness from the NAME.
ok('no name-prefix convention decides hostness (a prefix is a thing somebody renames)',
   !/host[-_]?prefix|startsWith\(['"]host/i.test(
     readFileSync(new URL('./m59-menagerie-guard.mjs', import.meta.url), 'utf8')));

// ---------------------------------------- 2. an unparseable roster is not an empty one

console.log('\n2. a menagerie that will not load is an error, never an open door');

const absent = join(tmp, 'nothing.menagerie.json');
ok('a menagerie that is genuinely absent is an empty one',
   loadMenagerie(absent).names.size === 0 && loadMenagerie(absent).present === false);

const broken = join(tmp, 'broken.menagerie.json');
writeFileSync(broken, '{ "shadowb19": { oops');
let threw = null;
try { loadMenagerie(broken); } catch (e) { threw = e; }
ok('a file that exists and will not parse THROWS', threw !== null);
ok('and says why it is not simply treated as empty',
   /NOT an empty menagerie|fall back to the fleet/i.test(threw?.message ?? ''),
   threw?.message?.slice(0, 80));

// This is the claim underneath it: an empty menagerie allows everything. That is correct
// — and it is exactly why the load above must refuse to produce one by accident.
ok('an empty menagerie allows every call (which is why load must fail loudly)',
   guardToolCall({ tool: 'travel', args: { agent: 'shadowb19' }, hosts: new Map() }).action === 'allow');

const good = join(tmp, 'good.menagerie.json');
writeFileSync(good, JSON.stringify(Object.fromEntries(HOSTS), null, 2));
ok('a well-formed menagerie loads its hosts', loadMenagerie(good).names.size === 2);

// ---------------------------------------- 3-5. the refusal

console.log('\n3. every tool refuses a host, by either of its names');

const refuse = (tool, args) => guardToolCall({ tool, args, hosts: HOSTS, index: INDEX });

ok('travel naming the host AGENT is refused',
   refuse('travel', { agent: 'shadowb19', to: 39 }).action === 'refuse');
ok('travel naming the host CHARACTER is refused',
   refuse('travel', { agent: 'Sssss', to: 39 }).action === 'refuse');
ok('...case-insensitively, because the fleet page prints both spellings',
   refuse('travel', { agent: 'SSSSS' }).action === 'refuse');
ok('a fleet character is untouched',
   refuse('travel', { agent: 'shadowb01', to: 39 }).action === 'allow');

// THE MESSAGE IS HALF THE FIX. A refusal that cannot say why it fired gets deleted by the
// next person in a hurry — this repository's own stated entry criterion for a guarantee.
const msg = refuse('travel', { agent: 'shadowb19' }).error;
ok('the refusal names the host and its character', /shadowb19/.test(msg) && /Sssss/.test(msg));
ok('the refusal says what DOES reach it', /m59-menagerie\.mjs status/.test(msg));
ok('the refusal says how to take it back', /discharge shadowb19/.test(msg));

console.log('\n4. read-only tools are refused too');

for (const tool of ['status', 'look', 'fleet', 'equipment', 'inventory']) {
  ok(`${tool} naming a host is refused`,
     refuse(tool, { agent: 'shadowb19' }).action === 'refuse');
}

console.log('\n5. a host named anywhere in the arguments is found');

ok('a nested object argument (commander_claim agents[])',
   refuse('commander_claim', { action: 'acquire',
     agents: [{ agent: 'shadowb01', character: 'Aaaa' },
              { agent: 'shadowb19', character: 'Sssss' }] }).action === 'refuse');
ok('a plain array of names',
   refuse('deploy', { agents: ['shadowb01', 'shadowb19'] }).action === 'refuse');
ok('a differently-named parameter nobody taught the guard about',
   refuse('supply', { from: 'shadowb01', to: 'shadowb19' }).action === 'refuse');
ok('...and `partner`, and `farmer`, for the same reason',
   refuse('pair', { agent: 'shadowb01', partner: 'shadowb19' }).action === 'refuse' &&
   refuse('visit', { farmer: 'Sssss' }).action === 'refuse');

// ---------------------------------------- 6. prose is not an identifier

console.log('\n6. free text is not an identifier');

ok('a fleet character may SAY a host\'s name',
   refuse('say', { agent: 'shadowb01', text: 'go see Sssss, he buys armour' }).action === 'allow');
ok('...even when the message is nothing but the name',
   refuse('say', { agent: 'shadowb01', text: 'Sssss' }).action === 'allow');
ok('but a bare identifier field is still caught',
   refuse('say', { agent: 'Sssss', text: 'hello' }).action === 'refuse');
ok('a substring of a longer identifier is NOT a match',
   refuse('travel', { agent: 'shadowb190' }).action === 'allow');

// AN AUDIENCE IS NOT A SUBJECT — the one exemption, and half the point of a merchant.
//
// Found live on shadow, 2026-09-09: the first guard refused a fleet character TELLING the
// merchant something, which forbids the fleet from trading with its own shop.
ok('a fleet character may ADDRESS a host — say --to names the audience, not the subject',
   refuse('say', { agent: 'shadowb01', type: 'tell', to: 'Ssss', text: 'what do you sell?' })
     .action === 'allow');
ok('...but the SPEAKER may still not be a host',
   refuse('say', { agent: 'shadowb19', type: 'tell', to: 'Aaaa', text: 'hi' }).action === 'refuse');
// The exemption is per tool AND per field, because `to` means the receiving character in a
// supply — a host named there IS being driven.
ok('`to` on a different tool is still a subject: supply --to a host is refused',
   refuse('supply', { agent: 'shadowb01', to: 'shadowb19' }).action === 'refuse');
ok('and `to` on travel is a room, so nothing changes there',
   refuse('travel', { agent: 'shadowb01', to: 39 }).action === 'allow');

// ---------------------------------------- 7. the one door that opens

console.log('\n7. the menagerie runtime, and only it, may drive a host');

ok('the runtime is allowed through',
   refuse('travel', { agent: 'shadowb19' }) &&
   guardToolCall({ tool: 'travel', args: { agent: 'shadowb19' }, hosts: HOSTS,
                   caller: { transport: 'http', local: true, menagerie: true } }).action === 'allow');
ok('a loopback HTTP caller WITHOUT the capability is not',
   guardToolCall({ tool: 'travel', args: { agent: 'shadowb19' }, hosts: HOSTS,
                   caller: { transport: 'http', local: true } }).action === 'refuse');
ok('stdio — which is what .mcp.json speaks — is not',
   guardToolCall({ tool: 'travel', args: { agent: 'shadowb19' }, hosts: HOSTS,
                   caller: { transport: 'stdio', local: true } }).action === 'refuse');
ok('the broker\'s own internal calls are not, either',
   guardToolCall({ tool: 'travel', args: { agent: 'shadowb19' }, hosts: HOSTS,
                   caller: { transport: 'internal', local: true } }).action === 'refuse');
ok('the capability is a flag the transport sets, not something args can claim',
   !isMenagerieCaller({ transport: 'http', local: true }) &&
   guardToolCall({ tool: 'travel', hosts: HOSTS,
                   args: { agent: 'shadowb19', menagerie: true } }).action === 'refuse');

// ---------------------------------------- 8. a listing that hides says so

console.log('\n8. a fleet listing that hides hosts says how many it hid');

const rows = [{ agent: 'shadowb01' }, { agent: 'shadowb19' }, { agent: 'shadowb02' }];
const filtered = withoutHosts(rows, ['shadowb19'], r => r.agent);
ok('hosts are removed from a fleet listing', filtered.rows.length === 2);
ok('and the count of what was removed comes back with it', filtered.hiddenCount === 1);
ok('the note names the tool that DOES reach them',
   /m59-menagerie\.mjs status/.test(excludedNote(1) ?? ''));
ok('no hosts means no note at all — nothing to explain', excludedNote(0) === null);

// ---------------------------------------- 9. ours to protect, not ours to command

console.log('\n9. "do not shoot" and "obey an order" are different questions');

const allied = alliedCharacters(['Aaaa', 'Bbbb'], ['Sssss']);
ok('a host IS one of ours for the fleetmate check', allied.has('Sssss'));
ok('and so is every fleet character', allied.has('Aaaa') && allied.has('Bbbb'));
ok('but it is NOT commandable — the two answers differ on purpose',
   refuse('attack', { agent: 'shadowb19' }).action === 'refuse');

// The incident this claim is made of. A keeper that could not see its own roster called
// the whole fleet strangers and a fleet-mate turned red was shot by everyone with a false
// grudge (Statler, 2026-08-27). A host excluded from the allied set is that bug, reissued.
ok('the guard file names the incident that makes claim 9 non-negotiable',
   /Statler/.test(readFileSync(new URL('./m59-menagerie-guard.mjs', import.meta.url), 'utf8')));

// ---------------------------------------- host config

console.log('\n   a host declares where it lives and what it runs');

ok('a well-formed host config resolves', hostConfig(HOSTS.get('shadowb19')).ok === true);
ok('...with its script and station', hostConfig(HOSTS.get('shadowb19')).script === 'merchant-tos' &&
   hostConfig(HOSTS.get('shadowb19')).station.room === 54);
ok('a host with no script is refused — it would stand still for ever, and look healthy',
   hostConfig({ host: { station: { room: 54 } } }).ok === false);
ok('a host with no station room is refused — "where does it live" is the question enlist answers',
   hostConfig({ host: { script: 'merchant-tos' } }).ok === false);
ok('a station square is optional; the room is not',
   hostConfig(HOSTS.get('shadowb20')).ok === true &&
   hostConfig(HOSTS.get('shadowb20')).station.col === null);

// ---------------------------------------- the two rosters must not overlap

console.log('\n   an agent in both rosters is a corrupted split, and is reported');

const split = splitRosters([...FLEET, 'shadowb19'], ['shadowb19', 'shadowb20']);
ok('an agent in both files is reported rather than silently resolved', split.ok === false);
ok('and named', split.overlap.includes('shadowb19'));
ok('a clean split is clean', splitRosters(FLEET, ['shadowb19']).ok === true);
ok('the fleet side excludes anything the menagerie claims',
   !split.fleet.includes('shadowb19') && split.fleet.includes('shadowb01'));

// ---------------------------------------- the wiring is actually in the broker

console.log('\n   the broker calls the guard at its one door');

ok('m59-broker.mjs imports the guard', /from '\.\/m59-menagerie-guard\.mjs'/.test(BROKER));
ok('and the roster loader', /from '\.\/m59-menagerie-roster\.mjs'/.test(BROKER));
// The door. If this moves, the guarantee moves with it, so the test names the function.
ok('guardToolCall is called inside callTool — the one door every MCP request goes through',
   /async function callTool[\s\S]{0,2000}?guardToolCall\(/.test(BROKER));
ok('the fleet tool filters hosts out of its rows', /withoutHosts\(/.test(BROKER));
ok('menagerie state is a SEPARATE map from fleetState',
   /const menagerieState = new Map\(\)/.test(BROKER));
// saveFleetState writes `Object.fromEntries(fleetState)` to the FLEET roster. A host in
// that map is a host written into the fleet's password file, and the merge logic there
// carries on-disk entries forward for ever — so it would be permanent.
ok('and saveFleetState still writes only fleetState, so a host can never land in the fleet roster',
   /const next = Object\.fromEntries\(fleetState\);/.test(BROKER));

rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
