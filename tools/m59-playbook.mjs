// WHAT TO DO AT THE MOMENTS THE KEEPER HAS NO OPINION ABOUT -- declared in advance by
// whoever is directing the fleet, executed by the keeper.
//
// THE KEEPER ASKS, IT DOES NOT CALL. This is the whole design and getting it wrong would
// undo the boundary it exists to serve. A playbook is a TABLE THIS PROCESS ALREADY HOLDS,
// read from disk and cached on mtime exactly as a loadout is, and consulted with a
// synchronous function call. There is no network round trip and there must never be one.
//
// The reason is the first trigger. A player attacking you is precisely the moment you
// cannot wait: the bot ticks at thirty seconds, a round trip is seconds at best, and the
// decision is worth nothing after either. So the bot writes the answer down ahead of
// time and the keeper reads it in microseconds at the instant it matters. "Check in with
// the strategy" is a lookup, not a request.
//
// (`ask_for_orders` is the one verb that DOES wait, and it exists so that the escape
// hatch is explicit, time-boxed, and something a doctrine opts into per trigger -- rather
// than being the default nobody noticed they had chosen.)
//
// SILENCE MEANS THE BEHAVIOUR THAT WAS ALREADY THERE, NEVER PARALYSIS. This is the same
// rule as a loadout and it is the one most easily got backwards. With no playbook, or a
// playbook with nothing for this trigger, `decide` returns null and the keeper does
// exactly what it did before this file existed -- which for `attacked_by_player` means the
// ordinary survival ladder: flee when losing, rest when hurt and safe, escape the
// Underworld if killed. A playbook ADDS a response. It can never remove the floor, and
// there is deliberately no verb for "stand still".
//
// THE VERBS ARE A CLOSED SET, and that is the safety property rather than a convenience.
// A bot may not hand the keeper a tool call, a script or an arbitrary argument list: it
// picks from things this file already knows how to do, with arguments this file
// validates. A directional bot that could name any harness tool at a moment of crisis
// would be a directional bot with the survival floor in its hands, which is the one thing
// the carve-out promises it does not have.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(import.meta.url), '..', '..');
export const PLAYBOOK_DIR = () => process.env.M59_PLAYBOOK_DIR || join(HERE, 'substrate', 'playbooks');

// ---------------------------------------------------------------- the moments
//
// Each of these is a place the keeper today has NO opinion, or an opinion that is
// obviously the fleet's rather than the character's. Adding one is a deliberate act: it
// means finding the spot in the keeper where the fact is already known and asking there.
export const TRIGGERS = {
  // A PLAYER IS HITTING US. The keeper is structurally blind to this -- `inReachOfUs()`
  // filters `OF.PLAYER` out, so an attacking player is never a bystander, never
  // retaliated against, and never noticed at all. That filter is CORRECT and stays: this
  // fleet must not start swinging at people on a shared server. What was missing is that
  // nothing else noticed either.
  attacked_by_player: {
    facts: ['who', 'health_pct', 'room', 'attackers', 'in_safe_spot'],
    why: 'the keeper treats a player and a monster identically, and they are not the ' +
         'same problem: a monster cannot follow you to a different town and will not ' +
         'wait five minutes',
  },
  // WE DIED. The keeper handles its own recovery -- that is `mortality` and it stays
  // here -- but what the FLEET does about a death is not a one-second decision and the
  // keeper has no way to express it. Somebody rich enough to re-arm the corpse is the
  // obvious case.
  died: {
    facts: ['killed_by', 'was_killed_by_player', 'room', 'purse_lost', 'level'],
    why: 'recovering is the keeper\'s and is unchanged; what the rest of the fleet does ' +
         'about it is nobody\'s decision today',
  },
  // SOMETHING IMPROVED. Max health is the level here, so a gain can invalidate the
  // entire reason the character is standing where it is standing -- a kill only pays
  // when the creature's level is STRICTLY above base max health, so the prey that was
  // paying five minutes ago may now be worth nothing.
  improved: {
    facts: ['what', 'from', 'to', 'hunting', 'room'],
    why: 'the keeper notices the gain and files it, and then carries on hunting the ' +
         'thing that just stopped paying',
  },
};

