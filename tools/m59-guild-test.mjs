#!/usr/bin/env node
// GUILDS — the rules and the wire. Offline, no server, no broker, safe any time:
//
//   node tools/m59-guild-test.mjs
//
// Guilds are the worst thing in this repository to test for real. Founding one costs
// 5,000 shillings and cannot be undone or renamed; maturing one takes three hours;
// declaring war stakes 50,000; and the fleet lives on a SHARED server where a guild
// name, a war and an alliance are all visible to strangers and attributable to these
// accounts. So the arithmetic and the packet layouts are pinned here, against fixtures,
// and the live path is left to do as little thinking as possible.
//
// What is pinned, in order of how expensive being wrong would be:
//
//   1. THE PERMISSION CHECK, because the server's refusal is TOTAL SILENCE. Every other
//      refusal in this game is at least a sentence spoken to the room; an under-ranked
//      guild command writes to the SERVER LOG and sends the player nothing at all
//      (user.kod:4855). A wrong answer here is not a wrong answer, it is a command that
//      appears to have worked.
//   2. THE PACKET LAYOUTS, because UC_GUILDINFO carries conditional fields and a
//      mis-read shifts everything after them into plausible-looking garbage — a rank, a
//      member count, a flag word. `exact` is the only thing standing between that and a
//      permission check run on nonsense.
//   3. THE TEN RANK TITLES ARE FLAT AND ORDERED, and getting the order wrong does not
//      error — it gives every woman in the guild a man's title, permanently.
//   4. THE INDUCTION IS SERIAL, because the game makes it so and the parallel version
//      reports twenty successes and inducts one.
//   5. THE UNITS: rent on the wire is a DAY of an hourly rate, maturity is ticks and not
//      minutes, and the war forfeit is a rent credit and not a purse.

import {
  GCID, RANK, RANK_NAME, COMMANDS, mayI, commandsIn,
  validateGuild, cleanGuildText, DEFAULT_RANK_TITLES, RANK_TITLE_FIELDS,
  guildPrice, maturityWait, hallCost, joinBlockers, inductionPlan,
  MAX_GUILD_NAME_LEN, MAX_GUILD_RANK_LEN, INVITATION_MS, WAR_LOSS_PENALTY,
  MINIMUM_MEMBERS, MAINTENANCE_MS,
  KNOWN_HALLS, FRULAR_ROOM, parseRentLine, parseRentHours, fundingPlan,
  RANK_QUOTA, rankRoom, SELF_SUSTAINING_RANK,
} from './m59-guild.mjs';
import { parseGuildInfo, parseGuildAsk, parseGuildList, parseGuildHalls } from './m59-parse.mjs';
import { isObjectId, sessionObjectId, ourSessionsById,
         rememberObjectId } from './m59-session-identity.mjs';
import { ROSTER_READ, rosterReadOutcome, rosterReadWorthRetrying,
         looksLikeHallRoomNumber } from './m59-guild.mjs';
import * as tithe from './m59-tithe.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TitheBook, tithePaymentPlan } from './m59-tithe.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// ---------------------------------------------------------------- packet fixtures
//
// Built the way the SERVER builds them, so the test is against the layout rather than
// against the parser's own idea of it. AddStringToPacket is a 2-byte length then the
// bytes (blakserv/commcli.c:131); AddPacket(4,x) is a little-endian int.
const str = s => { const b = Buffer.from(s, 'latin1'); const h = Buffer.alloc(2);
                   h.writeUInt16LE(b.length); return Buffer.concat([h, b]); };
const i32 = n => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u8 = n => Buffer.from([n]);

console.log('\nthe permission check, because the refusal is silence');
{
  // A master: every bit set.
  const master = 0xffff;
  ok('a master may invite',    mayI('invite',   { flags: master }).allowed);
  ok('a master may disband',   mayI('disband',  { flags: master }).allowed);

  // A lord holds invite but NOT exile or set_rank — the rank that can recruit and
  // neither expel nor promote. This asymmetry is the one somebody will "tidy up".
  const lord = GCID.INVITE | GCID.RENOUNCE | GCID.VOTE | GCID.ROSTER;
  ok('a lord may invite',                mayI('invite',   { flags: lord }).allowed);
  ok('a lord may NOT exile',            !mayI('exile',    { flags: lord }).allowed);
  ok('a lord may NOT set ranks',        !mayI('set_rank', { flags: lord }).allowed);
  ok('a lord may NOT disband',          !mayI('disband',  { flags: lord }).allowed);

  ok('invite needs LORD by the rank table',   COMMANDS.invite.rank === RANK.LORD);
  ok('exile needs LIEUTENANT',                COMMANDS.exile.rank === RANK.LIEUTENANT);
  ok('set_rank needs LIEUTENANT',             COMMANDS.set_rank.rank === RANK.LIEUTENANT);
  ok('renounce needs only APPRENTICE',        COMMANDS.renounce.rank === RANK.APPRENTICE);
  ok('vote needs only APPRENTICE',            COMMANDS.vote.rank === RANK.APPRENTICE);
  // set_password declares no viRank_needed of its own and inherits GuildCommand's
  // default of MASTER. Reading the absent declaration as "no restriction" is the
  // natural mistake and is wrong in the permissive direction.
  ok('set_password inherits MASTER',          COMMANDS.set_password.rank === RANK.MASTER);
  ok('abandon_hall needs LIEUTENANT',         COMMANDS.abandon_hall.rank === RANK.LIEUTENANT);

  // THE REFUSAL EXPLAINS THAT IT IS SILENT. If this text ever stops saying so, the next
  // reader will treat a missing bit as something the server would report.
  const no = mayI('disband', { flags: lord });
  ok('a refusal names the rank needed',   /master/.test(no.why));
  ok('a refusal cites the kod line',      /gcdisbnd\.kod/.test(no.why));
  ok('a refusal warns it is silent',      /SILENCE/i.test(no.why));

  // FLAGS BEAT RANK AND THE ANSWER SAYS WHICH IT USED. ResetPowers only re-runs on a
  // rank change and RemoveGuildCommand exists, so a bit can be missing from a rank the
  // table says holds it — the bitmask is what the server actually tests.
  ok('flags win when both are given', mayI('disband', { flags: 0, rank: RANK.MASTER }).allowed === false);
  ok('and it says it used the flags', mayI('disband', { flags: 0, rank: RANK.MASTER }).from === 'flags');
  ok('rank alone answers "would this rank normally"', mayI('disband', { rank: RANK.MASTER }).allowed);
  ok('rank alone says so',                            mayI('disband', { rank: RANK.MASTER }).from === 'rank');

  // NEITHER IS NOT PERMISSION. With nothing to check against, the answer must be no.
  ok('no flags and no rank is refused',  !mayI('invite', {}).allowed);
  ok('and says the roster was not read', /UC_GUILDINFO/.test(mayI('invite', {}).why));

  // An unknown command is refused and named, never guessed into the nearest match.
  ok('an unknown command is refused',    !mayI('promote_everybody', { flags: 0xffff }).allowed);
  ok('and lists the real ones',          mayI('nonsense', { flags: 0xffff }).commands.includes('set_rank'));

  ok('commandsIn reads a bitmask back',
     commandsIn(GCID.INVITE | GCID.DISBAND).sort().join(',') === 'disband,invite');
  ok('commandsIn on an empty mask is empty', commandsIn(0).length === 0);
}

