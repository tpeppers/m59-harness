#!/usr/bin/env node
// WHO KEEPS THEIR PACK WHEN THEY DIE — the operator calls these MULES, and it EXPIRES.
//
//   node tools/m59-nodrop.mjs                who in the fleet keeps its pack, and how we know
//   node tools/m59-nodrop.mjs --check hk1    one character, with the sentence the server said
//
// NOT `m59-mule.mjs`, WHICH ALREADY EXISTS AND MEANS SOMETHING ELSE. That one asks how far the
// weakest character in the fleet can travel — reach, not retention. It is about the same
// twenty-health bodies from the other side, and conflating them would be easy: read that file
// for "can this body get there", this one for "will it still be carrying the cargo afterwards".
//
// Operator, 2026-09-17: "20hp characters that cannot drop items when they die are mules", and
// Loial is to be tagged one so the magic-item collection can live on him. The shorthand is right
// about this fleet and wrong about the mechanism, and the difference is the whole reason this
// file exists rather than a boolean in the roster.
//
// ---------------------------------------------------------------- what actually grants it
//
// `player.kod` decides item loss with one local, `bNo_drop_death`, set TRUE by any of four
// things (player.kod:7990-8032). Two are situational — a Reign of Blood Frenzy chaos night, and
// holding a Token at the moment of death — and one is geographic: dying inside the newbie rooms.
// The one that describes this fleet's mules is the third:
//
//     OR psHonor <> $ AND StringEqual(psHonor, player_newbie_honor_string)
//
// and that string is "This soul is new to the lands of Meridian 59." (player.kod:390).
//
// With it set the character drops NOTHING — the `for lItems in [plActive, plPassive]` loop that
// scatters the pack is skipped whole (player.kod:8042) — and `piDeathCost = FALSE`, so there is
// no maximum-health penalty either. That is the fact the operator was working from earlier in
// this session: "Loial loses nothing when he dies, just run him again once he heals." He
// measurably did not: he died twice on 2026-09-12 and kept 60 elderberry, 64 emerald and 17
// herbs, while the errand runner's own log said "the loot is gone". The runner was wrong, the
// world disagreed, and this is why.
//
// HIT POINTS ARE A CORRELATE, NOT THE CAUSE. A character still carrying the newbie honour string
// has never advanced, so its maximum health sits near where it started — which is why every one
// of this fleet's mules is a 20hp body. Reading it the other way round would be a trap: raising
// a character's health does not end the protection, and losing the string ends it at any health.
//
// ---------------------------------------------------------------- AND IT RUNS OUT
//
// This is the part to build around rather than discover. The string is cleared in two places and
// neither is under our control:
//
//   * `GetAge` (player.kod:1531-1550) clears it once `GetYear - GetBirthYear >= 2` — the comment
//     says "about 2 months" — and that check runs EVERY TIME SOMEBODY LOOKS AT THE CHARACTER. A
//     mule can therefore stop being one because a passer-by glanced at it.
//   * becoming PK-enabled clears it too (player.kod:11086-11097).
//
// So a mule is a WASTING ASSET and parking a collection on one is a bet with a clock on it. That
// is not an argument against doing it; it is an argument for asking rather than assuming, which
// is why there is no stored `is_mule` flag anywhere in this file. The answer is derived from the
// sentence the server says, every time, and a third answer means nobody looked.
//
// ---------------------------------------------------------------- reading it
//
// The honour string arrives in the prose of a PLAYER look — `Player.TryLook` diverts to
// `SendLookPlayer`, which replies with BP_USERCOMMAND / UC_LOOK_PLAYER rather than BP_LOOK
// (user.kod:4374), a packet this client did not parse at all until somebody noticed. Same reply
// that carries the hometown, so `noDropFrom` is deliberately shaped like `hometownFrom` in
// m59-describe.mjs and keeps its three-way answer: no sentence at all is a different reply from
// a sentence that does not say newbie.
import { hometownFrom } from './m59-describe.mjs';

/** The server's own words. */
export const NEWBIE_HONOUR = 'This soul is new to the lands of Meridian 59.';

