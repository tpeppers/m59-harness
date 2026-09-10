#!/usr/bin/env node
// FOUNDING A GUILD, AND THE FOUR WAYS THE SERVER SAYS NO WITHOUT SAYING ANYTHING.
//
//   node tools/m59-guild-found-test.mjs
//
// Offline: no broker, no server, no network. Every call is answered by a fake, so this is
// safe to run while a live fleet is playing.
//
// STANDALONE ON PURPOSE, and the reason is worth keeping. These began life appended to
// m59-fleetscript-test.mjs, where they never ran once: that suite has a pre-existing hang in
// its "leaving the newbie zone" section — reproducible at HEAD against an untouched worktree
// — and everything after it is dead code that reports nothing. A test you cannot see fail is
// not a test. So this is its own file, the same reasoning that put m59-learnskill-test.mjs
// in one.
//
// WHAT IT GUARDS. A guild is founded ONCE, cannot be renamed, and costs 5,000 that is gone
// whether or not it worked. Every refusal in this command space is TOTAL SILENCE —
// `User.UserGuildCommand` takes the else branch, writes `Debug(...)` to the SERVER log, and
// sends the player nothing at all (user.kod:4848). So "no error was thrown" is the shape of
// success AND of every failure, and a caller that cannot tell them apart will spend the
// money and report a guild that does not exist.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK_DIR = mkdtempSync(join(tmpdir(), 'm59-guild-'));
process.env.M59_RUNLOCK_DIR = LOCK_DIR;
process.env.M59_CONTROL_URL = 'http://127.0.0.1:1/';   // never actually reached

const { stateFileFor } = await import('./m59-fleetpath.mjs');
const { fleetScript, foundGuild } = await import('./m59-fleetscript.mjs');

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};

// `guildReply` is a FUNCTION so a case can refuse the way the server really refuses:
// `ok:false` with prose and no error at all.
function fakeBroker({ room = 700, items = [], guildReply = null } = {}) {
  const sent = [];
  globalThis.fetch = async (_url, opts) => {
    if (!opts || opts.method !== 'POST')
      return { json: async () => ({ ok: true, fleet: 'testfleet',
                                    state: stateFileFor('testfleet') }) };
    const { name, arguments: a } = JSON.parse(opts.body).params;
    // `tool:` AND NOT `name:`. Spreading the arguments over a field called `name` lets the
    // GUILD's name win — `{ name, ...a }` records the tool as "The Second Swines" — so every
    // assertion about which tool was called silently matched nothing. Exactly the trap
    // CLAUDE.md records for `emit(kind, data)`, where a payload field called `kind` wins,
    // and it cost the same twenty minutes here.
    sent.push({ tool: name, ...a });
    let payload = { ok: true };
    if (name === 'status') payload = { where: { num: room, name: 'room' },
                                       hp: { value: 50, max: 50 }, gold: null };
    else if (name === 'inventory') payload = { items };
    else if (name === 'travel') payload = { started: true };
    else if (name === 'travel_estimate') payload = { ms: 1000, hops: 2 };
    else if (name === 'bank') payload = { banker_said: ['Skivlat hands it over.'] };
    else if (name === 'guild') payload = guildReply
      ? guildReply({ ...a })
      : { ok: true, name: a.name, price: 5000, messages: ['You found a guild!'],
          guild: { name: a.name, rank: 'master', members: 1 } };
    return { json: async () => ({ result: { content: [{ text: JSON.stringify(payload) }] } }) };
  };
  return sent;
}
const quiet = () => {};
const purse = (n) => (n == null ? [] : [{ id: 1, name: 'shillings', amount: n }]);
const trip = (steps) => fleetScript({ name: 'guild-t', fleet: 'testfleet', agents: ['a1'],
  steps, pollMs: 30, healMs: 400, onLog: quiet });
const step = (r) => r.results.a1.state['0:found_guild'];