console.log('\nUC_GUILDINFO, whose conditional fields shift everything after them');
{
  const body = Buffer.concat([
    str('Second Swines'),
    u8(0),                                        // no password (not master, or no hall)
    i32(GCID.INVITE | GCID.VOTE | GCID.RENOUNCE),
    i32(9001),                                    // guild id
    ...DEFAULT_RANK_TITLES.map(str),              // 5 ranks x 2 genders, flat
    i32(0),                                       // supporting nobody
    u16(2),
    i32(4484), str('Piggy'),  u8(RANK.MASTER),     u8(0),
    i32(4485), str('Kermit'), u8(RANK.APPRENTICE), u8(0),
  ]);
  const g = parseGuildInfo(body);
  ok('read to the last byte',        g.exact, `leftover ${g.leftover}`);
  ok('name',                         g.name === 'Second Swines');
  ok('guild id',                     g.guildId === 9001);
  ok('no password means null',       g.password === null);
  ok('flags survive as a bitmask',   commandsIn(g.flags).includes('invite'));
  ok('ten titles, not five',         g.titles.length === 10);
  ok('a vote of 0 reads as null',    g.vote === null);
  ok('two members',                  g.members.length === 2);
  ok('the master is the master',     g.members[0].rank === RANK.MASTER);

  // THE PASSWORD IS CONDITIONAL AND ITS ABSENCE IS NOT "no password set". Present only
  // for a guildmaster of a guild holding a hall (user.kod:1983). Getting the branch
  // wrong eats the flag word as a string length and everything after it is garbage that
  // still parses — which is exactly why `exact` is asserted on both shapes.
  const withPw = Buffer.concat([
    str('Second Swines'), u8(1), str('trotter'),
    i32(0xffff), i32(9001), ...DEFAULT_RANK_TITLES.map(str), i32(4484), u16(0),
  ]);
  const g2 = parseGuildInfo(withPw);
  ok('the password branch reads exactly', g2.exact, `leftover ${g2.leftover}`);
  ok('and yields the password',           g2.password === 'trotter');
  ok('a vote of ourselves survives',      g2.vote === 4484);
  ok('an empty roster is legal',          g2.members.length === 0);

  // A packet one byte short must not be quietly used. `exact` is how the client decides.
  const truncated = parseGuildInfo(Buffer.concat([body, Buffer.from([0])]));
  ok('a trailing byte is reported, not ignored', truncated.exact === false);
}

console.log('\nthe other three replies');
{
  const ask = parseGuildAsk(Buffer.concat([i32(5000), i32(7500)]));
  ok('UC_GUILD_ASK is two prices',   ask.exact && ask.price === 5000 && ask.secretPrice === 7500);
  ok('and matches the kod constant', ask.price === guildPrice(false));
  ok('secret is 150% of it',         ask.secretPrice === guildPrice(true));

  // FOUR ID LISTS IN A FIXED ORDER, and the last two are the one-sided ones. Swapping
  // enemies and declared_enemies makes a war we have merely announced look mutual, which
  // is the difference between a 50,000 forfeit applying and not.
  const list = parseGuildList(Buffer.concat([
    u16(2), i32(1), str('Second Swines'), i32(2), str('The Other Lot'),
    u16(0),                                  // allies (mutual)
    u16(1), i32(2),                          // enemies (mutual)
    u16(0),                                  // declared allies
    u16(1), i32(2),                          // declared enemies
  ]));
  ok('UC_GUILD_LIST reads exactly',   list.exact, `leftover ${list.leftover}`);
  ok('two guilds',                    list.guilds.length === 2);
  ok('mutual enemies are separate',   list.enemies.length === 1);
  ok('from declared enemies',         list.declaredEnemies.length === 1);
  ok('and allies stay empty',         list.allies.length === 0 && list.declaredAllies.length === 0);

  // THE HALL NAME IS A RESOURCE ID, NOT A STRING — the one place on this opcode where a
  // name is four bytes. Reading it as a length-prefixed string desynchronises the rest.
  const halls = parseGuildHalls(Buffer.concat([
    u16(1), i32(700), i32(12345), i32(15000), i32(3600),
  ]));
  ok('UC_GUILD_HALLS reads exactly',  halls.exact, `leftover ${halls.leftover}`);
  ok('the name is a resource id',     halls.halls[0].nameRsc === 12345);
  ok('cost is the purchase price',    halls.halls[0].cost === 15000);
  ok('and rent is named as a DAY',    halls.halls[0].rentDaily === 3600);
}

