// GUILDS — the rules, with no wire and no fleet in them.
//
// A guild is the one thing in this game that is a standing arrangement between
// characters rather than a property of one. Everything else the harness drives is
// answerable from inside a single character; a guild is answerable only from the
// roster, and the roster lives on the server.
//
// THE WHOLE COMMAND SPACE REFUSES BY SILENCE, AND WORSE THAN THE USUAL WAY.
//
// The usual Meridian refusal is a sentence spoken to the room — bad enough, and the
// reason nothing here trusts "no error" (see the Izzio/Ko'catan and Skivlat notes in
// CLAUDE.md). Guild commands are a step past that. `User.UserGuildCommand`
// (user.kod:4848) checks `HasGuildCommand` and, when the player does not hold the bit,
// takes the ELSE branch: `Debug("Player ... trying to use a guild command he doesn't
// have!!!")` and returns. That Debug goes to the SERVER LOG. The player is told
// nothing at all — not a message, not a resource string, nothing on the wire.
//
// So for these fourteen commands "the server said nothing" is the EXPECTED result of
// being under-ranked, and it is byte-for-byte identical to the packet having worked.
// This module exists so the check happens BEFORE the send, against the bitmask the
// server itself handed us, rather than being inferred afterwards from silence.
//
// Nothing in here does any I/O. `m59-client.mjs` owns the packets, the broker's
// `guild` tool owns the choreography, and `m59-guild-test.mjs` pins this.

// kod/include/blakston.khd:2300 — a bitmask, one bit per command, carried whole in
// UC_GUILDINFO as `piGuild_commands`.
export const GCID = {
  INVITE:         0x0001,
  EXILE:          0x0002,
  RENOUNCE:       0x0004,
  PROMOTE:        0x0008,
  DEMOTE:         0x0010,
  VOTE:           0x0020,
  ABDICATE:       0x0040,
  ROSTER:         0x0080,
  FORGE_ALLIANCE: 0x0100,
  END_ALLIANCE:   0x0200,
  DECLARE_ENEMY:  0x0400,
  PEACE:          0x0800,
  SET_RANK:       0x1000,
  DISBAND:        0x2000,
  ABANDON_HALL:   0x4000,
  SET_PASSWORD:   0x8000,
};

// kod/include/blakston.khd:2289. FIVE ranks, and the number IS the ordering — every
// permission test in the tree is `rank < viRank_needed`.
export const RANK = { APPRENTICE: 1, SIR: 2, LORD: 3, LIEUTENANT: 4, MASTER: 5 };
export const RANK_NAME = { 1: 'apprentice', 2: 'sir', 3: 'lord', 4: 'lieutenant', 5: 'master' };

