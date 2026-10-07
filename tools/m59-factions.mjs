// FACTION JOINING, AS DATA RATHER THAN PROSE.
//
// The three join quests are built in questengine.kod. Keeping the exact leaders,
// destinations, and possible assignments here lets the broker expose one narrow
// mechanical operation without giving an unattended caller general speech or NPC-offer
// authority.

export const FACTION_JOIN = Object.freeze({
  duke: Object.freeze({
    id: 'duke', title: 'The Duke', leader: 'Duke Akardius', room: 952,
    assignments: Object.freeze([
      { item: 'sapphire', target: 'Duke Akardius', room: 952 },
      { item: 'ruby', target: 'Duke Akardius', room: 952 },
      { item: 'emerald', target: 'Duke Akardius', room: 952 },
      { item: 'diamond', target: 'Duke Akardius', room: 952 },
    ]),
  }),
  princess: Object.freeze({
    id: 'princess', title: 'The Princess', leader: 'Princess Kateriina', room: 852,
    assignments: Object.freeze([
      { item: 'letter', target: 'Priestess Xiana', aliases: ['Xiana'], room: 48 },
      { item: 'letter', target: 'Lady Aftyn', room: 205 },
      { item: 'letter', target: 'Herbutte', room: 109 },
    ]),
  }),
  rebel: Object.freeze({
    id: 'rebel', title: 'The Rebels', leader: "Jonas D'Accor", room: 371,
    assignments: Object.freeze([
      { item: 'plate armor', target: "Jonas D'Accor", room: 371 },
      // `SimpleHelm` SPEAKS AS "helm" (simphelm.kod:19), and Jonas names the cargo by its
      // spoken name, so "simple helm" here never matched his sentence or the pack.
      { item: 'helm', target: "Jonas D'Accor", room: 371 },
      { item: "knight's shield", target: "Jonas D'Accor", room: 371 },
      { item: 'gauntlets', target: "Jonas D'Accor", room: 371 },
      { item: 'mystic sword', target: "Jonas D'Accor", room: 371 },
      { item: 'scimitar', target: "Jonas D'Accor", room: 371 },
    ]),
  }),
});

// Soldier promotion is a two-kill quest, with a fresh three-hour clock on each
// target. Troops are generated around faction flags; these are the three default
// flag rooms for each opposing army in the stock server data.
export const FACTION_SOLDIER = Object.freeze({
  duke: Object.freeze({ shield: "shield of the Duke's army",
    stages: Object.freeze([
      Object.freeze({ target: 'rebel soldier', rooms: Object.freeze([568, 557, 547]) }),
      Object.freeze({ target: "soldier of the Princess' army", rooms: Object.freeze([593, 583, 603]) }),
    ]) }),
  princess: Object.freeze({ shield: "shield of the Princess' army",
    stages: Object.freeze([
      Object.freeze({ target: "soldier of the Duke's army", rooms: Object.freeze([586, 596, 585]) }),
      Object.freeze({ target: 'rebel soldier', rooms: Object.freeze([568, 557, 547]) }),
    ]) }),
  rebel: Object.freeze({ shield: 'shield of the rebel militia',
    stages: Object.freeze([
      Object.freeze({ target: "soldier of the Princess' army", rooms: Object.freeze([593, 583, 603]) }),
      Object.freeze({ target: "soldier of the Duke's army", rooms: Object.freeze([586, 596, 585]) }),
    ]) }),
});

// THE DEFAULT ROOMS ABOVE ARE A GUESS ABOUT WHO HOLDS WHICH FLAG, AND THE GUESS AGES.
//
// Troops spawn only at a flagpole their faction currently holds (flag.kod GenerateTroops),
// and holdings change hands in the territory game. These are every non-town flag room
// `TerritoryGame.Recreate` builds (territry.kod plFlagRIDs, RID_* from blakston.khd); the
// five town flags (RID_TOS, RID_MARION, RID_JASWEST, RID_CORNOTH, RID_BAR_NORTH) never
// spawn troops and are left out. A soldier hunt that finds nobody at the defaults widens
// to these, nearest first.
export const WILDERNESS_FLAG_ROOMS = Object.freeze([
  552, 562, 563, 583, 593, 603, 534, 544, 554, 564, 574, 584, 535, 545, 575, 585,
  526, 536, 546, 556, 566, 576, 586, 596, 537, 547, 557, 567, 587, 597, 568,
]);