console.log('\nfounding one, which cannot be undone or renamed');
{
  const good = validateGuild({ name: 'Second Swines' });
  ok('a plain name passes',       good.ok);
  ok('at 5,000',                  good.price === 5000);
  ok('with the default titles',   good.titles.length === 10);
  ok('secret costs 7,500',        validateGuild({ name: 'x', secret: true }).price === 7500);

  // Both length limits are silent server-side discards that charge nothing and say
  // nothing, so being caught here is the only way anybody finds out.
  const long = validateGuild({ name: 'x'.repeat(MAX_GUILD_NAME_LEN + 1) });
  ok('an over-long name is refused',   !long.ok);
  ok('and the message says silence',   long.problems.some(p => /silence/.test(p)));
  const longTitle = [...DEFAULT_RANK_TITLES];
  longTitle[4] = 'y'.repeat(MAX_GUILD_RANK_LEN + 1);
  ok('an over-long title is refused',  !validateGuild({ name: 'ok', titles: longTitle }).ok);
  ok('and names which of the ten',
     validateGuild({ name: 'ok', titles: longTitle }).problems.some(p => /lord male/.test(p)));

  ok('an empty name is refused',       !validateGuild({ name: '' }).ok);
  ok('a whitespace name is refused',   !validateGuild({ name: '   ' }).ok);
  ok('nine titles is refused',         !validateGuild({ name: 'ok', titles: DEFAULT_RANK_TITLES.slice(1) }).ok);
  ok('an empty title is refused',
     !validateGuild({ name: 'ok', titles: DEFAULT_RANK_TITLES.map((t, i) => i === 3 ? '' : t) }).ok);

  // THE WIRE IS LATIN-1 AND pstr KEEPS THE LOW BYTE — the same trap as a character
  // description, except a guild name is permanent and public. An em dash would go out
  // as 0x14 with nothing erroring.
  ok('an em dash is folded, not sent',  cleanGuildText('Swines—Second') === 'Swines-Second');
  ok('curly quotes fold',               cleanGuildText('‘Swines’') === "'Swines'");
  ok('an unmappable character is dropped', cleanGuildText('Swines中') === 'Swines');
  ok('control bytes are dropped',       cleanGuildText('Swines') === 'Swines');
  const folded = validateGuild({ name: 'Second—Swines' });
  ok('and folding is REPORTED, not silent', folded.notes.some(n => /folded/.test(n)));

  // What this cannot know is stated rather than implied by a clean pass. A duplicate
  // name is a real refusal and only the server can see it.
  ok('it admits what only the server can check',
     good.server_will_also_check.some(x => /duplicate|FindGuildByString/.test(x)));
  ok('including the purse, not the bank',
     good.server_will_also_check.some(x => /purse/.test(x)));
  ok('and the PKILL_ENABLE gate',
     good.server_will_also_check.some(x => /PFLAG_PKILL_ENABLE/.test(x)));

  // Five ranks, two genders, in the order the flat packet wants them. Wrong order does
  // not error — it titles every woman as a man for the life of the guild.
  ok('ten fields',                  RANK_TITLE_FIELDS.length === 10);
  ok('apprentice first',            RANK_TITLE_FIELDS[0][0] === 'apprentice');
  ok('male before female',          RANK_TITLE_FIELDS[0][1] === 'male' && RANK_TITLE_FIELDS[1][1] === 'female');
  ok('master last',                 RANK_TITLE_FIELDS[9][0] === 'master');
  ok('and the defaults are paired', DEFAULT_RANK_TITLES[3] === 'Madame' && DEFAULT_RANK_TITLES[9] === 'Mistress');
}

console.log('\nthe units nobody gets right the first time');
{
  const m = maturityWait({});
  ok('30 ticks for a plain guild',  m.ticks === 30);
  ok('of six minutes each',         MAINTENANCE_MS === 360_000);
  ok('which is three hours',        m.minutes === 180);
  ok('secret takes twice as long',  maturityWait({ secret: true }).minutes === 360);
  // THE LAST TICK IS CONDITIONAL, and a two-member guild sits at 1 for ever looking
  // finished. Anybody planning a hall purchase needs this in the same answer.
  ok('and the answer names the member floor', new RegExp(`${MINIMUM_MEMBERS} members`).test(m.also));
  ok('and says the countdown stalls',         /holds at 1/.test(m.also));

  const h = hallCost({ quality: 3 });
  ok('purchase is quality*5000',    h.purchase === 15000);
  ok('rent is hourly, quality*50',  h.rent_hourly === 150);
  ok('and the wire figure is a day', h.rent_daily === 3600);
  // Doubled where player-killing is off — a property of the SERVER, not of the hall.
  ok('non-PK doubles the rent',     hallCost({ quality: 3, pkAllowed: false }).rent_hourly === 300);
  ok('but not the purchase price',  hallCost({ quality: 3, pkAllowed: false }).purchase === 15000);
  let threw = false; try { hallCost({ quality: 0 }); } catch { threw = true; }
  ok('a quality of zero is an error rather than a free hall', threw);

  ok('the war forfeit is 50,000',   WAR_LOSS_PENALTY === 50_000);
  ok('an invitation lives 2 minutes', INVITATION_MS === 120_000);
}

