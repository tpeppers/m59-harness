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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk, say, shop, fight, verify, walkTo, crawlTo, gate, ungate } from '../m59-fleetscript.mjs';
import { QUEST_NPC_RADIUS, sayToNpc } from '../m59-sayrange.mjs';
import { fleetName } from '../m59-fleetpath.mjs';
import { saveRun, runId } from '../m59-questbook.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
    // THE CONTROL ASK — something she sells BELOW the gate. See `probe()`: the gate's refusal
    // has historically not reached this client at all, so silence is its only reliable signal,
    // and silence needs a second ask to tell it from "she cannot hear me".
    control: 'create food',
    deadline: '2 hours',
  },
  shalille: {
    quest: 'deliver', questId: 1, temple: 48, priestess: 'Xiana',
    probe: 'rescue', control: 'minor heal', deadline: '3 hours', cargo: CARGO.shalille,
    // shalilledisciple_invoke_success — what the destination says when the sentence LANDS. It
    // reads like a rebuff in all three schools, which is the point: "neither wanted nor
    // needed", "I have no use for sermons", "that is a vile utterance" are SUCCESS.
    invoke: /neither wanted nor needed/i,
    // questengine.kod template #13. `first(...)` of each occupation list, so one instance each.
    destinations: [
      // THE TEMPLE OF QOR HAS A WANDERING ENTRANCE, AND NO STATIC EXIT TABLE CAN HOLD IT.
      //
      // `tempqor.kod:47,79-131`: `plExitPossibilities = [ RID_I8, RID_H9 ]` — rooms 598 and 589
      // — and `ExitsTimer` fires every `EXIT_DELAY = 600000` ms, ten minutes, choosing a
      // DIFFERENT one each time (`while oChosenExit = piCurrentExit` loops until it changes, so
      // it never stays put). It then sends `OpenQorTemple` to the winner and `CloseQorTemple`
      // to the loser. One door, alternating, for ever.
      //
      // So a router asked for room 802 answers, correctly about itself and misleadingly about
      // the world: *"nothing in the unified exit view arrives at room 802 … it is a room with
      // no recorded way in."* Measured on the shadow fleet 2026-09-18, when the Shal'ille quest
      // rolled Zuxana and the walk was refused before a step. The temple is not unreachable —
      // players go there — it is a door our model has no way to express, which is the same
      // shape as a mana node called unreachable because nobody wrote the jump down.
      //
      // Whoever fixes this has to decide what "the way in" means when it moves: 589 and 598 are
      // each right half the time, and which is open is only knowable by looking. Until then
      // this destination is expected to fail at the walk, the questbook records it, and a run
      // that draws it has simply drawn the hard one.
      { npc: 'Zuxana', room: 802, where: 'the temple of Qor — entered from 598 or 589, ' +
                                         'alternating every 600s; no static exit table has it' },
      { npc: "Tenuv'vyal", room: 45, where: 'the Badlands — the one dangerous destination here' },
      { npc: 'Akardius', room: 952, where: 'the Duke' },
    ],
  },
  faren: {
    quest: 'deliver', questId: 3, temple: 45, priestess: "Tenuv'vyal",
    probe: 'winds', control: 'light', deadline: '3 hours', cargo: CARGO.faren,
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
    probe: 'enfeeble', control: 'darkness', deadline: '2 hours', cargo: CARGO.qor,
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
/**
 * GETTING WITHIN FIVE SQUARES OF AN NPC IS A CRAWL, NOT AN AIM — AND NOT A ROOM CROSSING.
 *
 * Three things were tried against Priestess Qerti'nya on the shadow fleet, 2026-09-18, with
 * the characters standing 17 to 39 squares away in a 49x50 temple with a colonnade down it:
 *
 *   * `sayApproachSquare` + `walk_to` — a point on the straight line between the two bodies.
 *     Moved NOTHING, six times out of six, and reported `out_of_earshot` at the same squared
 *     distance it started at. An accurate message that invites the wrong diagnosis.
 *   * the broker's `approach` tool, which is the right idea — it asks the room geometry for a
 *     walkable square beside the target and budgets by route length. It throws
 *     `s.world.approachSquare is not a function` on every keeper-backed character, because the
 *     broker holds a snapshot and the World is in the keeper. Same family as `act('fight')`.
 *   * `walk_to` straight at her, re-issued. Crossed fourteen rows on the second call and then
 *     WEDGED: `blocked_at r12c28`, `refused_edges 5`, identical reply four times running,
 *     eight squares short. Same inputs, same failure — the shape the wedge detector exists for.
 *
 * `crawl_to` is the one that works, and it is the only one of the four that asks the KEEPER
 * what it can actually step onto (`/movecheck`) instead of planning over a map and hoping. It
 * is slower and it is the difference between an errand that arrives and one that reports a
 * true sentence about a distance it never closed.
 *
 * `within: 3` rather than 5. The quest node wants SQUARED distance <= 25 and `crawl_to` stops
 * on CHEBYSHEV — and chebyshev 5 can be (5,5), which is squared 50. Three is squared 18 at
 * worst, comfortably inside, and still not standing on her.
 */
const NEAR_NPC = 3;

/** Where a named NPC is standing right now, or null with the names that WERE in the room. */
export function findNpc(view, name) {
  const want = String(name ?? '').toLowerCase();
  const objects = view?.objects ?? [];
  const hit = objects.find(o => String(o.name ?? '').toLowerCase().includes(want));
  return hit && hit.col != null && hit.row != null
    ? { col: hit.col, row: hit.row, name: hit.name }
    : { missing: true, saw: objects.map(o => o.name).filter(Boolean).slice(0, 12) };
}

/**
 * THE PROBE IS DIFFERENTIAL, AND THAT IS NOT BELT AND BRACES — IT IS THE ONLY WAY IT WORKS.
 *
 * `CanDoTeach` announces the gate with
 * `#string=vrTeach_quest_needed, #parm1=<ability name>` (monster.kod:4511), and on a Temples
 * teacher that string is `priestess_teach_quest_needed` (temples.kod:18), which has NO `%s`.
 * The server therefore writes a parameter the format never reads. `m59-parse.mjs` now tolerates
 * that — it did not until 2026-09-18, and every keeper running older code still does not, so
 * the sentence this errand most needs to hear is exactly the sentence most likely to go
 * missing.
 *
 * Measured that day against Priestess Qerti'nya: `bless` and `create food` answered, and
 * `night vision`, `discordance`, `killing fields` and `anti-magic aura` — every ability above
 * the gate — were silent. She was answering all six.
 *
 * So the errand does not rely on receiving the refusal. It asks TWICE:
 *
 *   * a CONTROL, something she sells below the gate. Any answer proves she heard, she teaches,
 *     and the reply path works.
 *   * the PROBE, a level-3 spell.
 *
 * Control silent  -> the instrument is broken; say so and change nothing.
 * Control answers, probe silent -> the gate, inferred from the difference.
 * Probe answers   -> read the verdict straight off the sentence, which also corroborates the
 *                    inference and is the reading a fixed client gets.
 *
 * This is the shape of "verify the value, not the instrument": the thing being measured is
 * whether she will TEACH, and a silence that has two possible causes is not a measurement
 * until the second cause has been ruled out by a control.
 */
async function askAbout({ agent, call }, priestess, spell) {
  let lines = [];
  const r = await sayToNpc(
    // `approach: false` — the crawl step before this one is what closes the distance, and it
    // does it properly. What `sayToNpc` still does, and must, is REFUSE when the distance was
    // not closed: speaking anyway produces the silence this whole file is about.
    { text: spell, to: priestess, radius: QUEST_NPC_RADIUS, approach: false },
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
  // ONLY THE LINES THAT NAME WHAT WE ASKED ABOUT.
  //
  // A teacher's reply is `Send(poOwner,@SomeoneSaid,...)` — a say to the ROOM, heard by
  // everyone standing in it. When five of our own characters are at the same priestess asking
  // her the same questions a second apart, each one's listening window is full of the others'
  // answers. Measured 2026-09-18: shadow01 and shadow06 both read `already_known` off a reply
  // to somebody ELSE's "create food", concluded they were already disciples, and skipped the
  // whole quest — reporting success, with `Cccc says, "disciple"` sitting in their transcripts.
  //
  // Every teacher sentence carries the ability's name through `%s`, so the filter is exact. The
  // two that do not — the disciple refusal and "you have learned so much already" — are the
  // ones this client historically never received anyway, which is why the verdict does not rest
  // on hearing them; see `probe`.
  const mine = lines.filter(l => l.toLowerCase().includes(String(spell).toLowerCase()));
  return { ...r, lines, heard: mine, verdict: readProbe(mine) };
}

/** Control then probe, and a verdict built from the DIFFERENCE between the two. */
async function probe(ctx, s) {
  const control = await askAbout(ctx, s.priestess, s.control);
  // A control that could not even be spoken is a positioning failure, and the probe after it
  // would be measuring the same thing twice.
  if (!control.ok) return { ok: false, outcome: control.outcome, why: control.why,
                            lines: control.lines, stage: 'control' };
  const p = await askAbout(ctx, s.priestess, s.probe);
  const lines = [...control.lines, ...p.lines];
  if (!p.ok) return { ok: false, outcome: p.outcome, why: p.why, lines, stage: 'probe' };

  // Heard directly: the sentence is the answer, whatever the control did.
  if (p.verdict) return { ok: true, lines, verdict: p.verdict, heard_directly: true,
                          control_answered: !!control.heard.length };

  // Not heard. Now the control decides what the silence means — and it is the control's OWN
  // answer that counts, not whatever else the room was saying.
  if (!control.heard.length) return { ok: false, lines, why:
    `${s.priestess} said nothing about "${s.control}" either, and that is a spell she sells ` +
    `below the gate — so this is not a reading of the gate, it is the probe failing. Check ` +
    `the distance, and check whether this keeper's client drops a message whose format takes ` +
    `fewer parameters than the server sent (see m59-parse.mjs doneFormatted)` };

  return { ok: true, lines, heard_directly: false, control_answered: true,
           verdict: { verdict: 'not_a_disciple', disciple: false,
                      line: `she answered "${s.control}" and was silent on "${s.probe}"` } };
}

// ---------------------------------------------------------------- what she asked for
//
// ONE RECOGNISER, AND AN ANSWER FOR THE SENTENCE IT DOES NOT KNOW.
//
// The quest engine can ask for a handful of shapes and it says which in one private line.
// `readAsk` turns that line into a `kind` plus the fields that kind needs, and the point of
// having it as a pure function is that the sentence can be replayed into it off a transcript
// long after the character has walked away.
//
// `kind: 'unknown'` IS A RESULT. A sentence nothing here recognises is written to the
// questbook with its raw text and `handled: false`, and `m59-questbook.mjs asks` lists those —
// each one is the specification for the handler it needs. Silently doing nothing would leave a
// character holding a deadline and a log saying the quest never started.
export const ASK_KINDS = ['kill', 'deliver', 'fetch', 'showup', 'unknown'];

export function readAsk(lines = [], { school = null, monsters = KRAANAN_MONSTERS } = {}) {
  const all = (Array.isArray(lines) ? lines : [lines]).join('   ');
  const raw = String(all).slice(0, 600);
  const s = school ? SCHOOLS[school] : null;

  // KILL — "You have two hours in which to kill a <monster>." Matched against the names the
  // priestess SPEAKS, which for RedAnt is "mutant ant" and contains no "red".
  const monster = Object.keys(monsters).find(n =>
    new RegExp(`kill (?:a|an) ${n}\\b`, 'i').test(all) || all.toLowerCase().includes(n));
  if (monster) return { kind: 'kill', handled: true, raw, monster, room: monsters[monster].room,
                        difficulty: monsters[monster].difficulty };

  // DELIVER — she names one of her own candidate NPCs and the sentence to repeat. The cargo is
  // fixed per school (questengine.kod:173-201), so only WHO varies.
  const dest = s?.destinations?.find(d => all.toLowerCase().includes(d.npc.toLowerCase()));
  if (dest) return { kind: 'deliver', handled: true, raw, npc: dest.npc, room: dest.room,
                     alt: dest.alt ?? null, where: dest.where, cargo: s.cargo };

  // FETCH — "Bring me <something>." The old library quest system's wording (questengine.kod:161)
  // and the shape every item-type node takes. No disciple quest has ever produced one here;
  // the handler exists so that the day one does, the run buys the thing instead of recording a
  // shrug. See QUEST_HANDLERS.fetch for what it is and is not allowed to do.
  const bring = /bring me (?:some |a |an |the )?([a-z' -]{3,40}?)\s*[.!]/i.exec(all);
  if (bring) return { kind: 'fetch', handled: true, raw, item: bring[1].trim() };

  // SHOWUP — nothing to carry and nothing to kill, just be somewhere. The final node of every
  // delivery quest is one of these and needs no leg of its own, so this is only reached when
  // it is the WHOLE ask.
  if (/return and tell me|come back|show your face|seek me/i.test(all))
    return { kind: 'showup', handled: true, raw };

  return { kind: 'unknown', handled: false, raw };
}

// ---------------------------------------------------------------- the prepared handlers
//
// EVERY HANDLER'S STEPS ARE IN THE PLAN, AND EXACTLY ONE OF THEM ACTIVATES.
//
// The alternative — build the plan after hearing the ask — is not available: `steps` is
// compiled once, before anything walks, which is what lets a bad plan be refused for free. So
// each handler contributes its legs unconditionally and gates every one on
// `state.ask.kind`. A handler that is not the one in play resolves its walk to the temple the
// body is already standing in, which `compiledWalk` returns early on, and its say and its
// purchase to nothing, which `optional` skips.
//
// The cost is a few no-op steps per run. What it buys is that the whole reachable set of
// rooms is declared up front — `trapCheck` and a reviewer both see it — and that adding a
// handler is adding a table entry rather than rewriting the plan.
const MERCHANTS = join(REPO_ROOT, 'substrate', 'm59-merchants.json');

/** Every room a merchant sells anything in — the declared reach of the fetch handler. */
function sellerRooms() {
  try {
    return [...new Set(JSON.parse(readFileSync(MERCHANTS, 'utf8')).merchants
      .filter(m => (m.sells ?? []).length).map(m => Number(m.room)))].filter(Number.isFinite);
  } catch { return []; }
}

/** Who sells something matching `item`, cheapest first. Null when nobody on the mainland does. */
export function findSeller(item, file = MERCHANTS) {
  const want = String(item ?? '').trim().toLowerCase();
  if (!want) return null;
  let all = [];
  try { all = JSON.parse(readFileSync(file, 'utf8')).merchants ?? []; } catch { return null; }
  const hits = [];
  for (const m of all) {
    for (const row of (m.sells ?? [])) {
      const name = String(row.name ?? row.cls ?? '').toLowerCase();
      if (!name.includes(want) && !want.includes(name)) continue;
      hits.push({ seller: m.name, room: Number(m.room), item: row.name ?? row.cls,
                  price: Number(row.price ?? row.cost ?? NaN) });
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => (Number.isFinite(a.price) ? a.price : 1e9) -
                      (Number.isFinite(b.price) ? b.price : 1e9));
  return hits[0];
}

export const QUEST_HANDLERS = Object.freeze({
  kill: {
    describe: 'kill one creature of an exact class, by this character\'s own hand, then return',
    rooms: (s, hunts) => Object.values(hunts).map(m => m.room),
  },
  deliver: {
    describe: 'repeat a fixed sentence, word for word, to one NPC she names',
    rooms: (s) => (s.destinations ?? []).flatMap(d => (d.alt ? [d.room, d.alt] : [d.room])),
  },
  fetch: {
    describe: 'buy or find one item and hand it over',
    rooms: () => sellerRooms(),
  },
  showup: {
    describe: 'be in the room — no leg of its own, the return walk already does it',
    rooms: () => [],
  },
  unknown: {
    describe: 'RECORDED, NOT ATTEMPTED — the sentence is written to the questbook for review',
    rooms: () => [],
  },
});

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
    // Which questbook the transcripts land in. Named rather than inferred because a rehearsal
    // on a shadow fleet and a real run on prod must not share a directory — the whole value of
    // the book is that "what has this fleet ever been asked for" has one answer.
    fleet: { default: null, describe: 'questbook to write into; defaults to the running fleet' },

    // THE HEALTH FLOOR IS THIS ERRAND'S TO SET, AND LEAVING IT UNSET MEANT 100%.
    //
    // `fleetScript` defaults `minHealth` to 1 — full health — which is the right default for a
    // script that does not think about it, because the alternative is walking a hurt body onto
    // the roads that kill this fleet. It is the wrong answer for a quest with a deadline:
    // measured on the shadow fleet 2026-09-18, shadow10 was refused its walk to the Temple of
    // Shal'ille at 94%, six percentage points of a 48-health body, and the run ended there.
    // "Rest first" is not available to a character that is already standing in a temple with
    // nothing hitting it — resting caps out where it caps out.
    //
    // 0.6 is the fleet's own flee line for a reason, and a body above it is a body the keeper
    // would keep in the field. A character below it should not be crossing a map at all, so
    // the refusal is still the right answer down there.
    minHealth: { type: 'number', default: 0.6,
                 describe: 'health fraction a character must have before it will set out. ' +
                           'The chassis default is 1 (full), which refuses a 94% body' },
    // The SAME argument one floor down, for the other guarantee that refuses a journey. A
    // 20-max-health caster is genuinely fragile on a road, and it is also exactly the character
    // most likely to be sent for a disciple quest, so this is stated rather than inherited.
    fragileBelow: { type: 'number', default: 25,
                    describe: 'maximum-health floor under which a journey is refused outright' },
    // How long a character will wait its turn at the priestess before giving up. See the gate
    // steps below: the whole cohort is queueing for one NPC, so this has to cover the worst
    // case of everybody ahead of it taking its full time.
    templeWaitMs: { type: 'number', default: 20 * 60_000,
                    describe: 'how long to queue for the priestess before failing the run' },
  },

  async steps({ school, home, huntRooms, rounds, abortBelow, templeWaitMs,
                fleet: fleetArg, agent }) {
    const fleet = fleetArg || fleetName();
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

    // EVERY ROOM ANY HANDLER COULD CHOOSE, declared once so `trapCheck` and a reviewer both see
    // the whole reachable set rather than a closure. Union across handlers rather than per-leg,
    // because a plan that carries every handler can walk to any of them.
    const errandRooms = [...new Set([
      ...Object.values(QUEST_HANDLERS).flatMap(h => h.rooms(s, hunts)),
      s.temple,
    ])].filter(Number.isFinite);

    /**
     * LOOK, THEN CRAWL. Two steps, emitted before every place this errand has to speak.
     *
     * `who(state)` names the NPC to get near; returning null means "nothing to approach here",
     * and the crawl then resolves to the body's own square, which `crawl_to` answers `arrived`
     * for without moving. `optional` covers the NPC simply not being in the room — that is a
     * fact the say step reports far better than a walker can.
     *
     * AND `optional` COVERS THE COHORT BLOCKING ITSELF, WHICH IS THE COMMON CASE.
     *
     * Six characters sent to one priestess arrive through one door and stand in it. Measured on
     * the shadow fleet 2026-09-18 at the Temple of Shal'ille: five of six had both rungs refused
     * at r8c31/r9c31 with `blocked by a BODY, not by the ground` — `crawl_to` telling the truth
     * and distinguishing it from terrain, which is exactly what it is for. Every one of them
     * then probed, said `disciple` and read its ask anyway, because piling through the same
     * entrance had already put them within five squares.
     *
     * So this leg worked by a coincidence of the geography, and it is worth saying so: had the
     * priestess stood further from her door, the crowd would have blocked the approach and the
     * probe would have failed with the cohort standing in a heap. The fix if that ever bites is
     * to stagger the cohort, not to make the walker push through bodies — a body is not a wall
     * and the client SLIDES around one, so a walker that treats it as terrain learns a bad route.
     */
    const closeOn = (who, label) => [
      verify(async ({ agent: me, call, state }) => {
        const want = who(state);
        state.near = null;
        if (!want) return { ok: true, skipped: `nothing to approach for ${label}` };
        const view = await call('look', { agent: me }, 30_000).catch(() => null);
        const at = findNpc(view, want);
        if (at.missing) return { ok: true, absent: want, saw: at.saw, note:
          `${want} is not in room ${view?.room?.num ?? '?'} — the say step will report that ` +
          `properly; there is nothing to crawl towards` };
        // THE SQUARE BELONGS TO THE ROOM IT WAS SEEN IN, AND THE BODY CAN LEAVE BETWEEN THE
        // LOOK AND THE WALK.
        //
        // Measured 2026-09-18: shadow07 looked in room 952, found Duke Akardius at r11c20, and
        // was then in room 951 by the time the crawl ran — which spent its whole deadline
        // walking toward a square in a room it had left, and reported `ran out of time 9
        // square(s) from r11c20`. A true sentence about a coordinate that had stopped meaning
        // anything. This is `start_has_no_floor` wearing different clothes: a position and a
        // geometry from DIFFERENT ROOMS, which CLAUDE.md records as 1,535 of 2,361 hop failures
        // in one window.
        state.near = { ...at, room: Number(view?.room?.num ?? NaN) };
        return { ok: true, approaching: want, at: `r${at.row}c${at.col}`, room: state.near.room };
      }, `could not look for the ${label}`),

      // A LADDER, NOT A CHOICE. `walk_to` plans over the map and covers ground fast — measured
      // fourteen rows in one call in the Temple of Kraanan — and then WEDGES, returning the
      // identical reply however often it is re-issued. `crawl_to` asks the keeper what it can
      // step onto and never wedges, and it moves about one square every eight seconds, which
      // across thirty-three squares of temple is most of a deadline spent on a walk.
      //
      // So: the fast one first for the distance, the careful one after for the last few squares
      // it could not manage. `crawl_to` returns `arrived` on its first check when the walk
      // already got there, so the second rung is free whenever the first one worked.
      // `room` NAMED ON BOTH RUNGS, and resolved from the same state the coordinates are.
      // Both steps already honour `step.room ?? start.room` and answer `left_the_room`; what
      // they could not do is know which room the SQUARE came from. Now they do, so a body that
      // has left is refused at once instead of spending its budget walking to a coordinate
      // that belongs somewhere else.
      { ...walkTo(st => st.near?.col ?? null, st => st.near?.row ?? null,
                  { within: NEAR_NPC, deadlineMs: 120_000, stallMs: 25_000 }),
        room: st => st.near?.room ?? null, optional: true },
      crawlTo(st => st.near?.col ?? null, st => st.near?.row ?? null,
              { within: NEAR_NPC, optional: true, maxSteps: 60, deadlineMs: 180_000,
                room: st => st.near?.room ?? null }),
    ];

    const killSteps = [
          // WHERE THE ASSIGNED MONSTER LIVES — or nowhere, which is the temple we are already
          // standing in and therefore a no-op walk (compiledWalk returns early when the body is
          // already in the room).
          walk(st => (st.ask?.kind === 'kill' && hunts[st.ask.monster]?.room) || s.temple,
               { candidates: errandRooms }),

          // ONE KILL, BY THIS CHARACTER, OF EXACTLY THAT CLASS.
          //
          // `rounds` is a budget for the whole fight rather than for one exchange — the keeper
          // spends it in bursts and re-reads the quarry between them, which is what makes a
          // step list able to kill something at all. `optional` covers the case where nothing
          // was assigned: the resolved target is then null and the step refuses rather than
          // letting the keeper swing at whatever is nearest.
          fight(st => (st.ask?.kind === 'kill' ? st.ask.monster : null) ?? null,
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
            const want = state.ask?.kind === 'kill' ? state.ask.monster : null;
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
        ];

    const deliverSteps = [
          // WHERE SHE SENT US. Never guessed: the destination is whichever of her candidates
          // her own sentence named, and anything else walks to the temple we are standing in,
          // which is a no-op.
          walk(st => (st.ask?.kind === 'deliver' ? st.ask.room : null) ?? s.temple,
               { candidates: errandRooms }),

          ...closeOn(st => (st.ask?.kind === 'deliver' ? st.ask.npc : null), 'destination'),

          // THE SENTENCE, VERBATIM. `optional` because a run with no delivery has nobody to say
          // it to and `sayToNpc` refuses a say with no addressee rather than broadcasting it to
          // a town.
          say(st => (st.ask?.kind === 'deliver' ? st.ask.cargo : '') || '',
              { to: st => (st.ask?.kind === 'deliver' ? st.ask.npc : null) ?? null,
                radius: QUEST_NPC_RADIUS, listenMs: 6000, optional: true }),

          // DID IT LAND? The destination answers with a rebuff that is the success message,
          // and that sentence is the only difference between "delivered" and "stood next to
          // the right person and said nothing that registered". Recorded rather than acted on
          // — a false negative here costs one extra town, and a false positive would cost the
          // whole quest.
          verify(async ({ agent: who, call, state }) => {
            if (state.ask?.kind !== 'deliver') return { ok: true, skipped: 'nothing to deliver' };
            const { lines, cursor } = await proseSince(call, who, state.cursor ?? 0, 3000);
            state.cursor = cursor;
            (state.heard ??= []).push(...lines);
            state.delivered = lines.some(l => s.invoke.test(l));
            return { ok: true, delivered: state.delivered,
                     ...(state.delivered ? {} : { note:
                       `${state.ask.npc} did not answer the way the quest engine makes a ` +
                       `destination answer. That is not proof of failure — the line can be ` +
                       `missed — but it is the reason for the second attempt below` }) };
          }, 'could not tell whether the message was delivered'),

          // THE SECOND ADDRESS, FOR THE ONE NPC WHO EXISTS TWICE. Walked only when the first
          // delivery was not heard to land and this destination has a twin; otherwise this
          // resolves to the temple, which is where the next step goes anyway.
          walk(st => (st.ask?.kind === 'deliver' && !st.delivered && st.ask.alt) || s.temple,
               { candidates: errandRooms }),
          ...closeOn(st => (st.ask?.kind === 'deliver' && !st.delivered && st.ask.alt
                            ? st.ask.npc : null), 'twin destination'),
          say(st => (st.ask?.kind === 'deliver' && !st.delivered && st.ask.alt ? st.ask.cargo : ''),
              { to: st => (st.ask?.kind === 'deliver' ? st.ask.npc : null) ?? null,
                radius: QUEST_NPC_RADIUS, listenMs: 6000, optional: true }),
        ];

    // THE FETCH HANDLER — PREPARED, AND HONEST ABOUT NEVER HAVING FIRED.
    //
    // No disciple quest has asked for an item in anything measured here; the quest engine's
    // item nodes exist (`QN_TYPE_ITEM`, `QN_TYPE_ITEMCLASS`, and the old library wording "Bring
    // me %CARGO") and the operator asked that every possibility run to a prepared errand rather
    // than to a shrug. So this is real code on a path that is, so far, theoretical — which is
    // exactly the kind of code that rots silently, so `m59-questbook.mjs asks` reports whether
    // a `fetch` has ever been seen and the transcript records it when one is.
    //
    // WHAT IT WILL NOT DO. It will not farm for an item nobody sells — a fetch whose item has
    // no seller is recorded as unfulfillable rather than turned into an open-ended hunt, because
    // an errand that cannot finish the thing that opened it runs for ever and every lap reports
    // success. It buys ONE, from the cheapest mainland seller, and hands it over.
    const fetchSteps = [
      verify(async ({ state }) => {
        if (state.ask?.kind !== 'fetch') return { ok: true, skipped: 'nothing to fetch' };
        const found = findSeller(state.ask.item);
        state.ask.seller = found?.seller ?? null;
        state.ask.shopRoom = found?.room ?? null;
        state.ask.price = found?.price ?? null;
        if (!found) return { ok: false, why:
          `she asked for "${state.ask.item}" and no merchant in ` +
          `substrate/m59-merchants.json sells anything by that name. This errand does not ` +
          `farm for a quest item — say so and let the deadline lapse rather than starting a ` +
          `hunt that cannot end` };
        return { ok: true, seller: found.seller, room: found.room, price: found.price };
      }, 'could not find anywhere to buy the item she asked for'),

      walk(st => (st.ask?.kind === 'fetch' ? st.ask.shopRoom : null) ?? s.temple,
           { candidates: errandRooms }),

      // ONE, not a stack: the node wants an item, and buying more is money spent on nothing.
      shop(st => (st.ask?.kind === 'fetch' ? st.ask.seller : null) ?? null,
           st => (st.ask?.kind === 'fetch' && st.ask.item
             ? [{ match: new RegExp(String(st.ask.item).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
                  amount: 1 }]
             : []),
           { optional: true }),
    ];

    const middle = [...killSteps, ...deliverSteps, ...fetchSteps];


    // ONE TRANSCRIPT PER RUN, REWRITTEN IN PLACE. The id is fixed on the first write so the
    // second one lands on the same file rather than leaving two halves of one run on disk.
    const startedAt = Date.now();
    const writeTranscript = (state, outcome, extra = {}) => {
      state.runId ??= runId({ agent: state.agent, quest: `disciple-${key}`, at: startedAt });
      try {
        return saveRun({
          id: state.runId, at: new Date(startedAt).toISOString(), fleet,
          agent: state.agent, quest: `disciple-${key}`, school: key,
          priestess: s.priestess, temple: s.temple, probe_spell: s.probe, deadline: s.deadline,
          probe_before: state.probe_before ?? null,
          probe_after: state.probe_after ?? null,
          ask: state.ask ?? null,
          delivered: state.delivered ?? null,
          // EVERY LINE THE WORLD SAID, in order. This is the part a later reader needs and the
          // part nothing else keeps: server prose is not chat, so it is in no transcript the
          // broker holds either.
          heard: (state.heard ?? []).slice(-60),
          steps: Object.entries(state.results ?? {}).map(([at, r]) => ({
            at, ok: r?.ok ?? null, outcome: r?.outcome ?? null,
            why: r?.why ? String(r.why).slice(0, 300) : undefined })),
          outcome, ...extra,
        }, { fleet });
      } catch (e) {
        // A transcript that cannot be written must not take the errand down with it.
        return `UNWRITTEN (${e.message})`;
      }
    };

    // THE PRIESTESS IS THE SCARCE RESOURCE, AND SHE ONLY FITS ONE.
    //
    // Five of six Shal'ille runs failed on 2026-09-18 without the quest ever being the problem.
    // A temple is entered by a kod trigger, so every character lands on the SAME square — all
    // six arrived on r10c21 in room 48 — and the approach then has to cross the room to within
    // three squares of her. What the log shows is not a crowd, it is a DEADLOCK: shadow07
    // `a body blocks W, N`, shadow08 `a body blocks W, N, S`, each one the other's blocker,
    // eight waits each, fifty seconds each, both giving up eleven squares out.
    //
    // `parallel: false` would fix it and would also serialize two cross-country legs and a
    // monster fight — a six-minute errand becomes forty. So only the part that needs the room
    // to itself is gated: everyone travels at once, and then they take turns with her.
    //
    // The crawl's own fix is the other half and they are not redundant. Going AROUND a body
    // after two waits is what gets one character past the five standing on the landing square;
    // the gate is what stops those five from trying to move at the same time, which is the
    // case no amount of going around resolves because every detour is into somebody else.
    const templeGate = `temple:${s.temple}`;
    // A PARAMETER DEFAULT IS APPLIED BY `runNamed`, AND `steps()` IS ALSO CALLED DIRECTLY —
    // by the offline test, by `--dry`, and by anything that wants to read the plan without
    // running it. `Number(undefined)` is NaN, and a NaN timeout is an UNBOUNDED wait: the
    // whole cohort would queue behind the first character for ever. So the floor is restated
    // here rather than trusted to the caller.
    const templeWait = Number(templeWaitMs) > 0 ? Number(templeWaitMs) : 20 * 60_000;

    return [
      walk(s.temple),

      // WAIT MY TURN. Held from here to the moment she has been asked, and released even if the
      // run falls over in between — the runner's own `finally` does that, which is the whole
      // reason this is a step and not a lock taken inside `closeOn`.
      gate(templeGate, { timeoutMs: templeWait }),
      ...closeOn(() => s.priestess, 'priestess'),

      // ASK BEFORE STARTING ANYTHING. A character who is already a disciple must not be sent
      // round the world again, and — more sharply — must not have `disciple` said on its
      // behalf, because a second quest instance can be joined and then abandoned, which costs
      // an hour of logged-in time for nothing.
      verify(async (ctx) => {
        const p = await probe(ctx, s);
        ctx.state.probe_before = p.verdict?.verdict ?? null;
        ctx.state.disciple = p.verdict?.disciple ?? null;
        // MARK THE TAPE HERE. The assign hint is one line among whatever else the world is
        // saying, and `wait_for_event` without a `since` continues from wherever this agent
        // last read — which, mid-errand, is nowhere in particular. A cursor taken now, after
        // the probe has drained its own answer and before `disciple` is said, makes the next
        // read a window over exactly this exchange.
        ctx.state.cursor = await cursorNow(ctx.call, ctx.agent);
        if (!p.ok) return { ok: false, outcome: p.outcome, why: p.why };
        // Belt and braces: `probe` only returns ok with a verdict, so this is unreachable
        // unless that contract changes — and the thing it would otherwise produce is a run
        // that reasons from `disciple: null` as though it were `false`.
        if (!p.verdict) return { ok: false, heard: p.lines.slice(0, 4), why:
          `no verdict came back about "${s.probe}" even though the probe reported ok` };
        return { ok: true, verdict: p.verdict.verdict, disciple: p.verdict.disciple,
                 heard_directly: p.heard_directly, evidence: p.verdict.line };
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
        (state.heard ??= []).push(...heard);
        state.ask = readAsk(heard, { school: key, monsters: hunts });

        // WRITE IT DOWN BEFORE ACTING ON IT. This is the write that matters: a character that
        // then dies in the Badlands still leaves behind the sentence it was answering, and the
        // step loop BREAKS on an unrecovered death, which skips even the `always` steps.
        state.transcript = writeTranscript(state, 'in_progress');

        if (state.ask.kind === 'unknown') return { ok: false, ask: state.ask, why:
          `${s.priestess} asked for something with no prepared handler. It is written to ` +
          `${state.transcript} — read it with \`m59-questbook.mjs show\` and add an entry to ` +
          `QUEST_HANDLERS. Recording it beats the alternative, which is a character holding a ` +
          `deadline while the log says the quest never started` };

        if (state.ask.kind === 'kill')
          return { ok: true, ask: 'kill', monster: state.ask.monster, room: state.ask.room,
                   ...(state.ask.difficulty >= 8
                     ? { warning: `a ${state.ask.monster} is viDifficulty ` +
                                  `${state.ask.difficulty} — if this character cannot take that ` +
                                  `fight, stop now and let the ${s.deadline} lapse rather than ` +
                                  `walking it into one` }
                     : {}) };
        if (state.ask.kind === 'deliver')
          return { ok: true, ask: 'deliver', to: state.ask.npc, room: state.ask.room,
                   where: state.ask.where, ...(state.ask.alt ? { alt_room: state.ask.alt } : {}) };
        return { ok: true, ask: state.ask.kind };
      }, 'could not read what the priestess asked for'),

      // LET THE NEXT ONE IN. The quest legs below go anywhere in the world and take minutes;
      // holding the priestess through a monster fight would queue the whole cohort behind one
      // character's errand.
      ungate(templeGate),

      ...middle,

      // BACK TO HER. Walking in is enough on its own — `SomethingEntered` calls
      // `CheckCompletionCriteria` too (monster.kod:915-928) — but the body may never have left
      // the room, so the say below is the one that has to work.
      walk(s.temple),

      // AND QUEUE AGAIN FOR THE RETURN, WHICH IS THE VISIT THAT DECIDES THE QUEST. The closing
      // word has to be spoken within five squares of her (Q_NPC_CLOSE_ENOUGH), so this is the
      // approach that cannot be allowed to fail — shadow08 delivered its message, walked back,
      // could not get through the crowd, and finished the run still not a disciple.
      gate(templeGate, { timeoutMs: templeWait }),
      ...closeOn(() => s.priestess, 'priestess again'),

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
        const p = await probe(ctx, s);
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

      // AND LET GO, WHATEVER HAPPENED. `always` rather than a plain step because the verdict
      // above is the step most likely to fail, and a gate held by a character walking home is
      // the rest of the cohort waiting out its full timeout for nothing. The runner's `finally`
      // would catch it too; this releases it a leg earlier, before the walk home.
      { ...ungate(templeGate), always: true },

      // ALWAYS. A quest that failed still has to bring the character back; the roads this
      // errand uses are where four of one night's deaths started.
      ...(home === undefined || home === null ? [] : [{ ...walk(Number(home)), always: true }]),

      // AND ALWAYS WRITE THE RUN DOWN, including — especially — when it failed. `always` means
      // this one still runs while the plan is unwinding, so the file that a reviewer reads is
      // the file of the run that went wrong. The only case it misses is a death with no
      // recovery, which breaks the loop outright; the in-progress write above covers that.
      {
        ...verify(async ({ state }) => {
          const failed = Object.values(state.results ?? {}).find(r => r && r.ok === false);
          const outcome = state.probe_after && state.probe_after !== 'not_a_disciple' ? 'ok'
                        : failed ? 'failed' : 'unfinished';
          const path = writeTranscript(state, outcome,
            failed?.why ? { why: String(failed.why).slice(0, 400) } : {});
          return { ok: true, transcript: path, outcome };
        }, 'could not write the run transcript'),
        always: true,
      },
    ];
  },
};