// STAYING IN A FACTION IS A SUBSCRIPTION, AND THE NOTICE THAT IT HAS LAPSED IS PROSE ON
// A TWENTY-MINUTE REPEAT WITH FOUR HOURS BEHIND IT.
//
// `FactionServiceTimer` (player.kod:11238) re-arms every FACTION_UPDATE_TIME (20 min),
// accumulates unserved WALL-CLOCK time — it advances while the character is logged out —
// and crosses two thresholds: FACTION_WARN_TIME (72000s, 20h) sends `player_faction_time`
// — "Your liege is no longer convinced of your loyalty. You should visit your liege at
// court again." — and FACTION_RESIGN_TIME (86400s, 24h) calls `ResignFaction` outright.
// The difference is 14400 seconds. **Four hours after the first of those sentences,
// membership is gone**, and the expulsion announces itself only after the fact
// (`player_unfactioned`, player.kod:167).
//
// Four things about it that decide the whole design:
//
//   - THERE IS NO PACKET AND NO POLL. It is `MsgSendUser` prose, exactly like a bank
//     balance, so it is caught off the event stream on its way past and written down or
//     it is lost. It does REPEAT every twenty minutes until the deadline, which is the
//     one merciful thing here — a broker that was down for the first one still hears the
//     next. That is also why a repeat must not restart the clock: every one of those
//     sentences is about the same deadline, and re-dating on each would push the due time
//     forward for ever and the character would be expelled while the record said it had
//     three hours left.
//   - THE WARNING IS WHAT CREATES THE QUEST. Service quests declare
//     `QT_SCHEDULE_CHANCE = 0` (questengine.kod:1657, 1665, 2260), so the ordinary quest
//     timer NEVER creates one. Only `JoinFaction`, the completion of a previous service,
//     and the warning branch itself (player.kod:11274-11302, `#override=TRUE`) do. So
//     saying "loyalty" to a liege that has not warned you does nothing at all, silently —
//     and conversely the warning is a reliable signal that a quest is genuinely waiting.
//   - THE SERVICE QUEST'S LAST NODE IS TIMED AND ITS PENALTY IS EXPULSION. Every
//     faction's carries `#penaltylist = [[ QN_PRIZETYPE_FACTION,
//     QN_PRIZE_FACTION_NEUTRAL ]]` (questengine.kod:2521, 2551, 5697). So **starting the
//     quest and failing it is strictly worse than not starting it**: the four-hour grace
//     becomes one hour for the rebels and the princess, and half an hour for the duke.
//     That is why `request` insists the payload is already in the pack before the word is
//     spoken, rather than saying "loyalty" and then going shopping. Arriving one second
//     late awards the penalty, not the prize (questnode.kod:846).
//   - A SOLDIER IS WARNED FOR EVER AND NEVER EXPELLED. While a `SoldierShield` is worn,
//     `UpdateFactionService` (player.kod:11203) clamps the counter to the warn threshold
//     instead of adding to it. So a soldier receives the sentence, and the deadline it
//     implies never arrives. Reading the warning alone as "four hours to live" would send
//     the fleet's soldiers on an errand they do not need, once every twenty minutes, for
//     ever.
//
// AND A QUEST NODE BELONGS TO ONE CHARACTER. `QuestNode` hands a waiting node to the
// first qualifying speaker and answers everyone else with a bare FALSE
// (questnode.kod:800-822); the multiplayer branch is commented out. A fleet that all
// shouted "loyalty" at one liege would get one quest between them and twenty silences
// indistinguishable from success, so this is deliberately one character at a time.
export const FACTION_WARN_TIME_S = 72000;
export const FACTION_RESIGN_TIME_S = 86400;
export const FACTION_LOYALTY_GRACE_MS = (FACTION_RESIGN_TIME_S - FACTION_WARN_TIME_S) * 1000;

