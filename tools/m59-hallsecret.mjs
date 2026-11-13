#!/usr/bin/env node
// THE GUILD HALL'S PASSWORD — A SPOKEN KEY, KEPT WHERE THE ACCOUNT PASSWORDS ARE KEPT.
//
// A guild hall hides its chests behind a secret door, and the door is opened by SAYING a
// word out loud in the room. That makes the word a credential with an unusual property: it
// has to be spoken into a shared world where other players can hear it. It is still a
// credential, and it does not belong in a public repository.
//
// WHERE IT LIVES, AND WHY NOT IN THE ROSTER ITSELF.
//
// The obvious home is `substrate/fleets/<fleet>.json` — that file already holds every
// account password and is already gitignored. It is the wrong home, and the reason is
// structural rather than stylistic: EVERY TOP-LEVEL KEY IN A ROSTER IS AN AGENT. The broker
// builds `fleetState` from those keys, `saveFleetState()` carries forward every key on disk
// it did not load (m59-broker.mjs:3413), and the 45s rejoin sweep respawns keepers from the
// roster. A `_guild` key added beside `t1`..`t21` would therefore be logged every save as a
// roster entry nobody loaded, and read by anything enumerating the fleet as a twenty-fourth
// character — a phantom the sweep would try to log in.
//
// So it goes in a SIDECAR, exactly the way the menagerie does it: a file derived from the
// fleet's name with a DOT in it, which `--fleet` can never address because fleet names are
// `/^[A-Za-z0-9][A-Za-z0-9_-]*$/` (m59-fleetpath.mjs:55). `/substrate/fleets/` is already
// gitignored wholesale, so the sidecar is covered by the rule that covers the roster.
//
//     substrate/fleets/prod.json           the accounts
//     substrate/fleets/prod.secrets.json   what the fleet has to SAY  <- this file's business
//
// THE MECHANIC IT SERVES (ghall.kod:963-970, and guildh14.kod for the Bookmaker's hall):
//
//   if poGuild_owner <> $
//      AND StringEqual(string, Send(poGuild_owner,@GetPassword))
//      AND NOT Send(self,@InFoyer,#who=what)      <- NOT while standing in the foyer
//      AND NOT pbSecretDoorOpen                   <- saying it again while open does nothing
//      AND type <> SAY_EMOTE                      <- a say, never an emote
//   { Send(self,@OpenSecretDoor); }
//
// Four conditions, and three of them fail SILENTLY — which is this game's whole failure
// mode. Say it in the foyer and nothing happens and nothing is said about it.
//
// AND IT SHUTS AGAIN IN FIVE SECONDS. `DOOR_DELAY = 5000` (guildh14.kod:43): OpenSecretDoor
// starts a timer that closes the sector behind you. Whoever says it has five seconds to be
// through, which makes this a Qor-temple-shaped problem and not a door-shaped one.
//
// NEVER LOGGED. Every helper here returns the secret only to a caller that asked for it by
// name; `describe()` is what goes in a note, a page or a transcript.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GUILD_HALL_ROOMS } from './m59-storage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FLEETS_DIR = process.env.M59_FLEETS_DIR || resolve(HERE, '..', 'substrate', 'fleets');

// The same shape the menagerie uses, and un-nameable as a fleet for the same reason.
export const secretsPathFor = (fleet, dir = FLEETS_DIR) =>
  join(dir, `${String(fleet ?? 'default').replace(/[^A-Za-z0-9._-]/g, '_')}.secrets.json`);

function readSecrets(fleet, dir = FLEETS_DIR) {
  const path = secretsPathFor(fleet, dir);
  if (!existsSync(path)) return { path, present: false, data: {} };
  try {
    return { path, present: true, data: JSON.parse(readFileSync(path, 'utf8')) ?? {} };
  } catch (error) {
    // A FILE THAT WILL NOT PARSE IS NOT AN EMPTY FILE. Returning {} here would report "this
    // fleet has no hall password", and the caller would walk to Barloque and stand in front
    // of a wall it could have opened.
    return { path, present: true, data: {}, unreadable: error.message };
  }
}