// WHAT RANK EACH COMMAND ACTUALLY NEEDS, one citation per row, from the
// `viRank_needed` classvar of the command's own class in kod/object/passive/guildcmd/.
//
// Read the surprises rather than the pattern: INVITE is LORD (3) while EXILE and
// SET_RANK are LIEUTENANT (4), so there is a rank that can recruit but not expel and
// not promote. SET_PASSWORD declares nothing of its own and therefore inherits
// GuildCommand's default of MASTER (guildcmd.kod:41) — that default is the reason
// this table lists every command explicitly instead of falling back.
export const COMMANDS = {
  invite:        { gcid: GCID.INVITE,         rank: RANK.LORD,       cite: 'gcinvite.kod:48' },
  exile:         { gcid: GCID.EXILE,          rank: RANK.LIEUTENANT, cite: 'gcexile.kod:47' },
  // A RANK IS A FLOOR AND SOMETIMES ALSO A CEILING. `renounce` declares
  // `viRank_needed = RANK_APPRENTICE`, so the floor says everybody holds it — and
  // `gcrennce.kod:53` overrides `ResetCommand` to REMOVE it from a master, because a
  // guildmaster must abdicate or disband rather than walk out. Live proof: Piggy, master of
  // the Second Swines, reads flags 0x3fe3 with bit 0x0004 clear. This entry said "held at
  // every rank" until the server disagreed with it, which is precisely why `mayI` asks the
  // bitmask and treats the rank table as planning only.
  renounce:      { gcid: GCID.RENOUNCE,       rank: RANK.APPRENTICE, cite: 'gcrennce.kod:42',
                   not_for: [RANK.MASTER], not_for_why:
                     'a guildmaster has renounce REMOVED (gcrennce.kod:53) and must abdicate or ' +
                     'disband instead' },
  vote:          { gcid: GCID.VOTE,           rank: RANK.APPRENTICE, cite: 'gcvote.kod:39' },
  abdicate:      { gcid: GCID.ABDICATE,       rank: RANK.MASTER,     cite: 'gcabdic.kod:51' },
  roster:        { gcid: GCID.ROSTER,         rank: RANK.LORD,       cite: 'gcroster.kod:40' },
  ally:          { gcid: GCID.FORGE_ALLIANCE, rank: RANK.LIEUTENANT, cite: 'gcally.kod:48' },
  end_alliance:  { gcid: GCID.END_ALLIANCE,   rank: RANK.LIEUTENANT, cite: 'gcnoally.kod:39' },
  declare_war:   { gcid: GCID.DECLARE_ENEMY,  rank: RANK.LIEUTENANT, cite: 'gcenemy.kod:39' },
  make_peace:    { gcid: GCID.PEACE,          rank: RANK.LIEUTENANT, cite: 'gcnoenem.kod:39' },
  set_rank:      { gcid: GCID.SET_RANK,       rank: RANK.LIEUTENANT, cite: 'gcsetrnk.kod:41' },
  disband:       { gcid: GCID.DISBAND,        rank: RANK.MASTER,     cite: 'gcdisbnd.kod:39' },
  abandon_hall:  { gcid: GCID.ABANDON_HALL,   rank: RANK.LIEUTENANT, cite: 'gcaband.kod:38' },
  set_password:  { gcid: GCID.SET_PASSWORD,   rank: RANK.MASTER,     cite: 'guildcmd.kod:41 (inherited default)' },
};

// kod/include/blakston.khd:2961
export const MAX_GUILD_NAME_LEN = 30;
export const MAX_GUILD_RANK_LEN = 20;

// kod/util/system.kod:243 — one number, and the secret price is derived from it
// (GetGuildSecretPrice, system.kod:4240: `price * factor / 100`).
export const GUILD_PRICE = 5000;
export const GUILD_SECRET_FACTOR = 150;
export const guildPrice = (secret = false) =>
  secret ? Math.floor(GUILD_PRICE * GUILD_SECRET_FACTOR / 100) : GUILD_PRICE;

// kod/object/passive/guild.kod:31 and kod/util/system.kod:34.
//
// Maturity is a COUNTDOWN OF MAINTENANCE TICKS, not a wall clock, and the tick only
// counts down when at least one member is logged on (guild.kod:692). For this fleet
// that distinction never bites — somebody is always in game — but it is why the
// number below is a floor rather than a duration.
export const MATURITY_TICKS = { nonsecret: 30, secret: 60 };
export const MAINTENANCE_MS = 360_000;                   // 6 minutes
export const MINIMUM_MEMBERS = 3;
export const MAX_MEMBERS = 400;

