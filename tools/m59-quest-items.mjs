// QUEST ITEMS ARE NEVER DROPPED AND NEVER SOLD. Operator, 2026-11-15: "the shards are quest items that are hard to get,
// nobody wants to get them and then drop them so they can carry other loot".
//
// Janice's shard A (the tip of the sword of Riija, earned with an orc pit boss head) left her pack at 22:20:56Z on
// 2026-11-15 while she walked the avar jungle, logged only as `left_pack`; the next one costs another boss kill. So the
// guard sits at the two client calls every code path ends in -- `drop` and an `offer` to a non-player (a merchant buys by
// offer) -- rather than in each of the dozen faculties that decide what to shed, sell or eject. A trade to another PLAYER
// is still allowed (the head has to travel from its holder to the quester), and so is a vault or guild-chest deposit,
// which uses neither call. Names match the server's own (swshard.kod, bosshead.kod, riijaswd.kod, questnode.kod).
export const QUEST_ITEMS = Object.freeze([
  'shard of a sword',          // the four Riija shards (swsharda..d.kod), bound to the quester by name
  'orc pit boss head',         // shard A's price (bosshead.kod)
  'feather of an avar shaman', // shard D's evil route (questnode.kod)
  'sword of riija',            // the finished sword (riijaswd.kod)
]);

const norm = s => String(s ?? '').trim().toLowerCase();
/** True for a quest item's name, singular or the server's plural "s" form. */
export function isQuestItem(name) {
  const n = norm(name);
  return !!n && QUEST_ITEMS.some(q => n === q || n === `${q}s`);
}