console.log('\njoining, where the game and a fleet disagree hardest');
{
  ok('a clean character has no blockers',
     joinBlockers({ character: 'Kermit', maxHealth: 56, room: 700, inviterRoom: 700 }).ok);

  // Under 30 max health the invitation is refused when USED, not when issued — so the
  // inviter has already burned its one slot for two minutes finding out.
  const small = joinBlockers({ character: 'Tiny', maxHealth: 22, room: 700, inviterRoom: 700 });
  ok('under max health 30 is blocked',   !small.ok);
  ok('and it names PFLAG_PKILL_ENABLE',  /PFLAG_PKILL_ENABLE/.test(small.blockers[0].why));

  const elsewhere = joinBlockers({ character: 'Zoot', maxHealth: 59, room: 599, inviterRoom: 700 });
  ok('a different room is blocked',      !elsewhere.ok);
  ok('and it says the invitation vanishes', /vanishes/.test(elsewhere.blockers[0].why));

  const already = joinBlockers({ character: 'Rizzo', maxHealth: 60, room: 700, inviterRoom: 700,
                                 guildOfCharacter: 'The Other Lot' });
  ok('an existing guild is blocked',     !already.ok);
  ok('and the fix is renounce',          already.blockers[0].fix === 'renounce');

  const former = joinBlockers({ character: 'Floyd', maxHealth: 59, room: 700, inviterRoom: 700,
                                formerMember: true });
  ok('a former member is blocked',       !former.ok);
  // Silence on both halves of the room check: with only one side known, nothing is
  // claimed. Inventing a blocker from a missing fact would strand a joinable character.
  ok('an unknown room asserts nothing',
     joinBlockers({ character: 'Gonzo', maxHealth: 59 }).ok);

  const plan = inductionPlan({
    inviter: 'Piggy', inviterFlags: 0xffff, room: 700,
    characters: [{ character: 'Kermit', maxHealth: 56, room: 700 },
                 { character: 'Zoot',   maxHealth: 59, room: 599 },
                 { character: 'Tiny',   maxHealth: 12, room: 700 }],
  });
  ok('the plan is serial',           plan.serial === true);
  // NOT AN OPTIMISATION — CheckInvitationList refuses a second outstanding invitation
  // with no message at all, so a parallel fan-out reports every one of them as sent.
  ok('and says why it must be',      /ONE outstanding|one outstanding/.test(plan.serial_why));
  ok('one ready',                    plan.ready.join(',') === 'Kermit');
  ok('two blocked',                  plan.blocked.length === 2);
  ok('the far one for its room',     plan.blocked.some(b => b.character === 'Zoot'));
  ok('the small one for its health', plan.blocked.some(b => b.character === 'Tiny'));
  ok('every step confirms before moving on',
     plan.steps[0].sequence.some(x => /confirm/.test(x)));
  ok('and the window is carried',    plan.window_ms === INVITATION_MS);

  // An inviter without the bit is reported on the plan rather than discovered twenty
  // silent invitations later.
  const cantInvite = inductionPlan({ inviter: 'Beaker', inviterFlags: 0, room: 700,
                                     characters: ['Kermit'] });
  ok('a plan states the inviter may not invite', cantInvite.may_invite.allowed === false);
  ok('and still lists the steps',                cantInvite.steps.length === 1);

  // A STEP CARRIES ITS AGENT HANDLE, because the execution loop matches steps back to
  // sessions and the character NAME is not safe for that: a roster entry whose name has
  // not been read back is null, and two nulls compare equal — which would point every
  // unnamed character's step at the first one.
  const byAgent = inductionPlan({ inviter: 'Piggy', inviterFlags: 0xffff, room: 700,
    characters: [{ agent: 't1', character: null, maxHealth: 56, room: 700 },
                 { agent: 't2', character: null, maxHealth: 58, room: 700 }] });
  ok('two unnamed characters stay two steps', byAgent.steps.length === 2);
  ok('and each keeps its own agent handle',
     byAgent.steps.map(s => s.agent).join(',') === 't1,t2');
  ok('a plain string still works',
     inductionPlan({ inviter: 'P', inviterFlags: 0xffff, room: 700, characters: ['Kermit'] })
       .steps[0].character === 'Kermit');
}