// A RANK IS NOT ONLY A PERMISSION, IT IS A SEAT, AND ONLY ONE RANK IS RATIONED.
//
// `MAX_LIEUTENANT = 2` (guild.kod:49). `NewLieutenantOkay` counts the members already at
// rank 4 and refuses the third (guild.kod:1583); `NewLordOkay` is a two-line function whose
// own docstring says *"Currently, always returns TRUE"* (guild.kod:1604), so LORD IS
// UNLIMITED. There is exactly one master.
//
// THIS IS THE RANK ARITHMETIC THAT DECIDES HOW A GUILD SPREADS ACROSS A FLEET, and it cuts
// against the obvious plan. "Promote everyone to the second-highest rank so they can invite
// too" cannot be done for more than two of them — but it does not need to be, because
// INVITE NEEDS ONLY LORD (3) and lord is uncapped. What lord cannot do is `set_rank`, which
// needs 4. So a fleet of lords all recruit and none promote, and the promoting is left to
// the one master and at most two lieutenants.
//
// Measured live, 2026-08-12: Piggy (master) promoted Lew to lieutenant and was then refused
// for Kermit, Fozzie, Scooter, Animal and Rizzo, all of whom stayed at rank 1. The refusal
// (`guild_cant_promote_capt`) is sent to the PROMOTER, not to the member — so from the
// invitee's side a failed promotion is silent, and a spread that trusted its own set_rank
// calls would have reported five lieutenants and produced none.
export const RANK_QUOTA = { [RANK.MASTER]: 1, [RANK.LIEUTENANT]: 2 };

/**
 * How many more members may hold this rank, given the roster.
 *
 * `null` means unrationed — which is lord, sir and apprentice. Do not read null as zero.
 */
export function rankRoom(rank, members = []) {
  const cap = RANK_QUOTA[rank];
  if (cap == null) return { rank, capped: false, cap: null, held: null, room: null,
                            why: `rank ${rank} (${RANK_NAME[rank] ?? '?'}) is not rationed` };
  const held = members.filter(m => m.rank === rank).length;
  return { rank, capped: true, cap, held, room: Math.max(0, cap - held),
           why: held >= cap
             ? `the guild already holds ${held} of at most ${cap} at rank ${rank} ` +
               `(${RANK_NAME[rank] ?? '?'}); the refusal goes to the PROMOTER, not the member ` +
               `(guild.kod:1583)`
             : null };
}

/**
 * The rank to promote a new member to if the point is that they can recruit in turn.
 *
 * LORD, and the reasoning is worth keeping: it is the lowest rank that can invite, it is
 * uncapped, and aiming higher silently fails for everyone after the second.
 */
export const SELF_SUSTAINING_RANK = RANK.LORD;

/**
 * How long, at the earliest, before a new guild may rent a hall.
 *
 * THE LAST TICK IS CONDITIONAL ON MEMBERSHIP AND THAT IS THE PART THAT CATCHES A FLEET.
 * guild.kod:705 refuses to take the counter from 1 to 0 while the guild holds fewer
 * than three members, and it does not stop the clock so much as stall it — so a
 * two-member guild sits at 1 for ever, three hours in, looking finished.
 */
export function maturityWait({ secret = false } = {}) {
  const ticks = secret ? MATURITY_TICKS.secret : MATURITY_TICKS.nonsecret;
  return { ticks, ms: ticks * MAINTENANCE_MS, minutes: ticks * MAINTENANCE_MS / 60_000,
           also: `and at least ${MINIMUM_MEMBERS} members at the final tick, or the ` +
                 `countdown holds at 1 indefinitely (guild.kod:705)` };
}

// kod/object/active/holder/room/ghall.kod:30. A hall's price and rent are both a
// multiple of its own `viQuality`, so the two move together and there is no cheap
// hall with a high rent.
export const PURCHASE_MODIFIER = 5000;
export const RENT_MODIFIER = 50;

/**
 * Price and rent for a hall of the given quality.
 *
 * `GetRentValue` IS HOURLY AND THE PACKET SENDS A DAY OF IT. user.kod:5779 puts
 * `24*Send(i,@GetRentValue)` on the wire, so the number arriving from the server is a
 * DAILY figure while every rent rule inside the game is hourly. Reporting the packet's
 * number as "rent" understates the bill by a factor of 24 in one direction or
 * overstates the hourly rate by the same in the other, and both read plausible.
 *
 * Rent doubles where player-killing is not allowed (ghall.kod:502) — a server
 * property, not a hall property, which is why it is a parameter here.
 */