/** Every way `bNo_drop_death` can be true, with the citation and what it is worth to us. */
export const NO_DROP_REASONS = Object.freeze([
  { key: 'newbie_honour', cite: 'player.kod:7998-7999', durable: 'until about two game months',
    why: 'psHonor still equals player_newbie_honor_string. Drops nothing and pays no death ' +
         'cost. This is the one that makes a character useful as a vault on legs.' },
  { key: 'newbie_room', cite: 'player.kod:7997', durable: 'only while standing there',
    why: 'died inside RID_NEWB_BASE..RID_NEWB_MAX — a fact about WHERE, not about who.' },
  { key: 'chaos_night', cite: 'player.kod:7996', durable: 'until the night ends',
    why: 'a Reign of Blood Frenzy. Fleet-wide, temporary, and nothing to plan around.' },
  { key: 'token', cite: 'player.kod:8024-8028', durable: 'one death',
    why: 'holding a Token when you die. It is consumed.' },
]);

/**
 * DOES THIS CHARACTER KEEP ITS PACK, from the prose of a player look.
 *
 *   { no_drop: true }   the server said the newbie honour sentence
 *   { no_drop: false }  it said something else in that slot — the honour protection is gone
 *   null                there was no look text at all, so NOBODY HAS ASKED
 *
 * A stored flag would have been simpler and wrong: the protection expires on a clock we do not
 * own, and a stale `true` is the fleet's collection on the floor after one death.
 */
export function noDropFrom(extra) {
  const text = String(extra ?? '');
  if (!text.trim()) return null;
  if (text.includes(NEWBIE_HONOUR))
    return { no_drop: true, said: NEWBIE_HONOUR, reason: 'newbie_honour',
             cite: 'player.kod:7998-7999',
             why: 'keeps its whole pack and pays no death cost — but this is cleared at about ' +
                  'two game months of age, on a check that fires whenever anybody looks' };
  // The look came back and did NOT carry it. A real answer: whatever the honour string was
  // protecting, it is not protecting it now.
  return { no_drop: false, said: null, reason: null,
           why: 'the look came back without the newbie honour sentence, so the honour ' +
                'protection is not in force. A situational one may still apply — a token in ' +
                'hand, a chaos night, or dying in the newbie rooms — and none of those can be ' +
                'read from here. See NO_DROP_REASONS.' };
}

/**
 * The same question about a live character, through the broker.
 *
 * Costs a round trip and a body standing where it can be looked at; the server never volunteers
 * this. Answers `null` rather than guessing when the look does not come back, for the same
 * reason `hometownFrom` does — and `null` is NOT a "no".
 */
export async function checkNoDrop(agent, { call } = {}) {
  const st = await call('status', { agent }).catch(() => null);
  const who = st?.character ?? null;
  if (!who) return { agent, no_drop: null, why: 'could not read who this agent is holding' };
  const look = await call('look_at', { agent, target: who }).catch(() => null);
  const extra = look?.extra ?? look?.description ?? look?.text ?? null;
  const verdict = noDropFrom(extra);
  const home = hometownFrom(extra);
  return {
    agent, character: who,
    no_drop: verdict === null ? null : verdict.no_drop,
    ...(verdict ?? { why: 'no look text came back, so nobody has asked. This is not a "no".' }),
    // The other half of a mule's usefulness: it is the courier that cannot lose the cargo AND
    // has a free teleport home. `rescue` goes to the guild hall or, failing that, the home room.
    ...(home ? { hometown: home.town, home_room: home.room } : {}),
    max_health: st?.hp?.max ?? st?.vitals?.health?.max ?? null,
  };
}

// ---------------------------------------------------------------- cli

const isMain = !!process.argv[1] &&
  import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;

if (isMain) {
  const { callTool, fleetRoster } = await import('./m59-describe.mjs');
  const call = (name, args) => callTool(name, args, {});
  const argv = process.argv.slice(2);
  const one = argv.indexOf('--check') >= 0 ? argv[argv.indexOf('--check') + 1] : null;
  const agents = one ? [{ agent: one }] : await fleetRoster({});

  console.log('\nA mule keeps its whole pack when it dies and pays no death cost. The protection');
  console.log('expires at about two game months of age, on a check that fires whenever anybody');
  console.log('looks at the character — so this is asked, never stored.\n');
  console.log('agent  character         keeps  maxhp  home        why');
  for (const r of agents) {
    const v = await checkNoDrop(r.agent, { call });
    const flag = v.no_drop === null ? '  ?  ' : (v.no_drop ? ' YES ' : ' no  ');
    console.log(String(v.agent).padEnd(7) + String(v.character ?? '?').padEnd(18) +
                flag.padEnd(7) + String(v.max_health ?? '?').padEnd(7) +
                String(v.hometown ?? '-').padEnd(12) + String(v.why ?? '').slice(0, 58));
  }
  console.log('\n`?` means NOBODY ASKED — the look did not come back. It is not a "no", and a');
  console.log('collection parked on a character reading `?` is parked on a guess.');
}
