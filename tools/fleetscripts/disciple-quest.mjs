// BECOME A DISCIPLE OF ONE SCHOOL, SO THE PRIESTESS WILL SELL LEVEL-3 SPELLS AT ALL.
//
// PUBLIC. Everything here is read from the server source; the whole derivation, with line
// citations, is `m59-research/reports/disciple-quests.md` (pinned to Meridian59 1fb1f514).
// The short version:
//
//   A temple priestess refuses every spell of LEVEL 3 OR HIGHER until the character has done
//   her school's disciple quest, once, ever (temples.kod:52-73, monster.kod:4506-4518). The
//   refusal is one spoken sentence — "To learn that, you must first become my disciple by
//   proving the strength of your faith." — and it is the ONLY sign. `shop`-style listings do
//   not show the gate, and `abilities` cannot: the spell is simply never sold.
//
//   FOUR SCHOOLS HAVE ONE. Shal'ille, Kraanan, Faren, Qor. Riija's monk is a Temples subclass
//   with `viQuestID = 0`, which `HasDoneLearnQuest` answers TRUE for, and Jala's teachers are
//   not Temples at all — so for those two there is nothing to run and this script refuses.
//
// WHY THIS IS A FLEETSCRIPT AND NOT A HANDFUL OF `say` CALLS, since it looks like three:
//
//   * EVERY REFUSAL IS SILENT. Too far away, already a disciple, failed within the last hour
//     of logged-in time, anonymous — four different facts, one identical nothing. The only
//     instrument that tells them apart is the free teach probe at the bottom of this file,
//     and a script that does not run it reports "done" for a character that never started.
//
//   * THE REACH IS TIGHTER THAN SPEECH. A quest node wants
//     `SquaredDistanceTo <= Q_NPC_CLOSE_ENOUGH^2` = 25 (questnode.kod:650-653) while speech
//     carries to SAY_RADIUS 50 (blakston.khd:1299). There is a band, about five to seven
//     squares out, where the priestess HEARS the word and the quest node discards it. Hence
//     `radius: QUEST_NPC_RADIUS` on every say here — the say step then closes the extra two
//     squares instead of speaking into the gap.
//
//   * THE SERVER PICKS THE DESTINATION AND SAYS IT ONCE. Kraanan rolls one monster of three;
//     the other schools roll one NPC of three to five. It arrives as a single private line
//     (`NPC_quote_to_one`, questnode.kod:67) and is never repeated. That is why the walk and
//     the fight below take a function of the run state rather than a room number, and why
//     they declare `candidates` — see DYNAMIC_FIELDS in m59-fleetscript.mjs.
//
//   * AND THE ERRAND HAS A DEADLINE WITH A PRICE. Two hours (Kraanan, Qor delivery) or three
//     (Shal'ille, Faren delivery). Missing it writes a FAILURE into the quest history and
//     `Q_PLAYER_NOTFAILED_RECENTLY` then refuses a retry for 3600 seconds of LOGGED-IN time.
//     So a run that starts a quest and wanders off costs an hour of that character's day.
//
// IT IS SAFE TO RE-RUN AND DESIGNED TO BE. Every leg is conditional on what the probe and the
// assignment said, so a second run of a half-finished quest picks it up: the probe answers
// first, `disciple` is not said again once the quest is in flight or done, and the return leg
// completes a node that was already waiting for the body to show its face.
import { walk, say, fight, verify } from '../m59-fleetscript.mjs';
import { QUEST_NPC_RADIUS, sayToNpc } from '../m59-sayrange.mjs';