// ONE PASSWORD PER HALL, NOT PER FLEET. The secret door compares what was said against
// `Send(poGuild_owner,@GetPassword)` (ghall.kod:965) -- the HALL OWNER's password, not the speaker's
// guild's. So when a roster holds two allied guilds and a member of one walks into the other's hall,
// the word that opens the chest room is the host's. Passwords are therefore keyed by hall ROOM:
//
//     { "guild_hall":  { "room": 714, "password": "..." },          <- the one there always was
//       "guild_halls": { "713": { "password": "..." },             <- every other hall, by room:
//                        "703": { "password": "..." } } }          (713 Rowlfs, 703 Rizzo's Revenge)
//
// The legacy `guild_hall` block stays where it is (older deploys read it) and answers for its own
// room -- 714 when it names none, because that is the only hall it was ever written for.
const LEGACY_ROOM = 714;
const legacyRoom = (data) => Number(data?.guild_hall?.room ?? LEGACY_ROOM);
function wordFor(data, room) {
  if (room == null || Number(room) === legacyRoom(data)) {
    const v = data?.guild_hall?.password;
    if (typeof v === 'string' && v.length) return v;
    if (room == null) return null;
  }
  const v = data?.guild_halls?.[String(Number(room))]?.password;
  return typeof v === 'string' && v.length ? v : null;
}

/**
 * The word that opens a guild hall's secret door, or null. `room` is the hall the body is standing
 * in; omitted, it is the fleet's original hall.
 * NEVER log the return value — use `describe()` for anything a human or a file will read.
 */
export function hallPassword(fleet, { dir = FLEETS_DIR, room = null } = {}) {
  const { data, unreadable } = readSecrets(fleet, dir);
  if (unreadable) return null;
  return wordFor(data, room);
}

/** Everything ABOUT the secret that is safe to print. Never the secret. */
export function describe(fleet, { dir = FLEETS_DIR } = {}) {
  const { path, present, data, unreadable } = readSecrets(fleet, dir);
  const word = present && !unreadable ? data?.guild_hall?.password : null;
  return {
    fleet: String(fleet ?? 'default'),
    file: path,
    file_present: present,
    ...(unreadable ? { unreadable } : {}),
    has_password: typeof word === 'string' && word.length > 0,
    length: typeof word === 'string' ? word.length : 0,
    hall_room: present && !unreadable ? (data?.guild_hall?.room ?? null) : null,
    // Every hall this fleet can open, with whether a word is recorded -- never the word.
    halls: present && !unreadable ? [
      ...(data?.guild_hall ? [{ room: legacyRoom(data), has_password: !!wordFor(data, legacyRoom(data)) }] : []),
      ...Object.keys(data?.guild_halls ?? {}).map(Number).filter(r => r !== legacyRoom(data) || !data?.guild_hall)
        .map(room => ({ room, has_password: !!wordFor(data, room) })),
    ] : [],
    note: present && !unreadable && word
      ? 'the word itself is deliberately not reported — read it with hallPassword()'
      : 'no hall password recorded for this fleet',
  };
}

/** Record the word. Writes only into the gitignored fleets directory. */
export function setHallPassword(fleet, password, { dir = FLEETS_DIR, room = null } = {}) {
  const word = String(password ?? '');
  if (!word) throw new Error('setHallPassword needs a password');
  const { path, data, unreadable } = readSecrets(fleet, dir);
  if (unreadable) throw new Error(`${path} will not parse — fix it by hand rather than overwrite it`);
  // The legacy block keeps its own hall; any OTHER hall gets an entry of its own, so recording a second
  // guild's password can never overwrite the first guild's.
  const legacy = room == null || (data.guild_hall ? Number(room) === legacyRoom(data) : Number(room) === LEGACY_ROOM);
  const next = legacy
    ? { ...data, guild_hall: { ...(data.guild_hall ?? {}), password: word,
                               ...(room != null ? { room: Number(room) } : {}),
                               set_at: new Date().toISOString() } }
    : { ...data, guild_halls: { ...(data.guild_halls ?? {}),
                                [String(Number(room))]: { password: word, set_at: new Date().toISOString() } } };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, path);
  return describe(fleet, { dir });
}

