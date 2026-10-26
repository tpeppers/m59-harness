// THE RPG VOCABULARY: the questions a fight, a journey or a desk asks about a character, answered in this
// game's own terms from the server's own lists, each citing the kod it rests on. A pak's conditions are
// written against these answers (`self.resist.fire`, `self.curse.state`, `outcome.resisted`), so the same
// words mean the same thing in every pak and every dry run.
//
//   sheet.mjs       buffs, debuffs, resistances, what is worn and carried, and the CURSE (not a debuff)
//   timers.mjs      the one shared attack timer, which channels share it, and the three wands that do not
//   channels.mjs    every way this character can attack right now: melee, bow, wand:<name>, spell:<name>
//   damage.mjs      reading our own blow back: the verb band, the element, "laughs off" and "shrugs off"
//   hazards.mjs     what crossing a wall of fire costs, with resistance
//   suspicion.mjs   is that creature a morphed player; is that nameless player anonymous
//   doors.mjs       the doors between two rooms, and posts around where each lands
//   requests.mjs    the fleet's service board: ask for a purge, a remove curse; serve one
export * from './sheet.mjs';
export * from './timers.mjs';
export * from './channels.mjs';
export * from './damage.mjs';
export * from './hazards.mjs';
export * from './suspicion.mjs';
export * from './doors.mjs';
export * from './requests.mjs';
