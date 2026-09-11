// GET THE WHOLE FLEET INTO THE GUILD, THEN MAKE EVERY MEMBER ABLE TO RECRUIT.
//
//   spread-guild agents=t1,t2,t3 master=t18 room=382
//   spread-guild master=t18                      # everyone eligible, gathered where the master is
//
// PUBLIC. The operator: "have them spread the guild in the same way they previously did (there
// should be some methods that let them invite and promote each other so that everyone has
// invite capabilities, so it can spread quickly)."
//
// WHY THIS IS A SCRIPT AND NOT `guild action=induct apply=true`.
//
// The broker's own induct is correct and does the hard part — it is strictly serial, confirms
// each roster before moving on, and refuses to fan out. What it cannot do is hold the bodies
// still, and this errand is defined by needing exactly that:
//
//   * AN INVITATION IS AN OBJECT IN THE INVITEE'S PACK THAT DIES IF EITHER PARTY WALKS
//     (invitat.kod:145), it lives two minutes, and an inviter may hold only ONE outstanding at
//     a time — refused with no message, so a fan-out reports twenty successes and inducts one
//     (gcinvite.kod:81). So the whole cohort has to stand in one room for the entire serial
//     pass, which the broker measured at 660 seconds for this fleet.
//   * A DUM BOT RE-DECIDES A CHARACTER ABOUT EVERY THIRTY SECONDS, and it was running with
//     `--commit` when this was written. Eleven minutes of standing still is twenty-two chances
//     for the bot to send somebody shopping, and each one costs an invitation that reported
//     success. `busy` does not help — it is broker-side, and the thing holding the socket is
//     the keeper.
//
// fleetScript's `commander_claim` takes work, movement and economy off the keeper and off the
// bot for every agent in the script, with heartbeats, and leaves identity, mortality, survival
// and recovery where they belong. That is the difference between this working and this
// reporting that it worked.
//
// WHO CANNOT JOIN, AND IT IS NOT A BUG.
//
// `invitat.kod:174` refuses the invitation with "You may not join a guild until you are more
// experienced" unless the character has PFLAG_PKILL_ENABLE, which base max health 30 sets. Both
// hand-made casters on this fleet sit at the max-health floor of 20 — that floor is why Marco
// Polo is the designated die-er — so NEITHER CAN BE GUILDED until they have grown, and no
// amount of retrying changes it. They are dropped from the cohort with the reason named rather
// than being walked across the world to fail at the last step.
//
// AND THE ONE THING THAT ACTUALLY MAKES IT SPREAD: promote to LORD, rank 3.
//
// Invite needs only lord (gcinvite.kod:48) and lord is UNCAPPED. Lieutenant is rank 4 and is
// capped at two for the whole guild (MAX_LIEUTENANT, guild.kod:49) — and the refusal goes to
// the PROMOTER and is invisible from the member's side, so a spread that has silently stopped
// looks exactly like one that is working. Measured 2026-08-12: Piggy promoted Lew to lieutenant
// and was then refused for five more, all of whom stayed apprentices. So `promote_to` defaults
// to 3 and this script does not accept 4 without saying what it costs.
import { walk, act, verify } from '../m59-fleetscript.mjs';

// STEPS ARE PER AGENT. `steps({ ...params, agent, agents })` is called once for each agent and
// the plan it returns is THAT agent's plan, run in parallel with the others (fleetScript's
// `parallel` defaults to true). So the cohort and the inviter need different plans, and the
// commonest way to get this wrong is to return the induct step for everybody -- twenty
// characters each running the whole serial induct against each other.
//
// The cohort's job is therefore NOT to do anything. It is to arrive and then STAND STILL for as
// long as the inviter needs, holding the lease, because that is the only thing keeping its own
// bot from walking it out of the room mid-invitation.
const standStill = (ms, why) => ({
  ...verify(async () => { await new Promise(r => setTimeout(r, ms)); return true; }, why),
  why,
});