// ---------------------------------------------------------------- the verbs
//
// `arg` names what each takes. `outward` marks the two that put text in front of real
// people on a shared server, which is a different class of act and is gated separately.
export const VERBS = {
  // EXPLICIT, AND NOT THE SAME AS AN ABSENT PLAYBOOK. "I considered this and chose to do
  // nothing" belongs in the journal; "nobody has said" is a different fact and should not
  // render identically. Neither suppresses the survival ladder.
  nothing: { args: [], why: 'considered and declined' },
  // The keeper's own withdraw: back to a wall where the health timer can run.
  retreat: { args: [], why: 'take a safe spot' },
  leave_room: { args: [], why: 'leave the room entirely' },
  // THE ANSWER TO A GRIEFER, and the one verb whose value is in the WAITING. A player
  // who has decided to kill you is not deterred by you running to the next room; a
  // player who has to wait five minutes usually is, because they came for a fight now.
  logoff: { args: ['stay_off_s'], why: 'log out, and stay out for a while' },
  say: { args: ['message'], outward: true, why: 'speak to the room' },
  tell: { args: ['to', 'message'], outward: true, why: 'speak to one character' },
  // SAY_YELL (2) reaches this room AND the ones next to it (user.kod:4088), which is the
  // difference between telling the person killing you and telling somebody who might come.
  yell: { args: ['message'], outward: true, why: 'shout to this room and the adjacent ones' },
  // THE WHOLE SERVER HEARS THIS, WHICH IS A DIFFERENT CLASS OF ACT FROM `yell`.
  //
  // `say` reaches a room and `yell` reaches the adjacent ones; this reaches EVERY player
  // logged in, including strangers who never opted into anything we are doing. The game
  // itself treats it as the help-of-last-resort channel — the guardian angel's death mail
  // tells a new player to `broadcast` for somebody to find their corpse — so using it for
  // colour is borrowing a siren to tell a joke.
  //
  // It is in the set because the operator asked for it by name, for a character whose JOB
  // is dying: "he's going to be spamming a little bit here or there if he dies, he might
  // as well broadcast funny one liners." Their accounts, their server, their call.
  //
  // BUT IT CARRIES A COOLDOWN AND THE OTHER OUTWARD VERBS DO NOT, because the failure mode
  // is not one broadcast, it is a death loop: a character that dies every ninety seconds on
  // a road it cannot survive broadcasts every ninety seconds for as long as nobody is
  // watching, and that is indistinguishable from griefing to the people reading it.
  // `cooldown_s` defaults to ten minutes and the executor is expected to honour it; a
  // playbook may lower it, which is a choice somebody has to type.
  //
  // `message` MAY BE A LIST, and for this verb it usually should be. One line broadcast
  // repeatedly is worse than no line at all, so an array is picked from at random and a
  // bare string is used as-is.
  broadcast: { args: ['message', 'cooldown_s'], outward: true, server_wide: true,
               cooldown_s: 600,
               why: 'tell every player on the server, sparingly' },
  // SAY_GUILD (10) reaches every guild member who is logged on, anywhere in the world
  // (UserSayGuild, user.kod:4112). Refused with a sentence if the character has no guild.
  tell_guild: { args: ['message'], outward: true, why: 'tell the guild, wherever they are' },
  // WHAT A PLAYER ACTUALLY DOES WHEN SOMEBODY IS KILLING THEM, as one verb because the
  // order matters and the playbook fires ONE rule per trigger. Shout where you are, tell
  // the guild so somebody equipped can come, and only then go offline — a chaser cannot
  // follow you off, but neither can help find you once you have gone.
  //
  // BOTH SENTENCES ARE LITERALS AND THE LOCATION IS IN THEM. That is not a limitation to
  // work around: `room` is a fact on this trigger, so a playbook writes one rule per room
  // with the room named in the sentence its author chose. Assembling "help, I am in %s"
  // here would be the fleet saying something nobody wrote.
  call_for_help: { args: ['message', 'guild_message', 'stay_off_s'], outward: true,
                   why: 'shout for help, tell the guild, then log off and stay off' },
  // THE ESCAPE HATCH, and the only verb that waits. Marks the character busy and hands
  // the decision to whoever holds it, time-boxed. Explicit, per trigger, opt-in -- so
  // that "we blocked on a bot while being attacked" is always something somebody chose.
  ask_for_orders: { args: ['wait_s'], why: 'hand this decision to whoever is directing' },
  // Go inert and let the bot drive. Not `stop`: the instruments stay on.
  stand_down: { args: [], why: 'stop driving and wait to be told' },
  // ANSWER A PLAYER WHO IS HITTING US. The attacker name comes from facts.who in the
  // attacked_by_player trigger. The keeper engages THAT named target with the same
  // fight() it would use against a creature, except includePlayers:true and the
  // resolved object id are passed through so a name match cannot drift to somebody
  // else. The inReachOfUs() OF.PLAYER filter STAYS as the ordinary combat loop's
  // bystander check -- fight_back is a one-shot against a name the playbook
  // declared, not the everyday retaliation branch.
  fight_back: { args: [], why: 'fight back against the attacking player' },
  // SIGNAL THE FLEET. One-shot broadcast that the caller is under attack in this room
  // by this player, so any healthy nearby keeper travels here and engages too. The
  // broker keeps a conflicts table for this and the keeper's own respondToConflict
  // already does the converging -- what this verb does is DECLARE that conflict so
  // the rest of the fleet can see it.
  fleet_alert: { args: [], why: 'broadcast that we are under attack so nearby members come to help' },
};