console.log('\nthe two limits the live server taught us, both silent');
{
  // 1. A RANK IS A FLOOR AND SOMETIMES A CEILING. `renounce` declares RANK_APPRENTICE, so
  //    the floor grants it to everybody — and gcrennce.kod:53 removes it from a master.
  //    Live proof: Piggy, master of the Second Swines, read flags 0x3fe3, bit 0x0004 clear.
  ok('an apprentice may renounce',   mayI('renounce', { rank: RANK.APPRENTICE }).allowed);
  ok('a lieutenant may renounce',    mayI('renounce', { rank: RANK.LIEUTENANT }).allowed);
  ok('a MASTER may not',            !mayI('renounce', { rank: RANK.MASTER }).allowed);
  ok('and is told to abdicate',      /abdicate|disband/.test(mayI('renounce', { rank: RANK.MASTER }).why));
  // The real flag word Piggy reported. The exclusion is why rank alone was not enough.
  ok("the live master's flags lack renounce", commandsIn(0x3fe3).includes('renounce') === false);
  ok('but do include invite and set_rank',
     commandsIn(0x3fe3).includes('invite') && commandsIn(0x3fe3).includes('set_rank'));
  // No hall yet, so neither hall command is granted — another case where the rank table
  // alone would have said yes.
  ok('and lack the two hall commands',
     !commandsIn(0x3fe3).includes('abandon_hall') && !commandsIn(0x3fe3).includes('set_password'));

  // 2. MAX_LIEUTENANT = 2, AND THE REFUSAL GOES TO THE PROMOTER. Measured: Piggy promoted
  //    Lew to lieutenant, then was refused for five more, all of whom stayed at rank 1 —
  //    and the invitees were told nothing at all.
  const none = [{ id: 1, rank: RANK.MASTER }];
  ok('an empty guild has both seats',   rankRoom(RANK.LIEUTENANT, none).room === 2);
  const one = [...none, { id: 2, rank: RANK.LIEUTENANT }];
  ok('one lieutenant leaves one seat',  rankRoom(RANK.LIEUTENANT, one).room === 1);
  const two = [...one, { id: 3, rank: RANK.LIEUTENANT }];
  ok('two lieutenants leaves none',     rankRoom(RANK.LIEUTENANT, two).room === 0);
  ok('and it is flagged as capped',     rankRoom(RANK.LIEUTENANT, two).capped === true);
  ok('and says the promoter hears it',  /PROMOTER/.test(rankRoom(RANK.LIEUTENANT, two).why));

  // LORD IS UNCAPPED AND null IS NOT ZERO. Reading an unrationed rank's `room` as zero
  // would stop the spread dead at the first member.
  const lords = [...two, ...Array.from({ length: 50 }, (_, i) => ({ id: 100 + i, rank: RANK.LORD }))];
  ok('lord is not rationed',            rankRoom(RANK.LORD, lords).capped === false);
  ok('and its room is null, not 0',     rankRoom(RANK.LORD, lords).room === null);
  ok('fifty lords is still fine',       rankRoom(RANK.LORD, lords).cap === null);
  ok('apprentice is not rationed',      rankRoom(RANK.APPRENTICE, lords).capped === false);
  ok('there is exactly one master',     RANK_QUOTA[RANK.MASTER] === 1);

  // THE RANK A SPREAD SHOULD AIM AT. Lowest that can invite, and uncapped — aiming at the
  // second-highest silently fails for everyone after the second.
  ok('the self-sustaining rank is LORD', SELF_SUSTAINING_RANK === RANK.LORD);
  ok('and it can invite',                mayI('invite',   { rank: SELF_SUSTAINING_RANK }).allowed);
  ok('but cannot promote',              !mayI('set_rank', { rank: SELF_SUSTAINING_RANK }).allowed);
  ok('and it is not rationed',           rankRoom(SELF_SUSTAINING_RANK, lords).capped === false);
}

console.log('\nrent, which is prose and whose SIGN is the whole meaning');
{
  const owed = parseRentLine(['Frular tells you, "The Second Swines owes 12000 coins in rent at this time."']);
  ok('a debt is read',              owed.due === 12000);
  ok('and is POSITIVE, as the game means it', owed.due > 0);
  ok('with credit as its negation', owed.credit === -12000);

  // The credit sentence is a DIFFERENT sentence with the number already negated for
  // display, so matching on digits alone gets the sign backwards — and the sign decides
  // whether the guild is about to be disbanded or is carrying what a war needs.
  const credit = parseRentLine(['The Second Swines has a positive balance of 50000 shillings.  I thank thee for thy timely payments.']);
  ok('a credit is read',            credit.credit === 50000);
  ok('and is NEGATIVE due',         credit.due === -50000);

  ok('no rent owing is zero',       parseRentLine(['Thou owest no rent at this time.']).due === 0);
  ok('and in a guild',              parseRentLine(['Thou owest no rent at this time.']).in_guild === true);
  ok('no guild is not zero rent',   parseRentLine(['Thou belongest to no guild, and thus owest no rent.']).in_guild === false);
  ok('and reports a null balance',  parseRentLine(['Thou belongest to no guild, and thus owest no rent.']).due === null);

  // AN UNPARSED LINE MUST NOT LOOK LIKE A ZERO BALANCE. One of those means the guild is
  // fine and the other means nobody knows.
  ok('an unrecognised line is null', parseRentLine(['Frular says hello.']) === null);
  ok('no lines at all is null',      parseRentLine([]) === null);
  ok('and null is not zero',         parseRentLine(['blah'])?.due !== 0);
  ok('the first recognisable line wins',
     parseRentLine(['chatter', 'The X owes 5 coins in rent at this time.']).due === 5);

  ok('hours are read',              parseRentHours(['The guild members have 7 hours to pay off their balance, or the guild will be disbanded.']) === 7);
  ok('one hour is a special string', parseRentHours(['The guild members have an hour to pay off their balance, or the guild will be disbanded.']) === 1);
  ok('less than an hour is half',   parseRentHours(['The guild members have less than an hour to pay off their balance, or the guild will be disbanded.']) === 0.5);
  ok('and silence is null',         parseRentHours(['nothing about hours']) === null);
}