export function hallCost({ quality, pkAllowed = true }) {
  if (!Number.isFinite(quality) || quality <= 0) throw new Error('quality must be a positive number');
  const hourly = quality * RENT_MODIFIER * (pkAllowed ? 1 : 2);
  return { purchase: quality * PURCHASE_MODIFIER, rent_hourly: hourly, rent_daily: hourly * 24 };
}

// WHERE FRULAR STANDS, AND WHO OWNS THE RENT ARITHMETIC.
//
// He is the only guild NPC in the world: founding, hall purchase and rent all happen in
// front of him, at row 5 col 7 of room 700 (gmhall.kod:74). `MOB_NOMOVE`, so unlike most
// merchants he can be routed to once and relied on.
//
// THE RENT HALF LIVES IN `m59-tithe.mjs` AND IS RE-EXPORTED HERE RATHER THAN REPEATED.
// This file grew its own `parseRentLine`, `parseRentHours` and Frular constants on the same
// afternoon that `m59-tithe.mjs` was committed with the same four — two homes for one
// quantity, which in this repository has always ended in two answers. The tithe module is
// the owner because it also holds the durable day-book and the payment plan the keeper
// policy runs on; this one only needs the numbers to explain a hall.
export { FRULAR_ROOM, FRULAR_NAME, parseRentLine, parseRentHours,
         TitheBook, tithePaymentPlan, localDayKey, purseAmount } from './m59-tithe.mjs';
import { FRULAR_ROOM } from './m59-tithe.mjs';

// The halls this fleet has reason to know about. Not a complete index — halls are one kod
// file each under kod/object/active/holder/room/ghall/ — but a place to put a citation for
// the one that was actually chosen, because its price and rent are NOT derivable from the
// general formula.
//
// THE BOOKMAKER'S OVERRIDES GetRentValue AND THAT IS WHY IT COSTS WHAT IT COSTS.
// `hallCost({quality:5})` says 250/hour. The hall itself declares
// `GetRentValue() { return viQuality * RENT_MODIFIER * 2; }` (guildh14.kod:191) — an
// unconditional doubling of its own, nothing to do with the non-PK rule that also doubles.
// On a non-PK server the two would look identical at 500/hour and one of them would be
// invisible; on a PK server the general formula would understate this hall by half.
export const KNOWN_HALLS = {
  714: { room: 714, name: "The Bookmaker's Guild House", quality: 5,
         purchase: 25_000, rent_hourly: 500, rent_daily: 12_000,
         rent_override: 'viQuality * RENT_MODIFIER * 2, guildh14.kod:191 — its own doubling, ' +
                        'not the non-PK rule',
         cite: 'guildh14.kod:60,158,172', entrance: 'from RID_BAR_NORTH (101)' },
};

/**
 * Who should put in how much, to raise a sum for the guild.
 *
 * WEALTH IS PURSE PLUS BANK AND THE TWO ARE NOT INTERCHANGEABLE. A hall is paid from the
 * BUYER'S PURSE (user.kod:1815 reads GetMoneyObject), so banked money has to be withdrawn
 * before it can be walked anywhere — which is a trip to Tos or Jasper, not to Barloque,
 * because Barloque has no bank. This returns both figures per contributor so the caller can
 * see which of them implies a detour.
 *
 * The buyer's own money counts first and is not "contributed"; taking 25,000 off twenty
 * characters when one of them is holding 21,000 is twenty pointless walks.
 */