console.log('\nthe fee comes out of the PURSE, and a bank balance is not a purse');
{
  // system.kod:243. A character with 40,000 banked and an empty pocket is refused with
  // `user_no_guild_broke` — a sentence spoken to the room, not an error on the wire.
  let sent = fakeBroker({ items: purse(120) });
  let r = await trip([foundGuild('The Second Swines')]);
  ok('a short purse refuses before paying', step(r).outcome === 'purse_short',
     JSON.stringify(step(r)));
  ok('and it names the shortfall rather than just failing',
     step(r).purse === 120 && step(r).needs === 5000, JSON.stringify(step(r)));
  ok('and it says the bank does not count, which is the actual trap',
     /PURSE/.test(step(r).why || '') && /withdraw/i.test(step(r).why || ''));
  ok('and NOTHING was sent to the guild tool — the money is not risked to find out',
     !sent.some(x => x.tool === 'guild'));

  // AN EMPTY PACK IS NOT AN UNREADABLE ONE, and both refuse. Reading "no shillings found" as
  // "cannot tell, try anyway" would gamble 5,000 on a guess.
  sent = fakeBroker({ items: [] });
  r = await trip([foundGuild('The Second Swines')]);
  ok('a pack with no shillings in it refuses too', step(r).outcome === 'purse_short');
}

console.log('\na full purse founds it — and the proof is the roster, not the silence');
{
  const sent = fakeBroker({ items: purse(6000) });
  const r = await trip([foundGuild('The Second Swines')]);
  ok('the guild is founded', step(r).outcome === 'founded', JSON.stringify(step(r)));
  ok('and the run reports ok', r.results.a1.ok === true);
  const call = sent.find(x => x.tool === 'guild');
  ok('it asked for create, by name', call?.action === 'create'
     && call?.name === 'The Second Swines', JSON.stringify(call));
  ok('and it carries the roster back, so a caller can see what it got',
     !!step(r).guild, JSON.stringify(step(r).guild));
}

console.log('\nSILENCE IS THE REFUSAL — the case this whole verb exists for');
{
  // A duplicate name, a name matching a player, and a short purse all look like this: no
  // throw, no error field, and prose. `ok:false` from the tool is the only signal, and it is
  // there because the tool re-reads the roster rather than believing the send.
  let sent = fakeBroker({ items: purse(6000),
    guildReply: () => ({ ok: false, messages: ['That name is already in use.'] }) });
  let r = await trip([foundGuild('The Second Swines')]);
  ok('a refusal that throws nothing is still a refusal', step(r).outcome === 'not_founded',
     JSON.stringify(step(r)));
  ok('and the run does NOT report ok', r.results.a1.ok === false);
  ok('and it carries what was said, because that is the only diagnosis there is',
     JSON.stringify(step(r).said || '').includes('already in use'), JSON.stringify(step(r)));

  // A REPLY THAT IS SIMPLY EMPTY. The worst shape: nothing said, nothing thrown, no guild.
  sent = fakeBroker({ items: purse(6000), guildReply: () => ({ ok: false }) });
  r = await trip([foundGuild('The Second Swines')]);
  ok('an utterly silent refusal is still not a success', step(r).outcome === 'not_founded');
  ok('and it says so in words rather than returning an empty object',
     typeof step(r).why === 'string' && step(r).why.length > 10, JSON.stringify(step(r)));

  // AND `ok: true` IS BELIEVED, because the broker's create action sets it only after
  // re-reading the roster off the world. That is the one place trust is delegated, and it
  // is delegated on purpose to the layer that can see the answer.
  sent = fakeBroker({ items: purse(6000),
    guildReply: () => ({ ok: true, name: 'X', guild: { name: 'X' }, messages: [] }) });
  r = await trip([foundGuild('X')]);
  ok('ok:true from a tool that re-read the world IS the success signal',
     step(r).outcome === 'founded');
}

console.log('\na name the server would discard is caught before it costs anything');
{
  // There is NO WAY TO RENAME A GUILD — disband and pay again is the only correction — so a
  // name the server would silently truncate or drop has to be refused locally.
  const sent = fakeBroker({ items: purse(6000),
    guildReply: () => ({ ok: false, refused_locally: true,
                         reason: 'name is longer than the server accepts' }) });
  const r = await trip([foundGuild('x'.repeat(200))]);
  ok('a locally-refused name is reported as such', step(r).refused_locally === true,
     JSON.stringify(step(r)));
  ok('and the reason survives to the caller', /longer/.test(step(r).why || ''));
}

console.log(`\nguild founding: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