// ---------------------------------------------------------------- what the server wants
//
// TRANSCRIBED BYTE-FOR-BYTE, AND THAT IS NOT A STYLE POINT.
//
// The delivery node matches with `StringContain(message, pCargo)` (questnode.kod:679), which
// is `FuzzyBufferContain` (blakserv/ccode.c:886). Its own comment claims interior whitespace
// is squashed. The function it calls, `FuzzyCollapseString` (blakserv/ccode.c:626), only
// uppercases and trims the ENDS and then runs a plain `strstr` — so case is free, outer
// whitespace is free, and every interior space is load-bearing. These strings put TWO spaces
// after each full stop, and Faren's spells `sacriligious`. Reflowing this file must not touch
// them; `m59-disciple-test.mjs` reads the kod and fails if it does.
const CARGO = Object.freeze({
  shalille:
    'The ways of violence and destruction have hardened our people.  It is time to move ' +
    'towards gentleness and peace.  I will begin this process by granting forgiveness for ' +
    'your deeds.  Please accept my blessing.',
  faren:
    'You have defiled the land with your ways.  The land gives life, yet you treat it as the ' +
    'enemy to be conquered.  You are fools, all, if you continue on this sacriligious path.  ' +
    'Embrace nature, do not spurn it like a forgotten lover.  Repent your ways.  Follow the ' +
    'words of Faren.  Live for nature, not in opposition to it.',
  qor:
    'In darkness all shall be bound.  Our Mistress would walk among men in the comfort of a ' +
    'lightless sky and a bloody moon.',
});

// THE MONSTER IS NAMED BY ITS CLASS AND SPOKEN BY ITS NAME, AND FOR ONE OF THEM THOSE DIFFER.
// `RedAnt` is spoken as "mutant ant" (redant.kod:20). Nothing in the sentence says "red", so a
// parser looking for the class name finds nothing and reports no assignment.
//
// `viDifficulty` is the column that matters, not `viLevel` — a level-50 fungus beast at
// difficulty 1 is a warm-up and a level-65 mutant ant at difficulty 8 is a black-spider-class
// fight. A third of the rolls is the hard one and there is no re-roll: the only way out is to
// let the two hours lapse and pay the hour of cooldown.
export const KRAANAN_MONSTERS = Object.freeze({
  // Source of the River Ille: generator, 70% per tick, cap 7. Deliberately NOT 544 (Valley of
  // Ileria) — that room's spawn counter is shared across its whole table and has been measured
  // holding ten larvae and zero fungus beasts.
  'fungus beast': { room: 563, level: 50, difficulty: 1 },
  // Seafarer's Peak: cap 15, 60%. The Berdonne Canyons (32) is the alternative.
  'mutant ant': { room: 515, level: 65, difficulty: 8 },
  // Castle Victoria: cap 10, 40%, and a road this fleet already knows. G9 (579) is one hop
  // south of the Kraanan temple but carries a single RESPAWNING skeleton, so it is a coin
  // flip rather than a hunting ground.
  'skeleton': { room: 38, level: 75, difficulty: 5 },
});

