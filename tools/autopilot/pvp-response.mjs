// WHEN A PLAYER ATTACKS: noticing it, playbooks, defending.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 6 methods: inReachOfUs, checkAttackedByPlayer, runPlaybook, consultPlaybook,
//   defendAgainstPlayers, findByName
import * as grudge from '../m59-grudge.mjs';
import { declareConflict } from '../m59-intel.mjs';
import { recordEvent } from '../m59-ledger.mjs';
import { OF, playerClassName } from '../m59-parse.mjs';
import * as party from '../m59-party.mjs';
import * as playbook from '../m59-playbook.mjs';
import { pvpRoomsRefusal } from '../m59-pvp-rooms.mjs';
import { refusedHere } from '../m59-refused-targets.mjs';
import * as skills from '../m59-skills.mjs';
import { REACH, pct, sleep } from '../m59-autopilot.mjs';

export class PvpResponsePart {
  // @part 1

  // WHAT IS ACTUALLY IN REACH OF US RIGHT NOW.
  //
  // NOT FLEETMATES. Without the player filter this chose a fleetmate 131 times out of
  // 132 — the characters stand next to each other by design, on walls and in inns, and
  // every one of them is ATTACKABLE. They cannot hurt each other while their guardian
  // angels hold, so it never showed as damage; it showed as twenty-five characters busy
  // all night and three kills between them.
  //
  // REACH is a disc of radius 3 on SQUARE coordinates, because that is what the server
  // tests: SquaredDistanceTo <= GetAttackRange^2 (nomoveon.kod:121). Up to 28 squares can
  // hit you, not the 8 that touch you.
  //
  // Extracted because two branches ask this question — the retaliation path and the
  // no-wall-nowhere-to-go dead end — and a copy that drifts would mean one of them
  // quietly disagreeing with the other about whether the character is under attack.
  inReachOfUs() {
    const c = this.s.client, me = c?.self;
    if (!me || !c?.room) return [];
    return [...c.room.objects.values()].filter(o =>
      o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER) &&
      Math.hypot(o.col - me.col, o.row - me.row) <= REACH);
  }

  // ------------------------------------------------------- the moments we ask about
  //
  // THREE PLACES WHERE THE KEEPER HAS NO OPINION AND SHOULD NOT INVENT ONE. Each asks a
  // PLAYBOOK the fleet's director wrote in advance — `m59-playbook.mjs`, read from disk
  // and cached on mtime, consulted with a synchronous function call and no network.
  //
  // The lookup is deliberately not a request. The first of the three is a player
  // attacking us, which is exactly the moment a thirty-second round trip is worth
  // nothing; so the answer is written down beforehand and read in microseconds. `ask for
  // orders` is the one verb that waits, and it exists so the escape hatch is explicit
  // rather than being the default nobody noticed they had chosen.
  //
  // NOTHING DECLARED MEANS THE BEHAVIOUR THAT WAS ALREADY THERE. `decide` returns null
  // and every one of these returns without acting, which for an attack means the ordinary
  // survival ladder — flee when losing, rest when hurt and safe. There is no verb for
  // standing still and there must not be one.

  /**
   * A PLAYER IS HITTING US, AND UNTIL NOW NOTHING IN HERE COULD SEE IT.
   *
   * `inReachOfUs()` filters `OF.PLAYER` out, which is right and stays right: without it
   * the retaliation branch chose a FLEETMATE 131 times out of a sample, and a fleet that
   * hits back at players on a shared server is a different kind of project. But the
   * filter meant a stranger standing over a character was not merely unanswered, it was
   * unobserved — the keeper read the damage as coming from the room and applied the same
   * ladder it applies to a giant rat.
   *
   * A monster and a player are not the same problem. A monster does not follow you to
   * another town, does not wait, and does not come back tomorrow.
   *
   * THE EVIDENCE IS TWO FACTS TOGETHER, because either alone is ordinary. A stranger
   * standing near us is a Tuesday on `prod`; losing health next to one is not. So this
   * fires on an attackable non-fleetmate player within reach AND health that has gone
   * down since the last look — and it is deliberately cheap enough to ask every pass.
   */
  async checkAttackedByPlayer() {
    const c = this.s?.client, me = c?.self;
    if (!me || !c?.room) return null;
    const hp = c.vitals?.()?.health;
    const now = hp?.value ?? null;
    const before = this.lastSeenHealth ?? null;
    this.lastSeenHealth = now;
    if (now == null || before == null || now >= before) return null;

    const strangers = [...c.room.objects.values()].filter(o =>
      o.id !== c.selfId && (o.flags & OF.PLAYER) && (o.flags & OF.ATTACKABLE) &&
      Math.hypot(o.col - me.col, o.row - me.row) <= REACH &&
      // A FLEETMATE IS NOT AN ATTACKER. `party.knownCharacters()` is every character
      // whose keeper has reported this run — and a keeper that has not had a pass yet is
      // ABSENT from it, so this can call one of ours a stranger for a few seconds after a
      // restart. That is why the playbook's answers are withdraw-and-wait rather than
      // anything that hits back: being wrong here must cost a walk, not a fight.
      !party.isFleetmate(c.rsc.get(o.nameRsc)));
    if (!strangers.length) return null;

    // WRITE IT DOWN FOR THE WHOLE FLEET, BEFORE DECIDING ANYTHING.
    //
    // One character being hit is everybody's information. The record is what lets the
    // eight fleetmates standing in the same room defend the one that got hit, and what
    // lets any of them recognise the same person an hour later in a different town —
    // which is the entire difference between a player and a monster.
    //
    // Recorded whatever the attacker's flags say. An unflagged attacker produces a grudge
    // that can never be acted on, because `mayReturnFire` re-reads the live flag and
    // refuses without it — so this is evidence, and only evidence, until the server
    // agrees the person is a murderer or an outlaw.
    // ASKED A SECOND TIME, ON PURPOSE. The `strangers` filter above already excluded
    // fleetmates — and on the first live run it let six of our own characters into the
    // book anyway, because `party.isFleetmate` is populated one keeper at a time and a
    // broker that restarted thirty seconds ago knows nobody. That is fixed at the source
    // (party now falls back to the roster), and it is checked again here because the cost
    // of the two disagreeing is a record that accuses our own people of murder.
    for (const s of strangers) {
      const sName = c.rsc.get(s.nameRsc);
      if (!sName || party.isFleetmate(sName)) continue;
      grudge.recordAttack(sName, { who: this.who(), room: this.s.world?.room?.num ?? null,
                                   playerClass: playerClassName(s.flags) });
    }

    const pb = playbook.playbookFor(this.who());
    const facts = {
      who: c.rsc.get(strangers[0].nameRsc) ?? null,
      health_pct: pct(hp), room: this.s.world?.room?.num ?? null,
      attackers: strangers.length,
      // What the server thinks of the one hitting us, so a playbook can tell a flagged
      // murderer from somebody who has just this second become an outlaw by hitting us.
      attacker_class: playerClassName(strangers[0].flags),
      // `this.hold` is the square we have claimed; `proven` is whether it has been stood
      // in and held. A playbook that wants the difference asks holdWorks() — this is the
      // weaker "we are on a wall at all", which is the one that matters against a player,
      // because a wall proven against monsters is no wall at all against somebody who can
      // walk round it.
      in_safe_spot: !!this.hold,
    };
    const action = playbook.decide('attacked_by_player', pb, facts);
    // RECORDED WHETHER OR NOT ANYTHING WAS DECLARED. A fleet being picked on by one
    // player, with nobody having written a playbook, is exactly the thing that should be
    // visible afterwards — and with no note it looks like a run of bad luck with monsters.
    this.note('a player is attacking us', {
      ...facts, lost: before - now,
      declared: action ? `${action.verb}` : null,
      why: action ? action.why
                  : 'no playbook covers this, so the ordinary survival ladder applies — ' +
                    'which treats this exactly as it treats a giant rat',
    });
    // THE ATTACK IS ALREADY WRITTEN DOWN, AND IT IS WRITTEN DOWN SOMEWHERE THAT FORGETS.
    //
    // `grudge.recordAttack` a few lines above this recorded exactly this event, for the
    // whole fleet, keyed on the name, expiring in an hour, and gated behind a live flag
    // before it can ever authorise anything. This used to ALSO call
    // `addTarget(auto_attack: true)`, which is the same fact written to a second book
    // that never expires and that a separate code path treated as permission to attack.
    // Two homes for one quantity, and the second one was the one that could kill people.
    //
    // A conflict is declared by whoever actually swings — `defendAgainstPlayers`, once
    // `mayReturnFire` has agreed — rather than by being hit, so that the thing the rest
    // of the fleet converges on is a fight we are permitted to be in.
    if (!action) return null;
    return this.runPlaybook('attacked_by_player', action, facts);
  }

  /**
   * EXECUTE ONE PLAYBOOK VERB. The closed set from m59-playbook.mjs and nothing else —
   * a bot may not hand the keeper an arbitrary act, which is the whole reason the verbs
   * are a vocabulary rather than a tool call.
   *
   * Every branch reports what it did, because a playbook that fires and achieves nothing
   * is indistinguishable from one that was never consulted.
   */
  async runPlaybook(trigger, action, facts = {}) {
    const done = (what, extra = {}) => {
      this.tally.playbook = (this.tally.playbook || 0) + 1;
      this.note('playbook', { trigger, verb: action.verb, rule: action.rule,
                              why: action.why, did: what, ...extra });
      return { trigger, ...action, did: what };
    };
    try {
      switch (action.verb) {
        case 'nothing':
          return done('nothing, deliberately');

        // A PLAYBOOK VERB REPORTS WHAT IT DID, and this pair used to report what it was
        // asked to do. `retreatToSafety` refuses outright while `retreat_to_inn` is off,
        // so "retreated to a wall" was written into the journal by a character that had
        // not moved — the same lie, from the same call, that issue #51 is about. The
        // header comment two dozen lines up already states the rule: a playbook that
        // fires and achieves nothing must not be indistinguishable from one that worked.
        case 'retreat': {
          const r = await this.retreatToSafety({ because: `playbook: ${trigger}` });
          return done(r?.arrived ? (r.took_spot ? 'retreated to a wall' : 'retreated to safety')
                                 : 'nothing — the retreat was refused',
                      { refused: r?.arrived ? undefined : (r?.refused ?? 'no reason given') });
        }

        case 'leave_room': {
          const r = await this.retreatToSafety({ because: `playbook: ${trigger}`, leaveRoom: true });
          return done(r?.arrived ? 'left the room' : 'nothing — the retreat was refused',
                      { refused: r?.arrived ? undefined : (r?.refused ?? 'no reason given') });
        }

        case 'logoff': {
          // THE ANSWER TO A GRIEFER, AND THE HALF THAT MATTERS IS THE WAITING. Logging
          // off and straight back on hands the character back to whoever was hitting it.
          // So the stay-off window is published for the broker's rejoin sweep to honour —
          // otherwise the sweep, which exists to put back characters that fall out, would
          // put this one back in forty-five seconds and read the next drop as contention.
          const s = Number(action.args.stay_off_s) || 0;
          this.stayOffUntil = Date.now() + s * 1000;
          this.goInert(`playbook: ${trigger} — staying off for ${s}s`, { maxMs: (s + 60) * 1000 });
          const out = await this.breakOut(`playbook: ${trigger}`).catch(e => ({ did: false, why: e.message }));
          return done(out?.did ? `logged off for ${s}s` : `could not log off (${out?.why ?? 'refused'})`,
                      { stay_off_s: s, until: this.stayOffUntil });
        }

        case 'say':
        case 'tell': {
          // A LITERAL SOMEBODY CHOSE, SENT VERBATIM. `prod` has real players on it and
          // anything said is attributable to whoever owns the account, so the text comes
          // out of the playbook exactly as written — never assembled here, and never from
          // anything the world said back to us. m59-playbook.mjs refuses a message that
          // looks like a template for this reason.
          const text = String(action.args.message ?? '');
          if (!text) return done('nothing — no message was written');
          const c = this.s.client;
          if (action.verb === 'say') await this.s.pacer.submit('say', () => c.say(text));
          else {
            const to = this.findByName(action.args.to);
            if (!to) return done(`nobody here called ${action.args.to}`);
            await this.s.pacer.submit('say', () => c.tell(to.id, text));
          }
          return done(`said it`, { to: action.args.to ?? 'the room' });
        }

        case 'yell':
        case 'tell_guild': {
          const text = String(action.args.message ?? '');
          if (!text) return done('nothing — no message was written');
          const c = this.s.client;
          if (action.verb === 'yell') await this.s.pacer.submit('say', () => c.yell(text));
          else await this.s.pacer.submit('say', () => c.sayGuild(text));
          // A GUILD TELL FROM A GUILDLESS CHARACTER IS REFUSED WITH A SENTENCE
          // (`user_no_say_guild`, user.kod:4117) and nothing on the wire, so this reports
          // what it sent rather than claiming it arrived — the same standard as every
          // other spoken thing here.
          return done(action.verb === 'yell' ? 'shouted it to the room and the ones next door'
                                             : 'sent it to the guild (unverified — a guildless ' +
                                               'character is refused with prose)');
        }

        // EVERY PLAYER LOGGED IN HEARS THIS, SO IT IS THE ONE SPOKEN VERB WITH A CLOCK.
        //
        // `say` reaches a room and `yell` the ones next door; this reaches strangers who
        // never opted into anything the fleet is doing. The game itself treats it as the
        // help-of-last-resort channel — the guardian-angel death mail teaches a new player
        // to `broadcast` for somebody to find their corpse — so the failure mode worth
        // guarding is not one broadcast, it is a DEATH LOOP: a character dying every ninety
        // seconds on a road it cannot survive would broadcast every ninety seconds for as
        // long as nobody is watching, which reads as griefing however good the line is.
        //
        // The cooldown is the verb's own default (600s) unless the playbook lowered it, and
        // it is enforced HERE rather than trusted, because m59-playbook.mjs is pure and has
        // no clock to enforce it with. A suppressed broadcast is reported as suppressed —
        // silence that looks like success is the thing this repository keeps paying for.
        case 'broadcast': {
          const text = String(action.args.message ?? '');
          if (!text) return done('nothing — no message was written');
          const waitS = Number(action.args.cooldown_s ?? 600);
          const last = this.lastBroadcastAt ?? 0;
          const sinceS = (Date.now() - last) / 1000;
          if (last && sinceS < waitS)
            return done(`suppressed — broadcast cooldown, ${Math.round(waitS - sinceS)}s left`,
                        { suppressed: true, cooldown_s: waitS });
          this.lastBroadcastAt = Date.now();
          await this.s.pacer.submit('say', () => this.s.client.broadcast(text));
          return done('broadcast it to everyone logged in', { cooldown_s: waitS });
        }

        case 'call_for_help': {
          // THE ORDER IS THE POINT, AND IT IS WHY THIS IS ONE VERB. Shout, tell the guild,
          // then go. Logging off first would mean nobody ever learns where it happened;
          // this trigger fires one rule per pass and there is no guarantee of a second.
          const c = this.s.client;
          const shout = String(action.args.message ?? '');
          const toGuild = String(action.args.guild_message ?? '');
          const said = [];
          if (shout) {
            await this.s.pacer.submit('say', () => c.yell(shout)).catch(() => {});
            said.push('yelled');
          }
          if (toGuild) {
            await this.s.pacer.submit('say', () => c.sayGuild(toGuild)).catch(() => {});
            said.push('told the guild');
          }
          const s = Number(action.args.stay_off_s) || 0;
          this.stayOffUntil = Date.now() + s * 1000;
          this.goInert(`playbook: ${trigger} — staying off for ${s}s`, { maxMs: (s + 60) * 1000 });
          const out = await this.breakOut(`playbook: ${trigger}`).catch(e => ({ did: false, why: e.message }));
          return done(`${said.join(', ') || 'said nothing'}, then ` +
                      (out?.did ? `logged off for ${s}s` : `could NOT log off (${out?.why ?? 'refused'})`),
                      { stay_off_s: s, until: this.stayOffUntil, shouted: !!shout, guild: !!toGuild });
        }

        case 'stand_down':
          this.goInert(`playbook: ${trigger}`);
          return done('stood down and waited to be told');

        case 'ask_for_orders': {
          // THE ONE VERB THAT BLOCKS, and its cost is stated where it is paid. The
          // character is marked busy so nothing restarts its keeper while it waits, the
          // wait is bounded by the playbook (and capped hard by validation), and if
          // nobody answers the keeper carries on exactly as it would have.
          const waitS = Math.min(30, Number(action.args.wait_s) || 0);
          const held = this.heldStatus();
          if (!held) return done('nobody is holding this character, so there is nobody to ask');
          this.declareBusy({ by: held.by, kind: `asked:${trigger}`,
                             label: `waiting for orders about ${trigger}`,
                             leaseMs: (waitS + 30) * 1000 });
          this.pendingQuestion = { trigger, facts, at: Date.now(), by: held.by };
          const until = Date.now() + waitS * 1000;
          while (Date.now() < until && this.pendingQuestion) await sleep(500);
          const answered = !this.pendingQuestion;
          this.pendingQuestion = null;
          this.freeBusy({ by: held.by });
          return done(answered ? `${held.by} answered` : `${held.by} did not answer in ${waitS}s`,
                      { waited_s: waitS, answered });
        }

        default:
          // Unreachable through `decide`, which skips verbs it does not know. Here for
          // the day somebody calls this directly.
          return done(`nothing — "${action.verb}" is not a verb this keeper executes`);
      }
    } catch (e) {
      return done(`failed: ${e.message}`);
    }
  }

  /**
   * ASK THE PLAYBOOK ABOUT WHATEVER JUST HAPPENED — one call, from one place in the pass.
   *
   * The two queued triggers fire here rather than where they are detected, and for the
   * same reason in both cases: the moment of detection is the wrong moment to act. A
   * death is noticed inside the death handling, with the character in the Underworld,
   * where a playbook that walked it anywhere would be arguing with the escape; an
   * improvement is noticed while reading the event ring mid-fight. Queuing them costs one
   * pass and buys a keeper that is somewhere coherent when the action runs.
   *
   * Attacked-by-player is NOT queued, because its whole value is being immediate.
   */
  async consultPlaybook() {
    const pb = playbook.playbookFor(this.who());

    // Cleared before the await in every branch, so a slow action cannot make the same
    // event fire twice on the next pass.
    if (this.pendingDeath) {
      const facts = this.pendingDeath; this.pendingDeath = null;
      const action = playbook.decide('died', pb, facts);
      if (action) await this.runPlaybook('died', action, facts);
    }
    if (this.pendingImprovement) {
      const facts = this.pendingImprovement; this.pendingImprovement = null;
      // BEFORE the playbook, and not inside it. The flip has to happen whether or not this
      // character has a playbook configured, and an `improved` action that logs off or asks
      // for orders must not be able to skip it — the swing counter has already been reset
      // server-side by now, so this is the one moment switching is free.
      const flipped = this.onTrainingImprovement(facts);
      if (flipped) this.note(`training style now ${flipped}, the swing counter having just reset`,
        { style: flipped, after: facts?.skill ?? facts?.name ?? null });
      const action = playbook.decide('improved', pb, facts);
      if (action) await this.runPlaybook('improved', action, facts);
    }
    // A DELIBERATE LOGOFF IS NOT A DROP, and the keeper has to stop driving for the
    // window it asked for or it walks straight back into whoever it left.
    if (this.stayOffUntil && Date.now() < this.stayOffUntil) return;
    if (this.stayOffUntil) {
      this.stayOffUntil = null;
      this.note('stay-off window is over', { why: 'the playbook logged this character off ' +
        'and the wait it asked for has elapsed' });
    }
    // A CHARACTER THAT CANNOT LEAVE WHERE IT IS CANNOT DO ANYTHING ELSE EITHER, so this
    // goes before the rest. Flagged by noProgress, bounded by its own cooldown, and a
    // no-op on every pass where nothing is stuck.
    await this.blinkFree().catch(error =>
      this.note('could not blink free', { why: error.message }));
    await this.checkAttackedByPlayer();
    // BEFORE returning fire, so a fleetmate's shout counts on this pass rather than the
    // next one — the difference matters most for the character that cannot report itself.
    await this.hearAlarm().catch(error =>
      this.note('could not read the alarm', { why: error.message }));
    // AFTER the detection, so a blow landing this pass is already in the grudge book and
    // the answer to it is this pass rather than the next one.
    await this.defendAgainstPlayers().catch(error =>
      this.note('could not return fire', { why: error.message }));
  }

  /**
   * SWING BACK AT SOMEBODY WHO HAS ATTACKED THIS FLEET — the one place in this
   * repository that can make a character hit a real person, and the reason every
   * condition in it is checked rather than assumed.
   *
   * THE SERVER IS THE SAFETY, AND WE DO NOT TURN IT OFF. `PFLAG_SAFETY` stays on. Its
   * whole behaviour is in the docstring of `Player.CheckStatusAndSafety`
   * (player.kod:3767): *"PFLAG_SAFETY prevents accidental attacks. You can always
   * successfully hit a murderer or outlaw, though."* So with safety ON the server:
   *
   *   - REFUSES any attack on a player who is neither murderer nor outlaw, and says so
   *     ("Hey! You almost hit %s%s! Good thing your safety was on!", player.kod:177);
   *   - ALLOWS an attack on one who is, with no outlaw penalty — the branch that makes
   *     an aggressor an outlaw is skipped entirely for such a victim (player.kod:3816);
   *   - and if the fight is won, counts it as `piJustified_kill_count` rather than
   *     making US a murderer (player.kod:4841, 4856). No faction loss either.
   *
   * That is a stronger interlock than anything written here could be, because it is
   * enforced on the other side of the wire. Everything below is about not RELYING on it:
   * a fleet whose only protection against hitting an innocent is a remote server's
   * refusal is one server-flag change away from being a griefer.
   *
   * OFF UNLESS ASKED FOR. `defendAgainstPlayers` is unset by default, so a fresh clone
   * behaves exactly as before — silence means the behaviour that was already there. This
   * is a bet about a particular fleet on a particular shared server, not a mechanic, so
   * it belongs in a local policy rather than in a committed default.
   */
  async defendAgainstPlayers() {
    if (this.policy.defendAgainstPlayers !== true) return null;
    const c = this.s?.client, me = c?.self;
    if (!me || !c?.room) return null;

    // EVERYWHERE IN THIS ROOM, NOT JUST WITHIN REACH — the same argument `pull` makes.
    //
    // This used to filter to `<= REACH`, which meant a character only ever swung back at
    // somebody who had already closed to melee. Against an organised group that is not a
    // defence: they pick the range, hit, and step back out of a 3-square disc, and every
    // one of our characters stands there reporting itself safe. Measured on prod
    // 2026-08-19: Morpheus landed 19 hits across 9 characters and was engaged twice.
    //
    // REACH itself is NOT the knob and must not be widened — it is the SERVER's melee
    // reach (`SquaredDistanceTo <= GetAttackRange^2`, a disc of 2-3 squares) and a fact
    // about the game rather than a policy. What changes is how far we will WALK to put
    // ourselves inside it, which is the same distinction `pull` draws for monsters.
    // AND IT IS A SETTING, BECAUSE TACTICS CHANGE FASTER THAN CODE DOES. `defendChase`
    // off (the default, and the behaviour before any of this) engages only what has
    // already closed to melee. On, it searches the room and walks to them. This shipped
    // hardcoded for one afternoon and that was wrong: the operator reversed the decision
    // within the hour, and reversing it meant editing this file and restarting a broker
    // that holds twenty-one irreplaceable sessions.
    const chase = this.policy.defendChase === true;
    const candidates = [...c.room.objects.values()]
      .filter(o => o.id !== c.selfId &&
                   (chase || Math.hypot(o.col - me.col, o.row - me.row) <= REACH))
      .map(o => {
        const name = c.rsc.get(o.nameRsc) || null;
        return { o, name, verdict: grudge.mayReturnFire({ name, flags: o.flags },
                                     { fleetmate: party.isFleetmate(name) }) };
      })
      // REFUSED IN THIS ROOM ("Only those in guilds may attack each other here."): still a
      // threat the ladder answers, never somebody we swing at again here. m59-refused-targets.
      .filter(row => row.verdict.engage && !refusedHere(this.s, row.name));
    if (!candidates.length) return null;
    // OUTSIDE pvp_rooms NOBODY IS ENGAGED (m59-pvp-rooms.mjs). The grudge stands and the ladder
    // runs exactly as it would for anything else hurting us that we will not fight.
    const outside = pvpRoomsRefusal(this.policy, this.s.world?.room?.num);
    if (outside) {
      const key = `${outside.room}|${candidates.map(r => r.name).join(',')}`;
      if (this.pvpRoomsDefendNoted !== key) {
        this.pvpRoomsDefendNoted = key;
        this.note('not returning fire: outside pvp_rooms', {
          who: candidates.map(r => r.name), room: outside.room, pvp_rooms: outside.rooms,
          why: outside.why, survival: 'the ordinary ladder (flee below the line, logoff) owns this body' });
      }
      return { engaged: null, why: 'outside pvp_rooms' };
    }

    // THE ONE THAT HAS HIT US MOST RECENTLY. Not the nearest and not the weakest: a fight
    // with a person is about making one of them stop, and spreading damage over two
    // attackers finishes neither.
    candidates.sort((a, b) => (b.verdict.grudge?.at ?? 0) - (a.verdict.grudge?.at ?? 0));
    const pick = candidates[0];

    // NO THREAT CEILING HERE, AND THAT IS DELIBERATE. `refuseEngagement` exists to stop a
    // character picking a fight with a monster it cannot beat — a choice it did not have
    // to make. This is not that choice: somebody is already hitting us, and declining to
    // swing back does not end the fight, it just means losing it without trying. The
    // survival floor still applies exactly as before, which is what bounds this: the
    // ordinary ladder disengages and runs at `fleeBelow` whether or not we are swinging.
    if (this.foeId !== pick.o.id) {
      this.note('returning fire on a flagged attacker', {
        who: pick.name, room: this.s.world?.room?.num ?? null,
        their_class: playerClassName(pick.o.flags),
        grudge_age_m: Math.round((pick.verdict.grudge?.age_ms ?? 0) / 60000),
        they_have_hit: pick.verdict.grudge?.victims ?? [],
        why: pick.verdict.why,
        safety: 'our own PFLAG_SAFETY is left ON — the server refuses this attack ' +
                'outright if they are not actually flagged, which is the interlock',
      });
      recordEvent(this.who(), 'returned_fire', {
        target: pick.name, target_class: playerClassName(pick.o.flags),
        room: this.s.world?.room?.num ?? null,
        hits_on_us: pick.verdict.grudge?.hits ?? null,
      });
    }
    // ARM FOR THIS ONE EVEN IF THE BAN FORBIDS EVERYTHING WE CARRY. `isArmed` answers TRUE
    // when it cannot see the equipment, so this fires only when the hand is KNOWN empty —
    // it will not strip a weapon we simply failed to read. See escalateArmForPvp for why
    // the ban yields here and nowhere else.
    if (!skills.isArmed(c))
      await this.escalateArmForPvp(pick.name).catch(() => null);
    this.doing = 'fighting';
    // SAY SO, SO THE OTHERS CAN COME. This is the one place a conflict is published:
    // past `mayReturnFire`, at the moment of the swing, by the character swinging. Being
    // hit does not publish one — the grudge book already records that, and a conflict is
    // a call for help that should only ever name a fight we are permitted to be in.
    try {
      declareConflict(c.me?.name ?? this.who(), pick.name,
                      this.s.world?.room?.num ?? null);
    } catch { /* the record is never worth the swing */ }
    // CLOSE THE DISTANCE FIRST. An attack outside the server's melee reach is refused
    // silently, so without this the widened search above would only produce a character
    // swinging at the air. Bounded the way `pull` bounds it — relative to the trip —
    // so it stays in this room and walks no further than the exit.
    const away = Math.hypot(pick.o.col - me.col, pick.o.row - me.row);
    if (away > REACH) {
      const approach = this.s.world?.approachSquare?.(pick.o.col, pick.o.row);
      if (!approach) {
        this.note('cannot reach a flagged attacker', {
          who: pick.name, squares_away: Math.round(away),
          why: 'no square beside them this room can route us to' });
        return { engaged: null, why: 'no route to them' };
      }
      this.doing = 'fighting';
      const out = await this.s.walkTo(approach.col, approach.row,
                                      { maxSteps: approach.steps + 8 })
                            .catch(e => ({ arrived: false, reason: e.message }));
      this.movedAt = Date.now();
      if (!out.arrived) {
        this.note('could not close on a flagged attacker', {
          who: pick.name, squares_away: Math.round(away), why: out.reason ?? 'walk refused' });
        return { engaged: null, why: 'could not close' };
      }
    }
    // NEVER TRUST A CAPTURED OBJECT'S COORDINATES ACROSS A WALK. BP_ROOM_CONTENTS
    // replaces the whole object map, so the instance we picked may be stale or gone —
    // they are a player and players move, which is the entire reason we just walked.
    const still = c.room.objects.get(pick.o.id);
    if (!still) return { engaged: null, why: 'they left the room' };
    await this.s.faceToward(still).catch(() => {});
    await this.s.pacer.submit('attack', () => c.attack(still.id), 1050).catch(() => {});
    this.swungAt = Date.now();
    // A PLAYER BY CONSTRUCTION — this is the self-defence path. See notePlayerSwing.
    this.notePlayerSwing();
    this.foeId = still.id;
    return { engaged: pick.name, why: pick.verdict.why };
  }

  /** An object in this room whose name matches, for `tell`. */
  findByName(name) {
    const c = this.s?.client;
    if (!c?.room || !name) return null;
    const want = String(name).toLowerCase();
    return [...c.room.objects.values()]
      .find(o => (c.rsc.get(o.nameRsc) || '').toLowerCase() === want) ?? null;
  }
  // @end 1
}
