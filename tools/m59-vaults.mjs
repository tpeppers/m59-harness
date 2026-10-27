// THE VAULTS: WHO KEEPS THEM AND WHERE. ONE TABLE, FROM THE KOD.
//
// There are two vaultmen (MOB_VAULTMAN): Obert Cair'bre in North Barloque (bqvaultm.kod, room 114) and Itzal cha'Nosak in
// the Ko'catan bank (kcvaultm.kod, kocbank.kod RID_KOC_BANK = 2005). Every reader matched /obert cair|vaultman/, which
// would have answered "no vaultman in this room" standing in front of the island's one (operator, 2026-10-27: "People
// who arrive at the island should vault anything they can't bring into the jungle"). Pure.
export const VAULTS = Object.freeze([
  Object.freeze({ room: 114, npc: "Obert Cair'bre", where: 'North Barloque' }),
  Object.freeze({ room: 2005, npc: "Itzal cha'Nosak", where: "the Ko'catan bank" }),
]);
/** Is this object name a vaultman? The two by name, and anything calling itself one. */
export const VAULTMAN_RE = /obert cair|itzal cha.?nosak|vaultman/i;
export const isVaultmanName = name => VAULTMAN_RE.test(String(name ?? ''));
/** The vault in a room, or null. */
export const vaultIn = room => VAULTS.find(v => v.room === Number(room)) ?? null;
/** "Obert Cair'bre (114, North Barloque) or Itzal cha'Nosak (2005, the Ko'catan bank)": for a refusal. */
export const vaultsSaid = () => VAULTS.map(v => `${v.npc} (room ${v.room}, ${v.where})`).join(' or ');

// WHAT A BANKER SAYS, from the kod (monster.kod Lm_bnkr_*), and nothing else. A bank reply used to be "the first message
// after the request", and on prod 2026-10-27 that was "Hail your guildmate Fozzie!" -- a guild login notice -- reported as
// the banker's answer to a withdrawal of 8984 while no money moved.
export const BANKER_SAID = new RegExp([
  'You have [\\d,]+ shillings in your account',                     // balance
  'Thank you for your deposit',                                     // did_deposit
  'You have no money to withdraw',                                  // no_account
  'But you only have [\\d,]+ shillings in your (account|possession)', // not_enough_withdraw / _deposit
  'Here are your [\\d,]+ shillings',                                // did_withdraw
  'if I gave you a shilling more than',                             // player_full
  "You can't hold even a single shilling more",                     // player_all_full
].join('|'), 'i');
export const isBankerLine = text => BANKER_SAID.test(String(text ?? ''));