export const SCHOOLS = Object.freeze({
  kraanan: {
    quest: 'kill', questId: 2, temple: 801, priestess: "Qerti'nya",
    // The only level-3 spell she sells, so the only free probe available for this school.
    probe: 'night vision',
    deadline: '2 hours',
  },
  shalille: {
    quest: 'deliver', questId: 1, temple: 48, priestess: 'Xiana',
    probe: 'rescue', deadline: '3 hours', cargo: CARGO.shalille,
    // shalilledisciple_invoke_success — what the destination says when the sentence LANDS. It
    // reads like a rebuff in all three schools, which is the point: "neither wanted nor
    // needed", "I have no use for sermons", "that is a vile utterance" are SUCCESS.
    invoke: /neither wanted nor needed/i,
    // questengine.kod template #13. `first(...)` of each occupation list, so one instance each.
    destinations: [
      { npc: 'Zuxana', room: 802, where: 'the temple of Qor' },
      { npc: "Tenuv'vyal", room: 45, where: 'the Badlands — the one dangerous destination here' },
      { npc: 'Akardius', room: 952, where: 'the Duke' },
    ],
  },
  faren: {
    quest: 'deliver', questId: 3, temple: 45, priestess: "Tenuv'vyal",
    probe: 'winds', deadline: '3 hours', cargo: CARGO.faren,
    invoke: /no use for sermons/i,
    // THE PRIESTESS HERSELF STANDS IN THE BADLANDS. Room 45 is a monster room, not a town: both
    // ends of this errand are somewhere a character can be attacked while standing still
    // talking. Faren is the expensive school to do this for and there is no other Faren
    // teacher.
    dangerousTemple: 'the Badlands (45), which is a monster room and not a town',
    // Template #16: every bartender with `onIsland = FALSE`, so Kocatan's is excluded
    // (library.kod:1098-1131).
    //
    // AND HAZARBAD HAS TWO OF THEM. `HazarBartender` is live at 1007 AND 1017, both called
    // "Eric d'Jorn", and the assign hint carries only the NAME — so when she picks that
    // destination there is nothing in her sentence that says which. `alt` is the other room,
    // walked only when the first delivery was not heard to land.
    destinations: [
      { npc: 'Meidei', room: 103, where: 'Barloque' },
      { npc: 'Pietro', room: 371, where: 'Jasper' },
      { npc: 'Tova', room: 202, where: 'Marion' },
      { npc: "Eric d'Jorn", room: 1007, alt: 1017, where: 'Hazarbad — and there are TWO of him' },
    ],
  },
  qor: {
    quest: 'deliver', questId: 4, temple: 802, priestess: 'Zuxana',
    probe: 'enfeeble', deadline: '2 hours', cargo: CARGO.qor,
    invoke: /vile utterance/i,
    destinations: [
      { npc: 'Xiana', room: 48, where: 'the temple of Shal\'ille' },
      { npc: 'Aftyn', room: 205, where: 'the Marion healer' },
      { npc: "Fehr'loi", room: 113, where: 'the Barloque blacksmith' },
      { npc: 'Frisconar', room: 53, where: 'the Tos apothecary' },
      { npc: 'Qesino', room: 370, where: 'the Jasper inn' },
    ],
  },
});

// Schools with no gate at all. Named rather than merely absent, so the refusal can say why.
export const NO_QUEST = Object.freeze({
  riija: 'the Monk of Riija is a Temples subclass with viQuestID = 0 (kcrjmonk.kod:58), which ' +
         'HasDoneLearnQuest answers TRUE for — the gate is in his code and permanently open',
  jala: 'Jala is not taught by a Temples subclass at all, so the IsClass(self,&Temples) arm of ' +
        'CanDoTeach never fires',
});

// ---------------------------------------------------------------- reading her answer
//
// WHAT SHE SAYS BACK IS NOT CHAT. `SomeoneSaid(#type=SAY_RESOURCE, ...)` and `MsgSendUser` both
// arrive as `message` events, and the broker's own `chat` tool says so in as many words:
// "Server prose — combat text, refusals, shopkeepers reading from a script — is NOT here". So
// the say step's `replies` are empty for every line this errand cares about, and reading them
// would report silence from a priestess who answered immediately.
export const PROBE_ANSWERS = Object.freeze([
  // temples.kod:18 — the Temples override. The monster.kod:40 default ("I can teach you %s, but
  // first you must prove your worth as a pupil.") belongs to the other gated sellers; matched
  // too, because a character sent to the wrong teacher should get a reading rather than a
  // shrug.
  { verdict: 'not_a_disciple', disciple: false,
    re: /become my disciple|prove your worth as a pupil/i },
  { verdict: 'qualified', disciple: true, re: /currently qualified to learn/i },
  { verdict: 'short_on_percentage', disciple: true, re: /further progress in the previous/i },
  { verdict: 'already_known', disciple: true, re: /already been taught/i },
  // CanDoTeach tests the disciple gate BEFORE PlayerCanLearn (monster.kod:4506 vs 4536), so
  // every answer below the gate is itself proof the gate is open.
  { verdict: 'no_base', disciple: true, re: /knowledge of the previous level/i },
  { verdict: 'school_exhausted', disciple: true, re: /no\.\.\. need\.\.\. to learn further/i },
]);

export const readProbe = lines => {
  for (const line of lines)
    for (const a of PROBE_ANSWERS) if (a.re.test(line)) return { ...a, line };
  return null;
};