// The exact sentence, from `player_faction_time` (player.kod:160). Matched on the two
// halves that carry the meaning rather than on the whole string, because the resource is
// wrapped across two source lines and the `~I` is a formatting code the client strips.
const LOYALTY_WARNING_RE =
  /liege is no longer convinced of your loyalty|visit your liege at court again/i;

// `player_unfactioned` (player.kod:167) — the expulsion itself, after the fact.
const LOYALTY_LOST_RE = /stricken from the roll of membership|liege has no use for one such as you/i;

export const isLoyaltyWarning = text => LOYALTY_WARNING_RE.test(String(text ?? ''));
export const isLoyaltyLost = text => LOYALTY_LOST_RE.test(String(text ?? ''));

// ONE WORD, AND IT IS THE SAME WORD FOR ALL THREE LIEGES. Quest nodes 5, 8 and 197 are
// all `QN_TYPE_MESSAGE` with `#cargolist = [ duke_standard1_trigger ]`, and that resource
// is the literal "loyalty" (questengine.kod:125). The duke's own name on the constant is
// a source quirk, not three different words.
export const LOYALTY_TRIGGER = 'loyalty';

// The duke's second node wants this word said to a named townsperson (questengine.kod:6,
// `duke_standard2_trigger`, questengine.kod:130).
export const DUKE_TAX_TRIGGER = 'tax';

export const FACTION_LOYALTY = Object.freeze({
  // Node 197 -> 198 (questengine.kod:5671-5704). Say "loyalty" to Jonas, then bring him
  // one piece of equipment from a fixed list, within an hour, in the same room.
  rebel: Object.freeze({
    id: 'rebel', title: 'The Rebels', leader: "Jonas D'Accor", room: 371,
    shape: 'item-to-liege', time_limit_ms: 3600_000,
    accepts: Object.freeze(['helm', "knight's shield", 'gauntlets', 'long sword',
      'mystic sword', 'scimitar', 'nerudite sword']),
    target: "Jonas D'Accor", target_room: 371,
  }),
  // Node 8 -> 9 (questengine.kod:2536-2575). The Princess hands over the letter herself;
  // the errand is only the delivery, to one of five named NPCs, within an hour.
  princess: Object.freeze({
    id: 'princess', title: 'The Princess', leader: 'Princess Kateriina', room: 852,
    shape: 'letter-to-npc', time_limit_ms: 3600_000,
    accepts: Object.freeze(['letter']),
    recipients: Object.freeze([
      { target: 'Priestess Xiana', aliases: Object.freeze(['Xiana']), room: 48 },
      { target: 'Alzahakar', room: 37 },
      { target: 'Lady Aftyn', room: 205 },
      { target: 'Herbutte', room: 109 },
      { target: 'Esseldi', room: 526 },
    ]),
  }),
  // Node 5 -> 6 -> 7 (questengine.kod:2465-2532). Three legs, and the middle one is
  // "say `tax` to whichever townsperson the Duke names", which is a different NPC every
  // time. THIS ONE IS DELIBERATELY NOT AUTOMATED HERE: the allowlist would be every
  // merchant in three towns, which is a general speech surface wearing a quest's clothes,
  // and both of its legs are half-hour timers whose penalty is expulsion. It is
  // recognised, reported, and handed back to an operator.
  duke: Object.freeze({
    id: 'duke', title: 'The Duke', leader: 'Duke Akardius', room: 952,
    shape: 'tax-collection', time_limit_ms: 1800_000,
    accepts: Object.freeze([]),
    automated: false,
    why_not: 'the Duke names a different townsperson each time, and answering would mean ' +
      'a speech allowlist covering three towns; both of its legs are half-hour timers ' +
      'whose penalty is expulsion',
  }),
});

// A QUEST NODE IS DEAF BEYOND FIVE SQUARES, AND BEING DEAF LOOKS EXACTLY LIKE AGREEING.
//
// `CheckCompletionCriteria` tests `SquaredDistanceTo > Q_NPC_CLOSE_ENOUGH^2` before it
// looks at the message at all (questnode.kod:650, blakston.khd:2779), and every failure
// in that function returns FALSE and says nothing. So standing in the liege's room is not
// enough: in a large chamber the word is spoken, the room hears it, the quest does not,
// and the reply that never comes is the same non-event as a quest that was not scheduled.
// Checked before speaking so the answer is "too far, walk closer" rather than silence.
export const QUEST_NPC_REACH_SQUARES = 5;