export function fundingPlan({ need, buyer, holders = [], reserve = 0 } = {}) {
  if (!(need > 0)) throw new Error('need must be a positive number of shillings');
  const wealth = h => Math.max(0, (h.purse ?? 0) + (h.banked ?? 0) - reserve);
  const me = holders.find(h => h.agent === buyer || h.character === buyer) ?? null;
  const own = me ? Math.max(0, me.purse ?? 0) : 0;
  const ownBanked = me ? Math.max(0, me.banked ?? 0) : 0;

  let short = need - own - ownBanked;
  const from = [];
  const rest = holders
    .filter(h => h !== me && wealth(h) > 0)
    .sort((a, b) => wealth(b) - wealth(a));            // the wealthiest first, as asked
  for (const h of rest) {
    if (short <= 0) break;
    const take = Math.min(wealth(h), short);
    from.push({ agent: h.agent, character: h.character, take,
                purse: h.purse ?? 0, banked: h.banked ?? 0,
                must_withdraw: Math.max(0, take - (h.purse ?? 0)) });
    short -= take;
  }
  return {
    need, buyer,
    buyer_purse: own, buyer_banked: ownBanked,
    buyer_must_withdraw: Math.max(0, Math.min(need, own + ownBanked) - own),
    from, shortfall: Math.max(0, short),
    enough: short <= 0,
    contributors: from.length,
    // Stated rather than left implicit: every one of these is a walk to a bank and then a
    // walk to the buyer, and the buyer is in Barloque where there is no bank.
    withdrawals_needed: from.filter(f => f.must_withdraw > 0).length +
                        (Math.max(0, Math.min(need, own + ownBanked) - own) > 0 ? 1 : 0),
  };
}

// guild.kod:27. Declaring war requires the guild's rent account to be at least this
// far in CREDIT, held as a forfeit — `GetRentDue() > -WAR_LOSS_PENALTY` refuses
// (guild.kod:2290). Reading it as "you need 50,000 shillings" is wrong in the way that
// matters: it is not the purse, it is prepaid rent, and no character carrying that sum
// can satisfy it.
export const WAR_LOSS_PENALTY = 50_000;
export const WAR_WINNER_PERCENT = 60;

// invitat.kod:16. The item deletes itself two minutes after it is offered.
//
// THE COMMAND'S OWN DESCRIPTION SAYS ONE MINUTE AND IS WRONG.
// `guildinvite_desc_text_rsc` (gcinvite.kod:22) reads "Invited person has 1 minute to
// accept"; `SELF_DELETE_DELAY` is 120000 and the invitation's own description says two.
// The code is the authority and the shorter number is the safer one to plan against,
// so the budget below is deliberately well inside either.
export const INVITATION_MS = 120_000;
export const CANNOT_REJOIN_MINUTES = 4 * 60;             // guild.kod:21

/**
 * May this character issue this command right now?
 *
 * ASK WITH THE FLAGS, NOT WITH THE RANK. `piGuild_commands` is what the server will
 * actually test (user.kod:4848), it arrives whole in UC_GUILDINFO, and it is not
 * always the rank table's answer: `ResetPowers` only re-runs on a rank change
 * (guild.kod:562), and `RemoveGuildCommand` exists, so a bit can be absent from a rank
 * that the table says holds it. Passing `rank` alone is supported for planning — it
 * answers "would this rank normally hold it" — and says which of the two it used.
 */
export function mayI(command, { flags = null, rank = null } = {}) {
  const spec = COMMANDS[command];
  if (!spec) return { allowed: false, from: 'unknown', why: `no guild command named ${command}`,
                      commands: Object.keys(COMMANDS) };
  if (flags != null) {
    const allowed = (flags & spec.gcid) !== 0;
    return { allowed, from: 'flags', gcid: spec.gcid, needs_rank: spec.rank, cite: spec.cite,
             why: allowed ? null
               : `the server has not granted this character the ${command} bit (0x${spec.gcid.toString(16)}). ` +
                 `It normally needs rank ${spec.rank} (${RANK_NAME[spec.rank]}), ${spec.cite}. ` +
                 `Sending it anyway is answered with SILENCE, not an error (user.kod:4855)` };
  }
  if (rank != null) {
    // The floor, and then the exclusions — a rank high enough can still be carved out.
    if (spec.not_for?.includes(rank))
      return { allowed: false, from: 'rank', gcid: spec.gcid, needs_rank: spec.rank, cite: spec.cite,
               why: `${command} is not available to rank ${rank} (${RANK_NAME[rank] ?? '?'}): ` +
                    spec.not_for_why };
    const allowed = rank >= spec.rank;
    return { allowed, from: 'rank', gcid: spec.gcid, needs_rank: spec.rank, cite: spec.cite,
             why: allowed ? null
               : `${command} needs rank ${spec.rank} (${RANK_NAME[spec.rank]}); this character is ` +
                 `${rank} (${RANK_NAME[rank] ?? '?'}), ${spec.cite}` };
  }
  return { allowed: false, from: 'nothing', needs_rank: spec.rank, cite: spec.cite,
           why: 'no guild flags and no rank given — read UC_GUILDINFO first' };
}