const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;

// ---------------------------------------------------------------- reading one
//
// Cached on mtime, exactly like loadoutFor, so the per-pass cost is a stat(). A keeper
// asks this at moments that are already expensive; it must not also be a file read.
const cache = new Map();

export function playbookFor(character) {
  if (!character) return null;
  const file = join(PLAYBOOK_DIR(), `${String(character).toLowerCase()}.json`);
  let mtime = 0;
  try { mtime = existsSync(file) ? statSync(file).mtimeMs : 0; } catch { mtime = 0; }
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.value;
  let value = null;
  if (mtime) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      value = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null;
    } catch {
      // A PLAYBOOK THAT WILL NOT PARSE IS NO PLAYBOOK, NOT AN EMPTY ONE -- and those are
      // the same thing here only because "no playbook" already means "carry on as
      // before". If that ever stops being true this has to become an error instead.
      value = null;
    }
  }
  cache.set(file, { mtime, value });
  return value;
}

/** Every character that has one, for a board that wants to say who is covered. */
export function playbooksOnDisk() {
  try {
    return readdirSync(PLAYBOOK_DIR()).filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''));
  } catch { return []; }
}

// ---------------------------------------------------------------- the decision
//
// PURE. Facts in, one action or null out. No clock, no I/O, no randomness -- which is
// what lets the whole table be tested against fixtures, and what makes an action
// reproducible from the journal line that recorded the facts it was given.