console.log('\none home for the rent half, not two');
{
  // THIS FILE AND m59-tithe.mjs BOTH GREW A parseRentLine ON THE SAME AFTERNOON, written by
  // two hands from the same kod. They agreed by luck, which is not a property worth having:
  // the tithe module owns the rent arithmetic because it also owns the durable day-book and
  // the payment plan the keeper's guild_tithe policy runs on, and this one re-exports it.
  // Identity, not equality — a copy that merely matches today is the thing being prevented.
  ok('parseRentLine is the tithe module\'s own', parseRentLine === tithe.parseRentLine);
  ok('so is parseRentHours',                     parseRentHours === tithe.parseRentHours);
  ok('and Frular\'s room',                       FRULAR_ROOM === tithe.FRULAR_ROOM);

  // The book is keyed <fleet>-<agent>, so two answers to "which fleet" are two books — and
  // the failure is quiet in the expensive direction: paid_today reads 0 all day and the
  // fleet tithes again on every sale.
  ok('the fleet name has one resolver',  typeof tithe.titheFleet === 'function');
  ok('--fleet wins',                     tithe.titheFleet(['--fleet', 'x'], {}) === 'x');
  ok('then the environment',             tithe.titheFleet([], { M59_FLEET: 'y' }) === 'y');
  // AND IT IS NEVER EMPTY, whatever it resolves to. `fleetName` answers '' for the unnamed
  // fleet, and '' would key the book `-t14.json` — a third file nobody reads. The recorded
  // `substrate/fleet-default` sits between the environment and that fallback, which is why
  // this asserts non-empty rather than a literal: on this machine it is `prod`, and on a
  // fresh clone with no such file it is `default`.
  ok('and never empty',                  !!tithe.titheFleet([], {}));
  ok('even for the unnamed fleet',       tithe.titheFleet(['--fleet', '-'], {}) === 'default');
}

console.log("\nthe Bookmaker's, whose rent the general formula gets wrong");
{
  const h = KNOWN_HALLS[714];
  ok('room 714',                    h.room === 714);
  ok('quality 5',                   h.quality === 5);
  ok('purchase is 25,000',          h.purchase === 25_000);
  ok('and matches the formula',     hallCost({ quality: 5 }).purchase === h.purchase);
  ok('rent is 12,000 a day',        h.rent_daily === 12_000);
  ok('which is 500 an hour',        h.rent_hourly === 500 && h.rent_daily === h.rent_hourly * 24);
  // THE HALL OVERRIDES GetRentValue WITH A DOUBLING OF ITS OWN. On a PK server the general
  // formula understates this hall by half; on a non-PK server the two doublings coincide
  // and one of them is invisible. Pinned so the coincidence cannot be mistaken for the rule.
  ok('the general formula says HALF this',
     hallCost({ quality: 5, pkAllowed: true }).rent_hourly === 250);
  ok('and the override is cited',   /guildh14\.kod:191/.test(h.rent_override));
}

console.log('\npooling money, where purse and bank are not interchangeable');
{
  const holders = [
    { agent: 't14', character: 'Piggy',  purse: 21_011, banked: 0 },
    { agent: 't17', character: 'Zoot',   purse: 100,    banked: 15_317 },
    { agent: 't19', character: 'Rizzo',  purse: 50,     banked: 14_129 },
    { agent: 't1',  character: 'Kermit', purse: 0,      banked: 0 },
  ];
  const p = fundingPlan({ need: 25_000, buyer: 't14', holders });
  ok('the buyer\'s own money counts first', p.buyer_purse === 21_011);
  // Twenty pointless walks avoided: only the shortfall is collected.
  ok('only the shortfall is collected',   p.from.reduce((n, f) => n + f.take, 0) === 25_000 - 21_011);
  ok('from the wealthiest first',         p.from[0].agent === 't17');
  ok('and it is enough',                  p.enough);
  ok('a contributor with nothing is left alone', !p.from.some(f => f.agent === 't1'));
  // The withdrawal is the expensive half — Barloque has no bank, so every banked
  // contribution is a detour to Tos or Jasper before anybody can walk to Frular.
  ok('a banked contribution needs a withdrawal', p.from[0].must_withdraw === 25_000 - 21_011 - 100);
  ok('and the count is surfaced',                p.withdrawals_needed >= 1);

  const short = fundingPlan({ need: 100_000, buyer: 't14', holders });
  ok('a shortfall is reported, not hidden', !short.enough && short.shortfall > 0);
  ok('and everybody with money is in it',   short.from.length === 2);

  // A reserve keeps walking money in each contributor's pocket rather than stripping the
  // fleet to zero for one purchase.
  const reserved = fundingPlan({ need: 25_000, buyer: 't14', holders, reserve: 1_000 });
  ok('a reserve reduces what each gives',
     reserved.from[0].take <= p.from[0].take || reserved.from.length > p.from.length);
  let threw = false; try { fundingPlan({ need: 0, buyer: 't14', holders }); } catch { threw = true; }
  ok('a need of zero is an error', threw);
}