// WHY THERE IS NO redact() HERE, WHICH IS THE OBVIOUS THING TO WRITE.
//
// The first version of this file had one: find the password in a string, replace it with
// "<hall password>", and apply it wherever the fleet writes down what it said. It had to go,
// for two reasons that both point the same way.
//
// A REDACTOR IS ONLY SAFE IF THE SECRET IS UNGUESSABLE, and a hall password is chosen by a
// person, typed at a guildmaster, and has to be shoutable across a room. Plenty of perfectly
// reasonable choices are ordinary words that also appear in this repository's own prose, in
// a merchant's patter, or in a stranger's chat. A filter keyed on such a word rewrites all of
// those too — so it corrupts the log AND advertises exactly where the interesting string was.
//
// AND A FILTER IS A SECOND CHANCE TO GET IT RIGHT, which means there was a first chance that
// was missed. The stricter rule costs nothing and needs no cleverness: THE WORD IS NEVER PUT
// INTO A STRING THAT GETS WRITTEN DOWN. The say path logs `said the hall password` — a fixed
// sentence that is true, carries no secret, and leaves nothing downstream to scrub.
export const SAID_NOTE = 'said the hall password';

// THE FOYER IS WHERE THE PASSWORD DOES NOT WORK, and it is a rectangle per hall.
//
// `InFoyer` (ghall.kod:896-913) is a plain bounding-box test -- its own comment notes "the
// declared silence area must now be perfectly rectangular" -- and the say handler refuses to
// open the door for anyone inside it. The Bookmaker's Guild House declares
// viFoyer_north/south/west/east = 2/3/26/39 (guildh14.kod:145-148).
//
// This is also the SILENCE area: speech does not cross the foyer boundary either way, it is
// delivered as `guildhall_muffled`. So a character standing in the foyer is not merely
// failing to open the door -- nobody in the hall proper can hear it at all.
export const BOOKMAKERS_FOYER = Object.freeze({ north: 2, south: 3, west: 26, east: 39 });

// Every hall's box, from its own kod (m59-storage.mjs GUILD_HALL_ROOMS). null where the hall declares
// no complete box, and then `inFoyer` cannot answer for it.
export const foyerFor = (room) => room == null ? BOOKMAKERS_FOYER : (GUILD_HALL_ROOMS[Number(room)]?.foyer ?? null);

/** Is this square inside a hall's foyer, where the password is refused in silence? */
export function inFoyer(row, col, box = BOOKMAKERS_FOYER) {
  if (!box) return null;                                              // a hall with no known box
  if (!Number.isFinite(row) || !Number.isFinite(col)) return null;   // unknown, not "outside"
  return row >= box.north && row <= box.south && col >= box.west && col <= box.east;
}

// ------------------------------------------------------------------------------- cli
//
// `show` prints WHETHER there is one, never what it is. Printing a credential because
// somebody typed a command is how it ends up in a transcript, and transcripts get pasted.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (flag, dflt = null) => {
    const i = rest.indexOf(`--${flag}`);
    return i >= 0 ? rest[i + 1] : dflt;
  };
  const fleet = arg('fleet') || process.env.M59_FLEET || 'prod';
  if (cmd === 'set') {
    const word = arg('password');
    if (!word) {
      console.error('usage: m59-hallsecret.mjs set --fleet <name> --password <word> [--room 714]');
      process.exit(2);
    }
    const out = setHallPassword(fleet, word, { room: arg('room') });
    console.log(`recorded a ${out.length}-character hall password for "${out.fleet}"`);
    console.log(`  ${out.file}  (gitignored: /substrate/fleets/ covers it)`);
  } else if (cmd === 'show' || !cmd) {
    console.log(JSON.stringify(describe(fleet), null, 2));
  } else {
    console.error(`unknown command "${cmd}" — try: show | set`);
    process.exit(2);
  }
}