/** Does one rule's `when` clause hold, given the facts the trigger supplies? */
function holds(when, facts) {
  if (!when || typeof when !== 'object') return true;
  for (const [k, want] of Object.entries(when)) {
    // Two forms, and the suffix is the comparison. Anything else is UNRECOGNISED and
    // fails closed -- a condition nobody evaluates must not read as a condition that was
    // met, or a typo in a doctrine silently promotes a rule to unconditional.
    if (k.endsWith('_below')) {
      const got = num(facts[k.slice(0, -6)]);
      if (got === null || !(got < want)) return false;
    } else if (k.endsWith('_at_least')) {
      const got = num(facts[k.slice(0, -9)]);
      if (got === null || !(got >= want)) return false;
    } else if (k.endsWith('_is')) {
      if (facts[k.slice(0, -3)] !== want) return false;
    } else if (k in facts) {
      if (facts[k] !== want) return false;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * What the playbook says to do about this moment, or null for "nothing was declared".
 *
 * FIRST MATCH WINS, like every other ordered table in this repository, so a doctrine can
 * put the specific case above the general one and read the file top to bottom.
 *
 * @param {string} trigger      a key of TRIGGERS
 * @param {object|null} playbook
 * @param {object} facts        whatever that trigger promises in TRIGGERS[t].facts
 * @returns {{verb:string, args:object, why:string, rule:number}|null}
 */
export function decide(trigger, playbook, facts = {}) {
  if (!TRIGGERS[trigger]) return null;
  const rules = playbook?.on?.[trigger];
  if (!Array.isArray(rules) || !rules.length) return null;

  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (!r || typeof r !== 'object') continue;
    const spec = VERBS[r.do];
    // AN UNRECOGNISED VERB IS SKIPPED, NOT GUESSED AT AND NOT FATAL. A playbook written
    // against a newer harness than this one is the ordinary case as this list grows, and
    // the right behaviour is to fall through to the next rule -- which is why the caller
    // is handed `unknown` to journal rather than left to wonder.
    if (!spec) continue;
    if (!holds(r.when, facts)) continue;
    const args = {};
    for (const a of spec.args) if (r[a] !== undefined) args[a] = r[a];
    // A LIST OF LINES IS ONE DECISION, NOT A LIST OF DECISIONS. Rotating text is the
    // difference between a character with a voice and a character with a stuck record, and
    // the alternative — one rule per line with the same `when` — never fires past the first,
    // because first match wins.
    //
    // CHOSEN FROM THE FACTS, NOT FROM Math.random, AND THAT IS NOT FUSSINESS. This module's
    // contract is stated a few lines above: "PURE. Facts in, one action or null out. No
    // clock, no randomness -- which is what lets the whole table be tested against fixtures,
    // and what makes an action reproducible from the journal line that recorded the facts it
    // was given." A random pick would have quietly cost both of those. Hashing the facts
    // keeps them: the same death always yields the same line, a different death usually
    // yields a different one, and a journal entry can still be replayed to the same result.
    if (Array.isArray(args.message)) {
      const lines = args.message.filter(x => typeof x === 'string' && x.trim());
      if (!lines.length) delete args.message;
      else {
        let h = 2166136261;
        for (const ch of JSON.stringify(facts))
          h = ((h ^ ch.charCodeAt(0)) * 16777619) >>> 0;
        args.message = lines[h % lines.length];
      }
    }
    // A cooldown the playbook did not state is the verb's own, so an executor never has to
    // know which verbs are rate-limited.
    if (spec.cooldown_s !== undefined && args.cooldown_s === undefined)
      args.cooldown_s = spec.cooldown_s;
    return { verb: r.do, args, why: r.why || spec.why, rule: i };
  }
  return null;
}

/** The verbs a playbook names that this harness has never heard of. For reporting. */
export function unknownVerbs(playbook) {
  const out = new Set();
  for (const rules of Object.values(playbook?.on ?? {}))
    for (const r of (Array.isArray(rules) ? rules : []))
      if (r?.do && !VERBS[r.do]) out.add(r.do);
  return [...out];
}

// ---------------------------------------------------------------- validation
//
// Same standard as everything else here: check the things whose wrongness is SILENT. A
// playbook that will not load is better than one that runs and does something plausible.
export function validate(pb) {
  const bad = [];
  const say = (where, why) => bad.push({ where, why });
  if (!pb || typeof pb !== 'object') { say('', 'a playbook is an object with an `on` map'); return bad; }
  if (pb.on && typeof pb.on !== 'object') say('on', 'must be a map of trigger -> rules');

  for (const [trigger, rules] of Object.entries(pb.on ?? {})) {
    if (!TRIGGERS[trigger]) {
      // Not fatal to the file, but it will never fire and nothing else would ever say so.
      say(`on.${trigger}`, `no such trigger. This block can never run. Known: ` +
                           `${Object.keys(TRIGGERS).join(', ')}`);
      continue;
    }
    if (!Array.isArray(rules)) { say(`on.${trigger}`, 'must be a list of rules, in order'); continue; }
    rules.forEach((r, i) => {
      const at = `on.${trigger}[${i}]`;
      if (!r?.do) { say(`${at}.do`, 'every rule needs a verb'); return; }
      const spec = VERBS[r.do];
      if (!spec) {
        say(`${at}.do`, `"${r.do}" is not a verb this harness knows. Known: ` +
                        `${Object.keys(VERBS).join(', ')}`);
        return;
      }
      // THE TWO THAT PUT TEXT IN FRONT OF REAL PEOPLE. `prod` is a shared server; a
      // message is visible to strangers and attributable to whoever owns the account.
      // So the text must be WRITTEN DOWN IN THE PLAYBOOK -- a literal a person chose in
      // advance -- and never assembled from anything the world said back to us.
      if (spec.outward) {
        if (typeof r.message !== 'string' || !r.message.trim())
          say(`${at}.message`, `"${r.do}" speaks to other players and needs a literal ` +
                               `message written here. Text composed at the moment is how a ` +
                               `fleet says something nobody chose`);
        else if (/[{}$]|\bundefined\b/.test(r.message))
          say(`${at}.message`, 'looks like a template. This is sent verbatim to a shared ' +
                               'server -- write the sentence you mean');
        else if (r.message.length > 160)
          say(`${at}.message`, 'over 160 characters; the game truncates and the tail is lost');
      }
      if (r.do === 'tell' && !r.to) say(`${at}.to`, 'tell needs somebody to tell');
      // The second sentence is optional — a character with no guild has nobody to tell —
      // but if one is written it goes to real people and is held to the same standard.
      if (r.do === 'call_for_help' && r.guild_message !== undefined) {
        if (typeof r.guild_message !== 'string' || !r.guild_message.trim())
          say(`${at}.guild_message`, 'written but empty. Leave it out to skip the guild tell');
        else if (/[{}$]|\bundefined\b/.test(r.guild_message))
          say(`${at}.guild_message`, 'looks like a template. This is sent verbatim to real ' +
                                     'people — write the sentence you mean');
        else if (r.guild_message.length > 160)
          say(`${at}.guild_message`, 'over 160 characters; the game truncates and the tail is lost');
      }
      if (r.do === 'logoff' || r.do === 'call_for_help') {
        const s = num(r.stay_off_s);
        if (s === null || s < 0) say(`${at}.stay_off_s`, 'must be a number of seconds');
        else if (s > 3600) say(`${at}.stay_off_s`, 'over an hour. A character that is off is ' +
                                                   'not being defended, not earning, and not ' +
                                                   'visible on the board');
      }
      if (r.do === 'ask_for_orders') {
        const s = num(r.wait_s);
        if (s === null || s <= 0) say(`${at}.wait_s`, 'must be a positive number of seconds');
        // THE ONE VERB THAT BLOCKS, so the ceiling is where the argument is. A keeper
        // waiting on a bot is a keeper not deciding, and the trigger it is most tempting
        // to use this on is the one where waiting is most expensive.
        else if (s > 30) say(`${at}.wait_s`, 'over 30s. This BLOCKS the keeper while it waits ' +
                                             'for a bot to answer -- on attacked_by_player that ' +
                                             'is most of a fight');
        else if (trigger === 'attacked_by_player' && s > 5)
          say(`${at}.wait_s`, 'on attacked_by_player, waiting more than 5s for a bot means ' +
                              'the answer arrives after the fight. Put the decision in the ' +
                              'playbook instead -- that is what it is for');
      }
      if (r.when && typeof r.when !== 'object') say(`${at}.when`, 'must be a map of conditions');
      for (const k of Object.keys(r.when ?? {})) {
        const field = k.replace(/(_below|_at_least|_is)$/, '');
        if (!TRIGGERS[trigger].facts.includes(field))
          // The dangerous direction: an unrecognised condition FAILS CLOSED in decide(),
          // so a typo silently disables the rule rather than firing it. Saying so here is
          // the only way anybody finds out.
          say(`${at}.when.${k}`, `"${field}" is not something ${trigger} knows. It knows ` +
                                 `${TRIGGERS[trigger].facts.join(', ')}. An unknown condition ` +
                                 `never holds, so this rule would never fire`);
      }
    });
  }
  return bad;
}

/** Testing seam: drop the mtime cache. */
export function forget() { cache.clear(); }