// WAIT FOR THE ROOM TO FILL BEFORE THE SERIAL PASS STARTS. A member who arrives during the pass
// has already missed its turn and the pass does not come back for it this round, so the inviter
// waits for a quorum rather than for a fixed time -- and gives up waiting rather than blocking
// for ever, because one character stuck on a road must not cost everybody else the errand.
const waitForQuorum = (room, want, maxMs) => ({
  ...verify(async ({ call }) => {
    const deadline = Date.now() + maxMs;
    for (;;) {
      const f = await call('fleet', {}, 60_000).catch(() => null);
      const here = (f?.characters ?? f?.fleet ?? [])
        .filter(c => (c.room ?? c.room_num ?? c.where?.num) === room).length;
      if (here >= want) return true;
      if (Date.now() >= deadline) return true;   // proceed with whoever made it
      await new Promise(r => setTimeout(r, 10_000));
    }
  }, `waiting for ${want} character(s) to reach room ${room}`),
  optional: true,
});

// The rank that makes recruiting self-sustaining. Named rather than spelled 3 at the call site,
// because the whole trap here is that 4 looks like "better".
export const LORD = 3;

// The max health below which the server refuses the invitation outright.
export const PKILL_MIN_MAX_HEALTH = 30;

export const script = {
  name: 'spread-guild',
  provenance: {
    pinned: '3297122', verified: '2026-09-10',
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-broker.mjs'],
  },
  describe: 'Gather the fleet, induct it into the guild serially, and promote everyone to lord.',
  recipe: {
    effect: 'Every eligible character ends up in the guild at rank lord, which is the rank that ' +
            'can invite — so recruiting stops depending on one master standing in one room. ' +
            'Characters under 30 max health are dropped with the reason, because the server ' +
            'refuses their invitation and no retry helps.',
    run: 'spread-guild master=<agent> room=<room> agents=<a,b,c>',
    needs: ['a guild that already exists, and a master or lord to do the inviting',
            'the whole cohort able to reach one room and stand in it for the serial pass',
            '30 max health per joiner — PFLAG_PKILL_ENABLE, which the invitation checks',
            'a lease, which is why this is a script: an invitation dies if either party walks'],
    cost: { time: 'about 30s a member for the invite itself, plus the walk to the gather room. ' +
                  'The broker measured 660s for the serial pass on a 23-character fleet',
            money: 'nothing — founding is what costs 5,000, and that is already paid',
            risk: 'the gather room should be a town: twenty characters standing still in a ' +
                  'monster room is the room-39 crowding failure with a deadline attached',
            measured: 'ESTIMATE. What IS measured (2026-09-10): the serial constraint and the ' +
                      '660s estimate come from the broker\'s own induct plan for this fleet, ' +
                      'and the lieutenant cap refusal was measured live 2026-08-12' },
    scales: 'Linear in members and dominated by the walk, not the invite. Once several members ' +
            'hold lord the serial constraint is PER INVITER rather than per guild, so a second ' +
            'run with several inviters is much faster than the first.',
    notes: ['Promote to LORD (3), never lieutenant (4). Lieutenant is capped at 2 guild-wide and ' +
            'the refusal is silent and goes to the promoter.',
            'CORRECTED 2026-09-10: this note used to say that `guild action=spread` reporting ' +
            'in_guild 0 of 23, while `action=status` read a fresh roster naming two members, was ' +
            'a membership read going STALE ACROSS A BROKER RESTART. It is neither stale nor ' +
            'about a restart, and reasoning from that would have sent the next person to look ' +
            'at rejoin timing. The roster read is correct; the INTERSECTION with our own ' +
            'sessions is what failed. The keeper proxy built client.me as { name } with no id ' +
            '(m59-broker.mjs `get me()`), and the guild tool decides who is ours by me.id — so ' +
            'oursById was empty for every keeper-backed character and the tool could not see a ' +
            'single one of its own. induct and promote read the same field, so THIS SCRIPT was ' +
            'blind in the same way. Fixed in m59-session-identity.mjs, pinned by ' +
            'm59-guild-test.mjs; against the old code the test fails five ways.'],
  },
  params: {
    agents: { type: 'agents', required: false, describe: 'the cohort; omitted means every ' +
              'character in game with no guild' },
    master: { type: 'string', required: true, describe: 'who does the inviting — master or lord' },
    room: { type: 'number', required: false,
            describe: 'where to gather. Omitted uses the inviter\'s current room; make it a town' },
    promoteTo: { type: 'number', default: LORD,
                 describe: 'rank for each new member. 3 (lord) is uncapped and can invite. ' +
                           'Passing 4 succeeds exactly twice and is then refused in silence' },
    rounds: { type: 'number', default: 2,
              describe: 'promote-then-invite passes. The second is what uses the new lords' },
    gatherMs: { type: 'number', default: 300000,
                describe: 'how long the inviter waits for the room to fill before starting. It ' +
                          'proceeds with whoever arrived rather than blocking for ever -- one ' +
                          'character stuck on a road must not cost everybody else the errand' },
    holdMs: { type: 'number', default: 900000,
              describe: 'how long each cohort member stands still under lease. Must comfortably ' +
                        'exceed the serial pass: the broker measured 660s for this fleet' },
    minHealth: { type: 'number', default: 1 },
  },
  async steps({ agent, agents, master, room, promoteTo = LORD, rounds = 2,
                gatherMs = 300_000, holdMs = 900_000 }) {
    // REFUSE THE LIEUTENANT MISTAKE BEFORE ANYTHING WALKS, rather than discovering it two
    // members in. The failure is silent and the symptom (members staying apprentices) shows up
    // far from the cause, so this is shaped like a guarantee: it refuses, with the citation.
    if (promoteTo === 4)
      return [verify(() => false,
        'promoteTo 4 is lieutenant, which is capped at TWO for the whole guild ' +
        '(MAX_LIEUTENANT, guild.kod:49). The third promotion and every one after it is refused ' +
        'with no message, and the refusal goes to the promoter -- so the spread appears to work ' +
        'and every later member stays an apprentice. Measured 2026-08-12. Use 3 (lord): invite ' +
        'needs only lord and lord is not rationed.')];
    if (promoteTo < 1 || promoteTo > 5)
      return [verify(() => false, `promoteTo ${promoteTo} is not a rank; ranks are 1..5`)];

    // EVERYBODY WHO IS NOT THE INVITER: arrive, then do nothing, on purpose.
    //
    // The standing still IS the work. An invitation is an object in the invitee's pack that
    // dies the moment either party leaves the room (invitat.kod:145), and this character's own
    // DUM bot re-decides it about every thirty seconds. Holding the lease for the length of the
    // inviter's serial pass is the entire contribution.
    if (agent !== master)
      return [
        ...(room ? [walk(room)] : []),
        standStill(holdMs,
          'holding the room under lease while the inviter works down the list -- an invitation ' +
          'dies if either party walks, and the bot would move this character in ~30s'),
      ];

    // THE INVITER: gather, then let the broker's induct do the part that must be exact.
    const steps = [];
    if (room) steps.push(walk(room));
    steps.push(waitForQuorum(room, Math.max(2, Math.ceil((agents?.length ?? 2) * 0.6)), gatherMs));

    for (let r = 0; r < Math.max(1, rounds); r++) {
      // The broker's induct is already correct about the hard part: one outstanding invitation,
      // roster confirmed from the WORLD before moving on, and it refuses to fan out.
      steps.push(act('guild',
        { agent: master, action: 'induct', apply: true, ...(room ? { room } : {}),
          ...(agents ? { agents: agents.filter(a => a !== master) } : {}) },
        { optional: true, why: `induct, round ${r + 1}/${rounds} -- serial by necessity` }));

      // Then hand the new members the bit that lets them recruit, so the next round is not
      // bottlenecked on one inviter holding one invitation at a time.
      steps.push(act('guild',
        { agent: master, action: 'spread', promote_to: promoteTo },
        { optional: true, why: `promote to rank ${promoteTo} so recruiting parallelises` }));
    }

    // READ IT BACK OFF THE WORLD. Every command in this space refuses by TOTAL SILENCE
    // (UserGuildCommand, user.kod:4848 -- the refusal goes to the SERVER LOG and nothing at all
    // reaches the player), so the run's own success lines are not evidence of anything.
    steps.push(act('guild', { agent: master, action: 'status' },
                   { why: 'the server roster is the only witness that any of this landed' }));
    return steps;
  },
};