export function withinQuestReach(self, npc) {
  if (!self || !npc) return null;                       // unknown, which is not the same as far
  if ([self.col, self.row, npc.col, npc.row].some(value => typeof value !== 'number')) return null;
  const squared = (self.col - npc.col) ** 2 + (self.row - npc.row) ** 2;
  return { within: squared <= QUEST_NPC_REACH_SQUARES ** 2,
           distance: Math.round(Math.sqrt(squared) * 10) / 10 };
}

// WHERE A LOYALTY PAYMENT COMES FROM WHEN THE PACK HAS NONE.
//
// Looting one is a 5%-per-kill proposition, which is a fine answer for a durable goal and
// a terrible one for a four-hour deadline. So the planned source is a counter — and it
// must be a counter that CANNOT BE EMPTY, because "I have none of those" is a sentence
// spoken to the room and never an error on the wire, so a plan resting on a merchant that
// can run dry reports success and comes home with an empty pack.
//
// Rook in Cor Noth (room 154) is the entry that matters: `CorNothSergeant` does not
// declare `vbSellFromInventory = TRUE` — only `kcshopk.kod:54` and `izzio.kod:54` in the
// whole tree do — so he assembles his list on demand and cannot run out of long swords.
// Izzio stocks two of these and is exactly one of the two that can be empty, and wanders
// besides, so he is recorded for completeness and never planned against.
export const LOYALTY_MARKETS = Object.freeze({
  'long sword': Object.freeze([
    Object.freeze({ merchant: 'Rook', room: 154, finite_stock: false, wanders: false }),
    Object.freeze({ merchant: 'Izzio', room: 593, finite_stock: true, wanders: true }),
  ]),
  helm: Object.freeze([
    Object.freeze({ merchant: 'Izzio', room: 593, finite_stock: true, wanders: true }),
  ]),
  'nerudite sword': Object.freeze([
    Object.freeze({ merchant: "Ixla cha'Totlak", room: 2003, finite_stock: false, wanders: false }),
  ]),
});

/** The one thing to buy, and where, to pay this liege — or null when nothing can be. */
export function loyaltyPurchase(faction) {
  const spec = factionLoyaltySpec(faction);
  if (!spec || spec.automated === false || spec.shape !== 'item-to-liege') return null;
  for (const item of spec.accepts) {
    const seller = (LOYALTY_MARKETS[item] ?? []).find(m => !m.finite_stock && !m.wanders);
    if (seller) return { item, ...seller };
  }
  return null;
}

export function factionLoyaltySpec(value) {
  const id = ALIASES[String(value ?? '').trim().toLowerCase()];
  return id ? FACTION_LOYALTY[id] : null;
}

/**
 * What the liege asked for, out of its reply to "loyalty".
 *
 * The assign hints name the cargo through `%INDEF_CARGO%CARGO` (rebel) or `%NPC`
 * (princess), so the item or the recipient arrives as ordinary prose inside a sentence
 * this repository cannot template. Matching is therefore against the SOURCE-DEFINED set
 * and never against whatever noun happens to follow "bring me" — a reply nobody
 * anticipated returns null rather than an invented errand.
 */
export function loyaltyAssignment(faction, messages = []) {
  const spec = factionLoyaltySpec(faction);
  if (!spec) return null;
  const text = textOf(messages);
  if (!text) return null;

  if (spec.shape === 'item-to-liege') {
    // Longest name first: "long sword" contains "sword", and "knight's shield" contains
    // "shield". Matching the short one first would file a knight's shield as a shield the
    // recipient never asked for.
    const item = [...spec.accepts].sort((a, b) => b.length - a.length)
      .find(name => mentions(text, name));
    return item ? { item, target: spec.target, room: spec.target_room,
      time_limit_ms: spec.time_limit_ms } : null;
  }

  if (spec.shape === 'letter-to-npc') {
    for (const recipient of spec.recipients) {
      const names = [recipient.target, ...(recipient.aliases ?? [])];
      if (names.some(name => mentions(text, name)))
        return { item: 'letter', target: recipient.target, aliases: recipient.aliases,
          room: recipient.room, time_limit_ms: spec.time_limit_ms };
    }
    return null;
  }

  return null;
}

