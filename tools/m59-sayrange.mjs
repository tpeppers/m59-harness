// CAN THIS NPC ACTUALLY HEAR YOU? — the one rule, in one place.
//
// Speech to a monster is RANGE-LIMITED and the limit is invisible from our side.
// `Holder.SomeoneSaid` (holder.kod:585) does not broadcast to a monster unconditionally: it
// gates every hearer on `SayRangeCheck` (holder.kod:604), which DROPS a user's speech to a
// monster that is not `IsFullTalk` when `SquaredDistanceTo > SAY_RADIUS`. SAY_RADIUS is 50
// (blakston.khd:1299) and is compared against a SQUARED distance, so the real reach is about
// seven squares — not fifty.
//
// NOTHING IS SENT BACK WHEN IT IS DROPPED. No refusal, no error, no "he did not hear you".
// From this side an unheard question is byte-for-byte identical to an NPC that has no answer,
// which is the shape of every expensive failure in this game.
//
// WHAT IT COST. The guild rent balance was never once read on this fleet: `credit_after` is
// null on all eleven tithes in the book from 2026-08-12 onward, and a guildmaster standing in
// room 700 said "rent" twice that day and got only his own echo. It was written down as
// UNVERIFIED and reasoned from for a month. Measured again 2026-09-11 on a guild that HAD a
// hall and a large credit, where a real answer was owed: Gonzo asked from col 5 row 17 with
// Frular at col 7 row 5 — squared 148 against a limit of 50 — and heard nothing, because
// nothing was ever sent.
//
// AND THE NEIGHBOURING VERB IS NOT LIMITED, which is what hid it. An offer is a TRADE, not
// speech, and `ReqOffer` checks only that both are in the same room (gcreator.kod:331). So
// paying Frular works from across the hall while asking him a question does not: the money
// moves, the question evaporates, and the record shows a successful payment with an unknown
// balance. Every single time.
//
// Frular himself is `MOB_NOMOVE | MOB_NOFIGHT | MOB_LISTEN | MOB_RECEIVE` (gcreator.kod:74)
// — MOB_LISTEN means he is willing to hear, and it is NOT MOB_FULL_TALK, which is the one
// that would make him hear from any distance. Those two are easy to confuse and only one of
// them is about range.

// blakston.khd:1299. Compared against a SQUARED distance, so the reach is sqrt(50) ~= 7.07.
export const SAY_RADIUS = 50;

// AND BEING HEARD IS NOT THE ONLY REACH THERE IS. A quest node judges the same speech against
// its OWN distance — `SquaredDistanceTo > Q_NPC_CLOSE_ENOUGH * Q_NPC_CLOSE_ENOUGH`
// (questnode.kod:650-653), `Q_NPC_CLOSE_ENOUGH = 5` (blakston.khd:2779) — which is 25 against
// speech's 50. So there is a band, roughly five to seven squares out, where the NPC HEARS the
// word and the quest node discards it. Both silences look the same from here, and the second
// one is the expensive kind: it reads as "she has no quest for me" when the answer is "stand
// two squares closer".
export const QUEST_NPC_RADIUS = 25;

// Squared distance in SQUARES, which is the space SayRangeCheck works in. Null when either
// position is unknown — never 0, because a missing coordinate is not the origin.
export const squaredDistance = (a, b) =>
  (a == null || b == null || a.col == null || b.col == null ||
   a.row == null || b.row == null) ? null
    : (a.col - b.col) ** 2 + (a.row - b.row) ** 2;

// TRUE heard, FALSE dropped, NULL unknown — and unknown must never be treated as heard.
// A caller that reads "I could not measure" as "close enough" says the word, hears nothing,
// and files that silence as a fact about the world. That is the whole bug, one level up.
export function withinSayRange(speaker, hearer, radius = SAY_RADIUS) {
  const d2 = squaredDistance(speaker, hearer);
  return d2 === null ? null : d2 <= radius;
}

// WHERE TO STAND TO BE HEARD, aimed along the line between the two rather than at the NPC's
// own square — walking ONTO a monster is not a thing, and asking for its square is how a
// walker ends up shuffling against it until a stall detector fires.
//
// `leave` is how many squares short of the NPC to stop, defaulting to 2, which is inside
// melee reach and comfortably inside earshot. Returns null when there is nothing to compute
// from, and the speaker's own square when it is already close enough.
//
// `radius` IS THE CALLER'S, AND IT USED TO BE IGNORED. This read `d2 <= SAY_RADIUS` while its
// only caller was already passing `step.radius` to `withinSayRange` — so a caller asking for
// the quest node's tighter 25 got the approach decided at 50, answered `already: true` from
// six squares out, and then failed `out_of_earshot` on the very check that had just sent it
// there. The two halves of one decision were reading two different numbers.
export function sayApproachSquare(speaker, hearer, { leave = 2, radius = SAY_RADIUS } = {}) {
  const d2 = squaredDistance(speaker, hearer);
  if (d2 === null) return null;
  if (d2 <= radius) return { col: speaker.col, row: speaker.row, already: true };
  const dist = Math.sqrt(d2);
  const keep = Math.min(Math.max(leave, 0), Math.max(dist - 1, 0));
  const t = (dist - keep) / dist;
  return { col: Math.round(speaker.col + (hearer.col - speaker.col) * t),
           row: Math.round(speaker.row + (hearer.row - speaker.row) * t),
           already: false };
}