/** Every `message` event since `cursor`, as plain text, plus the cursor to carry on from. */
async function proseSince(call, agent, cursor, ms) {
  const out = [], until = Date.now() + ms;
  let at = cursor;
  while (Date.now() < until) {
    const w = await call('wait_for_event',
      { agent, since: at, kinds: ['message', 'said'], timeout_ms: Math.min(4000, until - Date.now()) },
      60_000).catch(() => null);
    if (!w) break;
    if (w.cursor !== undefined) at = w.cursor;
    for (const e of (w.events ?? [])) if (e?.text) out.push(String(e.text));
    if (out.length && w.timed_out) break;
  }
  return { lines: out, cursor: at };
}

/** The cursor as it stands now, so a later read cannot pick up yesterday's prose. */
const cursorNow = (call, agent) =>
  call('wait_for_event', { agent, kinds: ['message'], timeout_ms: 1 }, 30_000)
    .then(w => w?.cursor ?? 0).catch(() => 0);

/**
 * THE FREE PROBE — say a level-3 spell's name and read the sentence.
 *
 * Every teacher registers one speech trigger per ability it sells (monster.kod:5711-5733) and
 * the library turns it into a bare `CanDoTeach` (library.kod:2868-2872). No money moves, no
 * state changes, and the entries carry no spam key so it is repeatable. It is the only
 * instrument in the game that distinguishes "not a disciple" from "a disciple who is four
 * percent short", and both of those look like a locked shop from outside.
 *
 * Routed through `sayToNpc` rather than a bare `call('say')` so the probe gets the same
 * approach and the same earshot check the `say` step gets — a probe that speaks from out of
 * range answers "she said nothing", which is the answer this whole file exists to stop
 * anybody believing.
 */
async function probe({ agent, call }, priestess, spell) {
  let lines = [];
  const r = await sayToNpc(
    { text: spell, to: priestess, radius: QUEST_NPC_RADIUS, leave: 2 },
    {
      look: () => call('look', { agent }, 30_000).catch(() => null),
      walkTo: (t, o) => call('walk_to',
        { agent, col: t.col, row: t.row, arrive_within: o.arriveWithin }, o.timeoutMs),
      log: () => {},
      speak: async text => {
        const at = await cursorNow(call, agent);
        const spoken = await call('say', { agent, text }, 30_000).catch(e => ({ error: e.message }));
        ({ lines } = await proseSince(call, agent, at, 9000));
        return { spoken_ok: !spoken?.error, replies: lines.map(text => ({ name: null, text })) };
      },
    });
  const verdict = readProbe(lines);
  return { ...r, lines, verdict };
}