console.log('\ndaily tithes, charged only from verified sale proceeds');
{
  const full = tithePaymentPlan({ dailyAmount: 2_000, paidToday: 0,
    saleProceeds: 3_000, purse: 4_000, walkingMoney: 1_000 });
  ok('the configured daily amount caps one payment', full.amount === 2_000);
  const partial = tithePaymentPlan({ dailyAmount: 2_000, paidToday: 500,
    saleProceeds: 700, purse: 1_700, walkingMoney: 1_000 });
  ok('a smaller sale makes a partial payment', partial.amount === 700);
  const reserve = tithePaymentPlan({ dailyAmount: 2_000, paidToday: 0,
    saleProceeds: 2_000, purse: 2_500, walkingMoney: 1_000 });
  ok('walking money is never taxed', reserve.amount === 1_500);
  const noSale = tithePaymentPlan({ dailyAmount: 2_000, paidToday: 0,
    saleProceeds: 0, purse: 9_000, walkingMoney: 1_000 });
  ok('old purse is not mistaken for sale proceeds', noSale.amount === 0);

  const dir = mkdtempSync(join(tmpdir(), 'm59-tithe-'));
  try {
    const at = new Date(2026, 7, 12, 12).getTime();
    const book = new TitheBook({ agent: 'test', fleet: 'fixture', dir });
    book.record(700, { at });
    book.record(300, { at: at + 60_000 });
    ok('verified partials add within one day', book.paidToday(at) === 1_000);
    ok('the next local day starts unpaid', book.paidToday(at + 24 * 60 * 60_000) === 0);
    const reopened = new TitheBook({ agent: 'test', fleet: 'fixture', dir });
    ok('the daily total survives a restart', reopened.paidToday(at) === 1_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log('\nrank names, which are what a board prints');
{
  ok('five ranks',            Object.keys(RANK).length === 5);
  ok('master is the highest', RANK.MASTER === 5);
  ok('apprentice is 1',       RANK.APPRENTICE === 1);
  ok('and the ordering IS the permission test',
     [RANK.APPRENTICE, RANK.SIR, RANK.LORD, RANK.LIEUTENANT, RANK.MASTER]
       .every((v, i, arr) => i === 0 || v > arr[i - 1]));
  ok('every rank has a name',  [1, 2, 3, 4, 5].every(r => typeof RANK_NAME[r] === 'string'));
  ok('every command has a citation',
     Object.values(COMMANDS).every(s => /\.kod:\d+/.test(s.cite)));
  ok('every command bit is distinct',
     new Set(Object.values(COMMANDS).map(s => s.gcid)).size === Object.keys(COMMANDS).length);
}

// WHO IS OURS -- the boundary that keeps an invitation off a stranger, and the one that was
// open for a whole fleet. Every guild action that addresses another character decides
// membership by OBJECT ID against this broker's own sessions. On 2026-09-10 that map was
// EMPTY on prod: the keeper proxy's `client.me` carried only a name, so `me.id` was undefined
// for all twenty-three characters while `selfId` was right the whole time. `spread` answered
// `in_guild: 0 of 23` and named the guild's own master as still out, seconds after reading a
// fresh roster that listed him. This is the rule asked offline so it cannot go quiet again.
console.log('\nwhose character is this -- the id that decides who may be invited');
{
  const inProcess   = { state: 'game', me: { name: 'Piggy', id: 4476 }, selfId: 4476 };
  const keeperProxy = { state: 'game', me: { name: 'Fozzie' }, selfId: 4474 };   // no me.id
  const joining     = { state: 'none', me: null, selfId: null };
  const unknownSelf = { state: 'game', me: { name: 'Lew' }, selfId: -1 };

  ok('an in-process session answers with its own id',   sessionObjectId(inProcess) === 4476);
  ok('A KEEPER PROXY ANSWERS TOO -- the whole bug',      sessionObjectId(keeperProxy) === 4474);
  ok('a session still joining answers null',            sessionObjectId(joining) === null);
  ok('selfId -1 is "I do not know yet", not an id',     sessionObjectId(unknownSelf) === null);
  ok('a null client is not a character',                sessionObjectId(null) === null);

  ok('0 is never an object id',          !isObjectId(0));
  ok('a negative is never an object id', !isObjectId(-1));
  ok('undefined is never an object id',  !isObjectId(undefined));
  ok('a positive integer is',             isObjectId(4474));
  ok('a float is not',                   !isObjectId(4474.5));

  const ours = ourSessionsById(new Map([
    ['t14', { client: inProcess }],
    ['t12', { client: keeperProxy }],
    ['t3',  { client: joining }],
    ['t20', { client: unknownSelf }],
  ]));
  ok('a keeper-backed fleet is visible at all', ours.size === 2);
  ok('and keyed by the id the server gave it',  ours.get(4474)?.agent === 't12');
  ok('a session still joining is not in it',    ours.size === 2 && !ours.has(null));
  ok('AND NO JUNK ID IS EVER A KEY, because a lookup that matches on one matches a stranger',
     !ours.has(-1) && !ours.has(0) && !ours.has(undefined));

  // The regression itself, stated as the number that must never read zero again.
  const guildRoster = [{ id: 4474, rank: RANK.LIEUTENANT }, { id: 4480, rank: RANK.MASTER }];
  const inviters = [...ours.keys()]
    .filter(id => guildRoster.some(m => m.id === id && m.rank >= RANK.LORD));
  ok('a guild of keeper-backed members finds its inviters', inviters.length === 1);
}

// A ROSTER READ HAS THREE ANSWERS AND ONE OF THEM IS "NOTHING ANSWERED".
//
// UC_GUILDINFO replies with a roster packet, or with PROSE (`user_no_guild`,
// user.kod:1974) and no packet, or -- on a keeper-backed session, where the read is a round
// trip through the keeper -- with neither. The third was being filed as the second, so
// `status` answered in_guild:false for a lost packet and `spread` answered "the inviter is
// not in a guild" and stopped. Measured 2026-09-10 04:04:50: a spread loop stopped on that
// while Fozzie was a serving lieutenant and said so on the next three reads.
console.log('\nwhat a roster read said, including when it said nothing');
{
  const packet = { guild: { id: 8267, name: 'The Second Swines' }, said: [] };
  const prose  = { guild: null, said: ['Thou belongest to no guild.'] };
  const silence = { guild: null, said: [] };

  ok('a roster packet means in the guild',   rosterReadOutcome(packet) === ROSTER_READ.GUILD);
  ok('prose with no packet means NO guild',  rosterReadOutcome(prose) === ROSTER_READ.NONE);
  ok('NEITHER means nothing answered',       rosterReadOutcome(silence) === ROSTER_READ.UNANSWERED);
  ok('and unanswered is NOT the same as no guild',
     rosterReadOutcome(silence) !== rosterReadOutcome(prose));
  ok('a missing argument is unanswered, not no-guild',
     rosterReadOutcome() === ROSTER_READ.UNANSWERED);
  ok('prose ALONGSIDE a packet is still the guild -- the packet is the answer',
     rosterReadOutcome({ guild: { id: 1 }, said: ['chatter'] }) === ROSTER_READ.GUILD);

  ok('ONLY the non-answer is worth asking again', rosterReadWorthRetrying(silence));
  ok('a guildless answer is an ANSWER and is not re-asked', !rosterReadWorthRetrying(prose));
  ok('and neither is a roster we already have',   !rosterReadWorthRetrying(packet));
}

// A HALL ID AND A HALL ROOM ARE DIFFERENT NAMESPACES OF SMALL INTEGERS.
//
// The wire addresses a hall as an OBJECT (user.kod:1827) and the pushed list is built from
// hall objects (user.kod:5776), while KNOWN_HALLS — and every human — names halls by ROOM.
// Sending the room number is answered "come back when you have enough money", which reads as
// a purse problem and is not one. Measured 2026-09-11 at a cost of one world crossing with
// 33,330 shillings in hand for a 25,000 hall.
console.log('\na hall room number is not a hall id');
{
  ok('KNOWN_HALLS is keyed by ROOM number',
     Object.entries(KNOWN_HALLS).every(([k, h]) => Number(k) === h.room));
  ok('714 is the Bookmaker\'s ROOM and is caught', looksLikeHallRoomNumber(714));
  ok('the Bookmaker\'s costs 25,000', KNOWN_HALLS[714].purchase === 25_000);
  ok('and its rent is its OWN doubling, 12,000 a day not 6,000',
     KNOWN_HALLS[714].rent_daily === 12_000 && KNOWN_HALLS[714].rent_hourly === 500);
  ok('a plausible object id is NOT flagged', !looksLikeHallRoomNumber(8249));
  ok('a non-integer is not flagged',        !looksLikeHallRoomNumber(714.5));
  ok('null is not flagged',                 !looksLikeHallRoomNumber(null));
  ok('and neither is a name',               !looksLikeHallRoomNumber('Bookmaker'));
}

// A SNAPSHOT THAT FORGOT WHO YOU ARE IS NOT A CHARACTER THAT LEFT.
//
// The object id comes from the keeper's state snapshot, and snapshots sometimes arrive
// without `you`. Every reader then concludes the session has no character: /health drops the
// agent, ourSessionsById stops seeing it, and the guild tool loses an inviter it had a second
// ago. Measured on a HEALTHY fleet 2026-09-11: 150 samples at 2s, TEN of twenty-two agents
// dropped and returned, twenty-four transitions, always in pairs. Asked directly, not one had
// moved — t9 "left and rejoined" three times at connection_revision 1 with uptime unbroken.
//
// The revision is the invalidation key because a genuine rejoin is the one thing that changes
// the id, and it is exactly what moves that counter.
console.log('\nremembering who a session is across an incomplete snapshot');
{
  // A good snapshot answers from itself and seeds the cache.
  let r = rememberObjectId(null, { id: 4463, revision: 1 });
  ok('a complete snapshot answers with its own id', r.id === 4463);
  ok('and it is not "remembered"',                  r.remembered === false);
  ok('it seeds the cache with the revision',        r.cache.id === 4463 && r.cache.revision === 1);

  // THE BUG THIS EXISTS FOR: same connection, no `you`.
  const held = rememberObjectId(r.cache, { id: undefined, revision: 1 });
  ok('A SNAPSHOT WITHOUT `you` KEEPS THE ID on the same connection', held.id === 4463);
  ok('and says it was remembered rather than seen', held.remembered === true);

  // THE CASE THAT MUST NOT BE CACHED. A rejoin changes the id, so the old one now names
  // somebody else — on a shared server that is the mistake that matters.
  const rejoined = rememberObjectId(r.cache, { id: undefined, revision: 2 });
  ok('A REJOIN DROPS THE CACHE — the id really did change', rejoined.id === null);
  ok('and the stale cache is not carried forward',          rejoined.cache === null);

  // A new id on a new connection simply replaces it.
  const fresh = rememberObjectId(r.cache, { id: 9001, revision: 2 });
  ok('a new id on a new revision is taken', fresh.id === 9001 && fresh.cache.revision === 2);

  // UNKNOWN IS NOT A MATCH. A snapshot too degraded to say which connection it describes
  // cannot vouch for an id either.
  ok('an unknown revision refuses the cache',
     rememberObjectId(r.cache, { id: undefined, revision: null }).id === null);
  ok('and a cache with no revision cannot be matched',
     rememberObjectId({ id: 4463, revision: null }, { id: undefined, revision: 1 }).id === null);

  // Junk never survives, cached or not.
  ok('a junk id is not cached', rememberObjectId(null, { id: -1, revision: 1 }).id === null);
  ok('and a junk cache is not served',
     rememberObjectId({ id: 0, revision: 1 }, { id: undefined, revision: 1 }).id === null);
  ok('no cache and no id is simply unknown',
     rememberObjectId(null, { id: undefined, revision: 1 }).id === null);

  // The measured sequence, end to end: three phantom drops at one revision.
  let cache = null, ids = [];
  for (const snap of [{ id: 4471, revision: 1 }, { revision: 1 }, { id: 4471, revision: 1 },
                      { revision: 1 }, { revision: 1 }, { id: 4471, revision: 1 }]) {
    const out = rememberObjectId(cache, { id: snap.id, revision: snap.revision });
    cache = out.cache; ids.push(out.id);
  }
  ok('t9\'s six samples now read as ONE continuous character',
     ids.every(x => x === 4471));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