// FleetScript's NPC-speaking method. Keep the approach, fresh position check and
// speech in one operation so keeper errands can use it without starting a second
// FleetScript driver or making an RPC back into their own broker. The adapters
// provide transport only; neither caller gets to skip the hearing check.
// THIS APPROACH IS FOR THE LAST FEW SQUARES, AND IT IS NOT A ROUTER. SAY SO.
//
// `sayApproachSquare` returns a point on the line between the two bodies. That is right for a
// couple of squares of final adjustment and hopeless across a room: the Temple of Kraanan is
// 49x50 with a colonnade down the middle, and on the shadow fleet 2026-09-18 six characters
// arrived 17 to 39 squares from Priestess Qerti'nya, every one of them aimed at a straight-line
// point, every one of them moved nothing, and every one reported `out_of_earshot` at the SAME
// squared distance it had started at. The message was accurate; the diagnosis it invites —
// "she is too far away" — was wrong. She was reachable. The aim was not a route.
//
// TWO THINGS WERE TRIED INSTEAD AND ONE OF THEM IS A TRAP.
//
//   * The broker's `approach` tool is the right idea — it asks the room geometry for a walkable
//     square beside the target and budgets by ROUTE length. It throws
//     `s.world.approachSquare is not a function` on every keeper-backed character, because the
//     broker holds a snapshot and the World lives in the keeper. That is every character on
//     every fleet. Wiring it in here made this step WORSE, not better, and the offline suite
//     caught it within the hour: `a say aimed at an NPC out of earshot WALKS into range first`
//     went red. Do not re-add it.
//   * `crawl_to`, which asks the keeper what it can step onto, does work — but it is a STEP,
//     one square every eight seconds, and it belongs in the plan rather than inside a say.
//
// So a caller that needs to cross a room puts a walk in its plan before the say, and this stays
// what it has always been: the last two squares, and an honest refusal when that is not enough.
// `tools/fleetscripts/disciple-quest.mjs` has the ladder — look, `walk_to`, then `crawl_to`.
export async function sayToNpc(step, { look, walkTo, speak, log = () => {} }) {
  const text = String(step.text ?? '').trim();
  if (!text) return { ok: false, why: 'say needs something to say' };
  const wantHeard = step.to ?? null, radius = step.radius ?? SAY_RADIUS;
  const seen = async () => {
    const view = await look();
    return { me: view?.you ?? null, npc: wantHeard
      ? (view?.objects ?? []).find(o =>
          String(o.name ?? '').toLowerCase().includes(String(wantHeard).toLowerCase()))
      : null };
  };
  const absent = approached => ({ ok: false, outcome: 'not_here', approached,
    why: `${wantHeard} is not in this room, so nothing said here can reach them` });
  let { me, npc } = await seen();
  if (wantHeard && !npc) return absent(null);

  let approached = null;
  if (npc && withinSayRange(me, npc, radius) === false && step.approach !== false) {
    log(`say "${text}": ${wantHeard} is out of reach ` +
        `(squared ${squaredDistance(me, npc)} > ${radius}) — closing the last squares`);
    const target = sayApproachSquare(me, npc, { leave: step.leave ?? 2, radius });
    if (target && !target.already)
      approached = await walkTo(target, { arriveWithin: step.arriveWithin ?? 3,
        timeoutMs: step.timeoutMs ?? 120_000 }).catch(error => ({ error: error.message }));
    ({ me, npc } = await seen());
    if (wantHeard && !npc) return absent(approached);
  }

  // A completed walk is not proof of arrival. Read back the actual positions.
  const heard = npc ? withinSayRange(me, npc, radius) : true;
  const d2 = npc ? squaredDistance(me, npc) : null;
  if (heard === false)
    return { ok: false, outcome: 'out_of_earshot', squared_distance: d2, radius, approached,
      why: `still ${d2} squared from ${wantHeard}, past the ${radius} this step asked for` +
           (radius === SAY_RADIUS
             ? ` (SAY_RADIUS) — SayRangeCheck (holder.kod:604) DISCARDS this speech and sends ` +
               `nothing back, so speaking anyway would look exactly like an NPC with no answer`
             : ` (SAY_RADIUS is ${SAY_RADIUS}, so ${wantHeard} may well HEAR this — it is the ` +
               `tighter reach this step needs that is not met, and whatever is listening at ` +
               `that reach would discard it silently)`) };
  if (heard === null)
    return { ok: false, outcome: 'position_unknown', approached,
      why: `cannot read both positions, so cannot tell whether ${wantHeard} would ` +
           `hear this. Unknown is not close enough` };

  const result = await speak(text), replies = result.replies ?? [];
  return { ok: true, outcome: replies.length ? 'answered' : 'no_reply',
    said: text, to: wantHeard, squared_distance: d2, approached,
    ...result, replies,
    ...(replies.length ? {} : { note:
      `in earshot (squared ${d2} <= ${radius}) and nothing came back — THIS one is ` +
      `a fact about ${wantHeard ?? 'the room'}, not about the distance` }) };
}