export const script = {
  name: 'disciple-quest',
  describe: "Do a school's disciple quest, so its priestess will teach level-3 spells at all.",
  recipe: {
    effect: 'Walks to the priestess, proves whether the character is already a disciple, and ' +
            'if not runs her quest end to end — start it, do what she asks, come back — then ' +
            'proves the gate is open by asking her about a level-3 spell again. One school ' +
            'per run; the unlock is permanent and covers levels 3 to 6.',
    run: 'disciple-quest agents=<a> school=kraanan|shalille|faren|qor [home=<room>]',
    needs: ['the character must already hold LEVEL-2 spells in that school — the quest opens ' +
              'the shop, it does not pay for the spell or supply the percentages',
            'nothing in the pack, no money: the quest costs neither',
            'the character must not be anonymous or morphed — PFLAG_ANONYMOUS short-circuits ' +
              'Monster.SomeoneSaid before the quest hook ever runs (monster.kod:2605-2618)'],
    cost: {
      money: 'none. The quest is free; the spells afterwards are not',
      time: 'Kraanan: the temple, a hunting room and back. The others: the temple, one town ' +
            'or temple that the server picks, and back',
      risk: 'ordinary road risk, plus one fight for Kraanan — and the fight may be a MUTANT ' +
            'ANT (viDifficulty 8), which is a black-spider-class quarry. FAREN is the ' +
            'expensive one for a different reason: its priestess stands in the Badlands (45), ' +
            'a monster room, so both ends of that errand are somewhere a body can be attacked ' +
            'while standing still talking. Abandoning a started quest writes a failure and ' +
            'locks a retry for 3600s of LOGGED-IN time',
      estimate: 'two cross-country legs, one fight for Kraanan',
    },
    scales: 'Once per character per school, and there are four schools with a quest. Riija and ' +
            'Jala have none and are refused by name.',
  },

  // GUARANTEE 9. The two things that would break this without breaking anything visible are a
  // change to how speech reaches a keeper-backed character and a change to how the fight step
  // reports a kill — both of which would leave this script reporting a clean, wrong answer.
  provenance: {
    pinned: 'e7db7c7',
    verified: '2026-09-18',
    touches: [
      'tools/m59-fleetscript.mjs',     // the steps, the dynamic fields, the trap check
      'tools/m59-sayrange.mjs',        // the approach, and the quest node's tighter radius
      'tools/m59-keeper-process.mjs',  // where say and fight actually happen
      'tools/m59-broker.mjs',          // say, look, walk_to, wait_for_event
    ],
    // Warn rather than refuse: the quest is free, so a drifted run costs a walk. The expensive
    // failure here is a deadline, and no pin can see one.
    refuseOnDrift: false,
  },

  params: {
    agents: { type: 'agents', required: true, describe: 'who is becoming a disciple' },
    school: { required: true,
              describe: 'kraanan | shalille | faren | qor (riija and jala have no quest)' },
    // Left undefined means "end at the temple and let the keeper take it from there". Named
    // explicitly when the character has a station to go back to — a body parked outside its
    // confine with roam:false idles for ever and is not flagged as stalled.
    home: { type: 'number', describe: 'room to return to afterwards; omit to stay at the temple' },
    // The room to hunt the assigned monster in, when the default is wrong for this fleet's
    // level band. Keyed by the name the priestess SPEAKS: "fungus beast", "mutant ant",
    // "skeleton".
    huntRooms: { describe: 'override the hunting room per monster, e.g. {"skeleton":2601}' },
    rounds: { type: 'number', default: 40,
              describe: 'swing budget for the Kraanan fight — a budget for the whole fight, ' +
                        'not for one exchange' },
    abortBelow: { type: 'number', default: 0.5,
                  describe: 'health fraction at which the fight gives up. One more swing at ' +
                            '15% is a death, and a failed quest is cheaper than a corpse' },
  },

  async steps({ school, home, huntRooms, rounds, abortBelow, agent }) {
    const key = String(school ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
    if (NO_QUEST[key])
      throw new Error(`disciple-quest: ${key} has no disciple quest — ${NO_QUEST[key]}. ` +
                      `Nothing is gated, so there is nothing to run: buy the level-3 spell.`);
    const s = SCHOOLS[key];
    if (!s)
      throw new Error(`disciple-quest: unknown school "${school}". ` +
                      `Known: ${Object.keys(SCHOOLS).join(', ')} ` +
                      `(riija and jala have no quest).`);

    const hunts = { ...KRAANAN_MONSTERS };
    for (const [name, room] of Object.entries(huntRooms ?? {})) {
      if (!hunts[name]) throw new Error(
        `disciple-quest: huntRooms names "${name}", which is not a monster this quest can ` +
        `ask for. It asks for one of: ${Object.keys(KRAANAN_MONSTERS).join(', ')}.`);
      hunts[name] = { ...hunts[name], room: Number(room) };
    }

    // Every room a run-time-decided walk in this plan could choose, so `trapCheck` and a
    // reviewer see the whole reachable set rather than a closure.
    const errandRooms = s.quest === 'kill'
      ? Object.values(hunts).map(m => m.room)
      : s.destinations.flatMap(d => (d.alt ? [d.room, d.alt] : [d.room]));

    const middle = s.quest === 'kill'
      ? [
          // WHERE THE ASSIGNED MONSTER LIVES — or nowhere, which is the temple we are already
          // standing in and therefore a no-op walk (compiledWalk returns early when the body is
          // already in the room).
          walk(st => hunts[st.quest?.monster]?.room ?? s.temple,
               { candidates: [...errandRooms, s.temple] }),

          // ONE KILL, BY THIS CHARACTER, OF EXACTLY THAT CLASS.
          //
          // `rounds` is a budget for the whole fight rather than for one exchange — the keeper
          // spends it in bursts and re-reads the quarry between them, which is what makes a
          // step list able to kill something at all. `optional` covers the case where nothing
          // was assigned: the resolved target is then null and the step refuses rather than
          // letting the keeper swing at whatever is nearest.
          fight(st => st.quest?.monster ?? null,
                { rounds: Number(rounds), abortBelow: Number(abortBelow), optional: true }),

          // AND CHECK THE CORPSE, NOT THE ENGAGEMENT. The fight step passes on `engaged`, which
          // means blows were traded; the quest wants `killed`, by us, of that exact class.
          //
          // THE EXACT CLASS IS THE TRAP. The keeper picks its quarry with
          // `o.name.includes(want)`, so a target of "skeleton" happily matches a BATTERED,
          // DAEMON or TUSKED skeleton — and `MonsterKilled` compares `GetClass(dead_monster)`
          // against the quest's class with `<>`, not `IsClass` (questnode.kod:1583). Killing
          // the wrong skeleton is a complete, successful, useless fight.
          verify(async ({ state }) => {
            const want = state.quest?.monster;
            if (!want) return { ok: true, skipped: 'nothing was assigned to kill' };
            const r = Object.entries(state.results)
              .filter(([k]) => k.endsWith(':fight')).map(([, v]) => v).pop()?.result ?? {};
            const hit = String(r.target_name ?? '').trim().toLowerCase();
            if (!r.killed)
              return { ok: false, killed: false, engaged: !!r.engaged, why: r.why ??
                `the ${want} was not killed — the quest needs a corpse by this character's ` +
                `own hand, and the node stays open until the deadline` };
            if (hit && hit !== want)
              return { ok: false, killed_the_wrong_thing: hit, wanted: want, why:
                `killed "${hit}" and the quest wants exactly "${want}" — the keeper matches a ` +
                `target by substring and the quest engine compares the CLASS, so a battered, ` +
                `daemon or tusked skeleton is a fight that counts for nothing here` };
            return { ok: true, killed: hit || want };
          }, 'the assigned monster was not killed'),
        ]
      : [
          // WHERE SHE SENT US. Never guessed: the destination is whichever of her candidates
          // her own sentence named, and `null` means no assignment was read, which walks
          // nowhere.
          walk(st => st.quest?.room ?? s.temple, { candidates: [...errandRooms, s.temple] }),

          // THE SENTENCE, VERBATIM. `optional` because an unassigned run has nobody to say it
          // to and `sayToNpc` refuses a say with no addressee rather than broadcasting it to a
          // town.
          say(st => (st.quest?.npc ? s.cargo : ''),
              { to: st => st.quest?.npc ?? null, radius: QUEST_NPC_RADIUS,
                listenMs: 6000, optional: true }),

          // DID IT LAND? The destination answers with a rebuff that is the success message,
          // and that sentence is the only difference between "delivered" and "stood next to
          // the right person and said nothing that registered". Recorded rather than acted on
          // — a false negative here costs one extra town, and a false positive would cost the
          // whole quest.
          verify(async ({ agent: who, call, state }) => {
            if (!state.quest?.npc) return { ok: true, skipped: 'nothing to deliver' };
            const { lines } = await proseSince(call, who, state.cursor ?? 0, 3000);
            state.delivered = lines.some(l => s.invoke.test(l));
            return { ok: true, delivered: state.delivered,
                     ...(state.delivered ? {} : { note:
                       `${state.quest.npc} did not answer the way the quest engine makes a ` +
                       `destination answer. That is not proof of failure — the line can be ` +
                       `missed — but it is the reason for the second attempt below` }) };
          }, 'could not tell whether the message was delivered'),

          // THE SECOND ADDRESS, FOR THE ONE NPC WHO EXISTS TWICE. Walked only when the first
          // delivery was not heard to land and this destination has a twin; otherwise this
          // resolves to the temple, which is where the next step goes anyway.
          walk(st => (!st.delivered && st.quest?.alt) ? st.quest.alt : s.temple,
               { candidates: [...errandRooms, s.temple] }),
          say(st => (!st.delivered && st.quest?.alt ? s.cargo : ''),
              { to: st => st.quest?.npc ?? null, radius: QUEST_NPC_RADIUS,
                listenMs: 6000, optional: true }),
        ];

    return [
      walk(s.temple),

      // ASK BEFORE STARTING ANYTHING. A character who is already a disciple must not be sent
      // round the world again, and — more sharply — must not have `disciple` said on its
      // behalf, because a second quest instance can be joined and then abandoned, which costs
      // an hour of logged-in time for nothing.
      verify(async (ctx) => {
        const p = await probe(ctx, s.priestess, s.probe);
        ctx.state.probe_before = p.verdict?.verdict ?? null;
        ctx.state.disciple = p.verdict?.disciple ?? null;
        // MARK THE TAPE HERE. The assign hint is one line among whatever else the world is
        // saying, and `wait_for_event` without a `since` continues from wherever this agent
        // last read — which, mid-errand, is nowhere in particular. A cursor taken now, after
        // the probe has drained its own answer and before `disciple` is said, makes the next
        // read a window over exactly this exchange.
        ctx.state.cursor = await cursorNow(ctx.call, ctx.agent);
        if (!p.ok) return { ok: false, outcome: p.outcome, why: p.why };
        // A probe that heard nothing is NOT a "no". It is the instrument failing, and the
        // whole errand downstream would be reasoning from it.
        if (!p.verdict) return { ok: false, heard: p.lines.slice(0, 4), why:
          `${s.priestess} said nothing recognisable about "${s.probe}" — in earshot and ` +
          `silent means the probe spell is not one she sells, not that the gate is open` };
        return { ok: true, verdict: p.verdict.verdict, disciple: p.verdict.disciple };
      }, 'could not read whether this character is already a disciple'),

      // START IT — and only when there is something to start. An empty text is refused by the
      // say step, which `optional` turns into a skipped leg.
      say(st => (st.disciple === false ? 'disciple' : ''),
          { to: s.priestess, radius: QUEST_NPC_RADIUS, listenMs: 6000, optional: true }),

      // WHAT SHE ASKED FOR, READ OUT OF THE ONE LINE THAT CARRIES IT.
      //
      // This is a poll rather than a single read because the assign hint is posted from the
      // quest engine rather than sent inline with the reply — it lands a beat after the word.
      verify(async ({ agent: who, call, state }) => {
        if (state.disciple !== false) return { ok: true, skipped: 'already a disciple' };
        // From the mark set just before the word was said. Polled rather than read once: the
        // assign hint is POSTED by the quest engine rather than sent inline with the reply, so
        // it lands a beat after the say step has already returned.
        const { lines: heard, cursor } = await proseSince(call, who, state.cursor ?? 0, 8000);
        // Carry the tape forward, or the next read re-hears this one and the delivery check
        // matches against a window that includes the assignment it is meant to follow.
        state.cursor = cursor;
        const all = heard.join('   ');
        if (s.quest === 'kill') {
          const monster = Object.keys(KRAANAN_MONSTERS)
            .find(n => new RegExp(`kill a ${n}\\b`, 'i').test(all) || all.toLowerCase().includes(n));
          state.quest = monster ? { monster, room: hunts[monster].room } : null;
          return monster
            ? { ok: true, monster, difficulty: hunts[monster].difficulty, room: hunts[monster].room,
                ...(hunts[monster].difficulty >= 8
                  ? { warning: `a ${monster} is viDifficulty ${hunts[monster].difficulty} — if ` +
                               `this character cannot take that fight, stop now and let the ` +
                               `${s.deadline} lapse rather than walking it into one` }
                  : {}) }
            : { ok: false, heard: heard.slice(-4), why:
                `${s.priestess} named no monster — she asks for a fungus beast, a mutant ant ` +
                `or a skeleton ("mutant ant" is what RedAnt is called), so either the quest ` +
                `never started or her line was missed` };
        }
        const dest = s.destinations.find(d => all.toLowerCase().includes(d.npc.toLowerCase()));
        state.quest = dest ? { npc: dest.npc, room: dest.room, alt: dest.alt ?? null } : null;
        return dest
          ? { ok: true, deliver_to: dest.npc, room: dest.room, where: dest.where,
              ...(dest.alt ? { alt_room: dest.alt } : {}) }
          : { ok: false, heard: heard.slice(-4), why:
              `${s.priestess} named none of her ${s.destinations.length} possible ` +
              `destinations (${s.destinations.map(d => d.npc).join(', ')}), so either the ` +
              `quest never started or her line was missed` };
      }, 'could not read what the priestess asked for'),

      ...middle,

      // BACK TO HER. Walking in is enough on its own — `SomethingEntered` calls
      // `CheckCompletionCriteria` too (monster.kod:915-928) — but the body may never have left
      // the room, so the say below is the one that has to work.
      walk(s.temple),

      // THE CLOSING WORD, AND DELIBERATELY NOT "disciple".
      //
      // A monster or showup node completes on ANY speech within five squares, so the probe
      // spell's own name does the job. Saying "disciple" again would instead be offered to a
      // fresh waiting quest node, and joining a second instance of a quest already in flight is
      // how a character ends up holding a deadline nobody is working on.
      //
      // Note the quest hook runs BEFORE the teach trigger and `return`s on a match
      // (monster.kod:2620-2631), so this utterance closes the node and the teach probe is
      // suppressed. That is why the verdict below speaks a second time rather than reading
      // this step's reply.
      say(st => (st.disciple === false ? s.probe : ''),
          { to: s.priestess, radius: QUEST_NPC_RADIUS, listenMs: 6000, optional: true }),

      // THE VERDICT, MEASURED RATHER THAN INFERRED.
      //
      // Nothing above this proves anything: `AddQuestHistory` is written only when the quest
      // runs out of nodes (questnode.kod:890-899), and every step here can report success over
      // a quest that is still open. The probe is the one reading that comes from the server's
      // own opinion of this character.
      verify(async (ctx) => {
        const p = await probe(ctx, s.priestess, s.probe);
        ctx.state.probe_after = p.verdict?.verdict ?? null;
        if (!p.ok) return { ok: false, outcome: p.outcome, why: p.why };
        if (!p.verdict) return { ok: false, heard: p.lines.slice(0, 4), why:
          `could not get a reading from ${s.priestess} — the quest may well be done; ask her ` +
          `about "${s.probe}" from within five squares and read what she says` };
        if (!p.verdict.disciple) return { ok: false, verdict: p.verdict.verdict, why:
          `${s.priestess} still refuses to teach level-3 spells: "${p.verdict.line}". The ` +
          `quest is not finished. It stays open for ${s.deadline} from when it started, so ` +
          `re-running this script is the cheap move — it will pick up wherever it stopped` };
        return { ok: true, verdict: p.verdict.verdict, disciple: true,
                 note: p.verdict.verdict === 'short_on_percentage'
                   ? `the gate is OPEN — she will teach level 3 now. She is refusing on ` +
                     `percentages instead, which is the ordinary learn check and nothing to ` +
                     `do with the quest`
                   : undefined };
      }, 'the priestess still will not teach level-3 spells'),

      // ALWAYS. A quest that failed still has to bring the character back; the roads this
      // errand uses are where four of one night's deaths started.
      ...(home === undefined || home === null ? [] : [{ ...walk(Number(home)), always: true }]),
    ];
  },
};