// The success hints, per faction: `rebel_standard2_success` (questengine.kod:154) and
// `princess_standard2_success` (:141). Deliberately NOT the join confirmations — a
// loyalty renewal never says "entered on the roll of membership", because the character
// was on it the whole time, so reusing `factionJoinConfirmed` would report every
// successful renewal as unconfirmed.
export function loyaltyRenewalConfirmed(messages = []) {
  return /I will definitely put this to good use|A letter from her highness|Excellent\.\s*I will/i
    .test(textOf(messages));
}

// The failure hints (questengine.kod:155, 142, 133). These are the moment membership is
// actually lost, and they are worth telling apart from the warning: the warning starts a
// clock, this one says the clock ran out.
export function loyaltyFailed(messages = []) {
  return /You are not a true rebel|Your membership in my faction has been revoked|failed me when I needed you most/i
    .test(textOf(messages));
}

/**
 * May this character offer this thing, to this recipient, as loyalty service?
 *
 * The same allowlist shape `factionOfferAllowed` uses, and for the same reason: being
 * wrong here hands a possession to an NPC that will not give it back.
 */
export function loyaltyOfferAllowed(faction, { item, target } = {}) {
  const spec = factionLoyaltySpec(faction);
  if (!spec) return null;
  const itemText = String(item ?? '').trim().toLowerCase();
  const targetText = String(target ?? '').trim().toLowerCase();
  if (!spec.accepts.some(name => name.toLowerCase() === itemText)) return null;

  if (spec.shape === 'item-to-liege')
    return targetText === spec.target.toLowerCase()
      ? { item: itemText, target: spec.target, room: spec.target_room } : null;

  if (spec.shape === 'letter-to-npc') {
    const recipient = spec.recipients.find(candidate =>
      [candidate.target, ...(candidate.aliases ?? [])]
        .some(name => name.toLowerCase() === targetText));
    return recipient
      ? { item: itemText, target: recipient.target, aliases: recipient.aliases, room: recipient.room }
      : null;
  }

  return null;
}

/**
 * Does this character owe its liege service right now, and how long has it got?
 *
 * One definition, published on the fleet row, so the board, the broker and any bot are
 * reading the same answer rather than three re-derivations of it. Returns null for "no
 * debt", never a debt with zeroes in it — absent and satisfied are different facts and a
 * caller that treats `{ due_in_ms: 0 }` as falsy would get them the wrong way round.
 */
export function loyaltyDebt(status, now = Date.now()) {
  const loyalty = status?.loyalty;
  if (!loyalty?.warned_at) return null;
  if (loyalty.lost_at) return null;                                  // already out; nothing to serve
  if (loyalty.served_at && loyalty.served_at >= loyalty.warned_at) return null;
  if (!['duke', 'princess', 'rebel'].includes(status?.faction)) return null;

  const spec = factionLoyaltySpec(status.faction);
  const dueAt = loyalty.due_at ?? loyalty.warned_at + FACTION_LOYALTY_GRACE_MS;
  // A soldier's counter is clamped at the warn threshold and never reaches the resign
  // one, so it is warned indefinitely and is never actually at risk. Reported as a debt
  // with NO deadline rather than as no debt at all: the liege did ask, and an operator
  // may still want the service done — it just must not be treated as urgent, or the
  // fleet's soldiers would each run this errand once per warning, for ever.
  const soldier = status.soldier === true || loyalty.soldier_at_warning === true;
  return {
    faction: status.faction,
    warned_at: loyalty.warned_at,
    due_at: soldier ? null : dueAt,
    due_in_ms: soldier ? null : dueAt - now,
    expired: soldier ? false : now >= dueAt,
    soldier,
    automated: spec?.automated !== false,
    why_not: spec?.automated === false ? spec.why_not : undefined,
  };
}

export const COUNCIL_TOKENS = Object.freeze([
  'runed coffer token', 'jeweled egg token', 'jade cat token',
  'demon skull token', 'crystal sphere token',
]);