/** Every command this flag word carries, for a board or a status line. */
export function commandsIn(flags) {
  return Object.entries(COMMANDS).filter(([, s]) => (flags & s.gcid) !== 0).map(([n]) => n);
}

// ---------------------------------------------------------------- names and ranks

// The wire is Latin-1 and `pstr` keeps only the LOW BYTE of anything above U+00FF, so
// an em dash leaves as 0x14 and nothing errors — the same trap `cleanDescription`
// exists for. A guild name is worse than a description, because it is permanent and
// visible to every player on a shared server, and there is no way to rename a guild:
// the only correction is disband and pay 5,000 again.
const FOLD = new Map(Object.entries({
  '—': '-', '–': '-', '−': '-',
  '‘': "'", '’': "'", '‚': "'", '′': "'",
  '“': '"', '”': '"', '„': '"',
  '…': '...', ' ': ' ', '•': '*',
}));

export function cleanGuildText(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    if (FOLD.has(ch)) { out += FOLD.get(ch); continue; }
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || c === 13) { out += ' '; continue; }
    if (c < 32 || c === 127) continue;                   // control bytes, dropped
    if (c > 0xff) continue;                              // cannot survive Latin-1
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * The ten rank titles, in the order UC_GUILD_CREATE wants them.
 *
 * FIVE RANKS, TWO GENDERS, AND THE PACKET IS FLAT. user.kod:1697 reads positions 3..12
 * as apprentice-male, apprentice-female, sir, madame, lord, lady, lieutenant-male,
 * lieutenant-female, master, mistress — and `GetRankNames` (guild.kod:1195) returns
 * them back in exactly that order, so the same array serves both directions. Getting
 * the pairing wrong does not error; it gives every woman in the guild a man's title.
 */
export const RANK_TITLE_FIELDS = [
  ['apprentice', 'male'], ['apprentice', 'female'],
  ['sir', 'male'], ['sir', 'female'],
  ['lord', 'male'], ['lord', 'female'],
  ['lieutenant', 'male'], ['lieutenant', 'female'],
  ['master', 'male'], ['master', 'female'],
];

export const DEFAULT_RANK_TITLES =
  ['Apprentice', 'Apprentice', 'Sir', 'Madame', 'Lord', 'Lady',
   'Lieutenant', 'Lieutenant', 'Master', 'Mistress'];

/**
 * Check a guild name and its ten titles before anything is paid for.
 *
 * EVERY ONE OF THESE IS A SILENT FAILURE ON THE SERVER, and they are not the same
 * silence. A name longer than 30 or a title longer than 20 makes `UserCommand` return
 * FALSE after a `Debug` (user.kod:1683-1694) — nothing is charged and nothing is said.
 * A DUPLICATE name, or one matching a player, does answer with a message
 * (`user_duplicate_guildname`), but only the server can know it, so this reports the
 * possibility rather than pretending to rule it out.
 */