export const COUNCIL_TOKEN_DESTINATIONS = Object.freeze({
  'runed coffer token': Object.freeze({ councilor: 'Alzahakar', room: 37 }),
  'jeweled egg token': Object.freeze({ councilor: 'Bei Naq', room: 576 }),
  'jade cat token': Object.freeze({ councilor: 'Cylill', room: 563 }),
  'demon skull token': Object.freeze({ councilor: 'Drechx', room: 2 }),
  'crystal sphere token': Object.freeze({ councilor: 'Esseldi', room: 526 }),
});

const TOKEN_SET = new Set(COUNCIL_TOKENS.map(value => value.toLowerCase()));

export function factionFromProfile(extra) {
  const text = String(extra ?? '');
  if (!text.trim()) return 'unknown';
  if (/Duke Akardius/i.test(text)) return 'duke';
  if (/Princess Kateriina/i.test(text)) return 'princess';
  if (/freedom fighter|supporting Jonas/i.test(text)) return 'rebel';
  // Player.ShowExtraInfo emits no explicit neutral sentence: it appends origin and
  // guild, then appends a faction line only when GetFaction() is non-neutral.
  return 'neutral';
}

export function visibleTokenFromProfile(extra) {
  const text = String(extra ?? '').toLowerCase();
  return COUNCIL_TOKENS.find(token => text.includes(token)) ?? null;
}

export const isCouncilToken = value => TOKEN_SET.has(String(value ?? '').trim().toLowerCase());

export function soldierFromInventory(faction, items = []) {
  const spec = FACTION_SOLDIER[faction];
  if (!spec) return false;
  return items.some(item => String(item?.name ?? item ?? '').trim().toLowerCase() ===
    spec.shield.toLowerCase());
}

export function soldierAssignment(faction, messages = []) {
  const spec = FACTION_SOLDIER[faction];
  if (!spec) return null;
  const text = textOf(messages);
  const stageIndex = spec.stages.findIndex(stage => mentions(text, stage.target));
  return stageIndex < 0 ? null : { ...spec.stages[stageIndex], stage_index: stageIndex };
}

export function soldierPromotionConfirmed(faction, messages = [], items = []) {
  return soldierFromInventory(faction, items) ||
    /accepted into .*army|accepted into .*militia|proved yourself worthy|honor of serving/i
      .test(textOf(messages));
}

const ALIASES = Object.freeze({
  duke: 'duke', akardius: 'duke',
  princess: 'princess', kateriina: 'princess',
  rebel: 'rebel', rebels: 'rebel', jonas: 'rebel',
});

export function factionJoinSpec(value) {
  const id = ALIASES[String(value ?? '').trim().toLowerCase()];
  return id ? FACTION_JOIN[id] : null;
}

const textOf = messages => (Array.isArray(messages) ? messages : [])
  .map(message => typeof message === 'string' ? message : message?.text)
  .filter(Boolean).join('\n');

const mentions = (text, value) => text.toLowerCase().includes(value.toLowerCase());

/** Turn the liege's quest sentence into the exact item and recipient DUM must pursue. */
export function factionAssignment(faction, messages = []) {
  const spec = factionJoinSpec(faction);
  if (!spec) return null;
  const text = textOf(messages);
  if (!text) return null;
  for (const assignment of spec.assignments) {
    const names = [assignment.target, ...(assignment.aliases ?? [])];
    if (spec.id === 'princess') {
      if (names.some(name => mentions(text, name))) return { ...assignment };
    } else if (mentions(text, assignment.item)) return { ...assignment };
  }
  return null;
}

export function factionJoinConfirmed(messages = []) {
  const text = textOf(messages);
  return /entered on the roll of membership|one of the freedom fighters/i.test(text);
}

export function factionOfferAllowed(faction, { item, target } = {}) {
  const spec = factionJoinSpec(faction);
  if (!spec) return null;
  const itemText = String(item ?? '').trim().toLowerCase();
  const targetText = String(target ?? '').trim().toLowerCase();
  return spec.assignments.find(assignment => {
    const targets = [assignment.target, ...(assignment.aliases ?? [])]
      .map(name => name.toLowerCase());
    return assignment.item.toLowerCase() === itemText && targets.includes(targetText);
  }) ?? null;
}