export function validateGuild({ name, titles = DEFAULT_RANK_TITLES, secret = false } = {}) {
  const problems = [], notes = [];
  const clean = cleanGuildText(name);
  if (!clean) problems.push('a guild needs a name; StringLength < 1 is refused (user.kod:1674)');
  if (clean !== String(name ?? '').trim())
    notes.push(`name folded to "${clean}" — the wire is Latin-1 and anything above U+00FF ` +
               `would go out as its low byte`);
  if (clean.length > MAX_GUILD_NAME_LEN)
    problems.push(`name is ${clean.length} characters; MAX_GUILD_NAME_LEN is ${MAX_GUILD_NAME_LEN} ` +
                  `and a longer one is refused in silence (user.kod:1683)`);

  const list = [...titles];
  if (list.length !== 10)
    problems.push(`needs exactly 10 rank titles in RANK_TITLE_FIELDS order, got ${list.length}`);
  const cleanTitles = list.map(cleanGuildText);
  cleanTitles.forEach((t, i) => {
    const [rank, gender] = RANK_TITLE_FIELDS[i] ?? ['?', '?'];
    if (!t) problems.push(`rank title ${i + 1} (${rank} ${gender}) is empty`);
    if (t.length > MAX_GUILD_RANK_LEN)
      problems.push(`rank title ${i + 1} (${rank} ${gender}) is ${t.length} characters; ` +
                    `MAX_GUILD_RANK_LEN is ${MAX_GUILD_RANK_LEN}, refused in silence (user.kod:1690)`);
  });

  return {
    ok: problems.length === 0,
    name: clean, titles: cleanTitles, secret: !!secret,
    price: guildPrice(secret),
    problems, notes,
    // Not checkable from here, and both are real. Say so rather than implying a clean bill.
    server_will_also_check: [
      'no existing guild or player of that name (FindGuildByString / FindUserByString, user.kod:1659)',
      'the founder carries the full price in shillings — the purse, not a bank balance (user.kod:1652)',
      'the founder has PFLAG_PKILL_ENABLE, which base max health 30 sets (gcreator.kod:314)',
    ],
  };
}

// ---------------------------------------------------------------- joining a fleet up
//
// This is the part that is about the FLEET rather than about one character, and it is
// the part where the game's rules and a fleet's habits disagree hardest.

/**
 * What has to hold for one character to be invited into a guild, and in what order.
 *
 * THE INVITATION IS AN OBJECT IN THE INVITEE'S PACK AND IT DIES IF EITHER OF THEM
 * WALKS. `GuildInvitation.SomethingLeft` and `OwnerChangedOwner` (invitat.kod:145,155)
 * both call `InvitationVanish` when the inductor OR the inductee leaves the room. So
 * this is not "invite twenty characters and let them accept when they get round to it":
 * both parties must be standing in the same room, and must still be standing there when
 * the invitee uses the scroll.
 *
 * That is why `plan` below is strictly serial. `CheckInvitationList` (gcinvite.kod:81)
 * enforces one outstanding invitation per inductor and one per guild per invitee, so a
 * fan-out is refused anyway — but the refusal is `return FALSE` with no message, which
 * would have read as twenty successful invitations.
 */
export function joinBlockers({ character, guildOfCharacter = null, maxHealth = null,
                               room = null, inviterRoom = null, formerMember = false } = {}) {
  const blockers = [];
  if (guildOfCharacter)
    blockers.push({ why: `already in ${guildOfCharacter} — must renounce first, and the ` +
                         `invitation itself says so rather than joining (invitat.kod:180)`,
                    fix: 'renounce' });
  if (maxHealth != null && maxHealth < 30)
    blockers.push({ why: `max health ${maxHealth} is under 30, so PFLAG_PKILL_ENABLE is not set ` +
                         `and using the invitation is refused: "You may not join a guild until ` +
                         `you are more experienced" (invitat.kod:174)`,
                    fix: 'raise max health to 30' });
  if (formerMember)
    blockers.push({ why: `a former member may not rejoin for ${CANNOT_REJOIN_MINUTES} minutes ` +
                         `(CheckFormerMemberList, guild.kod:21)`, fix: 'wait' });
  if (room != null && inviterRoom != null && room !== inviterRoom)
    blockers.push({ why: `in room ${room} while the inviter is in ${inviterRoom}; the invitation ` +
                         `vanishes the moment either of them leaves the room (invitat.kod:145)`,
                    fix: 'bring both to one room' });
  return { character, ok: blockers.length === 0, blockers };
}

/**
 * A serial plan for inducting a list of characters, with the room requirement and the
 * two-minute window made explicit.
 *
 * `seconds_each` is a budget, not a measurement: walking a character in, issuing the
 * invite, and having it use the scroll is a handful of paced server actions, and the
 * whole thing has to finish inside INVITATION_MS or the scroll evaporates. It is
 * deliberately a fraction of that window rather than most of it, because the failure
 * mode is not a retry — the inviter's slot is occupied until the object dies.
 */
export function inductionPlan({ inviter, inviterRank = null, inviterFlags = null,
                                room, characters = [], secondsEach = 30 } = {}) {
  const may = mayI('invite', { flags: inviterFlags, rank: inviterRank });
  const steps = [];
  for (const c of characters) {
    const who = typeof c === 'string' ? { character: c } : c;
    steps.push({
      character: who.character,
      // CARRIED THROUGH, because a step has to be matched back to the session that will
      // execute it and the character NAME is not safe for that: a roster entry whose name
      // has not been read back yet is null, and two nulls compare equal. Keying the
      // execution loop on the name would have pointed every unnamed character's step at
      // the first one. `agent` is this checkout's own handle and is always present.
      agent: who.agent ?? null,
      blockers: joinBlockers({ ...who, inviterRoom: room }).blockers,
      sequence: [`travel ${who.character} to room ${room}`,
                 `${inviter} invites ${who.character}`,
                 `${who.character} uses the invitation within ${INVITATION_MS / 1000}s`,
                 `confirm ${who.character}'s guild before moving on`],
    });
  }
  return {
    inviter, room, may_invite: may,
    // One at a time, and this is a rule of the game rather than a caution.
    serial: true,
    serial_why: 'CheckInvitationList allows the inviter ONE outstanding invitation and refuses ' +
                'a second with no message at all (gcinvite.kod:81) — a parallel fan-out would ' +
                'report twenty successes and induct one',
    window_ms: INVITATION_MS,
    steps,
    estimate_s: steps.length * secondsEach,
    ready: steps.filter(s => !s.blockers.length).map(s => s.character),
    blocked: steps.filter(s => s.blockers.length).map(s => ({ character: s.character, blockers: s.blockers })),
  };
}


// WHAT A ROSTER READ ACTUALLY SAID -- and the third answer, which was being thrown away.
//
// `UC_GUILDINFO` has two legitimate replies and one non-reply, and only two of them were
// ever distinguished. A roster packet means the character is in that guild. PROSE with no
// packet means the server answered `user_no_guild` (UserGuildSendInfo, user.kod:1974) -- a
// real answer, and the character has no guild. NOTHING AT ALL means nothing answered: on a
// keeper-backed session the read is a round trip through the keeper and it can simply miss
// its window.
//
// The third was being reported as the second. `guild action=status` answered `in_guild:
// false` for a lost packet exactly as for a guildless character, and `spread` answered "the
// inviter is not in a guild" and stopped. Measured 2026-09-10, 04:04:50: a spread loop
// stopped on that line while Fozzie was a serving LIEUTENANT of The Second Swines, and said
// so on each of the next three reads.
//
// This is the same shape as m59-which.mjs's INDETERMINATE: a port that does not answer is a
// question, not a fleet. An unanswered read is a question, not a fact about a character.
export const ROSTER_READ = Object.freeze({
  GUILD: 'guild',              // a roster packet came back: this character is in that guild
  NONE: 'none',                // prose came back: the server said `user_no_guild`
  UNANSWERED: 'unanswered',    // neither: nothing landed, and that is not evidence of anything
});

export function rosterReadOutcome({ guild = null, said = [] } = {}) {
  if (guild) return ROSTER_READ.GUILD;
  return (said && said.length) ? ROSTER_READ.NONE : ROSTER_READ.UNANSWERED;
}

// Whether a read is worth asking again. Only the non-answer is: a read that returned prose
// HAS answered, so re-asking it costs a round trip on the path that is already working.
export const rosterReadWorthRetrying = r => rosterReadOutcome(r) === ROSTER_READ.UNANSWERED;
