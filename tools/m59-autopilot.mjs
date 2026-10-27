#!/usr/bin/env node
import {stationaryTradeActive} from './m59-stationary-trade.mjs';
import {configureCooperativeLogoff,requestCooperativeLogoff,abortPreparingCooperativeLogoff,cooperativeAssist,publishCooperativePresence,cooperativeReturnRefuge} from './m59-cooperative-logoff.mjs';
import {withBodyStage,bodyAuthority} from './m59-body-command.mjs';
import{affordablePoisonCure,castRecoveryCure}from'./m59-recovery-cure.mjs';
import{scriptedTrafficResumeReady,scriptedDeviationResumeCandidate}from'./m59-traffic-resume.mjs';
import{deathLocationFromSessions}from'./m59-death-location.mjs';
// The keeper: a background loop that holds a character's baseline state so the model
// driving it does not have to.
//
// The problem this solves is a mismatch of clocks. The server runs at one action per
// second and a fight takes half a minute; a model thinks in one burst and then is
// gone until someone calls it again. In between, a character standing in a monster
// room bleeds out, or sits at full health doing nothing for an hour.
//
// So: a small always-on loop per character with no language model in it at all. It
// makes only the decisions that are genuinely mechanical — rest when hurt and safe,
// break off and withdraw when losing, get out of the Underworld after dying, re-wield
// a weapon — and it writes down everything it did so the model can read the history
// and take over whenever it likes.
//
// Two rules it follows, both of them about not surprising its owner:
//
//   * it never picks a fight the owner did not ask for. `survive` only defends what
//     is already happening; `farm` fights, but only what it was told to fight.
//   * everything it does is in the journal with a reason. An agent that comes back to
//     find itself somewhere else can find out why.

import {findDeathNotice} from './m59-death-notices.mjs';
import {noteTrafficJam,trafficBlinkAdvice,waitForBlinkCast} from './m59-traffic-blink.mjs';
import {affordableHeal,castRecoveryHeal,healReadiness,healAllowed} from './m59-recovery-heal.mjs';
// policy.healSpells as a list, or null: every heal this character knows. A function of the policy rather than a method,
// because the heal paths are also called on bare objects that borrow Autopilot.prototype methods.
export const healAllowOf = a => Array.isArray(a?.policy?.healSpells) ? a.policy.healSpells : null;
import {publishFleetHealth,readFleetHealth} from './m59-fleet-health.mjs';
import { withCastRite, idleGearCheck, riteStatus } from './m59-castrite.mjs';
import { castRole } from './m59-spellgear.mjs';
import {keeperRecoveryRescueReady} from './m59-move-origin.mjs';
import {continuingProvenRefugeLeg} from './m59-refuge-leg.mjs';
import { SWARM_MIN_MAX_HEALTH } from './m59-swarm-follow.mjs';
import { applyDeathAttribution } from './m59-death-attribution.mjs';
import { classifyPvpDeath, pvpReturnDelayMs, readPvpDeath, writePvpDeath,
         pvpHoldState } from './m59-pvp-return.mjs';
import { rememberedEnemy } from './m59-war.mjs';
import { pvpAllowedHere, pvpRoomsOf, pvpRoomsRefusal } from './m59-pvp-rooms.mjs';
import { allyVerdict } from './m59-ally.mjs';
import {JAM_TTL_MS,JAM_MEASURE_MS,REPLAN_MS,sameJamPocket,jamObservation,validJamOwner,recoveryObservationKey} from './m59-survival-jam.mjs';
import {recordBlockerClearance} from './m59-blocker-events.mjs';
import {blockerRetaliated, lureRefugeFilter} from './m59-blocker-combat.mjs';
import { isSpared, grantProvoke, endProvoke } from './m59-spare.mjs';
import * as skills from './m59-skills.mjs';
import {stalePullReason} from './m59-quarry-identity.mjs';
import { bannedWeaponsHeld } from './m59-arming.mjs';
import { clearConjureHoard } from './m59-conjure-cleanup.mjs';
import { escapeGroundEffect } from './m59-combat-mode.mjs';
import { effectsAt } from './m59-ground-effects.mjs';
import { recoveryRefugeReach, recoveryOccupiedSquares, recoveryUnderPressure, observeRefugeProgress, REFUGE_PROGRESS_MS,
         planDoorEscape } from './m59-recovery-refuge.mjs';
import { attachSurvivalDecisions, currentSurvivalDecision, chooseSurvivalDecision,
  updateSurvivalDecision, cancelSurvivalDecision, finishSurvivalDecision,
  observeSurvivalDecision, survivalDecisionSnapshot } from './m59-survival-decision.mjs';
import { createSurvivalDecisionRecorder } from './m59-survival-decision-log.mjs';
import { attachReplayRecorder } from './m59-replay-recorder.mjs';
import { epochId } from './m59-epoch.mjs';
import { attachSurvivalTrace, traceSurvival, traceSurvivalNote, traceSurvivalOperation,
         tracePassContext, traceBody, traceRefuge, survivalTraceSnapshot,
         survivalTraceSummary } from './m59-survival-trace.mjs';
import { opensFightFromWall } from './m59-policydiff.mjs';
import * as watchdog from './m59-watchdog.mjs';
import { HealingWands } from './m59-healing-wands.mjs';
import { PotionFreshness } from './m59-potion-freshness.mjs';
import { FarmWandSupport } from './m59-farm-wand-support.mjs';
import { OF, affordances, dropSpec as dropSpecFor, buyLines,
         playerClassName, flaggedAggressor, blocksMovement } from './m59-parse.mjs';
import * as grudge from './m59-grudge.mjs';
import { refusedHere, refusedTargets } from './m59-refused-targets.mjs';
import {quarryApproachSignature} from './m59-pocket-rails.mjs';
import { isFood, foodValue, weighItem, weighPack, foodSurplusOf, MARKET_KEEP, isWeaponName } from './m59-items.mjs';
import { loadSpawns, huntingGrounds, huntMatcher, huntedCreatures, huntLabel,
         roomThreats, goalYield, roomCap, karmaSafe, huntRoomYield, farmSourcesFor,
         FORGIVING_RATING as GENTLE_RATING, creatureByName } from './m59-spawns.mjs';
import { findPath, roomsWithin } from './m59-map.mjs';
import { sameRoomDoorPlan, sameRoomIslandBridgePlan, sameRoomDoors } from './m59-world.mjs';
import { notePreySide, preySideFor } from './m59-preyside.mjs';
import { isTerminalMovementReason } from './m59-movement.mjs';
import { recordTactic } from './m59-tactics.mjs';
import { verdictFromRow, safeWallVerdict } from './m59-safewall.mjs';
import { RoomGeometry } from './m59-roo.mjs';
import { thoroughfareYield } from './m59-thoroughfare.mjs';
import { recordRest } from './m59-restwatch.mjs';
// `exposureAt` is the FORMULA for a safe wall and `RoomGeometry` says which grid the monster
// uses. Imported so the survival ladder can ask the geometry directly instead of asking the
// safe-spot book what used to work -- see wallHere().
import { nearestSafeSpot, coarseCombatReachFrom, PLAYER_REACH,
         exposureAt, reachableFrom }
  from './m59-safespots.mjs';
import { activeRoutes, anchorFor } from './m59-routes.mjs';
import { watchFarmDanger } from './m59-stage-danger.mjs';
import { beginPullProgress, samplePullProgress } from './m59-pull-progress.mjs';
import { heardOrder, dropCrumb, nextStep, behindBy, exitTakenFrom } from './m59-follow.mjs';
import { inboxIfAny, unwrapSpeech } from './m59-inbox.mjs';
import { arenaCall } from './m59-chatter.mjs';
import { describeCommitment } from './m59-commitment.mjs';
import * as tougher from './m59-tougher.mjs';
import { WeaponMagicBook, magicSwap } from './m59-weapon-magic.mjs';
import { recordEvent } from './m59-ledger.mjs';
import { pendingOrderFor, writeState as writeOrderState, orderPrice, orderSkills } from './m59-standing-orders.mjs';
import { CHALICE, REFILL_ROOMS, GUILD_HALL_ROOM, normalizeChalice, roleOf, sameName, shouldRide, sweepVerdict, actingDesk, moneyExcess, depositPlan,
         tipPlan, planRoom, chaliceStoreFor, folWanted, holderShortfall, donationPlan, servingOrHolder, restockBuyPlan, cargoWants,
         reagentFloor, castsAbove, servingDesk, humanMark, serviceTellText, serviceReplyText, deskMenu, folRoomsOf,
         sipVerdict, SIP_TOOK, SIP_REFUSED_PVP, dutyEligible, passTo, draftAlternate, carriesCup } from './m59-chalice.mjs';
import { rideChaliceNow } from './m59-chalice-ride.mjs';
import * as wandDuty from './m59-wand-duty.mjs';
import { normalizePractice, offeredServices, deskReserve, choosePractice, pickCreatureTarget, touchedCreatures, spellCost } from './m59-deskpractice.mjs';
import { claimGift, releaseGift } from './m59-interest-store.mjs';
import { normalizeShare, planGift, shortfallTargets, SHORTFALL_TTL_MS } from './m59-sharing.mjs';
import { makeTracker as makeGrindTracker } from './m59-wallgrind.mjs';
import { recordShelterRun } from './m59-shelter.mjs';
import { traceLadder, traceDecision } from './m59-keeper-trace.mjs';
import { detailSettings, recordStrategyStat, saveVaultSnapshot }
  from './m59-strategy-stats.mjs';
import { siftValue } from './m59-overfarm.mjs';
import { routeTravelKind } from './m59-travel-kind.mjs';
import { purchasePlan, purchaseKey, PURCHASE_BANKS, accountBalance } from './m59-purchase-plan.mjs';
import { runReagentCoop } from './m59-reagent-coop-runtime.mjs';
import { readBankerLine, balancesFor } from './m59-bank.mjs';
import { completeTownIncome, recordTownTrade } from './m59-town-income.mjs';
import { travelJourneyMetrics, withTravelJourneyMetrics, compactRefusals } from './m59-trip-telemetry.mjs';
import { TitheBook, payGuildTithe, purseAmount, tithePaymentPlan,
         titheFleet } from './m59-tithe.mjs';
import { normalizeCurseCycle, curseCycleGate, uncurseAffordable, restrictPlan,
         CURSE_CYCLE_SPELL, CURSE_CYCLE_REAGENT } from './m59-curse-cycle.mjs';
import { contributionPlan, guildPlan, guildKeepTest, reagentSource, REAGENT_MODES }
  from './m59-guildwants.mjs';
import { StorageCache, BOOKMAKERS_HALL_ROOM, chestKey, chestFullness, STOCKPILE_GET_REACH, STOCKPILE_WALK_WITHIN } from './m59-storage.mjs';
import { TicketBook, TICKETS_FILE, readDeskOpen } from './m59-vault-broker.mjs';
import { stockpileKeepTest, sourcePlan, savingsOf, StockpileBook,
         canEnterHall, REAGENTS } from './m59-stockpile.mjs';
import { hallPassword, inFoyer, SAID_NOTE } from './m59-hallsecret.mjs';
import { guildPassage, hallPost } from './m59-guild-passage.mjs';
// ROOM 2600'S TWO LEVERS, worked by the keeper on a journey to 2601. See passLeverPuzzle.
import { leverPuzzleFor, puzzleBlocksJourney, trustedDoorHeights, doorState, finalFoes,
         inFinalZone, decideLeverStep, nextApproachLeg, readClaims, updateClaims, claimLeverOnDisk,
         claimLever, releaseLevers, markReady, partnerReady, agreeBeat, heldLever, claimsFile,
         chebyshev, PULL_BEAT_MS, PULL_LEAD_MS, STATUS as LEVER_STATUS } from './m59-leverpuzzle.mjs';
// The chest side of the hall. The coop runtime asks guildPassage for the same section.
export const GUILD_CHEST_SECTION = 4;
import { listLoadouts } from './m59-loadout.mjs';
import * as uptime from './m59-uptime.mjs';
import * as party from './m59-party.mjs';
import * as buddySys from './m59-buddy.mjs';
import { classifyCombatLine as classifyBuddyLine } from './m59-combatlog.mjs';
import * as pvpGear from './m59-pvp-gear.mjs';
import { mayShareSpot } from './m59-party.mjs';
import {
  claimFileSpot, fileClaimedSpotList, fileSpotClaimSnapshot,
  fileSpotClaimsEnabled, fileSpotHeldBy, fileSpotOccupancy,
  fileSpotTakenByAnother, releaseFileSpot, rememberFileSpotPartner,
} from './m59-spotclaims.mjs';
// The pre-registered table the keeper consults at the three moments it has no opinion
// about. A LOOKUP, never a request — see the note above checkAttackedByPlayer().
import * as playbook from './m59-playbook.mjs';
import { CITY_INNS } from './m59-underworld.mjs';
// SIGHTINGS, AN OPERATOR'S TARGET LIST, AND WHO IS FIGHTING WHOM RIGHT NOW. Evidence and
// coordination only — the authority for swinging at a person is m59-grudge.mjs, and
// nothing imported here may be read as permission. `addTarget` is deliberately NOT
// imported: the keeper does not write its own kill orders.
import { recordSightings, recordTargetKill, targetsFor,
         declareConflict, clearConflict, activeConflicts } from './m59-intel.mjs';
// WHAT THIS PARTICULAR CHARACTER IS SUPPOSED TO BE CARRYING, if anybody has said. Every
// buy, sell, keep and drop rule below used to be one constant for twenty-one characters;
// a loadout is that answer per character, written in the compendium's planner. It is an
// OVERLAY — a character with no loadout behaves exactly as it did before this import
// existed, and every call below is guarded on the null that says so.
import { loadoutFor, loadoutMtime, POLICY_KEYS, keepTest, sellTest, dropRank, wantsOf, norm,
         reconcile, equipYield } from './m59-loadout.mjs';
// Behavior-tree subtree factories and the blackboard helper. Only getArmedTree is
// wired today, behind a per-character policy.useBT opt-in. The rest (handle_threat,
// farm, etc.) come later, gated on the m59-combat-test suite per docs/BT-PLAN.md.
import { getArmedTree, updateBlackboard } from './m59-bt-nodes.mjs';
import { RUNNING } from './m59-bt.mjs';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// One resolver, shared with the broker's `tithe` tool — see titheFleet in m59-tithe.mjs
// for why two answers here meant two books and a fleet that tithed twice a day.
import { UNDERWORLD } from './m59-travelgate.mjs';
// A touch spell is the weapon: train it with an empty hand and the buff on. See touchTrainingHere.
import { touchSpellSpec, TouchSpellState, touchRecastBackoffMs, touchCastTiming,
         touchRefreshDue } from './m59-touchspell.mjs';
import { orderByHuntPriority, huntPriorityProblems, priorityRankOf } from './m59-hunt-priority.mjs';
import { lootOnlyStatus } from './m59-loot-filter.mjs';
// FARMING STRATEGY FILES: the engine applies a file; the keeper only binds it (applyFarmStrategy).
import { FarmStrategyEngine } from './m59-strategy-engine.mjs';
import { PolicySourceBook } from './m59-policy-sources.mjs';
import { keeperOrigin, claimantOrigin, moveOrigin, originLabel, liveMoveOrder, movementReport,
         journeyProvenance, installMoveOrders, describePreemption } from './m59-move-origin.mjs';
import { recordMovementIncident, classifyJourneyFailure } from './m59-movement-incidents.mjs';
import { packCounts, newTripTrade, addTradeFact, tripLedgerFields } from './m59-towntrip-ledger.mjs';
import * as townFavors from './m59-town-favors.mjs';
// THE KEEPER'S PARTS (tools/autopilot/). Each is a block of Autopilot's own methods, moved out of
// this file verbatim and installed below, right after the class. See tools/autopilot/parts.mjs.
import { installParts } from './autopilot/parts.mjs';
import { HuntSetupPart } from './autopilot/hunt-setup.mjs';
import { TrainingPart } from './autopilot/training.mjs';
import { GearPart } from './autopilot/gear.mjs';
import { ProvisionPart } from './autopilot/provision.mjs';
import { SensesPart } from './autopilot/senses.mjs';
import { BridgesPart } from './autopilot/bridges.mjs';
import { InventoryPart } from './autopilot/inventory.mjs';
import { SafeSpotsPart } from './autopilot/safe-spots.mjs';
import { PullPart } from './autopilot/pull.mjs';
import { SanctuaryPart } from './autopilot/sanctuary.mjs';
import { ErrandsPart } from './autopilot/errands.mjs';
import { HuntBooksPart } from './autopilot/hunt-books.mjs';
import { PvpReturnPart } from './autopilot/pvp-return.mjs';
import { TravelPart } from './autopilot/travel.mjs';
import { PvpResponsePart } from './autopilot/pvp-response.mjs';
import { ThreatPart } from './autopilot/threat.mjs';
import { DeathPart } from './autopilot/death.mjs';
import { JournalPart } from './autopilot/journal.mjs';
import { StatusPart } from './autopilot/status.mjs';
import { FacultiesPart } from './autopilot/faculties.mjs';
import { WatchdogPart } from './autopilot/watchdog.mjs';
import { WedgePart } from './autopilot/wedge.mjs';
import { PassTravellingPart } from './autopilot/pass-travelling.mjs';
import { PassCombatPart } from './autopilot/pass-combat.mjs';
import { PassSurvivalPart } from './autopilot/pass-survival.mjs';
import { PassOutsidePart } from './autopilot/pass-outside.mjs';
import { LeverPuzzlePart } from './autopilot/lever-puzzle.mjs';
import { PassErrandPart } from './autopilot/pass-errand.mjs';
import { BuddyPart } from './autopilot/buddy.mjs';
import { CurseCyclePart } from './autopilot/curse-cycle.mjs';
import { PassFarmPart } from './autopilot/pass-farm.mjs';
import { SocialPart } from './autopilot/social.mjs';
import { ChalicePart } from './autopilot/chalice.mjs';
import { WandDutyPart } from './autopilot/wand-duty.mjs';
import { DeskPracticePart } from './autopilot/desk-practice.mjs';
import { HeardPart } from './autopilot/heard.mjs';
import { MarketPart } from './autopilot/market.mjs';
import { DeliveryPart } from './autopilot/delivery.mjs';
import { ShoppingPart } from './autopilot/shopping.mjs';
import { TownTripPart } from './autopilot/town-trip.mjs';
import { HallPart } from './autopilot/hall.mjs';
import { TownShopsPart } from './autopilot/town-shops.mjs';
import { CooperativePart } from './autopilot/cooperative.mjs';
import { GearUpkeepPart } from './autopilot/gear-upkeep.mjs';
import { RetreatPart } from './autopilot/retreat.mjs';
import { survivalOffOf } from './m59-hazards.mjs';


// THE UNDERWORLD'S ROOM OBJECT ID, which is not its room number: it is room 1 and its room
// object's id is 6. Named because a bare 6 in a room comparison is unreadable, and because it
// was already being compared against a variable that usually held a room NUMBER instead.
export const UNDERWORLD_ROOM_OBJECT_ID = 6;
export const TITHE_FLEET = titheFleet();

// Keep the stall-accounting decision independently testable. A partial exchange is
// useful only when the server confirms that we damaged the still-retained quarry;
// neither attempted swings nor dying during the exchange qualify as progress.
export function partialFightMadeProgress(result = {}) {
  return !result?.died && Number(result?.landed_hits || 0) > 0;
}

// Built by: node tools/m59-spawns.mjs
export const SPAWN_FILE = process.env.M59_SPAWN_FILE ||
  fileURLToPath(new URL('../substrate/m59-spawns.json', import.meta.url));
// (a SAFESPOT_FILE was read from here into a per-square outcome book. Retired 2026-09-20 —
// see the tombstone in m59-safespots.mjs. Walls are computed from geometry and nothing else.)
// One file per death. Gitignored, like everything a running fleet writes.
export const POSTMORTEM_DIR = process.env.M59_POSTMORTEM_DIR ||
  fileURLToPath(new URL('../substrate/postmortems', import.meta.url));

// MONSTER-FREE RETREATS THAT ARE NOT TRUE SANCTUARIES.
//
// Castle Victoria's nearest useful recovery room is its front step. Room 2 has no
// monster generator, so crossing the door ends a monster chase and makes ordinary
// resting practical. It has no NO_COMBAT/NO_PK/sanctuary flag, however: another player
// can still kill somebody there. Keep that distinction in the data and in every journal
// entry rather than quietly upgrading "no monsters spawn" into "nothing can hurt us".
//
// Upstairs (39) reaches it through base Castle Victoria (38). A working wall remains
// better than either trip; retreatToSafety checks that before consulting this table.
export const PREFERRED_QUIET_RETREATS = Object.freeze({
  38: Object.freeze({ room: 2, name: 'Outside Castle Victoria' }),
  39: Object.freeze({ room: 2, name: 'Outside Castle Victoria' }),
});

export function preferredQuietRetreat(world, { maxHops = Infinity } = {}) {
  const from = Number(world?.room?.num);
  const pref = PREFERRED_QUIET_RETREATS[from];
  if (!pref) return null;
  const route = world?.route?.(pref.room);
  if (!route?.found) return null;
  const hops = route.hops?.length ?? Infinity;
  if (hops > maxHops) return null;
  return { ...pref, hops, preferred: true, isInn: false,
           safety: 'no monsters spawn here', playerSafe: false };
}

// A ROOM ASSIGNMENT IS A DESTINATION, NOT A TIE-BREAKER.
//
// The old farm loop only consulted preyRooms() when the current room could not spawn
// the quarry. A bot assigned to Castle Victoria while standing in Marion's crypt could
// therefore hunt the same skeleton there forever: status said assigned_room=39 while
// the character never took one step toward 39.
export function shouldRelocateToAssignedRoom(policy, room, deniedRooms = null,
                                             movementLeased = false) {
  // A LEASE ON MOVEMENT OUTRANKS AN ASSIGNMENT. The assignment says where this character
  // belongs when nobody else is deciding; a held movement faculty means somebody else IS.
  // Taken as a parameter rather than read off the keeper so the rule can be pinned without
  // building a world — see m59-unattended-test.
  //
  // OPERATOR DECISION, 2026-09-03, and it was lost in the three-way merge on 09-04 and
  // restored: the lease used to be advisory — recorded, shown on the board, and ignored by
  // the farm pass. Three supply waves bought nothing because a courier with work and
  // movement leased to a fleet errand was walked back to its assigned room the moment the
  // errand's walk ended.
  if (movementLeased) return false;
  const assigned = policy?.assignedRoom;
  if (assigned == null || room?.num == null || room.num === assigned) return false;
  // An assignment is strong, not absolute. If this same keeper has already denied the
  // room under a bounded safety experiment, forcing the assignment and the denial to
  // alternate makes both rules useless: leave 566, immediately aim at 566, repeat.
  // `false` means the room was probed and accepted; only a truthy reason defers it.
  return !deniedRooms?.get(assigned);
}

// Keep an explicit placement reachable even when it is not one of the globally
// highest-yielding rooms.  The old caller asked huntingGrounds for eight rows and only
// then tried to move the assignment to the front.  Room 38 is a valid skeleton room but
// ranks below that cut; Floyd consequently alternated between whichever top-eight room
// was nearest on each side of the map, completing six-hop trips in both directions while
// every journal entry claimed it was returning to room 38.
export function preferAssignedRoom(rooms, assignedRoom, limit = 8) {
  const ranked = [...rooms];
  if (assignedRoom != null) {
    const i = ranked.findIndex(r => r.room === assignedRoom);
    if (i > 0) ranked.unshift(ranked.splice(i, 1)[0]);
  }
  return ranked.slice(0, limit);
}

// Enter an open fight conservatively, then do not reverse that decision after one
// ordinary hit.  The previous test always required 90% health and divided MAX health by
// damage per blow. Floyd entered room 38 at 56/57, took five points while killing one
// zombie, then abandoned the assignment for a fourteen-hop journey at 51/57.  Current
// health is the number of blows actually left; the configured recovery floor is the
// hysteresis boundary after a unit has already accepted this room.
export function openFightReadiness({ healthValue, healthMax, vigor, vigorBar, preyLevel,
  alreadyFighting = false, openFightHealth = 0.9, restBelow = 0.75, minimumBlows = 7 } = {}) {
  const healthPct = healthMax > 0 && healthValue != null ? healthValue / healthMax : null;
  const perBlow = preyLevel != null ? Math.max(1, preyLevel / 12) : null;
  const blows = healthValue != null && perBlow != null ? healthValue / perBlow : null;
  const floor = alreadyFighting ? Math.min(openFightHealth, restBelow) : openFightHealth;
  return { ready: healthPct !== null && healthPct >= floor &&
      vigor != null && vigor >= vigorBar && blows !== null && blows >= minimumBlows,
    healthPct, blows, floor };
}

// An empty larder makes the ordinary fighting floor deliberately fall back to the
// strongest value rest alone can reach. The open-room gate used its independent 130
// bar instead, so a starved character was allowed to fight by the general gate at 70
// but denied its assigned room by this one at 129 — and answered the supply shortage
// with a trip across the world. The danger-specific bar can make a fight cheaper; it
// must not make the already-adjusted, reachable fighting floor impossible again.
export function reachableOpenFightVigorBar(dangerBar, fightFloor) {
  if (dangerBar == null) return fightFloor;
  if (fightFloor == null) return dangerBar;
  return Math.min(dangerBar, fightFloor);
}

// EVERY ROOM-SCOPED FARM REFUSAL HAS TO PARTICIPATE IN THE SAME DECISION.
//
// A wall refusal used to be the only denial, so assignment deferral and prey-room
// ranking read `noWallRooms` directly.  Spawn-cap refusals were later recorded in a
// separate `cappedRooms` collection, but none of those readers consulted it.  The
// keeper could therefore announce that it was giving a capped room up, then stay
// there (with roam:false) or select it again on the next relocation.
//
// Keep the evidence separate at the source so status can say what happened, but merge
// it at the decision boundary.  False wall entries mean a room was tested and accepted,
// so only truthy reasons are denials.  Everything here is session-local: this chooses a
// different room for the current keeper and never blocks the strategic goal.
export function farmRoomDenials(noWallRooms = null, cappedRooms = null) {
  const denied = new Map();
  for (const [room, why] of noWallRooms?.entries?.() ?? []) {
    if (why) denied.set(room, why);
  }
  for (const [room, why] of cappedRooms?.entries?.() ?? []) {
    if (why) denied.set(room, why);
  }
  return denied;
}

// How long a spot must go quiet, with something adjacent to us that wants to kill us,
// before we believe it works. Two passes' worth: one quiet reading is also what you
// get from a monster that happened to be walking away.
export const PROOF_MS = 12_000;
// HOW MANY SWAPS OFF THE SAME WEAPON, REFUSED IN A ROW WITH NO REASON, MAKE A CURSE SUSPECT.
export const CURSE_SUSPECT_REFUSALS = 3;
// Why a swap did not happen, in the note's own words, from equipBest's result.
export const swapWhyNot = (r, swapped) => swapped ? {} : {
  why_not: r?.cursed_in_hand?.length ? `cursed in hand: ${r.cursed_in_hand.map(w => w.name).join(', ')}`
    : r?.vetoed ? 'vetoed' : r?.cancelled ? 'cancelled' : r?.already_wielded ? 'the ranking kept the weapon in hand'
    : r?.rejected?.length ? r.rejected.map(x => x.why).join('; ').slice(0, 300)
    : (r?.note ?? r?.why ?? 'unknown') };
// AND HOW LONG AFTER SETTLING ON THE SQUARE BEFORE DAMAGE IS THE SQUARE'S FAULT.
//
// Being hit is resolved on the server and arrives here as a packet. Our arrival is also
// a packet, travelling the other way. So a blow the server resolved while we were still
// a square short can land in our lap after we have reported standing on the spot — and
// the reading blames the wall for a hit that was already in the air before we reached it.
// A failure is PERMANENT (see discredited() in m59-safespots.mjs), so one such reading
// retires a good square for ever, and nothing about it looks wrong afterwards.
//
// The walked-in path was already covered by accident: takeSafeSpot stamps movedAt on
// arrival, so the whole first window is thrown out for "we moved in this window", which
// at a 1s pass cadence tolerates about a second of skew. The hole was the OTHER path —
// `steps_away === 0`, taking a hold on a square we are already standing on, which walks
// nowhere and therefore stamps no movement. There the first window could open the
// instant the hold was taken, with the approach's damage still arriving.
//
// So the clock is the later of "we stopped moving" and "we claimed the square", and a
// window that opens inside this grace is discarded rather than counted either way.
// Discarded, not merely forgiven, because a window whose damage we do not trust is a
// window whose quiet we do not trust either — the same packet delay that hides a hit
// until later is what would make the square look quiet now.
//
// 250ms rather than the fuller half-second the round trip can take, deliberately. The
// asymmetry that governs this whole file runs the other way: being wrong about a bad
// square costs a character, being wrong about a good one costs a walk to the next
// corner. Widen it only against `settled_ms` on real failures, which is recorded for
// exactly that argument.
export const SETTLE_GRACE_MS = 250;
// How far a swing carries, and how far away something still counts as part of a swarm.
//
// THREE, NOT 1.5. Reach is `SquaredDistanceTo <= GetAttackRange^2` on square
// coordinates (nomoveon.kod:121), and GetAttackRange is `Bound(2 + viDifficulty/6,2,3)`
// (monster.kod:1682) — so the shortest-armed thing in the game reaches two squares and
// a difficulty-6 one reaches three. 1.5 was the diagonal of a single square, i.e. the
// assumption that melee is adjacency, and it made this blind to more than half of what
// could hit us: a centipede sitting two squares away was not counted as adjacent at all.
//
// That mattered most where it was least visible. observe() only credits a quiet reading
// as proof of a square when something that wants us dead is in reach, so under-counting
// reach meant sieges that proved nothing, and the damage that did arrive was attributed
// to a square with "0 adjacent" — a contradiction that was written into the book as
// fact.
export const REACH = 3;
// farmBuffContext's walk estimate back to the safe spot: a square of walking, plus settling on the wall.
export const FARM_BUFF_MS_PER_SQUARE = 450;
export const FARM_BUFF_SETTLE_MS = 1500;
// lureSparedBlocker: at most this many lures per room per window, then the movement ladder has it.
export const SPARE_LURES_PER_ROOM = 6;
export const SPARE_LURE_WINDOW_MS = 10 * 60_000;
// HOW LONG A SQUARE STAYS "COULD NOT GET THERE". Long enough that a hurt character stops
// re-choosing it for the rest of the fight that is stopping it, short enough that a wall
// blocked by one wandering monster is not written off for the session.
// HOW MANY PASSES OF LEVEL HEALTH MEAN THE WALL HAS STOPPED PAYING. The keeper passes about
// once a second, so this is a handful of seconds of no improvement — long enough not to fire
// between two ticks of a rest that is working, short enough that a character stalled where it
// cannot heal sets off again instead of resting out the clock.
// HOW FAR AN AILING CHARACTER MAY FALL BEFORE IT STOPS AND MENDS. Poison takes a character
// to 1 health and then makes it rest to full once the enchantment ends, so the rest is coming
// either way — the only question is whether it happens behind a wall on the route or in the
// open where the fall started.
export const AILING_SHELTER_BELOW = Number(process.env.M59_AILING_SHELTER_BELOW || 0.75);

export const RESUME_FLAT_SAMPLES = Number(process.env.M59_RESUME_FLAT_SAMPLES || 8);

export const UNREACHABLE_SPOT_MS = Number(process.env.M59_UNREACHABLE_SPOT_MS || 5 * 60 * 1000);
export const CROWD_RADIUS = 4;
// Where resting alone runs out. RestTimer stops awarding vigor at its threshold of 80
// out of 200, so 0.4 is the ceiling of what sitting down can ever buy — asking for
// more is asking to sit until the timeout expires. The rest comes from food.
export const REST_VIGOR_CAP = 0.4;
// THE CHARACTER'S OWN RESTING CEILING, AS THE SERVER SENDS IT. 80 is only the base: Second Wind raises the threshold to
// 80 + (ability + 1) / 5 (secwind.kod:158, bounded 10..100 at player.kod:1238) and the server sends it as the vigor stat's
// current_max (user.kod SendStatVigor), which the client reports as vitals().vigor.rest_threshold. Operator, 2026-10-26:
// "be willing to rest to its actual maximum vigor". A threshold under 80 is the Second Wind cooldown (player.kod:1235 sets
// 10 while the enchantment runs): resting cannot award anything then, so it reads as the base rather than as permission
// to fight at 10. A fraction of the 200 bar, like REST_VIGOR_CAP.
//
// ONLY WHERE A REST ENDS. Operator, 2026-10-26: "the actual max vigor should be used for each character just for when it
// finishes being resting between fights". So the rest TARGETS take it; deciding whether to rest at all, and the reachable
// fight floor, stay on the base 80.
export function restVigorCapOf(vitals) {
  const t = Number(vitals?.vigor?.rest_threshold);
  return (Number.isFinite(t) && t > 80 ? Math.min(t, 100) : 80) / 200;
}
// THE VIGOR A TRAVELLER MUST NOT DROP BELOW ON AN ORDINARY ROAD.
//
// Raw vigor, not a fraction, because that is the unit everything else here reports and the
// unit the server's own rule is written in: `RUN_VIGOR_FLOOR` is 12, and under it the speed
// is refused and the body drops from about five squares a second to two and a half.
//
// Forty rather than thirteen, and the gap is the whole point. The floor is not "keep running
// for one more second", it is "never ARRIVE at a hard crossing unable to run at all" — and a
// character cannot know which room is the hard one until it is in it. Mmmm reached Ukgoth at
// vigor one on 2026-08-27, having crossed eleven rooms in four minutes, and then spent
// forty-three minutes failing to leave: the climb out of that valley is 86 to 126 mover
// steps, the same crossing runs in 24-27 seconds six times out of six, and at walking pace it
// exhausts `leaveViaAny`'s candidate budget and reports the DOORWAY as refused. An energy
// problem wearing a geometry verdict, which is what made it expensive to find.
//
// Operator's number, 2026-08-27. Above `REST_VIGOR_WORTH_WAITING`'s 50/200 on purpose is the
// one thing it is NOT: that constant decides whether an existing rest bothers waiting for
// vigor, and this one decides whether a rest happens at all.
export const TRAVEL_VIGOR_FLOOR = Number(process.env.M59_TRAVEL_VIGOR_FLOOR ?? 40);
// AND THE FLOOR NO ORDINARY ACTIVITY MAY CROSS AT ALL — travel, farm, or errand.
//
// Operator's number, 2026-08-28. Raw vigor again, and deliberately well above the server's
// RUN_VIGOR_FLOOR of 12: the point is not to keep running for one more second, it is that the
// interesting failures all start once vigor is spent, and the cheapest moment to fix vigor is
// long before it runs out.
//
// It is a MUST, not a preference. Everything else that mentions vigor here is a target — what
// a rest asks for once it is happening, or whether a journey bothers topping up. This decides
// that a rest happens, and it is not weighed against wanting to fight, wanting to travel, or
// wanting to finish an errand. A character below it stops and sits down.
//
// Why it needs to exist alongside `vigorRestAt`, which already fires at 80 of 200: that trigger
// makes a character WANT to rest, and every path from wanting to resting could be refused —
// by a combat zone, by not holding a wall, by an errand in flight. Fozzie sat at vigor 1 for
// the better part of an hour with that trigger firing every pass. A floor that cannot be
// out-argued is the difference between a preference and a rule.
export const ORDINARY_VIGOR_FLOOR = Number(process.env.M59_ORDINARY_VIGOR_FLOOR ?? 20);
// A TRAVELLER IS NOT MADE TO SIT FOR VIGOR IT CANNOT AFFORD TO EARN.
//
// Resting recovers vigor towards REST_VIGOR_CAP (80 of 200) and everything above that has to
// be EATEN — but the climb is slow from the bottom, and a mid-journey rest that waits for it
// is a journey that stops for minutes to buy a number that only matters for RUNNING. Health
// is what the stop is for.
//
// So below this, a rest asks for health only and takes whatever vigor arrives with it. Above
// it, the top-up is close enough to the cap to be worth finishing. It gates the TARGET, never
// whether the rest happens: refuge is never refused for vigor — see travelHoldCandidate.
export const REST_VIGOR_WORTH_WAITING = Number(process.env.M59_VIGOR_WORTH_WAITING ?? 50) / 200;

// HOW LONG A POST-DEATH RECOVERY IS ALLOWED TO TAKE before the character goes back out
// anyway. recovered() waits on health, mana AND vigor, and each of the three is a way to
// wait for something that is not arriving — a health point that never lands, a mana bar
// held down by something chipping at us in a room we believed was safe.
//
// Twelve minutes is well clear of a real recovery. A character that walks to a corner of
// an inn and sits reaches full health and the 80 vigor resting can give in about two, and
// a full mana bar from empty in five or six. Anything past that is not recovering, it is
// stuck — and a stuck character should show up as a stall, not vanish into an inn for the
// rest of the session.
export const RECOVER_MAX_MS = 12 * 60_000;

// HOW LONG A HURT CHARACTER MAY REFUSE TO GIVE UP A WALL FOR A DISCRETIONARY ERRAND.
//
// Far shorter than RECOVER_MAX_MS, because the two waits are not the same. That one is a
// character sitting in an INN, where nothing can reach it and waiting costs only time.
// This one is standing on a wall in a monster room, which is safe on the thesis but is
// still a room with monsters in it — so the cap is set where a real recovery has clearly
// failed rather than where patience runs out. Full health from the rest threshold takes
// well under a minute at any decent vigor; three is generous and still bounded.
export const HOLD_WHILE_HURT_MAX_MS = 3 * 60_000;

// A LOGOFF IS A SERVER EVENT WITH A PRICE, AND IT BUYS EXACTLY ONE THING.
//
// What it buys: whatever is hitting us stops, because a reconnect is a fresh room entry and
// monsters hold off until we act. What it costs is in the kod, not in this file. Logging off
// anywhere but an inn leaves a LogoffGhost (`user.kod` UserLogoff) whose timer fires at a
// DEADLINE about ten minutes out, and if we are offline at that instant the ghost takes
// items, spell and skill points and base max health (`logghost.kod` InflictPenalties),
// escalating with every penalty toward the cost of a death. The deadline is only moved when
// the old one has passed or we have been logged in for a fifth of the ghost time — so a
// character that logs off again within two minutes of logging in keeps the OLD deadline,
// and every reconnect is another roll at being offline when it lands.
//
// MEASURED ON PROD, 2026-09-24, from substrate/survival-decisions: 13,573 logoffs in 19.7
// hours, 31 per character per hour, median 54 seconds apart, 89% within two minutes of the
// previous one — 32% of them at FULL health and 90% at 70% or better. Rizzo logged off six
// times in twenty-five seconds at 75/75 on chalice duty. Each reconnect keeps the character
// offline ~3.2s. Meanwhile 31 max-health losses since 2026-09-15 match no death at all,
// 13 of them on 2026-09-23.
//
// So a logoff has to be FOR something. Nothing hitting us means there is nothing for it to
// stop, and a character at a wall that is not being hit should simply rest there: its
// moved-since-entry flag is already set, so the health timer is already running. And a
// second logoff inside the server's no-refresh window is reserved for below the flee line.
export const LOGOFF_UNDER_ATTACK_MS = 6_000;
// `LogoffPenaltyGhostTime / 5` at the stock ten minutes: log in for less than this and the
// next logoff inherits the previous ghost's deadline instead of starting a new one.
export const LOGOFF_REFRESH_MS = 120_000;

// THE WATCHDOG'S THREE NUMBERS. See startWatchdog() for what it is for.
//
// The tick is fast because it is free: it reads `client.vitals()`, which the server
// pushes, and writes nothing to the wire. 500ms is well inside the ~1s pace at which
// damage can arrive, so nothing lands between two ticks unseen.
// How long a pass may be inside one await before the watchdog will interrupt it. Three
// seconds is three normal passes — long enough that an ordinary slow call is not treated
// as a stall, short enough that a character bleeding out is not left to it.
// The longest the record may go without a frame while nothing is changing. Matches the
// keeper's own resync interval, which is the same number the deaths page uses to decide
// whether a keeper counts as having been watching (`WATCH_MS` in m59-postmortems.mjs).
// Deliberately the same: the thing that reports blindness and the thing that prevents it
// should not disagree about what it is.

// THE POSITION PULSE — "IS THE CHARACTER MOVING", ASKED OF THE CHARACTER.
//
// Every stall number this repository already has measures the KEEPER. `ms_since_moved` is
// when the keeper last moved somebody, so it climbs while an errand walks the character
// perfectly well — which is exactly how a post-mortem came to read `doing: "stalled", 8
// minutes since it last moved` about a character the frames put in three different rooms.
// Read naively it manufactures stalls that are not there, and it is silent about the one
// that is: a character wedged in a pocket is *frantically busy*, replanning, and the
// keeper is moving it constantly — at the same two squares, forever.
//
// So: sample the POSITION on a clock, independently of the pass. Two consecutive samples
// a second apart at the same square, while the character is supposed to be going
// somewhere, is a stall in the only sense that matters — the body is not moving. It costs
// nothing: `client.self` is already maintained from pushed packets, so this reads memory
// and writes nothing to the wire, and it is exactly what a person watching the screen sees.
//
// It DECIDES NOTHING and interrupts nothing. It is an instrument: it raises `!` on the
// status, writes one frame, and counts. The debugging this exists for — "the board said
// travelling and nobody moved" — needs a record, not another actor. The handbrake below
// is the thing that acts, and it acts on health, which is a different question.
// Two samples, one second apart, per the shape of the question: has it moved since last
// time, and the time before that. A third would only delay the alert.

// RESTING AT A WALL PART-WAY THROUGH A JOURNEY — 'ab' | 'observe' | 'off'.
//
// Two questions share this ring and they want different windows. "Has it moved since last
// time, and the time before that" is answered by three samples and a fourth would only
// delay the alert — so `pennedIn` and `stillHere` still take the newest three and are
// unchanged by this.
//
// "How fast is it losing health" cannot be asked of three. Damage lands about once a
// second and a two-second window is one hit wide, so the rate it computes is either zero
// or enormous depending on which second you look at. Cccc died in West Merchant Way losing
// 7 health over 22 seconds — half a point a second, perfectly steady, and invisible to
// every two-second window in it. Six samples is five seconds of history, which is enough
// to see a rate and short enough to still be about NOW.
export const PULSE_SAMPLES = 6;
// The newest few, for the two questions that are about the body having moved rather than
// about how much time is left. Kept as its own constant so widening the ring above can
// never quietly widen these — `pennedIn` gets STRICTER as the ring grows, so a careless
// change there would switch off the rescue it feeds rather than loosening it.
export const PULSE_MOVEMENT_SAMPLES = 3;
// HOW LONG A STATIONARY, BLEEDING, INERT CHARACTER WAITS FOR ITS DRIVER BEFORE THE KEEPER
// TAKES IT BACK. See `pulsePosition`'s inert branch and the rescue in `watchdogTick`. Four
// seconds is four pulses: long enough that a driver pausing to turn or open a door is not
// treated as an abandonment, short enough that these characters — 20 to 56 max health
// against four ants at about half a point a second — are still alive at the end of it.
export const INERT_RESCUE_MS = Number(process.env.M59_INERT_RESCUE_MS || 4_000);
// Grind rows one character may write per hour before short episodes start being counted
// rather than written, and the length above which an episode is written regardless.
// 12/hour/character is 1.7 MB/day across 23 characters at 250 bytes a row.
export const GRIND_ROWS_PER_HOUR = Number(process.env.M59_GRIND_ROWS_PER_HOUR || 12);
export const GRIND_ALWAYS_MS = Number(process.env.M59_GRIND_ALWAYS_MS || 120_000);

// ==================== TRAVELLING: STOOD DOWN WITHOUT STANDING THERE ====================
//
// `goInert` is the right state for an ERRAND — a shopping trip, a supply exchange, a
// pilot claim — because those take the character somewhere the keeper has no opinion
// about and the keeper genuinely should not interfere. It is the WRONG state for a
// JOURNEY, and the difference cost Cccc on 2026-08-21.
//
// The record, second by second. A commute driver re-sent `travel` to a character that was
// in the Underworld at 2 of 37 health. `travelJob` made the keeper inert. The keeper — the
// Underworld escape is above the inert gate, which is the one exemption — walked it out to
// the Limping Toad Inn, a sanctuary, at 11 of 37. The journey, already running, then walked
// it straight back out of the inn and into West Merchant Way, where six things ate it over
// twenty-two seconds. The keeper watched all of it. Its flee threshold was 70%; the
// character was at 27% when it entered the room and never went above it.
//
// Nothing there was a bug in the survival ladder. The ladder was switched off, by design,
// by a state that means "somebody else is driving" and was being used for a driver that
// only steers.
//
// SO TRAVELLING IS A THIRD STATE. Not `running` — the keeper does not get to hunt, roam,
// shop or pick a room while a journey owns the route. Not `inert` — the survival ladder
// stays armed and reads real numbers every pass. What it may do is enumerated, per
// character, and every entry can be switched off from the `autopilot` tool.
//
// TWO CLOCKS, AND THIS IS THE PART THAT MAKES IT SAFE. Only ONE thing may drive a body.
//
//   at a HOP BOUNDARY the mover is not stepping, so the journey's own `onHop` hook can
//   sit the character down without contending for it. `rest` and `safe_spot` live here.
//
//   MID-HOP the mover is walking, and the keeper cannot act without taking the character
//   back first. So the mid-hop entries do exactly what the watchdog rescue already does:
//   cancel the movement, leave the travelling state, and let the ORDINARY ladder decide
//   on the next breath with real numbers. They decide nothing themselves. `flee`,
//   `fight_back`, `play_dead` and `arm` live here.
//
// That split is not a nicety. Two loops driving one character is the failure `goInert`
// was introduced to prevent, and it is still prevented — the keeper never moves a
// character a journey is moving; it ends the journey and then moves it.
// ON THE ROAD, ONLY TWO THINGS MAY END A JOURNEY: A PLAYER, AND DYING.
//
// Operator's call, 2026-08-27, and the measurement behind it is 37 road deaths across two
// five-inn runs. Every one of them was `mode: idle` — pure travel, no hunting — and they
// were not sudden:
//
//     decline from peak health to death   median 119s   32 of 37 took over a minute
//     time spent BELOW the flee line      median  68s   max 243s
//     regenerated 5hp or more mid-decline 23 of 37, several by +20 to +25
//     frames spent `stalled`              1,155 of 1,498
//     frames holding a safe spot                29 of 1,498  — 1.9%
//
// A minute and a half of standing in it, under the line, with something eating you, and
// the ladder handing the body back to the mover each pass. The thresholds were not the
// problem: there was an enormous window and nothing used it.
//
// AND THE ANSWERS THE LADDER HAD ARE NOT ANSWERS. Walking away does not work on a monster
// — vision is 4 + difficulty/2 squares and they follow — which is why the ordinary flee
// rung was already removed. Changing objective for an inn is worse: it abandons the road
// mid-crossing to cross more of it. Neither survives contact with a room holding fifteen
// attackers, which 26 of these 37 deaths did.
//
// SO THERE IS ONE ANSWER AND IT IS THE SAME ANSWER EVERY TIME. Whatever happens on the
// road — poison, the health line falling, a bad room, anything short of a player or death
// — the move is: find the next safe spot within `travel_shelter_detour` squares of the
// planned route, go and park on it, play dead ONCE to make what is chasing us forget,
// rest to FULL, and carry on to where we were going. The objective is never abandoned.
//
// Everything that used to compete with that is kept and switched OFF, because a behaviour
// deleted is a behaviour that cannot be measured again — and because two of these were
// right once and may be right again with different numbers.
export const TRAVEL_GUARD_DEFAULTS = Object.freeze({
  // ---- mid-hop: each one CANCELS the journey and hands back to the ordinary ladder
  //
  // THE ONE THAT STAYS ON, AND IT IS THE PVP EXEMPTION RATHER THAN A FLEE. It is gated on
  // `worthEnding`, which under the default `travel_flee_from: 'players'` is PEOPLE ONLY, so
  // what this permits is "a person is emptying the bar, stop travelling and deal with it".
  // Dying to a troll costs the walk back; dying to a person costs everything carried.
  flee: true,        // below flee_below with a PLAYER adjacent — see travel_flee_from
  // ALSO STAYS ON, AND IT IS ALSO THE PVP EXEMPTION WEARING A MISLEADING NAME. Read the
  // rung: everything under this faculty is gated on `worthEnding` too, so what it actually
  // permits is "a PERSON is emptying the bar faster than this journey can finish — abandon".
  // A monster doing the same thing is the road doing what the road does, and the wall rung
  // is the answer to that. I defaulted this one off on the first pass at this doctrine and
  // it took the PVP rescue out with it; `m59-travelling-test` caught it.
  fight_back: true,  // a PERSON is emptying the bar fast — see travel_flee_from
  // OFF. THE ONLY ONE OF THE THREE THAT COULD EVER FIRE FOR A MONSTER, WHICH IS THE POINT.
  //
  // Being unarmed is a reason to be somewhere safe, not a reason to stop on a road and
  // rummage. It cancels the crossing at FULL HEALTH on a fact about the pack, in rooms that
  // kill a character in nine seconds — and the shelter rung is the better answer to every
  // situation it fires in, because it takes the body off the road first. Re-arming is
  // something to do parked; `loadout` already does it at the far end.
  arm: false,        // the weapon is gone
  // `play_dead` WAS HERE AND IS GONE — removed 2026-08-21, deliberately and not by tidying.
  //
  // It cancelled a journey so the ordinary ladder could freeze. Freezing is now refused
  // anywhere but a proven safe spot (see playDead), because it recovers vigor and NEVER
  // health: in the open the character comes back with the health it went down with, in
  // reach of everything that put it there. Measured in the Twisted Wood — three froze at
  // 4, 10 and 13 health in rooms of twelve to fifteen monsters, and all three died.
  //
  // So the guard entry had nothing left to permit, and a switch that silently does
  // nothing is how `purpose` stayed out of a schema for a year. Removing it from the key
  // list makes `travel_guard: {play_dead:false}` a LOUD error naming the real faculties,
  // which is the behaviour this repository wants from a setting that no longer exists.
  // Rung 4 (flee) catches every character that rung used to, and hands over to moving.
  // ---- at a hop boundary: the journey pauses and nothing is contended
  rest: true,        // sit in a sanctuary until health AND vigor are as high as sitting takes them
  safe_spot: true,   // hold a defensible wall part-way through — see travelHold
  // ---- mid-hop, and the ONLY faculty here that may swing at a MONSTER.
  //
  // KILL THE THING STANDING IN THE PIPE. Operator, 2026-09-11, having walked into it: "a
  // traffic jam of ~3 bots in The Flatlands that were piled up because of a few spiders and
  // ants clogging the needle.. everyone there was capable of killing them but nobody was
  // attacking the low level monsters that were blocking their paths."
  //
  // WHY NOTHING ALREADY COVERED IT, which took three wrong guesses to establish:
  //   fight_back   sounds exactly like this and is not. Gated on `worthEnding` — a PERSON —
  //                and armed only by `lost > 0`, i.e. BEING HIT. A spider that merely stands
  //                in the corridor never arms it, and standing there is the whole problem.
  //   capBlockers  computes `clearable`, but for the SPAWN CAP, not the path: it returns
  //                early on `!status.full`. Three spiders in a pipe do not fill a cap.
  //   the needle   solves AROUND bodies on a 400ms clock and cannot conceive of removing one.
  //
  // So N travellers each re-plan around bodies that will not move, none of them permitted to
  // swing, and none registering as stuck — they ARE moving, just not arriving, which is the
  // two-square shuffle that defeats every stillness detector in this file.
  //
  // AND IT DOES NOT CANCEL A CROSSING TO DO IT, which is what makes it affordable where the
  // mid-hop SHELTER rung was not. That rung was retired because the only thing it could do
  // was cancel: the mover has the body and a wall cannot be reached without taking the body
  // off the line. A SWING NEEDS NO GROUND. Melee reach is a disc of 2-3 squares, so anything
  // blocking a step is already inside it, and the keeper answers without contending for the
  // body at all. It arms the fight-back path that already exists rather than growing a second.
  clear_path: true,  // a creature is blocking the walk and we have covered no ground
});
export const TRAVEL_GUARD_KEYS = Object.freeze(Object.keys(TRAVEL_GUARD_DEFAULTS));
// Which clock each one is on. Reported by `travel_guard` so an operator turning one off
// knows whether they have disabled an interruption or a pause.
export const TRAVEL_GUARD_CLOCK = Object.freeze({
  flee: 'mid-hop', fight_back: 'mid-hop', arm: 'mid-hop',
  // MID-HOP AND PROUD OF IT: a swing needs no ground, so this one costs the crossing nothing.
  clear_path: 'mid-hop',
  rest: 'hop boundary',
  // BOTH CLOCKS, and it had to be. At a boundary the journey pauses and the character rests
  // at a wall to full. MID-HOP it hands back so the ordinary ladder can take one, because a
  // big room kills a character long before it offers a boundary to be asked at: seven of
  // eleven deaths in one window were inside the Cragged Mountains, which is 2,450 squares,
  // with no refuge taken there at all.
  // HOP BOUNDARY ONLY, AGAIN, AND THIS TIME BECAUSE MID-HOP COULD NOT PAUSE.
  //
  // It was 'both' on a real argument: the Cragged Mountains is 2,450 squares and kills a
  // character long before it offers a boundary to be asked at, seven of eleven deaths in one
  // window. What that argument missed is what mid-hop COSTS, because the only thing a
  // mid-hop trigger can do is CANCEL — the mover has the body, and the keeper cannot take a
  // wall without taking the body off it first.
  //
  // So every scratch in a zone that outranks the character tore down the crossing, and
  // `travelShelterBelow` returns 1 there, meaning any scratch at all. Measured, repeatedly:
  //
  //   586  cancelled at 0 of 40 by a travel guard rung taking the character back
  //   587  cancelled at 6 of 65 by a travel guard rung taking the character back
  //
  // Step zero of forty. The room could not be crossed because the crossing could not begin,
  // and a shelter that prevents arrival is not shelter.
  //
  // BOTH CLOCKS AGAIN, 2026-08-23, BECAUSE THE PREMISE OF THE ABOVE HAS CHANGED.
  //
  // The argument for hop-boundary-only was that a mid-hop trigger can only CANCEL, and that
  // a cancelled crossing is a lost journey. The second half of that is no longer true:
  // f245be5 made a journey that ends short KEEP its destination, and a4bb63f fixed the rung
  // that resumes it — `passErrand`'s idle catch-all was ending every tick before `passFarm`
  // could ever be reached, so the resume had never once fired. It fires now, measured:
  //
  //     +276s  room 596  holding a untested safe spot
  //     +287s  room 596  inert — travelling to 38 (resumed)
  //
  // So mid-hop is a PAUSE too, by a slower route: cancel, take the wall, mend, resume.
  //
  // And the thing that actually made mid-hop unaffordable was never the clock. It was
  // `travelShelterBelow` returning 1 in an outranking zone — shelter at any damage at all —
  // which in the Twisted Wood is the continuous condition. That is fixed at its source.
  //
  // WHAT THIS COSTS AND WHY IT IS WORTH IT. Aaaa, this afternoon: entered the Cragged
  // Mountains at full health, was killed inside it in twenty-five seconds, and never reached
  // another boundary to be asked at. The room is 2,450 squares. A wall it cannot be offered
  // until the far side of the room is not a wall it has.
  safe_spot: 'both',
});

// HOW SOON THE DAMAGE WOULD KILL US BEFORE A JOURNEY IS WORTH INTERRUPTING OVER.
//
// The rescue this replaces required the character to be STATIONARY for four seconds, and
// that requirement is what let Cccc die. His last pulses read 23,3 / 25,5 / 26,5 / 25,5 —
// a two-square shuffle against a wall, which is not moving in any sense that matters and
// resets a stillness timer on every sample. The wedge only aged past four seconds once the
// shuffle stopped, 5.1 seconds before the end.
//
// So the trigger is DAMAGE, and it does not care whether the body is moving. A character
// walking a road while something eats it is in exactly as much trouble as one standing in
// the same place while something eats it, and the walking one is harder to see.
export const TRAVEL_RESCUE_TTL_MS = Number(process.env.M59_TRAVEL_RESCUE_TTL_MS || 10_000);

// RESTING AT A WALL PART-WAY THROUGH A JOURNEY — 'on' | 'observe' | 'off'.
//
//   on       always hold when the conditions are met. THE DEFAULT, and the answer.
//   observe  decide and write down what would have happened; change nothing.
//   off      the behaviour that existed before any of this.
//
// ============================ THE EXPERIMENT IS CLOSED ============================
//
// This defaulted to `ab` — half the journeys holding, half walking on, a coin per journey —
// because nothing offline could say whether stopping at a wall helped. Retired 2026-08-21
// by the operator, and the reason it did not need another week of denominators is that the
// question stopped being about the wall.
//
// The A/B was built to compare TWO WAYS OF TRAVELLING WELL. What the fleet actually does is
// neither: it gets stuck, lost or unresponsive, and then something eats it where it stands.
// Cccc's death is the whole argument in one record — walked out of a sanctuary at 27%
// health against a 70% flee threshold, into a room with six things in it, and killed over
// twenty-two seconds during which nothing was driving at all. No arm of this experiment
// addresses that, and half of every journey was being spent in a control arm that
// deliberately walked hurt characters on past the only free healing on the road.
//
// So: holding is the behaviour, not a treatment. `ab`/`half` are still ACCEPTED, because
// rosters and policy files on disk carry them and a value that throws would take a fleet
// down on restart — but they are mapped to `on` and REPORTED every time, rather than
// silently honoured. A setting that quietly does something other than what it says is the
// exact failure this file spends the most words on.
//
// `m59-travel-ab.mjs` still reads the historical rows; it now prints the verdict rather
// than a power calculation. Settable live per character over the `autopilot` tool
// (`travel_hold`) — no restart, and a restart is the one thing that costs a fleet more
// deaths.
export const TRAVEL_HOLD_MODE = process.env.M59_TRAVEL_HOLD || 'on';
// HOW MUCH A WALL ON THE ROAD AHEAD IS WORTH, against one behind. See nearestSafeSpot's
// `forwardBias`: squares of progress toward the exit, multiplied by this, against the walk
// to the wall. Eight, per the operator (2026-09-01): "5:1 or 10:1 on forward progress over a
// small backtrack". Distance to the wall stops being a cap at the same time — see
// `onwardExit` — so a reachable wall far up the road is preferred to a near one behind.
export const TRAVEL_FORWARD_BIAS = Number(process.env.M59_TRAVEL_FORWARD_BIAS || 8);
// The one arm that is left. Written down rather than inlined, so the ledger rows, the
// keeper's `travelArm` and anything joining the two cannot drift apart.
export const TRAVEL_HOLD_ARM = 'hold';

// HOW LONG A KEEPER STAYS INERT WITHOUT ANYBODY SAYING SO AGAIN.
//
// Every caller that holds a keeper pairs the hold with a revive, and the pairing is the
// bug: `m59-outfit.mjs` has died between the two and left a character standing, and the
// supervisor's own log carries the line `COULD NOT RESTART ITS KEEPER — it is standing
// unattended` for exactly that. Inert is a better state to be abandoned in than stopped —
// it is still recording — but it is not a state to be abandoned in for ever.
//
// Fifteen minutes is longer than any errand here: the slowest is a cross-town outfit run
// at three or four. An errand still going at fifteen has already failed.
export const INERT_MAX_MS = 15 * 60_000;
// THE LONGEST AN OUTSIDE HOLDER MAY MARK A CHARACTER HANDS-OFF IN ONE ASK. Matched to
// INERT_MAX_MS on purpose: both answer the same question — how long may something else
// hold a character before this repository takes it back — and two different answers to
// that would be two different opinions about when a fleet is unattended. A holder that
// needs longer EXTENDS, which is cheap and proves it is still there.
export const BUSY_MAX_MS = INERT_MAX_MS;

// Where to eat to when no strategy names a target. Resting stops awarding vigor at 80 of
// 200 (REST_VIGOR_CAP), and the death rate falls roughly thirtyfold once a character is
// clear of it — 101.8 deaths per thousand observations at or below 85, against 4.4 from
// 86 to 120. So the default is "get off the cap", not "fill the bar": it is the cheap
// part of the curve, and the stomach only admits 100 filling at a time anyway.
export const EAT_TO_AT_LEAST = 120;

// HOW RESTED YOU HAVE TO BE TO FIGHT WITHOUT A WALL, WHICH DEPENDS ON WHAT YOU ARE FIGHTING.
//
// A flat 130 closed a loop the fleet could not get out of. A character with no food sits
// at the resting cap of 80; at 80 it refuses every wall-less fight; refusing means it
// leaves the ground it was sent to; wandering means "nothing to hunt here"; no kills
// means no money; no money means no food; and no food means it is still at 80 tomorrow.
// Nineteen of twenty-one characters were in that loop, and three were doing all the
// killing.
//
// The way out is to notice that "fighting in the open" is not one risk. A giant rat is
// the gentlest thing in this world — level 30, difficulty 1, attack rating 150 — and a
// level-23 character swinging at one from open floor is not the same act as taking on a
// centipede at 390. Damage still scales with level, so `blowsWeCanTake` stays the hard
// floor; this only says how much vigor to demand before allowing it at all.
//
// Gentle prey (at or under a fungus beast's 210, the same bar the room filter uses) is
// allowed from the resting cap. Anything harder still wants the full 130.
// The rating MUST come from the spawn table, which carries the real viDifficulty. My
// first attempt derived it from level alone as 3*level + 60 — that is the difficulty-1
// case, so it called a centipede (really 390) and an ant (360) gentle and would have sent
// characters at the resting cap against them in the open. Level is what a blow costs;
// difficulty is how often one lands, and only the table knows it.
//
// Unknown difficulty means unknown danger, and unknown is NOT gentle.
// WHAT A KEEPER CAN BE OUT THERE FOR, and the list is closed on purpose — anything not on
// it is reported as unrecognised rather than quietly skipping the yield check. `advance`
// asks whether the prey can still raise what we are trying to raise; `equip` asks whether
// it can still drop what we are still short of. A character at the level cap doing the
// second is working, not stalled, and the board has to be able to tell them apart.
export const YIELD_PURPOSES = ['advance', 'equip'];
function ratingOfCreature(name) {
  const all = loadSpawns(SPAWN_FILE)?.creatures;
  const q = String(name || '').toLowerCase();
  if (!all || !q) return null;
  const hit = all[q] || Object.values(all).find(v => q.includes(String(v.name).toLowerCase()));
  return hit?.attack_rating ?? null;
}
/** Same lookup, for the level. Null when the table has no row — never a guess. */
function levelOfCreature(name) {
  const all = loadSpawns(SPAWN_FILE)?.creatures;
  const q = String(name || '').toLowerCase();
  if (!all || !q) return null;
  const hit = all[q] || Object.values(all).find(v => q.includes(String(v.name).toLowerCase()));
  return Number.isFinite(hit?.level) ? hit.level : null;
}

/**
 * Does killing this creature still raise max health for a body of `maxHealth`?
 *
 * The game's rule, which this repository's own doctrine files state in as many words: a kill
 * advances only while the creature's level is STRICTLY above max health. A fungus beast at 50
 * pays everyone under 50 and nobody at or over it.
 *
 * UNKNOWN COUNTS AS ADVANCING, and the direction is deliberate. This is used to decide which
 * bodies may be IGNORED when counting a crowd, so a creature the table cannot identify must
 * stay in the count — discounting an unrecognised thing is how a crowd guard is talked out of
 * the one case it exists for.
 */
export function advancesUs(name, maxHealth) {
  if (!Number.isFinite(maxHealth) || maxHealth <= 0) return true;
  const level = levelOfCreature(name);
  return level == null ? true : level > maxHealth;
}

// WHICH PRECONDITION IS ACTUALLY MISSING FOR `create weapon`, AS A PURE FUNCTION.
//
// Extracted from `passArm` because the bug it fixes is a CLASSIFICATION bug and the
// classification lived inside a six-hundred-line pass nothing could drive. The chain names
// the preconditions this keeper knows about and calls the leftover case `neither` — and
// `neither` used to be reported as `mana`, so a character with vigor, mana AND pack space all
// sufficient was told it needed mana it already had.
//
// THAT IS NOT A COSMETIC DEFECT. `m59-supervise.mjs` skips any character refusing
// UNARMED_NO_DONOR, on the correct reasoning that a character below the bar will arm itself
// the moment mana returns. A character ABOVE the bar never leaves that skip. Measured on prod
// 2026-09-19: Animal, 23 mana against a bar of 15, `stuck.seconds` 25122 — seven hours — and
// `repeats` 22155. The false reason disabled the layer whose job was to catch it.
//
// So `neither` gets its own code, and the code is what the supervisor reads.
export function unarmedBlocker({ vigor = null, mana = null, bulkFree = null,
                                 vigorNeeded = 0, manaNeeded = 15, bulkNeeded = 0,
                                 declinedWhy = null } = {}) {
  const blocker = (vigor != null && vigor < vigorNeeded) ? 'vigor'
                : (mana != null && mana < manaNeeded) ? 'mana'
                : (bulkFree != null && bulkFree < bulkNeeded) ? 'room'
                : 'neither';
  const code = blocker === 'neither' ? 'UNARMED_CANNOT_CAST' : 'UNARMED_NO_DONOR';
  // Only the two that come back on their own are a WAIT. Pack space does not regenerate and
  // a policy refusal does not pass, so promising a wait for either is a promise nothing keeps.
  const wait = blocker === 'vigor' ? 'VIGOR_FOR_CREATE_WEAPON'
             : blocker === 'mana' ? 'MANA_FOR_CREATE_WEAPON'
             : null;
  return { blocker, code, wait, declinedWhy: blocker === 'neither' ? declinedWhy : null };
}

// ONE SOURCE-DERIVED ENGAGEMENT DECISION FOR EVERY KEEPER PATH.
//
// The capped-room cleanup path and the retaliation path used to implement this rule
// separately. Both read the same attack rating, but capBlockers() fell through from its
// rating-aware branch into an unconditional level-only rejection. The result was an
// impossible disagreement: a level-50/difficulty-1 fungus beast (rating 210) was safe to
// hit back at and safe enough for huntingGrounds(), yet unsafe to clear from a capped
// room. Once every alternate room was boundedly refused, that contradiction stopped the
// whole keeper. Keep unknown data fail-closed, forgive only a known gentle rating, and
// make every caller consume the same result.
export function engagementRefusal(info, { name = info?.name ?? '', ceiling = null } = {}) {
  const level = info?.level ?? null;
  const rating = info?.attack_rating ?? null;
  if (!info)
    return { name, level: null, rating: null,
             why: 'nothing is known about it — the spawn table has no row for this name, and ' +
                  'an unrecognised creature is refused rather than assumed harmless' };
  if (rating != null && rating <= GENTLE_RATING) return null;
  if (ceiling != null && level != null && level > ceiling)
    return { name, level, rating,
             why: rating != null
               ? `attack rating ${rating} is above the forgiving band of ${GENTLE_RATING} ` +
                 `and level ${level} is above the safety band of ${ceiling}`
               : `level ${level} is above the safety band of ${ceiling} and the table has no ` +
                 'attack rating to judge it more kindly by' };
  return null;
}

export function vigorBarFor(names, policy) {
  const full = policy.openFightVigor ?? 130;
  const list = [].concat(names || []).filter(Boolean);
  if (!list.length) return full;
  const rates = list.map(ratingOfCreature);
  if (rates.some(r => r == null)) return full;              // do not guess in our own favour
  return Math.max(...rates) <= GENTLE_RATING ? (policy.openFightVigorGentle ?? 78) : full;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const pct = v => (v && v.max ? v.value / v.max : null);

// ── THE PASS LADDER ──────────────────────────────────────────────────────────────
//
// `pass()` used to be one enormous function in which `return;` meant "this tick is over".
// Splitting it into stages quietly changed that contract: a bare `return;` in a stage
// yields `undefined`, and a caller written as `if (await this.passX()) return;` reads
// `undefined` as "carry on" — so a stage that had just DEALT with something fell through
// into the next one. Measured on the first cut of that refactor, the fall-throughs
// included recovering-after-death, a rest interrupted by damage, and a completed bank run,
// all of which continued into `passFarm` and went hunting in the same tick. Three of those
// are the protected faculties, and every one of them looked completely healthy on the
// board.
//
// So the verdict is now a SENTINEL rather than a boolean, and the ladder validates it:
//
//   HANDLED   this stage acted; the tick is over
//   CONTINUE  this stage had nothing to do; try the next one
//
// Anything else — which in practice means a bare `return;` somebody forgot to convert —
// is treated as HANDLED, because that is what it meant before the split and stopping the
// tick is the safe direction, AND is reported by name, because the whole failure above was
// that it was silent. A Symbol is used deliberately: `true`, `false`, `null` and
// `undefined` can all arrive by accident, and none of them can be mistaken for one of these.
export const HANDLED  = Symbol('pass:handled');
export const CONTINUE = Symbol('pass:continue');

// THE ORDER, IN ONE PLACE, BECAUSE IT IS THE THING THAT MUST NOT DRIFT. Urgency descending:
// being dead, then unarmed, then what the fleet's director says about players, then being
// in danger or hurt, then whoever else is driving, then an errand, then the actual job.
// `m59-passorder-test.mjs` pins this array and the short-circuit — see the note there
// about what to do when the order genuinely needs to change.
// THE WATCHDOG'S THREE NUMBERS. See startWatchdog() for what it is for.
//
// The tick is fast because it is free: it reads `client.vitals()`, which the server
// pushes, and writes nothing to the wire. 500ms is well inside the ~1s pace at which
// damage can arrive, so nothing lands between two ticks unseen.
export const WATCHDOG_MS = Number(process.env.M59_WATCHDOG_MS || 500);
// How long a pass may be inside one await before the watchdog will interrupt it. Three
// seconds is three normal passes — long enough that an ordinary slow call is not treated
// as a stall, short enough that a character bleeding out is not left to it.
export const WATCHDOG_BLOCKED_MS = Number(process.env.M59_WATCHDOG_BLOCKED_MS || 3_000);
// The longest the record may go without a frame while nothing is changing. Matches the
// keeper's own resync interval, which is the same number the deaths page uses to decide
// whether a keeper counts as having been watching (`WATCH_MS` in m59-postmortems.mjs).
// Deliberately the same: the thing that reports blindness and the thing that prevents it
// should not disagree about what it is.
export const WATCHDOG_FRAME_MS = Number(process.env.M59_WATCHDOG_FRAME_MS || 8_000);
// ONE HOME FOR THESE TWO NUMBERS, even though the tick itself is still duplicated between
// this file and m59-watchdog.mjs. The two copies have already drifted once — this one
// carries a room-number fix the module never got, and the module carried a wedge-breaker
// this one never got, which is why a healthy character could sit in a doorway for four and
// a half minutes with a guard running and nothing to show for it. Thresholds at least come
// from one place now, so they cannot disagree on top of everything else.
export const WATCHDOG_PINNED_MS = watchdog.WATCHDOG_PINNED_MS;
// Only the healthy-wedge CANCEL uses this. It does NOT gate detection and it does not gate
// the escape ladder: the ladder is reached from `answerWedge` off `wedgeBreak`, which the
// arm writes on WEDGE_LADDER_MS. Believing otherwise is what left prod without an escape
// ladder for hours after the cancel was turned off.
export const WATCHDOG_HEALTHY_CANCEL_MS = watchdog.WATCHDOG_HEALTHY_CANCEL_MS;
// How long stationary-and-not-on-purpose before the escape ladder is offered.
export const WEDGE_LADDER_MS = watchdog.WEDGE_LADDER_MS;
export const WATCHDOG_PINNED_SQUARES = watchdog.WATCHDOG_PINNED_SQUARES;
// WHERE A WEDGED BODY IS MOVED BEFORE THE WALK IS RE-PLANNED, indexed by how many times the
// watchdog has broken a wedge at that place. Two squares, because one is inside the melee
// disc and the slide the client does on a blocked endpoint, and eight headings so that
// consecutive attempts never aim the same way. See `answerWedge`.
export const WEDGE_SIDESTEPS = [
  { name: 'east',       dc:  2, dr:  0 }, { name: 'west',       dc: -2, dr:  0 },
  { name: 'south',      dc:  0, dr:  2 }, { name: 'north',      dc:  0, dr: -2 },
  { name: 'south-east', dc:  2, dr:  2 }, { name: 'north-west', dc: -2, dr: -2 },
  { name: 'north-east', dc:  2, dr: -2 }, { name: 'south-west', dc: -2, dr:  2 },
];
// BLINK BEFORE SIDESTEPPING. Operator, 2026-10-22: "if anyone gets stuck for more than 10-15s, blink! they can blink
// out! especially in east/west jasper, the blink spots are perfect for getting access to the rest of the room if you're
// stuck". The ladder's first record arrives WEDGE_LADDER_MS (10s) pinned, so the first rung is a blink at ~10-15s; the
// sidestep stays as the fallback (no blink known, short of mana, hurt, fighting, or the blink did not move us). A
// wedge-specific cooldown, not the stall blink's 120s: a second jam in the same Jasper stop deserves a second blink,
// and the cost is 15 mana. Per-character `blink_when_wedged: false` turns the rung off.
export const WEDGE_BLINK_COOLDOWN_MS = Number(process.env.M59_WEDGE_BLINK_COOLDOWN_MS || 30_000);
export const WEDGE_BLINK_MIN_HEALTH = 0.5;
export const WEDGE_BLINK_DOOR_SQUARES = 2;   // see wedgeBlink: never blink away from a door that is merely slow
// HOW LONG BETWEEN TWO BLOWS STILL COUNTS AS ONE ATTACK. Damage lands about once a second
// and misses are ordinary, so a single quiet second is not the end of a fight; six of them
// is. Only the fight-back edict reads this — see `fightBackCheck`.
export const FIGHT_BACK_GAP_MS = Number(process.env.M59_FIGHT_BACK_GAP_MS || 6_000);
// A fight-back the watchdog asked for and no pass has answered within this long is stale:
// the situation it described is gone, and acting on it would be swinging at a memory.
export const FIGHT_BACK_STALE_MS = 30_000;
// HOW LONG A JOURNEY MAY COVER NO GROUND BEFORE A CREATURE IN REACH COUNTS AS BLOCKING IT.
// Deliberately longer than a slide and shorter than a stall: the needle solver is on a 400ms
// clock and a healthy crossing re-anchors constantly, so six seconds of zero displacement
// with something inside melee reach is not slow progress, it is a body that will not move.
// Below WATCHDOG_PINNED_MS (20s) on purpose — the healthy-wedge arm is about a stuck ROUTE
// and this is about a stuck CORRIDOR, which is cheaper to answer and worth answering sooner.
export const CLEAR_PATH_MS = Number(process.env.M59_CLEAR_PATH_MS || 6_000);
// The same four states m59-watchdog.mjs calls GOING. Imported rather than retyped would be
// better still; this file already has a second copy at `goingSomewhere` and a third would be
// how they drift apart.
export const GOING_STATES = watchdog.GOING;

// THE POSITION PULSE — "IS THE CHARACTER MOVING", ASKED OF THE CHARACTER.
//
// Every stall number this repository already has measures the KEEPER. `ms_since_moved` is
// when the keeper last moved somebody, so it climbs while an errand walks the character
// perfectly well — which is exactly how a post-mortem came to read `doing: "stalled", 8
// minutes since it last moved` about a character the frames put in three different rooms.
// Read naively it manufactures stalls that are not there, and it is silent about the one
// that is: a character wedged in a pocket is *frantically busy*, replanning, and the
// keeper is moving it constantly — at the same two squares, forever.
//
// So: sample the POSITION on a clock, independently of the pass. Two consecutive samples
// a second apart at the same square, while the character is supposed to be going
// somewhere, is a stall in the only sense that matters — the body is not moving. It costs
// nothing: `client.self` is already maintained from pushed packets, so this reads memory
// and writes nothing to the wire, and it is exactly what a person watching the screen sees.
//
// It DECIDES NOTHING and interrupts nothing. It is an instrument: it raises `!` on the
// status, writes one frame, and counts. The debugging this exists for — "the board said
// travelling and nobody moved" — needs a record, not another actor. The handbrake below
// is the thing that acts, and it acts on health, which is a different question.
export const PULSE_MS = Number(process.env.M59_PULSE_MS || 1_000);
// SIX SAMPLES, AND THE MOVEMENT TESTS STILL ONLY READ THREE OF THEM.
//
// Two questions share this ring and they want different windows. "Has it moved since last

export const PASS_STAGES = [
  'passUnderworld',
  'passArm',
  'passPlaybook',
  // THE FIGHT-BACK EDICT SITS ABOVE THE SURVIVAL LADDER AND DEFERS TO IT. It fires only on
  // an operator's order (`fightBackAfterMs`), only after the watchdog has counted that many
  // milliseconds of being hit while not swinging, and it steps aside below the flee line —
  // so fleeing still outranks it; what it outranks is every wall, pull and walk below.
  'passFightBack',
  'passFleeAndRest',
  'passCooperative',
  // FOLLOWING A PERSON SITS HERE ON PURPOSE. Below survival, because being led somewhere is
  // never worth dying on the way to; above everything directional, because the entire point
  // is that a person walking in front knows something the router does not.
  'passFollow',
  'passOutside',
  'passErrand',
  // THE CURSE CYCLE (m59-curse-cycle.mjs): break a curse a cycled ring put on us and drop the ring.
  // Below survival and errands; inert (CONTINUE) unless a strategy answered `curseCycle` for us.
  'passCurseCycle',
  // THE BUDDY SYSTEM, directly above the farm it replaces for a paired character, and below
  // everything protected and every errand. Inert (CONTINUE) unless policy.buddy names this slot.
  'passBuddy',
  'passFarm',
];

// ------------------------------------------------------ HOW LONG THE LADDER WAITS FOR A RUNG
//
// A PASS STAGE HAD NO DEADLINE, SO ONE HUNG RUNG HELD THE WHOLE SURVIVAL LADDER.
//
// `runPassLadder` did `await this[stage](ctx)` with no race and no bound, and the watchdog's
// only lever fires at most once per pass. So a rung that never returns is a keeper that never
// decides anything again — including fleeing, because `passFleeAndRest` is a rung like any
// other and cannot run while `passFarm` above it is still awaiting.
//
// Measured on prod, 2026-09-19, over 36 deaths in fourteen hours. Using this file's own test —
// "`in_stage_ms` is the number to compare against `pass_blocked_ms`; when they match, the
// stage named here is the one that stopped the keeper" — 21 of 36 had ONE stage owning more
// than 80% of the blocked pass: `passFleeAndRest` 10, `passFarm` 9, `passOutside` 2. Robin
// spent 533 seconds of a 534-second pass inside `passFarm` and was killed in it. Across those
// deaths `fled_in_time` ran 0.02 to 0.22 against a 0.68 flee threshold — the flee decision was
// not losing an argument, it was never reached.
//
// THE BOUND IS ON THE WAIT, NOT ON THE WORK, and that distinction is the whole design. A
// promise cannot be cancelled, so the rung keeps running; what expires is the LADDER's
// patience with it. The rung is then marked in flight and SKIPPED on later passes until it
// settles, so nothing is ever invoked twice — a second shopping trip on top of a running one
// is a worse bug than the one being fixed. Everything above the stuck rung therefore runs
// every pass, which is the point: a hung `passFarm` must not be able to stop a character
// fleeing.
//
// So the numbers are short even for the rungs that legitimately take minutes. `passFarm`
// bounded at 30s does not mean a town trip gets 30 seconds; it means the ladder stops waiting
// on it after 30 and goes back to watching for danger while it finishes.
//
// `M59_STAGE_DEADLINE_MS=0` restores the old unbounded behaviour exactly, for a bisect.
export const STAGE_OVERRAN = Symbol('stage overran the ladder deadline');

const STAGE_DEADLINE_MS = Object.freeze({
  // Identity, mortality, survival and recovery. These are this repository's at the one-second
  // clock; a rung here that needs more than fifteen seconds has already failed at its job.
  passUnderworld: 15_000,
  passArm: 15_000,
  passPlaybook: 15_000,
  passFightBack: 15_000,
  passFleeAndRest: 15_000,
  passFollow: 15_000,
  // Directional. These legitimately walk across towns and stand at counters — and the bound
  // does not interrupt any of it, it only stops the ladder holding its breath.
  passOutside: 30_000,
  passErrand: 30_000,
  passFarm: 30_000,
});

/** How long the ladder waits for one rung. 0 (or an unparseable override) means forever. */
export function stageDeadlineMs(stage, env = process.env) {
  const override = env.M59_STAGE_DEADLINE_MS;
  if (override !== undefined && override !== '') {
    const n = Number(override);
    // AN UNUSABLE VALUE KEEPS THE COMMITTED ONE. Same rule as every other policy surface
    // here: a typo must not silently unbound the survival ladder.
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return STAGE_DEADLINE_MS[stage] ?? 30_000;
}

// ------------------------------------------------------- debugging from inside the game
//
// THREE STATES WE DO NOT YET UNDERSTAND, reported to whoever is standing next to the
// character rather than to a terminal nobody is reading.
//
// These are the three that survived the last round of fixes without being explained:
// they are common (across 403 attended deaths: 46%, 29% and 14% of them), each one is
// individually a correct-looking refusal, and the sum of them is a character quietly
// doing nothing until something eats it. The one thing they have in common is that the
// journal line does not carry enough to tell what the character could actually SEE.
//
// So: flag the state, keep the full detail on the keeper, and — only when a human has a
// client open on one of the fleet's own characters — send it as a tell. Standing next to
// the thing while it explains itself is a different debugging instrument from reading a
// post-mortem afterwards, which is the whole point.
export const DEBUG_STATES = {
  'every defensible square here is out of the fight\'s reach': 'no defensible square',
  'could not reach the safe spot': 'could not reach safe spot',
  'frozen': 'play-dead freeze',
};
// FIVE MINUTES PER CHARACTER PER CONDITION. Measured across 425 post-mortem journals the
// three states fire 2.12 times per character-minute, which across 21 characters is about
// 2,675 tells an hour at one mana each — unreadable, and expensive. The cooldown is per
// (character, condition) so one noisy character cannot mask another's first report, and
// what it suppresses is COUNTED and stated in the next tell rather than dropped, because
// "the 40th time in five minutes" is itself the finding.
// THE MASTER SWITCH, AND IT IS OFF.
//
// Opt-in rather than opt-out because the cost of being wrong is asymmetric: forgetting to
// turn it off means the fleet talks to a live shared server all day, and forgetting to
// turn it on means one debugging session prints a "debug tells are off" reason and you
// set the variable. Any value other than empty/0/false enables it.
export const DEBUG_TELLS_ON = !['', '0', 'false', 'no', 'off']
  .includes(String(process.env.M59_DEBUG_TELLS ?? '').toLowerCase());
export const DEBUG_TELL_COOLDOWN_MS = Number(process.env.M59_DEBUG_TELL_MS || 5 * 60_000);
export const tellCooldown = new Map();     // "character|state" -> last sent at
export const tellSuppressed = new Map();   // "character|state" -> how many since then

// WHO IS AT THE CONTROLS, if anyone.
//
// Registered by the broker rather than imported from it, because the pilot claim is
// bound to a local process id and that is broker state — and because importing
// m59-broker.mjs RUNS it (it takes the fleet lock and starts rejoin timers), which is
// the trap CLAUDE.md warns about. The keeper only needs the answer.
//
// Null until the broker sets it. A headless run, a test, or a broker with nobody piloting
// all give the same answer, and the same behaviour: say nothing to nobody.
let pilotLookup = () => null;
export function setPilotLookup(fn) {
  pilotLookup = typeof fn === 'function' ? fn : (() => null);
}
export function pilotedNow() { try { return pilotLookup(); } catch { return null; } }

// WHERE IN THE ROOM, IN WORDS. A tell that says "col 16, row 11" is a tell you have to go
// and look up; standing in the room you want "far north-west". Rows count from the north
// (LEAVE.NORTH aims at row 1) and columns from the west (LEAVE.WEST aims at col 1) —
// taken from the boundary candidates in World.exits(), not assumed.
export function bearingIn(row, col, rows, cols) {
  if (!rows || !cols || row == null || col == null) return null;
  const band = (v, n) => (v <= n / 3 ? 0 : v <= (2 * n) / 3 ? 1 : 2);
  const ns = ['north', '', 'south'][band(row, rows)];
  const ew = ['west', '', 'east'][band(col, cols)];
  const edge = row <= 2 || col <= 2 || row >= rows - 1 || col >= cols - 1;
  if (!ns && !ew) return 'the middle of the map';
  const where = [ns, ew].filter(Boolean).join('-');
  return (ns && ew) ? `the ${where} corner${edge ? ' (hard against the edge)' : ''}`
                    : `the ${where} side${edge ? ' (hard against the edge)' : ''}`;
}

// Once a meal has lifted us above the configured fighting floor, do not spend a
// long digestion interval chasing the strategy's ideal ceiling. The floor is the
// operator's statement that fighting is safe; the ceiling is only a useful top-up
// target when the next bite is soon, or when the wait is also healing us.
export function shouldWaitForProvision({ vigor, floor, wait, hurt, overdrive = null }) {
  // OVERDRIVE WAITS OUT THE STOMACH TO THE TARGET, not just to the fighting floor: a fed character
  // leaves at 200 rather than at 160, so the fight that follows is one long stretch instead of a
  // stop every forty vigor. Bounded by one full digestion (833 s): a wait longer than that means
  // the stomach model is wrong, and waiting on a wrong model is waiting for ever.
  // Within the last bite of the target counts as there (provision releases at target - 5 too).
  if (overdrive?.active && vigor < (overdrive.reach ?? overdrive.target) - 5 && wait <= 900) return true;
  return vigor < floor || hurt || wait <= 60;
}

// OVERDRIVE (operator, 2026-09-28): "an 'overdrive' strategy for vigor that mirrors our overfarm
// strategy: seeking to maximize the resource. Overdriving vigor causes the unit to just sit and eat
// food until reaching 200 vigor while tracking hunger. Then they get released from overdrive back to
// their original task, so they can maintain 200 vigor longer rather than stop/starting."
//
// WHAT IT CAN AND CANNOT BUY, from the kod, so nobody reads more into it than is there. Vigor comes
// in only through the stomach, which empties at 0.12 filling a second whether the character sits or
// fights (player.kod:1347) — so over a long day no schedule of eating raises the TOTAL: meat pie
// 4.3 vigor a minute, bread 3.6, cheese 5.4, inky cap 14.4. A swing costs 0.5 (ATTACK_EXERTION,
// player.kod:57). What overdrive changes is the SHAPE: one sitting to 200 at a natural stop, then a
// long unbroken fight, instead of forty-vigor stretches with a walk to a rest spot between each. And
// every minute sat at high vigor heals faster ((200-v)^2/6 + 1000 ms a point, :5617), so the sitting
// is not wasted on a hurt character. Eating on the clock DURING the fight (provision, "mid-hunt") is
// the other half and already runs.
//
// AND IT DOES NOT LET GO THE MOMENT IT REACHES 200 (operator, 2026-09-28): "afterwards it should wait
// until it's expected to be back near full hungriness before releasing control, part of the goal is its
// *more* ready to keep farming than if it just ate to max vigor, since it's both max vigor and ready to
// immediately continue reinforcing that max vigor by eating again once it begins expending vigor." So
// the sitting has two phases: EAT to the target, then DIGEST — keep sitting until the modelled stomach
// is down to `digestTo` (default 20 of 100: room for a full sitting). Released early by anything that
// needs the body (something in reach, a lease on work or movement) or by `digestMaxMinutes`.
//
// policy.overdrive = { enabled, target = 200, maxMinutes = 30, digestTo = 20, digestMaxMinutes = 15 }.
// Off unless set: silence is the behaviour that was already there.
export function overdriveSettings(policy) {
  const o = policy?.overdrive;
  if (!o || o.enabled === false || o.enabled == null && !o.target) return null;
  const target = Math.min(200, Math.max(81, Number(o.target) || 200));
  const maxMinutes = Math.max(1, Number(o.maxMinutes) || 30);
  const digestTo = Math.min(100, Math.max(0, Number.isFinite(Number(o.digestTo)) ? Number(o.digestTo) : 20));
  const digestMaxMinutes = Math.max(0, Number.isFinite(Number(o.digestMaxMinutes)) ? Number(o.digestMaxMinutes) : 15);
  return { target, maxMinutes, digestTo, digestMaxMinutes };
}

/**
 * THE TARGET A LARDER CAN ACTUALLY REACH. `eat` refuses a bite that would carry vigor past 200, so with
 * nothing smaller than bread (+20) aboard, 181 is as high as a climb gets — and a climb that waits for
 * 200 waits out its whole cap eating nothing. Measured 2026-09-28: Kermit, 188 -> 188, 29.5 min, 0 meals.
 * Returns the target to compare against (`target - 5` is "there").
 */
export function overdriveReachable(target, larder = []) {
  const bites = larder.map(x => Number(x?.food?.nutrition ?? x?.nutrition)).filter(n => n > 0);
  if (!bites.length) return target;
  return Math.min(target, 205 - Math.min(...bites));
}

/**
 * The DIGEST phase, pure: after the target is reached, should the character keep sitting? Returns
 * { hold, released_by } — `hold` while the stomach is above digestTo and nothing needs the body.
 */
export function overdriveDigest({ od, stomachLevel, digestingForMs, danger = false, leased = false }) {
  if (danger) return { hold: false, released_by: 'something in reach' };
  if (leased) return { hold: false, released_by: 'a lease wanted the body' };
  if (!(stomachLevel > od.digestTo)) return { hold: false, released_by: 'digested: room to eat again' };
  if (digestingForMs >= od.digestMaxMinutes * 60_000) return { hold: false, released_by: `${od.digestMaxMinutes} min digest cap` };
  return { hold: true, released_by: null };
}

// VIGOR IS NOT SHAPED LIKE THE OTHER TWO, and reading it as though it were has been
// quietly disabling every vigor decision in this file.
//
// Health and mana report {value, max}. Vigor reports {value, scale_max, rest_threshold}
// — there is no `max`, because its fourth field is the level the game counts as RESTED
// (80 of 200) rather than a ceiling. So `pct(vitals.vigor)` returned null, every
// `vig !== null` guard was false, and no character has ever rested because it was
// tired. Morgan sat at 14 vigor on full health "fighting from a proven safe spot",
// which is thirty seconds of swinging and no way back.
export const vigorOf = v => (v?.vigor?.value ?? null);
// HOW MANY REAGENTS TO KEEP. Six is three casts of create food, which a character gets
// through in an hour and then declines every cast until it happens past another shop.
// The fleet declined 278 casts for want of reagents in three hours, against 21 for mana,
// while holding eight elderberry across twenty-one characters — and create food is the
// only route to vigor for anyone not standing in a town.
//
// Twenty is ten casts. Elderberry and herbs are 10 weight each, so both targets together
// are about 400 of a 1700 carry allowance, and the walking float still bounds the spend.
// Herbs are already abundant (135 fleet-wide against 8 elderberry); the target is really
// about elderberry, and being over-stocked on herbs costs weight and nothing else.
export const REAGENT_TARGET = 20;

// AND THE COMMENT ABOVE IS NOW EXACTLY BACKWARDS, WHICH IS THE WHOLE ARGUMENT FOR A
// PER-KIND TARGET.
//
// "Herbs are already abundant (135 fleet-wide against 8 elderberry)" was true when it was
// written. Measured today, after nine hours of running: 999 ELDERBERRY AND 13 HERBS. Six
// castable pairs across twenty-one characters, one of whom can cook, and `create food`
// declined for want of reagents 785 times in that window alone (3,816 lifetime).
//
// The inversion is structural, not luck. The hunting grounds DROP elderberry — every
// fungus beast pays in it — and nothing anywhere drops herbs, so the only herb in the
// world arrives by being bought at an apothecary. One number for both kinds therefore
// buys the thing that is free and rations the thing that is scarce, and the surplus is
// dead weight: 999 elderberries are ~48 a character of carry allowance spent on the half
// of the recipe nobody is short of.
//
// So the floor is per kind. Herbs are bought deep because a visit to Joguer is rare and
// each casting burns two; elderberry keeps the old target because the field refills it
// for nothing. This changes only HOW MUCH is bought at a counter the character is already
// standing at — it opens no new trip, which is the failure mode the last two changes to
// this file had to be walked back from.
export const REAGENT_TARGET_BY_KIND = { elderberry: REAGENT_TARGET, herb: 60 };
export const reagentTargetFor = (kind, policyTarget) =>
  policyTarget != null ? policyTarget
                       : (REAGENT_TARGET_BY_KIND[kind] ?? REAGENT_TARGET);

// WHAT A THING IS WORTH, from viValue_average in the kod — the number a merchant prices
// around, before markup. Read once at load; a missing file simply makes every pile value
// zero, which reads as "not worth a walk" and is the safe direction to fail in.
export const ITEM_VALUE = (() => {
  try {
    const p = fileURLToPath(new URL('../substrate/m59-values.json', import.meta.url));
    return JSON.parse(readFileSync(p, 'utf8')).values ?? {};
  } catch { return {}; }
})();

// What `create food` costs to cast — viMana on the Kraanan spell, the same number the
// broker's `spells` tool reports out of the kod source. Reagents alone never made a cast
// affordable, and treating them as the only precondition is what put the fleet in the
// state where reagents were delivered to characters too tired to spend them.
export const CREATE_FOOD_MANA = 10;

// BLINK — Riija 1, 15 mana, no reagents, no target. The game's own answer to "there is no
// step out of here", and the only way onto the upper cliff in the Cragged Mountains. The
// cooldown is long because the failure it treats is a standing condition rather than a
// moment: a character marooned by geometry is still marooned in thirty seconds, and a
// spell fired every pass is a mana leak that also teleports working characters off their
// safe spot.
export const BLINK_MANA = 15;
export const BLINK_COOLDOWN_MS = 120_000;
// The stall reasons that are about GETTING OUT of somewhere, as opposed to having nothing
// worth doing. Only these are worth a spell — blinking because the prey ran out would move
// a perfectly mobile character for no reason.
const STUCK_IN_PLACE = /could not reach|cannot reach|no route|refused|no floor|stuck|could not get|unreachable|no exit/i;

// A STALL HAS TO NAME ITS LEVER, AND "NONE" IS AN ANSWER RATHER THAN A SILENCE.
//
// `noProgress` had exactly one lever — blink — selected by testing the reason SENTENCE
// against the regex above. A reason that did not match got no lever at all, and nothing
// anywhere said so: the counter went up, `stuck.since` advanced, and the character stood
// there. Issue #50 is 27 minutes of it in the character's own farm room, 943 idle passes,
// zero kills, the detector watching the whole time.
//
// The second lever is outside this file — `m59-supervise.mjs` restarts a keeper stalled
// for eight passes — and it is a lever for a STATEFUL stall, where the thing in the way is
// keeper-local (a room written off, a route given up on, a square's failure budget). It is
// not a lever for a DETERMINISTIC one: a fresh keeper walks into the same room with the
// same inputs and re-enters the loop in seconds, once every ninety seconds, for ever, and
// every line of it looks like the supervisor working. That file already names that trap
// twice, for `NO_SAFE_WALL` and for a character resting up the mana to arm itself.
//
// So the lever becomes DATA. `stallLever` is the whole map from a reason to the thing that
// can act on it, `null` is a legitimate and reportable answer, and a stall that keeps
// giving the same leverless reason stops being endured and gets DECLARED — as a refusal,
// with a code, on the channel the supervisor and the board already read. Declaring is not
// a cure. It is the difference between a character nobody can help and a character nobody
// can SEE, and only one of those is fixable by whoever is on shift.
export const STALL_LEVERS = Object.freeze({ blink: STUCK_IN_PLACE });
export const stallLever = (why) => {
  const s = String(why ?? '');
  for (const [name, test] of Object.entries(STALL_LEVERS)) if (test.test(s)) return name;
  return null;
};
// THE SAME REASON TWICE IS A DIFFERENT FACT FROM TWO WAYS OF FAILING. A character finding
// a new obstacle every pass is working; one reciting the same sentence is in a loop that
// its own inputs cannot leave. Only the second is worth declaring, which is why this
// counts REPEATS of one reason rather than idle passes of any kind.
//
// Twenty, at the ~1.5s pass the reported loop ran at, is about thirty seconds — well past
// anything transient and a long way short of the 1,623 seconds it actually took.
export const STALL_NO_LEVER_REPEATS = 20;

export const vigorPct = v => {
  const g = v?.vigor;
  if (!g || g.value == null) return null;
  return g.value / (g.scale_max ?? 200);
};

// NOBODY STARTS A FIGHT TIRED.
//
// Attacking costs half a point a swing at one a second — thirty a minute — and vigor
// is also what sets how fast health comes back between fights. Below about a third of
// the bar a character cannot finish what it starts: it swings, runs dry, breaks off,
// and recovers slower than it would have if it had simply waited.
//
// Seventy WAS chosen to be reachable without food, and that turned out to be the wrong
// thing to optimise. Resting alone stops at 80 of 200, so a floor of 70 meant every
// character fought permanently exhausted — not occasionally, by accident, but as the
// designed steady state — and then recovered slowly between fights because vigor is
// what sets the regeneration rate. The floor was reachable; it was also useless.
//
// So the floor is now set by what a character needs to FIGHT WELL, and the food supply
// is expected to meet it. That is not a free choice — everything above 80 has to be
// eaten — which is exactly why the larder and the vigor floor are one problem.
// EIGHTY, BECAUSE THAT IS WHAT RESTING ALONE DELIVERS — AND 100 WAS NOT SETTABLE.
//
// This is a CLAMP, not a default: `fightFloor` is `Math.max(MIN_FIGHT_VIGOR, ...)`, so
// every value below it was silently raised. An operator setting `fight_above_vigor: 80`
// got 100, the policy read back 80, and nothing said otherwise — the exact shape of a
// setting that looks applied and does nothing, which this repository has paid for before.
// substrate/policy.local.json even documented the trap in a key called
// `why_the_floor_is_100` rather than the clamp being moved.
//
// Measured on prod 2026-08-28: eighteen of twenty characters reported `cannot fight`
// against a floor of 100, across ten consecutive half-hourly reports with zero toughers
// and fleet max health falling 1,006 -> 930. Resting stops at REST_VIGOR_CAP (80 of 200),
// so the only way past 80 is EATING, and a fleet whose larder is thin is a fleet that
// never starts a fight at all. The escape hatch below (STARVED_FIGHT_VIGOR) only fires on
// an EMPTY larder — a character with one mushroom and a floor of 100 is still deadlocked.
//
// 80 is not an arbitrary loosening. It is exactly the resting cap, so it is the highest
// floor a character can always reach without the food chain working, which makes it the
// last value that can never deadlock. Wanting more than that is still expressible — set
// `fight_above_vigor` higher — but it is now a CHOICE about the food supply rather than a
// hidden minimum nobody could see.
export const MIN_FIGHT_VIGOR = 80;       // never start a fight below this while there is food
export const WANT_FIGHT_VIGOR = 140;     // what every pattern aims to set out at
// THE ESCAPE HATCH, and the reason a hard floor of 100 does not deadlock the fleet.
// With an empty larder the floor is unreachable by any action the keeper can take, and
// holding out for it idles the character for ever — so an empty larder drops it to what
// resting alone can actually deliver. This is a SUPPLY failure and is counted as one.
export const STARVED_FIGHT_VIGOR = 70;
// The game's own ceiling: `eat` refuses anything that would carry vigor past it.
export const VIGOR_CAP = 200;
// AND THE GAME'S OWN FLOOR FOR CASTING, WHICH IS NOT ABOUT MANA AT ALL.
// `CanPayManaVigor` (spell.kod:597) tests vigor BEFORE it tests mana, and returns FALSE
// without spending anything when the caster is too tired:
//
//     % Make sure caster is not too tired
//     if (NOT Send(who,@HasVigor,#amount=viSpellExertion))     % viSpellExertion = 13
//        Send(who,@MsgSendUser,#message_rsc=spell_too_tired,#parm1=vrName);
//        return FALSE;
//
// A refusal that costs no mana is indistinguishable, from this side, from a cast that was
// never sent — so it read as a mystery rather than as a precondition. Beaker spent 3.6
// hours and 5194 casts on `create weapon` with mana at 25 of 25 and vigor at 1, while the
// keeper reported "not enough mana". See m59-conjure-test.mjs.
export const SPELL_EXERTION_VIGOR = 13;
// AND THE PACK HAS TO BE ABLE TO HOLD WHAT THE SPELL MAKES. `ReqNewHold` refuses on bulk
// and creaweap.kod:116-129 then DELETES the weapon — AFTER the mana is spent. The spell
// rolls between six weapons (creaweap.kod:71-105) and the largest is the scimitar at 70
// bulk, so a pack with less headroom than this is paying 15 mana for a coin flip.
// Measured 2026-08-29: Beaker had 57 bulk free and Janice 12, both stuffed with mushrooms.
export const CONJURED_WEAPON_BULK = 70;

// EVERY WEAPON `create weapon` CAN PRODUCE, AND NOTHING ELSE.
//
// `creaweap.kod` CastSpell rolls `iNum = Random(iSpellPower/3, iSpellPower)` and picks by
// band: mace under 20, short sword 20-29, hammer 30-44, axe 45-59, long sword 60-74,
// scimitar 75-94, mystic sword at 95 and over. So the spell is a slot machine over exactly
// these seven, and a ban list that forbids all seven makes every cast a certainty of waste:
// 15 mana, 70 bulk, and an item the character may not hold.
//
// AND IT GETS WORSE AS THE CASTER IMPROVES, which is the part that surprises people.
// `iSpellPower` is instrument bonus + maxHealth/12 + faction + GetSpellAbility/2
// (spell.kod:2095, :2205), so practising the spell raises the floor of the roll. Once
// spell power reaches about 135 the bottom of `Random(sp/3, sp)` clears 45 and MACE,
// SHORT SWORD AND HAMMER BECOME UNREACHABLE — the three cheapest weapons, and the two
// blunt ones this fleet needs for the skeleton family (skel.kod resists thrust 70 and
// takes 20% EXTRA from bludgeon). A practised caster can no longer conjure the weapon its
// own quarry calls for.
export const CONJURABLE_WEAPONS = Object.freeze([
  'mace', 'short sword', 'hammer', 'axe', 'long sword', 'scimitar', 'mystic sword']);

// How many unusable conjured weapons are enough to say the slot machine is not paying.
// Three, because one is bad luck and the failure this stops had TWENTY-FOUR: Rizzo, on
// prod 2026-09-18, stood bare in room 38 with 24 long swords its own ban list forbade and
// 14 mana against the 15 the spell costs.
export const CONJURE_HOARD_LIMIT = 3;

// WHERE THE TRAINING-WEAPON ROULETTE STOPS. A proficiency stroke improves only while the
// ability is under the TARGET's level (stroke.kod:115); this fleet's hardest quarry is the
// level-75 skeleton, and the operator set the goal at 70 on 2026-09-25. Past it the conjured
// weapon trains nothing and the priority list takes over again.
export const ROULETTE_UNTIL = 70;

// THE BANDS create weapon ROLLS OVER (creaweap.kod:66-107), for the odds in the note.
const CONJURE_BANDS = Object.freeze([
  ['mace', 0, 20], ['short sword', 20, 30], ['hammer', 30, 45], ['axe', 45, 60],
  ['long sword', 60, 75], ['scimitar', 75, 95], ['mystic sword', 95, Infinity]]);

/**
 * An ESTIMATE of this character's Create Weapon spell power and the chance of each weapon.
 * Kraanan (spell.kod:2066-2205): half the ability, plus the number of active holders in the
 * room bounded 0..30, plus health*10/max bounded 0..10; armour penalties count half. The room
 * count is read off the client's room objects and is approximate, so this is for the ledger
 * and the note, never a gate.
 */
export function conjurePowerEstimate(c, spell = null) {
  const ability = Number(skills.abilityOf(c, 'create weapon') ?? spell?.ability);
  const hp = c?.vitals?.()?.health ?? c?.vitals?.()?.hp ?? null;
  const crowd = Math.max(0, Math.min(30, Number(c?.room?.objects?.size ?? 0)));
  const healthBonus = hp?.max ? Math.max(0, Math.min(10, Math.floor((hp.value * 10) / hp.max))) : 10;
  const power = Number.isFinite(ability) ? Math.floor(ability / 2) + crowd + healthBonus : null;
  const chance = (name) => {
    const band = CONJURE_BANDS.find(b => b[0] === name);
    if (!band || !Number.isFinite(power) || power < 1) return null;
    const lo = Math.floor(power / 3), hi = power;
    const overlap = Math.min(band[2] - 1, hi) - Math.max(band[1], lo) + 1;
    return Math.max(0, overlap) / (hi - lo + 1);
  };
  return { power, crowd, chance };
}

// WHERE THE MONEY GOES. Jasper and Tos share one banking system, so either counter
// pays into the same balance and the only question is which is nearer — which really
// does flip across this fleet's rooms: Jasper is closer to the Merchant Way rooms,
// Tos to the gate rooms. Ko'catan keeps a separate account and is deliberately not
// here; banking into it would strand the money somewhere nobody goes.
export const BANKS = [
  { room: 54,  name: 'First Royal Bank of Tos' },
  { room: 376, name: 'The Royal Bank of Jasper' },
];

// WHERE A FULL PACK IS ACTUALLY WORTH SOMETHING.
//
// Roq — RID_ASSHQ, room 110, "A shadowy corner" in Barloque — is the only NPC known to
// buy an unlimited quantity of anything, and it is NOT IN THE MERCHANT INDEX: its class
// is Assassin, it has no for-sale list, and `merchants show:Roq` returns nothing. So the
// one general buyer in the world was invisible to every tool here while the fleet walked
// through its room all week carrying 1,868 units of unsold loot.
//
// Measured on the first sale ever made to it: Floyd handed over ten stacks for 4,793
// shillings and came away with its money, the armour on its back, its weapon, its food
// and the elderberry a crewmate wanted. That is the shape a town trip should have.
//
// A bank is where MONEY goes; this is where GOODS go. Which one a trip aims at depends on
// which threshold opened it — see bankRun.
// WHAT A TOWN TRIP IS FOR, by the trigger that opened it (checkIfShouldSell). `town_trip_opened`
// records both, so a trip can be judged against its purpose: a SELL trip should carry enough to be
// worth the road (MIN_SELL_TRIP_VALUE), a RESTOCK trip should buy enough not to repeat soon.
export const TRIP_PURPOSE = Object.freeze({
  load: 'sell', stacks: 'sell', unweighable: 'sell', broke: 'sell',
  supply: 'restock', food: 'food', standing_order: 'order', policy: 'policy', bank: 'bank',
  // Opened on demand (m59-town-favors.mjs): by the operator, or by a private `townTrip` strategy.
  operator: 'operator', strategy: 'strategy',
});
// Operator, 2026-09-27: "town trips should aim to be $10k+ if their purpose is for selling".
// Overridable per character as policy.minSellTripValue.
export const MIN_SELL_TRIP_VALUE = 10_000;
// A pack this full goes to market whatever it is worth: there is no room left to make it worth more.
export const SELL_REGARDLESS_AT = 0.97;

// WHEN A TRIP ALREADY GOING TO TOWN ALSO WALKS THE COUNTERS (Autopilot.packWantsMarket). Deliberately
// lower than a typical sellAtLoad: the trip is happening anyway, and the departure trigger is what
// the courier and overfarm holds are allowed to veto -- this is not.
export const MARKET_ALONG_AT = 0.85;
export const MARKET_ALONG_RELIEF = 0.25;      // selling frees this much capacity: always walk them
export const MARKET_ALONG_MIN_RELIEF = 0.05;  // near full but this little is sellable: do not
export const MARKET_STOPS = Object.freeze([
  { room: 113, name: "Fehr'loi Qan, Barloque" },
  { room: 109, name: 'Herbutte, Barloque', maxStack: 25 },
  { room: 104, name: 'Joguer, Barloque' },
]);
// A full pack needs all three specialists. The starting counter buys equipment;
// the persisted shopping cursor then visits gems and reagents, without Roq's route.
export const MARKETS = [MARKET_STOPS[0]];

// The bread. 103 is the one shelf in the world carrying cheese, meat pie, bread and
// apples together (144/144/108/45), and it is a short hop from Roq — so the sell leg and
// the eat leg are the same trip. Tos cheese at 112 for 30 vigor is cheaper per point,
// but Barloque is where the selling happens and a second town is a second walk.
export const FOOD_SHOP = { room: 103, name: 'The Bhrama & Falcon, Barloque' };
// MORE THAN ONE BREAD SHOP, NEAREST FIRST (operator, 2026-09-28: "There is a fence/wall blocking the
// door to Meidei's"). 103 was the ONLY food shop this keeper knew, so with its door fenced no keeper
// has bought food at all — and the troll crew's vigor followed the pie drops down. Solomon's Edibles
// (151, off Cor Noth) and Pietro's Wicked Brews (371, Jasper) both sell bread (m59-merchants.json);
// 103 stays last in case the fence comes down.
export const FOOD_SHOPS = Object.freeze([
  { room: 151, name: "Solomon's Edibles, Cor Noth" },
  { room: 371, name: "Pietro's Wicked Brews, Jasper" },
  FOOD_SHOP,
]);
export const FOOD_WORD = /cheese|pie|bread|apple|grape|edible mushroom|inky.?cap|stew|drumstick|turkey|pork/i;

// AND THE REAGENTS ARE NEXT DOOR, WHICH IS WHY THE HERBS RAN OUT WITHIN SIGHT OF THEM.
//
// The bread shop is an inn and an inn sells bread. `restockReagents` buys elderberry and
// herbs at whatever counter the trip happened to end at, and the two counters a town trip
// ends at are a bank and Roq — a bank is a bank, and Roq stocks nothing. So the fleet
// bought food and never once bought a reagent, and the two halves diverged in the way a
// one-sided flow always does: over four passes elderberry went 368 -> 406 -> 534 while
// herbs went 41 -> 33, because elderberry is what the hunting grounds drop and herbs are
// what `create food` burns two of. Sixteen castable pairs left out of a 534-berry pile.
//
// Joguer stands in 104, ONE ROOM from the bread shop, and sells both (m59-merchants.mjs
// who-sells herb). Barloque has the bread, the apothecary and Roq within a few rooms of
// each other, which is why every town leg in this file already points at that town.
// ONE TOWN'S ANSWER, SO THE KEEPER ENV MAY NAME ANOTHER. A fleet on a Tos graveyard
// shift was sent to Barloque for herbs across the lethal cross-country leg when Tos has its
// own apothecary (Frisconar, RID_TOSAPOTH = 53, one hop from Familiars). The room is the
// decision; the name is only what the journal prints. Unset, or anything that is not a
// positive room number, keeps Joguer — the same shape as M59_HOST / M59_RATE.
export function reagentShopFor(env = process.env) {
  const room = Number(env.M59_REAGENT_SHOP_ROOM);
  if (Number.isInteger(room) && room > 0)
    return { room, name: env.M59_REAGENT_SHOP_NAME || `apothecary (room ${room})` };
  return { room: 104, name: 'Joguer the apothecary, Barloque' };
}
export const REAGENT_SHOP = reagentShopFor();

// Independent purchase permissions owned by DUM strategies. `undefined` means the
// historical behaviour (enabled), so an older roster or a standalone keeper does not
// silently lose maintenance merely because it predates these switches.
export const purchaseEnabled = (policy, kind) => policy?.[{
  food: 'buyFood', weapons: 'buyWeapons', reagents: 'buyReagents',
}[kind]] !== false;
// The retreat line is intentionally independent of engageAt and vigor. Those decide
// whether to open a fight and whether to eat; neither means a healthy character should
// abandon a monster room. Exported because 89% vs a 90% engagement preference is the
// exact regression this distinction exists to pin.
export const belowRoomRetreatHealth = (health, restBelow) =>
  health != null && Number.isFinite(restBelow) && health < restBelow;
export const BARLOQUE_VAULT = { room: 114, name: "Obert Cair'bre's vault, North Barloque" };

// WHICH COUNTER A TOWN TRIP IS AIMED AT, AS ONE ORDERED ANSWER RATHER THAN A NESTED
// CONDITIONAL INSIDE A 200-LINE METHOD.
//
// Every door into a town trip has a different remedy and they are NOT interchangeable —
// this file already records what aiming a full pack at a banker cost (Camilla and Floyd
// at the Jasper counter with sixteen stacks each and nobody who would pay for any of it),
// and it cost the same again in the other direction when a REAGENT shortfall was aimed at
// a market, which sells nothing and buys only what you have. Written out as a table, the
// mismatches are visible; written inline, the supply row was simply never added.
//
// | door | what fixes it | counter |
// |---|---|---|
// | needs cash first | a withdrawal | a bank, and the shop is the last hop after it |
// | reagent floor | buying | the apothecary |
// | empty larder | buying | the bread shop |
// | full pack, or broke with goods | selling | Roq, the one NPC that pays |
// | rich | depositing | a bank |
//
// `richEnoughToBank` outranks the three shopping doors because a purse over the banking
// threshold is money that is dropped on death; the shops it was going to visit are all
// hung off the end of that same trip anyway.
export function townDestinations({ needsCashFirst = false, supplyTrip = false, starving = false,
                                   packFull = false, brokeWithGoods = false,
                                   richEnoughToBank = false } = {}) {
  if (needsCashFirst) return BANKS;
  if (packFull || brokeWithGoods) return MARKETS;
  if (richEnoughToBank) return BANKS;
  if (supplyTrip) return [REAGENT_SHOP];
  if (starving && !packFull) return [...FOOD_SHOPS];   // 103 alone is fenced (2026-09-28)
  return BANKS;
}

// IS AN EMPTY LARDER A REASON TO WALK TO TOWN? Only when the character's own fight floor is
// above what resting reaches. Resting stops at 80 of 200 (REST_VIGOR_CAP) and fightFloor()
// already falls back to STARVED_FIGHT_VIGOR with no food, so a character whose floor resting
// covers loses nothing by having no food -- it rests and swings. Sending it across the world
// for 450 shillings of apples is pure cost.
//
// Clifford, 2026-10-06: floor 80 (MIN_FIGHT_VIGOR; his own vigorFloor is 40), bank about
// 7,000 and falling, no reagents. TEN `trigger: "food"` trips in one day, every one "6%
// loaded, nothing to do", each buying ten apples or three meat pies off a small withdrawal,
// eaten before the next pass -- an hour on the road per trip, skeletons at Castle Victoria
// never farmed long enough to earn the next one. Food is still bought at the end of any
// trip opened for another reason, and a `townTrip` strategy or the operator can still ask
// for a food trip outright.
export function hungerNeedsTown(wantedFloor, vigorMax = 200) {
  return Number(wantedFloor) > REST_VIGOR_CAP * (Number(vigorMax) || 200);
}

export const MODES = ['survive', 'farm', 'idle', 'tick'];

// Farming patterns, as a table rather than scattered conditionals, so that adding a
// sixth is a row and so that the differences between them are readable side by side.
//
// The one thing they all share: what is being measured is MAX HEALTH GAINED PER
// HOUR, not kills. Kills are cheap to produce and easy to fool yourself with — a
// character killing something at or below its own level gains nothing at all.
export const STRATEGIES = {
  // WHAT THE VIGOR FLOORS NO LONGER VARY BY.
  //
  // These patterns used to disagree about how tired a character may be when it starts
  // a fight — baseline and fieldrest said "any", wellfed said 120, trader and coop
  // said 100 — and that comparison is finished. Nothing beats not fighting tired:
  // swinging costs about thirty vigor a minute, vigor sets how fast health returns
  // between fights, and a character that engages below the floor breaks off part-way
  // and then recovers slower than if it had simply waited.
  //
  // So every pattern now starts from MIN_FIGHT_VIGOR and the strategies differ only in
  // what they do about FOOD, which is the part still worth measuring: the floor is
  // reachable by resting, everything above it has to be eaten.

  // Control. Rest when hurt, fight from whatever vigor resting gives you.
  baseline: {
    vigorFloor: WANT_FIGHT_VIGOR, vigorCeiling: 200,
    eatBeforeFighting: true, restInTown: true, sellLoot: false,
    why: 'the obvious loop, and the thing every other pattern has to beat',
  },
  // Eat up to the stomach limit before going back out. Costs food; buys a faster
  // health regeneration rate and more margin in every fight.
  //
  // A ZONE, NOT A THRESHOLD. See provision() — the point of the ceiling is to set out
  // at the top of the band with an empty enough stomach to keep eating while
  // fighting, so the fighting stretch lasts as long as the food does.
  wellfed: {
    vigorFloor: WANT_FIGHT_VIGOR, vigorCeiling: 200,
    eatBeforeFighting: true, restInTown: true, sellLoot: true,
    why: 'vigor sets the regeneration rate, so being well fed should mean both ' +
         'shorter recovery and more survivable fights — at the cost of food',
  },
  // Never walk back to town. Withdraw within the hunting area and rest there.
  fieldrest: {
    vigorFloor: WANT_FIGHT_VIGOR, vigorCeiling: 200,
    eatBeforeFighting: true, restInTown: false, sellLoot: false,
    why: 'a town trip is several minutes of walking each way at one square a second; ' +
         'this trades safety and shopping for never paying that',
  },
  // The full economic loop: haul loot back, sell it, spend it on food, stay fed.
  trader: {
    vigorFloor: WANT_FIGHT_VIGOR, vigorCeiling: 200,
    eatBeforeFighting: true, restInTown: true, sellLoot: true,
    maxCarry: 40,
    why: 'tests whether the money loop pays for itself — reagents and drops fund the ' +
         'food that funds the vigor that funds the uptime',
  },
  // Cooperative: heal each other, and hand herbs to the Shal'ille casters who need
  // them rather than selling into an NPC spread.
  coop: {
    vigorFloor: WANT_FIGHT_VIGOR, vigorCeiling: 200,
    eatBeforeFighting: true, restInTown: true, sellLoot: false,
    medic: true, share: true,
    why: 'an NPC buys low and sells high; two players trading a herb for a loaf both ' +
         'do better than either does against that spread',
  },
};

// AN EXPLICIT BROKER THRESHOLD IS THE FLOOR, AND IT HAS TO OUTRANK THE STRATEGY.
//
// `fight_above_vigor` was advertised as the value a keeper eats to before fighting, and
// then stored only in the legacy `fightAboveVigor` field — which fightFloor() consults
// LAST, behind `plan.vigorFloor`. Every strategy in the table sets `vigorFloor`, so the
// public argument was never once the number that decided anything.
//
// THE CEILING IS DELIBERATELY LEFT ALONE, and an earlier version of this clamped it to
// the same value. A ceiling equal to the floor turns provisioning into a threshold, and
// the whole point of the band is stated in `wellfed`: set out at the TOP of it with an
// empty enough stomach to keep eating while fighting. Health returns as
// ((200-vigor)^2/6 + 1000) ms a point, so pinning a character at its floor throws away
// most of the regeneration rate it just paid food for. The symptom that motivated the
// clamp — a character at 127 sitting in an inn waiting on the strategy's 200 — is
// shouldWaitForProvision()'s job, and it now sets out once the floor is satisfied and
// the next mouthful is far away.
export function applyFightAboveVigor(policy, value) {
  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 200)
    throw new Error('fight_above_vigor must be a finite number from 0 to 200');
  policy.fightAboveVigor = threshold;
  policy.vigorFloor = threshold;
  return policy;
}

// A FLOOR THE CHARACTER CANNOT REACH IS NOT A THRESHOLD, IT IS A DEADLOCK.
//
// Resting stops awarding vigor at REST_VIGOR_CAP of the bar — 80 of 200 — and everything
// above that has to be EATEN. So a fighting floor above `rest cap + what is in the pack` is
// a number no action available to the keeper can satisfy, and holding out for it idles the
// character for ever.
//
// `fightFloor` already had an escape hatch for this and it was BINARY: empty larder, drop to
// the starved floor. That misses the case the operator hit — the larder is not empty, it is
// just too small. Baseline floor 140, one mushroom worth 50, resting caps at 80: 130 is
// everything the character can reach and the hatch never fires because the pack is not bare.
// It sat there repeating "too tired to start a fight" against a number it could not make.
//
// Returns what is actually reachable, never raising a floor that was already low enough.
// The cap scales with the bar rather than assuming 200, because the same arithmetic has to
// hold for a character whose maximum is not 200.
export function reachableFightFloor(floor, maxVigor = 200, foodVigor = 0, restCap = REST_VIGOR_CAP) {
  const restCeiling = (Number(restCap) || REST_VIGOR_CAP) * maxVigor;
  return Math.min(floor, restCeiling + Math.max(0, Number(foodVigor) || 0));
}

// THE SQUARES OTHER PLAYERS ARE STANDING ON, AND THE ONES NEXT TO THEM.
//
// A wall square is only worth walking to if the walk can end on it, and the one thing the
// fine walker cannot route around is a body: it fans, slides, and shuffles (see walkFine).
// So a spot occupied by another player — or adjacent to one, because the approach step
// lands there first — is excluded from selection for THIS pass, exactly as a square we
// recently failed to reach is. It is not remembered: people move, and the next pass asks
// again. `playersOnline` preserves identity through Morph, which deliberately removes the
// OF.PLAYER bit from the room object. Players only, never monsters — a monster next to a
// wall is what the wall is for.
//
// Measured 2026-08-26, Castle Victoria: six fleet characters converged on one corner and
// stood in each other's way, two of them on the same square, all "NOT MOVING".
// The returned exclusion keys are serialized 1-based public squares: "col,row".
export function crowdedSquares(objects, selfId, { radius = 1, playersOnline = null } = {}) {
  const out = new Set();
  const list = objects instanceof Map ? [...objects.values()] : (objects || []);
  for (const o of list) {
    const truePlayer = !!(o?.flags & OF.PLAYER) || !!playersOnline?.has?.(o?.id);
    if (!o || o.id === selfId || !truePlayer) continue;
    if (!Number.isFinite(o.col) || !Number.isFinite(o.row)) continue;
    for (let dc = -radius; dc <= radius; dc++)
      for (let dr = -radius; dr <= radius; dr++)
        out.add(`${o.col + dc},${o.row + dr}`);
  }
  return out;
}

/**
 * WHAT GOES QUIET WHEN A REAGENT RUNS OUT.
 *
 * Cited, because "short of orc teeth" means nothing to a reader who does not already know the
 * spell list, and the entire point of publishing a shortage rather than retrying a purchase is
 * that somebody can act on it. A character that cannot get orc teeth is not broken; it is a
 * character that cannot cast super strength.
 */
export const REAGENT_BLOCKS = {
  'orc tooth': 'super strength (2 mushroom + 1 orc tooth, persench/strength.kod:57-64)',
  'sapphire': 'bless (2 mushroom + 2 sapphire, persench/bless.kod:64-70)',
  'fairy wing': 'holy weapon (3 fairy wing + 1 orc tooth, holywp.kod:60-62)',
};

/**
 * WHICH REAGENTS THIS CHARACTER MAY BUY, AND WHERE THE REST COME FROM.
 *
 * MEASURED ON PROD, 2026-09-18. Robin's shopping plan came to 39,124 shillings against a purse of
 * 618; 33,600 of it was 180 sapphires and 150 orc teeth. The guild chests, cached the same
 * afternoon, held 503 sapphires, 460 mushrooms and 202 orc teeth. Ten of twenty-one characters sat
 * in `poor_farming.active` and eleven carried `purchase_funding.status: "unaffordable — returning
 * to farming"`, a status that RETRIES rather than stopping. Lew made 26 journeys in 90 minutes,
 * every one to a shop, and reached his station ONCE.
 *
 * THE DECISION DOES NOT LIVE HERE ANY MORE, and that is the point. It was a hardcoded set naming
 * orc teeth, which made one fleet's economy a fact about the source tree. It is now the GUILD's,
 * in its own plan file, with a default and per-reagent overrides — `reagentSource` in
 * m59-guildwants.mjs — because whether a guild can supply its own reagents is a fact about that
 * guild's hall, not about this repository.
 *
 * `chest` is one setting with two halves and is meaningless without both: take it from the chest
 * instead of buying, AND put it in the chest instead of selling. A merchant buys at ~60% and sells
 * at ~140%, so a reagent that goes over a counter and comes back has cost 2.3x its own value. The
 * selling half is `chestSourcedNames`, which joins `protectedItemNames`.
 */
export function reagentBuyAllowed(policy, item, plan = null) {
  if (!purchaseEnabled(policy, 'reagents')) return false;   // the class switch still outranks all
  return reagentSource(item, { plan, policy }) === 'buy';
}

/**
 * Split a want list three ways by how each item is to be acquired.
 *
 * A PURE FUNCTION AND AN EXPORTED ONE, because the alternative is a filter inlined in a method
 * that needs a live Autopilot to reach, and an untestable refusal is the kind the next person in
 * a hurry deletes. It returns ALL THREE groups, never only the survivors: a line that silently
 * vanishes from a shopping list is indistinguishable from one nobody wanted.
 */
export function splitBySourcing(requests = [], { policy = null, plan = null } = {}) {
  const buy = [], stockpile = [], off = [];
  for (const r of (Array.isArray(requests) ? requests : [])) {
    if (!r || !r.item) continue;
    if (!purchaseEnabled(policy, 'reagents')) { stockpile.push(r); continue; }
    const mode = reagentSource(r.item, { plan, policy });
    (mode === 'buy' ? buy : mode === 'off' ? off : stockpile).push(r);
  }
  return { buy, stockpile, off };
}

// THE MOVEMENT INCIDENT a failed keeper journey, a wedge given up on, or a stall with no lever
// leaves behind (m59-movement-incidents.mjs). A module function rather than only a method, so a
// test's stand-in keeper running `Autopilot.prototype.travel` reaches it too.
export function journeyIncident(ap, { kind = null, outcome = {}, to = null, startedIn = null, startedAt = 0,
                            startAt = null, origin = null, route = null, legs = null,
                            hpStart = null, hpMax = null } = {}) {
  try {
    const s = ap?.s, c = s?.client, me = c?.self;
    const cancel = (s?.lastMovementCancel?.at ?? 0) >= startedAt ? s.lastMovementCancel : null;
    const hops = Array.isArray(route?.hops) ? route.hops : [];
    const stage = (Array.isArray(outcome?.refusals) ? outcome.refusals : []).find(r => r?.stand_on)?.stand_on
      ?? (Number.isFinite(Number(legs)) ? hops[Number(legs)]?.stand_on : null) ?? null;
    const here = s?.world?.room ?? null;
    const objs = [...(c?.room?.objects?.values?.() ?? [])]
      .filter(o => o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER));
    const v = c?.vitals?.() ?? {};
    recordMovementIncident({
      agent: ap?.name ?? s?.name ?? null, character: c?.me?.name ?? null,
      kind: kind ?? classifyJourneyFailure(outcome, cancel), source: 'keeper',
      reason: outcome?.reason ?? outcome?.why ?? null,
      deviation: outcome?.deviation ?? ((s?.lastMovementDeviation?.confirmation?.asked_at??0)>=startedAt?s.lastMovementDeviation:null),
      room: here ? { num: here.num, name: here.name ?? null } : null,
      from: startedIn, start: startAt,
      end: me ? { room: here?.num ?? null, row: me.row, col: me.col, x: me.x, y: me.y } : null,
      target: { room: to, name: hops.at(-1)?.to_name ?? null,
                ...(stage ? { row: stage.row, col: stage.col, kind: 'exit_stage' } : {}) },
      route: { planned: hops.length ? [hops[0]?.from, ...hops.map(h => h?.to)] : null,
               legs_done: legs, hop_index: legs, next_hop: hops[Number(legs)]?.to ?? null },
      refusals: Array.isArray(outcome?.refusals) ? compactRefusals(outcome.refusals) : null,
      origin, cancel: cancel ? { ...cancel, summary: describePreemption(cancel) } : null,
      trail: ap?.watch?.pulses ?? null,
      vitals: { health: v.health?.value ?? null, max_health: hpMax ?? v.health?.max ?? null,
                health_at_start: hpStart, vigor: v.vigor?.value ?? null },
      threats: { count: objs.length,
                 names: [...new Set(objs.map(o => c?.rsc?.get?.(o.nameRsc) ?? o.name).filter(Boolean))] },
      ms: startedAt ? Date.now() - startedAt : null,
      epoch: epochId('movement'),
    });
  } catch (e) { if (process.env.M59_INCIDENT_DEBUG) console.error('[incident]', e); }
}

// Fine-route scripts own a whole journey, including gaps between walking legs.
// Apply the same optional arm=false doctrine as ordinary/suspended travel.
export function scriptedWalkDefersArming(pilot){
 const owner=pilot.facultyOwner?.('movement');
 return pilot.mode==='idle'&&typeof owner==='string'&&owner.startsWith('fleetscript:')&&
  pilot.facultyOwner?.('work')===owner&&pilot.travelGuard().arm!==true;
}

// A healthy scripted idle journey uses the normal travel vigor reserve.
// A small vigor deficit below the resting cap is not an urgent recovery while
// it still has the normal road reserve. Health, ailments and exhaustion retain
// the keeper's recovery behavior; farming and foreign leases never use this.
export function scriptedWalkDefersVigorRest(pilot,v){
 const owner=pilot.facultyOwner?.('movement');
 if(pilot.stopping||pilot.mode!=='idle'||pilot.suspendedJourney||pilot.inert?.travelling||pilot.recoverUntilWhole||
    typeof owner!=='string'||!owner.startsWith('fleetscript:')||pilot.facultyOwner?.('work')!==owner||
    typeof pilot.facultyHeld!=='function'||['survival','recovery','combat'].some(k=>pilot.facultyHeld(k))||pilot.s?.combat?.active?.pvp||
    (pilot.s?.client?.ailments?.()??[]).length)return false;
 const hp=v?.health,vigor=v?.vigor?.value,floor=Math.max(pilot.policy?.travelVigorFloor??TRAVEL_VIGOR_FLOOR,pilot.policy?.ordinaryVigorFloor??ORDINARY_VIGOR_FLOOR);
 return Number.isFinite(hp?.max)&&hp.max>0&&Number.isFinite(hp.value)&&hp.value>=hp.max&&Number.isFinite(vigor)&&vigor>=floor;
}

// The farm rung already owns its effective fight/food floor. Do not send a
// healthy, armed farmer to a wall for the last few vigor points above that floor.
export function farmVigorWorkReady(pilot,v){
 const s=pilot.s,c=s?.client,h=v?.health,raw=v?.vigor?.value;
 if(pilot.mode!=='farm'||!pilot.policy?.hunt||pilot.stopping||pilot.inert||pilot.suspendedJourney||pilot.recoverUntilWhole||s?.combat?.active||s?._rite||
    !c?.combatReady||c.state!=='game'||c.self?.predicted||!c.self||!Number.isFinite(c.inventoryAt)||!Number.isFinite(h?.max)||!(h.max>0&&h.value>=h.max)||!Number.isFinite(raw)||
    (c.ailments?.()??[]).length||pilot.checkFreeze?.()||typeof pilot.facultyHeld!=='function'||['work','movement','survival','recovery','combat'].some(k=>pilot.facultyHeld(k))||
    pilot.armedForSure?.()!==true||pilot.policy.assignedRoom!=null&&Number(pilot.policy.assignedRoom)!==Number(s.world?.room?.num))return false;
 const d=currentSurvivalDecision(s);if(['turn_required','frozen_without_action'].includes(d?.phase))return false;
 const quarry=skills.findCreature(s,pilot.policy.hunt,{match:pilot.huntMatch()}).some(o=>Math.hypot(o.col-c.self.col,o.row-c.self.row)<=8);if(!quarry)return false;
 const floor=Number(pilot.fightFloor()),cap=Number(pilot.restVigorCeiling())*200;
 return Number.isFinite(floor)&&Number.isFinite(cap)&&raw>=Math.max(pilot.policy.ordinaryVigorFloor??ORDINARY_VIGOR_FLOOR,Math.min(floor,cap));
}

export class Autopilot {
  constructor(session, { mode = 'survive', policy = {} } = {}) {
    this.s = session;
    this.healingWands = new HealingWands();
    this.potionFreshness = new PotionFreshness();
    this.farmWandSupport = new FarmWandSupport(this);
    session.healingWandTick = cancelled => this.useHealingWand(cancelled);
    session.activeSelfHealTick = trigger => this.activeSelfHealing(trigger);
    // Every equipBest on this session ranks with the book's magic readings (see syncMagicSet).
    if (session) session.beforeEquip = (c) => this.syncMagicSet(c);
    // THE SPARE LIST IS READ BY THE SESSION, because the attack veto and findCreature live there
    // and every swing reaches them (m59-spare.mjs). Read live, so a push or a farm strategy applies
    // on the next swing without a restart.
    if (session) session.sparePatterns = () => this.policy?.spareCreatures ?? null;
    // AND EVERY equipBest ON THIS SESSION ASKS WHETHER THE HAND IS MEANT TO BE EMPTY. Ten call
    // sites equip — a gift, a rescue plea, a magic swap, `equip_best` — and a touch-spell trainer
    // on its own ground must not have any of them put a weapon back in its hand, because a
    // wielded weapon is swung INSTEAD of the touch (player.kod:4712-4729). One veto, at the one
    // function they all share, rather than ten guards that drift.
    if (session) session.equipVeto = () => this.touchEquipVeto();
    // AGAINST TROLLS A MYSTIC SWORD IS ALWAYS A CANDIDATE (skills.isMysticSword), asked at the same door.
    if (session) session.equipTrollQuarry = () => this.huntsTrolls();
    // AND A HAND THAT WILL NOT LET GO IS A CURSE SUSPECT, whichever of the ten call sites heard it.
    if (session) session.onCursedInHand = (items, said) => this.noteCurseSuspect({ items, said, certain: true });
    // AND WHICH WEAPONS IT MAY CHOOSE AT ALL, from the same one place (`trainingWeaponOnlyNow`).
    if (session) session.equipOnly = () => this.trainingWeaponOnlyNow();
    attachReplayRecorder(session,this);
    attachSurvivalTrace(session, this);
    this.survivalRecorder = createSurvivalDecisionRecorder(session.name);
    attachSurvivalDecisions(session, { epoch:epochId('movement'),
      onCancel:(why,d) => this.replacementSurvivalChoice(why,d),
      record:row => {
        this.survivalRecorder(row);
        session.replayRecorder?.decision(row);
        traceSurvival(session, 'survival_decision_'+row.event, {
          id:row.decision.id,strategy:row.decision.strategy,reason:row.decision.reason,
          chosen_at:row.decision.chosen_at,status:row.decision.status,
          chosen_refuge:row.decision.chosen_refuge,replacement_id:row.decision.replacement_id,
          outcome:row.decision.outcome,cancel_reason:row.decision.cancel_reason });
      } });
    this.mode = mode;
    this.policy = {
      // Rest when health OR vigor falls below this and nothing is attacking us.
      restBelow: 0.7,
      // Opt in locally when the fleet has healing wands to spend. Zero disables.
      healWandBelow: 0,
      // Break off and withdraw at this. Deliberately higher than fight()'s own
      // threshold: the keeper is not watching a fight, it is watching a character.
      fleeBelow: 0.4,
      // What to hunt in `farm` mode. Never guessed — if it is empty, farm does nothing.
      hunt: null,
      // WHAT THE FARMING IS FOR — 'money' | 'items' | 'advance' | null. See scorePrey in
      // m59-spawns.mjs, which is where the rules live.
      //
      // This does NOT make the keeper choose prey. `hunt` is still never guessed, and
      // still only changes when someone changes it over MCP; the trade-off between money,
      // items and advancement is a decision about what a character is FOR, and the keeper
      // has no business inventing one.
      //
      // What it buys is the check in yieldCheck(): whether the thing we are already
      // killing still pays for the thing we said we were farming. That gap is the reason
      // this exists. A keeper grinding worthless prey looks EXACTLY like a healthy one —
      // it kills something every pass, so progress() fires, so the stall detector never
      // trips, and the board reads `hunting: giant rat` for as long as you leave it.
      // Twenty-one characters can farm nothing for an afternoon that way.
      purpose: null,
      // What `purpose: 'advance'` is trying to raise:
      //   [{ kind: 'hp' },
      //    { kind: 'skill', name: 'slash' },
      //    { kind: 'spell', name: 'blast', ability: 20, requisite: 25 }]
      // Empty means the check cannot run and says so, rather than passing silently.
      goals: [],
      // Stop farming when carrying this many things, so the character does not spend
      // an hour filling up and dropping the overflow.
      maxCarry: 14,
      // Shelter farming cannot pay for a market trip every time the pack gets heavy.
      // When set to a fraction such as .75, shed one expendable, lowest-value load at a
      // time until both weight and bulk are back below the fraction. null preserves the
      // ordinary sell/bank economy. Food, reagents, worn/protected items and useful gear
      // are never candidates; if those alone bind, the keeper reports that instead of
      // stripping its survival kit.
      dropAtLoad: null,
      // Items a directional strategy is accumulating. The keeper treats these as
      // collection stock rather than food or loot and stores them during Barloque loops.
      vaultItems: [],
      // Temporary cargo that must survive eating, selling, gifting and dropping, but
      // must stay in the pack. Unlike vaultItems this is never deposited: faction
      // errands use it for the item that has to be offered to a quest recipient.
      protectedItems: [],
      // Cursed items this character may loot (see lootFloor's NEVER PICK THESE UP). Empty
      // refuses both, which is every character that is not a Shal'ille trainee.
      pickupCursed: [],
      // Total weapons retained after a merchant visit, including the equipped one.
      // Two means the weapon in hand and one best spare under weaponPriority.
      maxWeapons: 2,
      // Paying a merchant is independently selectable from creating, looting, sharing,
      // eating, or equipping the same item classes.
      buyFood: true,
      buyWeapons: true,
      buyReagents: true,
      // Independent DUM coordination strategies. null is deliberately inert: assigning
      // either strategy is what widens the keeper's behaviour, not merely installing it.
      movementRegion: null,
      farmCleanup: null,
      farmDelivery: null,
      // SIFT MORE THAN THE PACK HOLDS AND CARRY THE BEST OF IT. Inert as null like its
      // neighbours: a character with no overfarm policy loots exactly as this fleet always
      // did — everything, nearest first, until the pack is full. See m59-overfarm.mjs.
      overfarm: null,
      // Cast the Kraanan personal enchantments on whoever else is in the room. null is
      // inert like its neighbours: holding the spells is not the instruction, being posted
      // as the group's caster is. Shape: { enabled, spells: [...], gap_ms, mana_floor }.
      buffAllies: null,
      // Practise spells at a post while nothing needs us, keeping back two casts of the desk's
      // dearest service. null is inert. See m59-deskpractice.mjs and practiceAtDesk().
      practiceSpells: null,
      // WHICH HEALS THE KEEPER MAY CAST, on itself or an ally: a list of spell names, or null for every heal it knows.
      // One drill can own a heal spell: Pepe's hospice practice wants hospice and nothing else (2026-10-26).
      healSpells: null,
      // THE BUDDY SYSTEM (m59-buddy.mjs, passBuddy): { pairs: { tagger: killer }, wait_s, tries,
      // reach, quarry }. A tagger lands one blow on an untouched monster and waits at its wall for
      // its fixed partner to kill it, which credits the tagger's max-health roll without its karma
      // moving. null is inert: no stage runs and no attack is vetoed.
      buddy: null,
      // After a death to a PLAYER, how long before this keeper may set out for a farming room
      // (m59-pvp-return.mjs). null means the committed default. It has to be a key HERE: a keeper
      // applies a pushed order only for fields this object names, so without it the broker's
      // pvp_return_delay_ms was recorded nowhere and pushed nowhere (2026-10-01).
      pvpReturnDelayMs: null,
      // WHERE THIS CHARACTER MAY FIGHT A PLAYER AT ALL: map room numbers (room.num). null or []
      // is every room, the behaviour before the key existed. Set, every player-engaging path —
      // return fire, war on sight, defendAgainstPlayers, player targets, the fight-back edict's
      // player rows — refuses outside the list, and the survival ladder is untouched
      // (m59-pvp-rooms.mjs; operator, 2026-10-11: "stop people from fighting back outside of
      // 599/2/38"). A key HERE for the same reason as pvpReturnDelayMs above.
      pvpRooms: null,
      // LOUD PVP (m59-pvp-callout.mjs): say a line out loud when a hostile player enters our map, from
      // substrate/pvp-callouts.json. Off by default -- silence is the behaviour that was already there.
      pvpLoud: false,
      // TRAIN A TOUCH SPELL BY SWINGING IT — 'acid touch', 'touch of flame', 'holy touch',
      // 'icy fingers', 'zap', or null (inert). On the assigned farm room in farm mode the keeper
      // keeps the hand EMPTY (a wielded weapon suppresses the touch, player.kod:4712-4729) and the
      // buff ON, recasting it on itself when the server says it stopped or a swing reads "Your
      // punch". Off that room every ordinary arming rule stands. See m59-touchspell.mjs. It has to
      // be a key HERE, like pvpReturnDelayMs above, or a pushed order is reflected nowhere.
      touchSpell: null,
      // WHEN the touch is cast: 'on_target' (null, the default) also casts as soon as the farm pass
      // CHOSE its next quarry — before the approach — and refreshes a buff that may be about to
      // lapse; 'before_swing' casts only before a swing. Operator, 2026-10-02. m59-touchspell.mjs.
      touchSpellTiming: null,
      // AN ORDER OVER THE HUNT SET, and a per-creature loot allow list. Both null (inert), both
      // keys HERE for the same reason as touchSpell. huntPriority: ['spider', 'living tree'] takes
      // the first-listed creature the keeper may already engage (m59-hunt-priority.mjs); lootOnly:
      // { spider: ['purple mushroom'] } takes only those from that creature's kill
      // (m59-loot-filter.mjs). Operator, 2026-10-02, for Kermit in Faronath.
      huntPriority: null,
      lootOnly: null,
      // CREATURES NEVER SWUNG AT, even when they attack (m59-spare.mjs): ['spider'] keeps the Icky
      // Cave's spiders alive so they fill its spawn cap and no orc can spawn (operator, 2026-10-02).
      // A filter on targets and on the attack packet; survival (rest, flee, recover) is unchanged.
      spareCreatures: null,
      // WHAT TO DO WHEN A SPARED CREATURE IS THE THING IN THE WAY (m59-spare.mjs spareBlockerMode):
      // null leaves it to the movement ladder; 'lure' backs off so it follows us out of the needle;
      // 'provoke' swings once first. See `lureSparedBlocker`.
      spareBlockers: null,
      // THE FARMING STRATEGY ASSIGNED TO THIS CHARACTER, by name: substrate/farm-strategies/<name>.mjs
      // (m59-strategy-engine.mjs). null is none. NOT `strategy` below, which picks a STRATEGIES
      // pattern like 'fieldrest'. Only this name is pushed and carried; the file's own keys are
      // laid over this object by the engine on every pass and never persisted.
      farmStrategy: null,
      // Take reagents from a fleetmate without negotiating. The provider half of a
      // fleet service: null is inert, an object is { enabled, reagents, drop_for_space,
      // min_bulk_free }.
      acceptDonations: null,
      // LOOT EJECTION (m59-loot-eject.mjs): { enabled, to: [station, courier], every_s, batch }. Off by default.
      lootEject: null,
      // AN ERRAND'S PURSE LEASE (m59-purse-lease.mjs): { carry, until, owner }. While live, no banking rule takes it.
      purseLease: null,
      // Weapons never to draw. null means no prohibition, which is what every doctrine
      // written before this expects.
      bannedWeapons: null,
      // A daily share of actual sale proceeds paid to Frular for guild rent. null is
      // inert; DUM's independent Guild Tithe strategy installs the settings object.
      guildTithe: null,
      // Null, not {enabled:false}: absent means the fleet has no guild wants at all, which
      // is a different thing from having them switched off, and only the first should be
      // silent on the board.
      guildWants: null,
      reagentCoop: null,
      // Opt-in detailed, short-lived activity records. DUM owns this object and leaves
      // it null unless the independent Detailed strategy stats strategy is checked.
      strategyStats: null,
      // WHICH WEAPON TO REACH FOR. null ranks by the character's proficiency in each
      // weapon's own skill (m59-skills.mjs weaponRanking). A list of name fragments
      // overrides it — ['axe'] trains the axe on a character who would otherwise wield
      // its 90% sword for ever, because ranking by proficiency is a feedback loop that
      // only ever rewards what you are already good at.
      weaponPriority: null,
      // Optional practice regimen. `alternate` keeps one style for the lifetime of a
      // quarry, then flips for the next one; changing hands while a creature is still
      // alive would reset the target/advancement flags the regimen is meant to train.
      trainingStyle: 'normal',
      // ONLY THE TRAINING WEAPON MAY BE WIELDED while the armed style is in force (`trainingWeaponOnly`,
      // see `trainingWeaponOnlyNow`). Off by default: silence is the old ranking.
      trainingWeaponOnly: false,
      // THE ROAD INTO THE STATION (`approachLegs`): rooms walked in order by a journey to the station that
      // starts outside the confinement. null: the router's own road.
      approachRooms: null,
      // PULL EVEN WHEN THE ROOM IS CROWDED, and then the closest qualifying target (`pull`, `closestPullable`).
      // Off by default: the crowd refusal is the old behaviour.
      pullThroughCrowd: false,
      // PREFER A WEAPON READ AS MAGIC over a mundane one of the SAME priority rank. Off by
      // default and inert when off. A troll resists ATCK_WEAP_NONMAGIC 80 (troll.kod:64-67), so
      // on that quarry the enchanted twin is five times the weapon; the Ukgoth Trolls strategy
      // turns this on. It never outranks the priority itself — see weaponRanking.
      preferMagicWeapon: false,
      // THE OPPOSITE TIE-BREAK: a mundane twin over a magic one inside the family (`syncMagicSet`, the ranking in
      // m59-skills weaponRanking). For a crew that keeps its dedicated weapon for trolls only. Off by default.
      preferMundaneWeapon: false,
      // KILL WHAT WE DO NOT WANT, TO KEEP THE ROOM PRODUCING WHAT WE DO. The spawn cap
      // is a room-wide total, so a creature we step over is a slot our prey cannot use.
      // Off makes the keeper ignore weak creatures and slowly suffocate its own hunting
      // ground, which is what it did.
      clearWeak: true,
      // The karma school this character is protecting: 'good', 'evil', 'neutral', or
      // null for none. Only ever used to REFUSE a kill — it never picks prey.
      karma: null,
      // Drop junk, and weapons the server has told us are broken. A broken weapon is
      // NOT renamed (weapon.kod:788 changes only the icon), so it keeps out-scoring the
      // working one in the pack and cannot be recognised except by having been refused.
      dropJunk: true,
      // How often to look for and drop broken gear, independently of the pack being full.
      dropBrokenEverySec: 120,
      // How many COMPLETE pulls that never turn into a fight before the keeper stops
      // standing here and picks somewhere else. It WRITES NOTHING DOWN — see the note on
      // pullDidNotConvert, and `barrenSpotsBeforeRoomDecision`, which used to live beside
      // this and turned three such squares into a verdict on the whole room.
      pullsBeforeMovingOn: 4,
      // Give the quarry enough time to walk the same ground we just crossed. Decisions
      // run every second, while one square of movement takes about a second; counting
      // the very next decision as a failed pull condemned distant but working walls.
      pullFollowMinMs: 8_000,
      pullFollowPerStepMs: 1_100,
      pullFollowMaxMs: 60_000,
      // WHICH MOVEMENT GRID THE SERVER PUTS MONSTERS ON. room.kod:2102 reads one
      // server-wide setting: 0 LOS_OLD (default — everyone coarse), 1 monsters fine,
      // 2 players fine, 3 both. Getting this wrong in the permissive direction is what
      // put five characters on a clifftop, so it defaults to the server's own default
      // rather than to the value that would let the keeper roam most freely.
      los: 0,
      // DECIDING IS FREE. ASKING IS NOT. These were the same number and should never
      // have been.
      //
      // A pass used to open with roomContents() + stats(1) — two requests and up to
      // four seconds waiting for the replies — so re-deciding meant re-polling, and
      // eight seconds between decisions looked like the price of not hammering the
      // server. It was not. The server PUSHES the world: BP.CREATE adds an object to
      // room.objects, BP.REMOVE deletes it, BP.MOVE moves it, and stats arrive on
      // change. The client's map is already live between polls; roomContents is a
      // RESYNC against drift, not the source of truth.
      //
      // And the poll is not passive. It counts as an action and calls
      // NotifyMonstersOfPresence — which is why playing dead forbids it. Polling every
      // second would wake the room eight times as often, in a safe spot whose entire
      // value is that nothing attacks until you swing.
      //
      // So: decide often on what we already know, resync rarely.
      decideMs: 1000,
      // How often to re-ask the server for the room and our stats. Drift correction:
      // a push can be missed, and a character that has been acting on a stale map is
      // the failure this guards against. Unchanged from the old pass interval, because
      // that cadence was never the problem.
      resyncMs: 8000,
      // Kept so an existing roster, and anything that set it, still means something.
      // Read as the resync interval — which is what it always actually controlled.
      idleMs: 8000,
      // Move to a neighbouring room when this one has nothing left to hunt. Monsters
      // do come back, but slowly, and a keeper that stands in a cleared room for an
      // hour is not managing anything. Off by default: wandering changes where the
      // owner left their character, which is a surprise, so it is opted into.
      roam: false,
      // How many empty passes to tolerate before moving on.
      roamAfterEmptyPasses: 3,
      // Never wander further than this from where roaming began, so a character can
      // still be found. Counted in rooms travelled, not distance.
      roamLimit: 6,
      // How far above the character's own level the toughest thing a room can
      // generate is allowed to be. See preyRooms.
      maxThreatOver: 6,
      // HOW FAR ABOVE ITS OWN LEVEL A CHARACTER MAY FIGHT, AS A PROPORTION.
      //
      // This replaced `maxThreatOver`, which was a flat number of levels added to max
      // health, and a flat number cannot be right at both ends of a roster: +24 is a 53%
      // widening for a character at 45 and a 27% one at 88, so the same policy was reckless
      // for the small and timid for the large. 150% is the same bet at every level.
      // Either a PROPORTION of max health or a FLAT number of levels above it, and the mode
      // is explicit so the two can never silently disagree. Percent is the default because
      // a flat band is a different bet at each end of a roster — +24 widens a 45-health
      // character by 53% and an 88-health one by 27% — but flat is the right answer when a
      // fleet is levelling past a fixed prey and wants the band to stop growing with it.
      threatCeiling: { mode: 'percent', value: 150 },
      // WHERE THIS CHARACTER IS SUPPOSED TO FARM. null means "wherever ranks best".
      //
      // Without it a fleet cannot be spread out, and not because anyone moves it back
      // by hand — the keeper does it. Standing anywhere its prey does not spawn (a
      // town, an inn, the room it woke up in after dying) the keeper leaves for
      // preyRooms()[0], and that is the same room for every character hunting the same
      // thing. Twenty-one characters were placed across six rooms and were back in two
      // within the hour, one death at a time, each one individually behaving correctly.
      //
      // Set this and the keeper goes HERE instead. It still refuses a room that cannot
      // generate the prey — an assignment is a preference, not a way to make a
      // character stand in a shop for ever.
      assignedRoom: null,
      // WHICH FARMING PATTERN THIS CHARACTER IS RUNNING. These exist to be compared
      // against each other — the ledger records the strategy with every sample, so
      // `history` can report health gained per hour by strategy rather than anyone
      // having to argue about which ought to work. See STRATEGIES below.
      strategy: 'baseline',
      // Vigor to reach before picking a fight. Resting alone tops out at the rest
      // threshold (80 of 200); anything above it has to be eaten.
      fightAboveVigor: MIN_FIGHT_VIGOR,
      // A confirmed supply shortfall sends the farmer back to earning at a restable floor.
      poorFarming: true,
      noFoodVigorFloor: 70,
      poorSupplyRetryMs: 300000,
      // Whether to broadcast for a flask or a blade when badly hurt with nothing to heal
      // with, or unarmed after a death. OFF since 2026-08-27: a fleet on a shared server
      // does not beg in public. Declared here so `status` shows the default rather than
      // nothing; askForHelp() gates on `=== true` either way, and the re-equip and
      // conjure-a-blade attempts before the plea run regardless. Set with `ask_for_help`
      // on the autopilot tool, in tuning.json, or in a loadout's policy block.
      askForHelp: false,
      // Disconnect rather than die when a single exchange could finish us. Set false
      // to forbid it — but it is the most effective survival move available when we
      // have nowhere safe to stand, and the penalties the game attaches to logging
      // off exist for PvP, not for this.
      survivalEnabled: true,
      panicLogoff: true,
      // How long to stay frozen and unattackable after reconnecting.
      freezeMs: 90_000,

      // THE ALWAYS-ON FACILITY, AND NO LONGER A CHOICE. Operator, 2026-09-10: the safe
      // wall is on for everything that is not combat. `coerceSpotPair` forces this true
      // on every write, so the key survives only so that anything still writing it keeps
      // parsing. To choose a COMBAT posture, use `pullToSafeWall`.
      useSafeSpots: true,

      // SKIP PREY THIS CHARACTER HAS PROVED IT CANNOT WALK TO. On by default, because the
      // failure it prevents is silent and total: the keeper ranks the nearest creature,
      // cannot reach it, breaks off, and ranks it again -- for ever, while every board reads
      // "hunting". Declared here rather than left implicit so `status` reports it, per the
      // rule that a setting which silently does nothing is how `purpose` stayed out of a
      // schema for a year with every keeper's audit switched off.
      //
      // Set false to make the keeper keep trying, which is the right choice exactly when you
      // suspect the MODEL is wrong rather than the world -- an undeclared jump, a missing
      // fall, a door the bake does not know. Turning it off is how you reproduce the stall on
      // purpose. It is never a fix for a room that is genuinely walled off.
      ignoreUnreachablePrey: true,

      // WHERE YOU STOP IS NOT THE SAME QUESTION AS HOW YOU FIGHT, AND CONFLATING THEM COST
      // FOUR DEATHS.
      //
      // `useSafeSpots` used to govern the FIGHTING posture, and the fleet turned it off for
      // a real reason: in the Valley of Ileria `takeSafeSpot -> returnToSpot` oscillated and
      // produced hours of "travelling / NOT MOVING" with prey in reach and zero kills.
      //
      // But it also silently governed where a character SITS DOWN, so switching the fighting
      // posture off switched off the shelter you rest in — and resting is the one activity
      // whose entire premise is that nothing can reach you. Waldorf died four times on
      // 2026-09-08 resting in the open with the survival ladder quiet, because a rest
      // presupposes you already walked somewhere unhittable.
      //
      // FINISHED 2026-09-10: the split this block started is now the whole design. Nothing
      // outside combat asks about a policy flag at all — the five non-combat rungs that
      // used to test `useSafeSpots` (hurt in a spawn room, parking for an outage, a wall
      // before a vigor rest, hit while resting, the survival ladder) are unconditional, and
      // the fighting choice moved to `pullToSafeWall`. This key remains only as the
      // always-on facility, forced true on every write.
      // `restAnywhere: true` is the deliberate order to sit wherever you stand — per
      // character, off unless somebody asks for it. Operator's rule, 2026-09-10: never
      // arrive at an unsafe stop by default; you may always arrive at one on purpose.
      restAnywhere: false,
      // ALWAYS TAKE THE FIGHT FROM FULL, when we are somewhere that lets us choose.
      //
      // Out in the open, health is spent capital: recovering it means disengaging,
      // walking somewhere quiet and sitting down, so it is worth fighting well down
      // the bar before paying that. In a safe spot none of that is true — stopping
      // costs a pause and nothing else — so there is no reason to ever swing at
      // anything below this. It is much higher than restBelow on purpose.
      //
      // THIS IS THE FIGHTING NUMBER, NOT THE ROAD ONE, and the distinction cost me a wrong
      // edit on 2026-08-27. Asked to make a traveller always rest full, I raised this to 1
      // — but a road already has its own floor (`travelHoldResumeAbove ?? 1`, see the
      // `onARoad` branch in the leave-the-wall test), so the doctrine was already satisfied
      // and what I had actually changed was when a HUNTING character gets up off a wall to
      // swing again. That is a combat pacing decision with its own argument above, nothing
      // to do with travelling, and it was not asked for. Put back.
      holdResumeAbove: 0.9,
      // How far to go to fetch a monster that will not come to us. UNSET: there is no
      // limit, because distance was never the thing that made a pull dangerous — see
      // pull(). It went 8, then 14 when the Tos gate turned out to be 58 by 44 and every
      // pull in it was being refused, and each of those numbers was a room-shaped guess
      // standing in for the reasoning. Set `pull_within` to put a ceiling back.
      pullWithin: null,
      // { room, squares } -- where in a room prey may be chosen (m59-strategy-schema.mjs huntArea). null = anywhere.
      huntArea: null,
      // { room, squares, rect? } -- ONE character's operator-drawn hunt area (normGuardZone). Wins over huntArea
      // in its own room, so a strategy file's area is the fallback, never the override. null = none.
      guardZone: null,
      // WHETHER A FIGHT OPENS BY WALKING TO A WALL. Renamed 2026-09-10 from
      // `requireSafeWall`, which had grown four jobs and only one of them was this.
      //
      // The wall used to be a REQUIREMENT that reached everywhere: it decided the fighting
      // posture, it decided where a character sat down to rest, and it wrote off any room
      // no wall could be found in. Two of those were never combat, and tying them to a
      // combat flag is what killed Waldorf four times on 2026-09-08 — a rest presupposes
      // you already walked somewhere unhittable, whatever you had decided about fighting.
      //
      // So non-combat wall-seeking is now unconditional and has no flag at all, and this
      // key controls ONLY the opening pull:
      //
      //   true   open the fight from a wall — walk there first, and treat a room with no
      //          findable wall as unusable, which is the same statement
      //   false  open the fight where the prey is, and take a wall as a RESPONSE when
      //          `wallAtAttackers` creatures are inside melee reach. Not a posture.
      //
      // THE LEGACY NAME IS STILL THE DEFAULT KEY ON PURPOSE, and this is load-bearing
      // rather than laziness. Every character in the live roster has `requireSafeWall`
      // persisted; `coerceSpotPair` adopts it into `pullToSafeWall` when the new key is
      // absent. If this default were written as `pullToSafeWall` instead, a roster saying
      // `requireSafeWall: false` would merge against a default of `true`, both keys would
      // be defined, and the adoption could not tell the roster's answer from the default's
      // — flipping 21 characters to the strict posture at the next keeper restart. Leave
      // the default under the old name until the roster has migrated.
      requireSafeWall: true,
      // AND WHAT "NOT REQUIRED" MEANS, WHICH IS THE SETTING ABOVE READ AS THREE STATES
      // RATHER THAN TWO. With `pullToSafeWall:false` the wall stops being the posture and
      // becomes the answer to a crowd: hold one when this many creatures are inside melee
      // reach, and fight in the open below it. See holdWorthwhile(), which is the only
      // reader, and the release in the work branch, which is what makes it a response
      // rather than a one-way door. Ignored entirely while `pullToSafeWall` is true.
      //
      // 2 rather than 3 (the crowd bar the REQUIRED path uses for prey we outclass)
      // because that path already has the wall by then; this one is deciding whether to
      // move at all, and the second attacker is what changes a fight into a race.
      wallAtAttackers: 2,
      // PARTY: who this character fights alongside, or null for solo.
      //
      // The pairing itself lives in m59-party.mjs, which is process-wide and shared by
      // every keeper; this is only the instruction, so it survives being written into
      // the roster and rebuilt after a restart. Setting it registers the pair.
      partner: null,
      // Below this fraction of health, a partnered character stops swinging and heals
      // while the other keeps the fight going. Higher than fleeBelow on purpose: the
      // point is to leave the fight early and cheaply, not to survive leaving it late.
      partyHealBelow: 0.5,
      // SWING BACK AT A FLAGGED PLAYER WHO HAS ATTACKED THIS FLEET. Unset, so a fresh
      // clone behaves exactly as before: whether a fleet should fight a person at all is
      // a decision about the server it is on and the people on it, not a mechanic, and
      // it belongs in a local policy. See defendAgainstPlayers() for the interlocks.
      defendAgainstPlayers: false,
      // Reconnect before stepping off a spot that has a crowd on it. See breakOut().
      breakOutViaLogoff: true,
      // How many monsters camped on us make leaving worth a reconnect.
      breakOutAbove: 2,
      // FLEET PLACEMENT, NOT COMBAT SAFETY. null means no occupancy limit: several
      // keepers may choose the same top-ranked wall. A directional bot may set a
      // positive number when its independently enabled spread strategy wants every
      // wall filled before another keeper shares one. Keeping this null by default is
      // what makes room/wall spreading opt-in rather than an always-on keeper tactic.
      maxBotsPerSafeSpot: null,
      // ROOMS THIS CHARACTER MUST NOT SET OUT FOR, for any reason this file can generate:
      // not to sell, not to bank, not to farm. A DESTINATION ban, not an avoidance — a
      // journey that merely passes THROUGH one of these rooms is not rerouted. An array of room numbers, empty by default.
      //
      // The first entry it was written for is 110, "A shadowy corner" — Roq, the one NPC
      // that buys a full pack. The road to him crosses a lupogg's ground with a jump in
      // it, and characters kept colliding with the lupogg on the jump and being eaten for
      // a sale that does not pay well anyway. Rather than special-case Roq, this says the
      // general thing: an operator can strike a room off, and every destination chooser
      // here honours the strike. A trip whose only destination is struck is not taken,
      // and says so once. This is an ORDER, so it lives in the roster, not in git.
      bannedDestinations: [],
      // HOW MANY TIMES A SESSION TO STOP AND ACTUALLY TEST A SPOT.
      //
      // Proof used to arrive only by accident: a character that swings every pass
      // never produces a quiet window, so the one state that can prove a wall — being
      // next to something and not hitting it — happened only when it got hurt enough
      // to sit down. That is exactly backwards, because the proof is worth most BEFORE
      // the fight goes badly.
      //
      // So: when a monster has come to the wall and the spot is untested, hold the
      // swing for a couple of passes and watch. It costs a few seconds, once per
      // fight, for the first few fights of a session. Not once ever — walls do not
      // move but maps get rebuilt and rooms get renumbered, so a handful of fresh
      // readings each session is what keeps the book honest.
      spotTestsPerSession: 3,
      // Below this fraction of health, in a safe spot, panic-logoff anyway. Out in
      // the open the trigger is two of the biggest hit the game can land, which is
      // around 70% for these characters — far too eager once a wall is doing the
      // work, and every false alarm costs a minute of not healing. See the doomed
      // check in pass().
      doomedInSpotBelow: 0.35,
      // Shillings to keep in hand for flasks and food; everything above this goes to
      // the bank, where death cannot take it.
      walkingMoney: 400,
      // CARRY MORE THAN THIS AND GO AND BANK IT, wherever you are. On by default,
      // because the alternative is what this fleet was already doing: 35,920 shillings
      // in pockets across twenty-one characters, one of them holding 5,840, all of it
      // dropped on a corpse the moment anything killed them. Two thousand is roughly
      // where a player stops what they are doing and walks to Jasper or Tos.
      // Set 0 or null to keep the old behaviour — bank only if you happen to walk past one.
      // BANK EARLY, BECAUSE DYING IS NOT RARE HERE.
      //
      // Everything carried drops where you die and a bank balance does not. Across 30
      // hours and 21 characters this fleet died 259 times — 0.41 deaths per character per
      // hour, a death every two and a half hours — so money held for an hour has roughly
      // a 41% chance of being dropped.
      //
      // At 2000 almost nothing was ever banked: a character carrying 1,900 shillings kept
      // carrying them and lost the lot at the next death, and the journal line for it was
      // a cheerful "carrying, but under the banking threshold". Expected loss on 1,000
      // carried is about 410 an hour, against one trip to a town — which is a sanctuary,
      // so the trip itself is the safest walking the fleet does.
      //
      // 800 is twice the walking float, so a character still keeps enough to shop with.
      //
      // CHANGING THIS DOES NOT REACH KEEPERS THAT ALREADY EXIST. Each keeper's policy is
      // persisted with the roster and restored by resumeFleet, so a new default applies
      // only to keepers created afterwards — I changed this to 800, restarted, and found
      // every keeper still reporting "carrying, but under the banking threshold ...
      // banks_at: 2000". Use the autopilot tool's `bank_above` to move the live ones.
      // Lowered again to 500 after Rowlf — the fleet's best character, ten levels gained
      // in a session — was found at 8 of 30 health carrying 731 shillings, which was 46%
      // of everything the fleet owned. At 800 it would not bank, and one bad fight would
      // have put nearly half the fleet's money on the floor of a monster room.
      //
      // The threshold is not really about the amount. It is about how much of the fleet's
      // total is riding on one character that can die in the next eight seconds.
      bankAbove: 500,
      ...policy,
    };
    // THE PRISTINE DEFAULTS, once, from the first Autopilot built with no orders (autopilotFor).
    // What a strategy key goes back to when an unassignment finds the file's own value sitting in
    // the orders (m59-strategy-engine.mjs strategyResidue) -- read, never constructed, because an
    // Autopilot has side effects (recorders, session hooks) a throwaway one would leave behind.
    if (!POLICY_DEFAULTS && !Object.keys(policy ?? {}).length) {
      try { POLICY_DEFAULTS = Object.freeze(JSON.parse(JSON.stringify(this.policy))); } catch {}
    }
    // WHO SET EACH KEY (m59-policy-sources.mjs): one answer per key, reported as policy_sources.
    this.policySources = new PolicySourceBook();
    this.policySources.mark(Object.keys(policy ?? {}), 'roster');
    // What we believe is in the stomach. Nothing reports it, so it is modelled from
    // what we ate plus the documented drain rate, and corrected whenever the server
    // refuses a mouthful. See provision().
    this.stomach = new skills.Stomach();
    this.climbing = false;
    this.running = false;
    this.stopping = false;
    // NOT ACTING IS NOT THE SAME AS NOT LOOKING. See goInert().
    this.inert = null;
    this.journal = [];
    this.passes = 0;
    this.startedAt = null;
    // THE MOST RECENT ERROR THAT HAS NOT SINCE BEEN RECOVERED FROM — not "the most recent
    // error ever", which is what this field used to mean and not what anything reads it as.
    //
    // The status snapshot calls it "the one field worth reading before anything else", and
    // the operator, the hourly strategy review and the ten-minute play tick all read it as
    // a statement about NOW. It was set in two places and cleared in one: here. So the
    // first transient blip of a process populated it for the life of that process.
    //
    // The blip is not rare — it is a FEATURE firing. With `breakOutViaLogoff`, leaving a
    // crowded spot calls reconnect() → rejoin(), which nulls `client` for ~800ms; `live`
    // goes false and any action the in-flight pass still attempts throws. Measured on
    // JohnsSlave 2026-08-29: 16 deliberate breakouts in 58 minutes of healthy farming, and
    // a status snapshot showing 4 kills, 0 deaths, "fighting from a proven safe spot" —
    // beside `last_error: agent "psycho" is not in game — call join first`, six minutes
    // stale and unclearable. A reader could not tell a healed blip from a dead session,
    // and a second poll did not help, because healing did not clear it.
    //
    // So: cleared by a completed pass on a live session (see loop()), and stamped, so a
    // reader that wants the history can still tell a four-minute-old scar from a live
    // wound without a second poll.
    this.lastError = null;
    this.lastErrorAt = null;
    // ARE WE GRINDING AGAINST A WALL, AND FOR HOW LONG. Fed from `pulsePosition` so it sees the
    // same samples every other movement question here sees -- two instruments describing two
    // different walks is the failure `trackSinceFull` is commented against, and this would be
    // a third walk if it sampled on its own timer.
    //
    // Closed episodes go to the ledger as `wall_contact` / `shuffle`; `m59-grinds.mjs` reads
    // them back. NOTHING IS EMITTED UNTIL AN EPISODE ENDS, because an episode without a
    // duration is the point event this exists to replace.
    this.grind = makeGrindTracker();
    // AN HOURLY BUDGET, SO A WEDGED CHARACTER CANNOT FILL THE DISK WITH ITS OWN MISERY.
    //
    // Measured cost: one episode row is 250 bytes, and the fleet is 23 characters. At 60
    // episodes per character per hour that is 8.3 MB/day against a ledger already at 131 MB --
    // it would roughly double it in a fortnight. At 300/hour it is 41 MB/day, which is the
    // ballooning the operator asked to avoid.
    //
    // The pathological case is NOT the one that costs the most, which is worth knowing: a
    // character grinding for six hours produces ONE long episode, because the episode stays
    // open while it continues. The expensive shape is repeated bump-and-recover, and the
    // hundredth identical bounce at the same square tells nobody anything the first twelve did
    // not.
    //
    // So the budget SUPPRESSES rows but never hides them: the overflow is counted and reported
    // as a single `grind_suppressed` row per hour. A cap that silently dropped evidence would
    // make the totals wrong in the direction of "everything is fine", which is the one
    // direction this repository keeps getting burned by.
    this.grindBudget = { hour: null, written: 0, suppressed: 0 };
    // The mover's own refusal, parked here by `terminalMovement` and consumed by the next
    // pulse. One field rather than a queue: the pulse is a second wide and the question is
    // "was this sample refused", not "how many times" -- the episode counts those.
    this.grindRefusal = null;
    // Where the pass last gave up walking from, and until when. See `answerWedge`.
    this.wedgeHold = null;
    // Was the session live when it threw? `false` during a breakout window is the
    // self-inflicted, self-healing kind; `true` is a real one. One boolean in the journal
    // is the difference between a five-second check and an afternoon's investigation.
    this.lastErrorLive = null;
    // How many consecutive passes have now failed. 1 is a blip; a climbing number is the
    // genuinely dangerous case and is the thing an alert should fire on.
    this.consecutivePassFailures = 0;
    // What actually happened, so a returning model gets a summary rather than a tail.
    this.tally = { kills: 0, deaths: 0, rests: 0, withdrawals: 0, rooms_moved: 0, looted: {} };
    this.coordination = {
      cleanup: { runs: 0, dropped: 0, picked: 0, picked_value: 0, protected_picked: 0, refused: 0 },
      delivery: { trips: 0, farmers_polled: 0, requested: { herb: 0, elderberry: 0 },
        bought: { herb: 0, elderberry: 0 }, delivered: { herb: 0, elderberry: 0 },
        retained: { herb: 0, elderberry: 0 }, failed: 0 },
    };
    this.pendingFarmDelivery = null;
    // WHEN each kill happened, not just how many there have been.
    //
    // A running total answers "has this character ever worked", and that is not the
    // question anyone asks of a fleet board. A character with 40 kills and none in the
    // last hour looks identical to one earning steadily, and the difference is the entire
    // point of watching. It is also reset by every keeper restart, so on a fleet whose
    // keepers get restarted constantly the total mostly measures uptime.
    //
    // Timestamps cost nothing and answer the real question. Bounded because a good session
    // is a few hundred, and nothing here looks further back than an hour.
    this.killTimes = [];
    // EVERY CAST, AND EVERY CAST IT DECIDED AGAINST.
    //
    // The keeper's self-supply decisions are the ones hardest to check from outside,
    // because both spells it relies on refuse SILENTLY: `create food` without 2
    // ElderBerry and 2 Herbs, `create weapon` below 15 mana. Neither says a word, so a
    // character that cast forty times and got nothing looks exactly like one that cast
    // forty times and ate well — and a character that never cast at all looks exactly
    // like one that does not know the spell. A count of actions cannot separate those;
    // the OUTCOME and the REFUSAL have to be recorded with the attempt.
    //
    // `declined` is the half a log of actions can never give you, and it is why this is
    // an audit rather than a counter.
    this.spellbook = { casts: [], by_spell: {}, declined_logged: new Map() };
    // WHAT IT SPENT MONEY ON. The economic half of the same question: a character can
    // keep its vigor up by buying food, or by buying the two reagents and casting for
    // it, and those cost differently and fail differently. Recorded per purchase so
    // the mix is readable rather than inferred from a shrinking purse.
    this.spending = { bought: [], spent: 0, by_kind: {}, declined: {} };
    // HOW WELL THE ASSIGNMENT IS HOLDING. Read by `status` and by the spread tool.
    //   effective  — returned_to_assignment / relocations
    //   consistent — drifted, and drifted_to says WHERE it keeps losing them to
    //   robust     — failed + why_not, the verbatim reason travel gave up
    this.placement = { relocations: 0, aimed_at_assignment: 0, returned_to_assignment: 0,
                       drifted: 0, drifted_to: {}, failed: 0, why_not: [] };
    // Consecutive failed attempts to reach a room, so a single transient miss does not
    // get mistaken for the room being unreachable. Cleared the moment one succeeds.
    this.relocFails = new Map();
    // WHAT VIGOR THE FIGHTS ACTUALLY START AT — the number the floor exists to move,
    // reported rather than assumed. `below_want` is the one to read: a floor nobody
    // reaches is a wish, and the commonest reason to miss it is an empty larder.
    this.vigor = { engagements: 0, total_at_engage: 0, lowest_at_engage: null,
                   below_want: 0, waited: 0, starved_passes: 0, cooked: 0, cook_failed: 0 };
    // Whether the money is actually getting to a bank, and what stops it when it does
    // not. `carried_at_death` is the number this whole mechanism exists to drive to 0.
    this.money = { trips: 0, trips_failed: 0, carried_at_death: 0, why_not: [] };
    // The faction-goal scheduler waits for this boundary: a completed town loop means
    // loot was sold and surplus was banked before a long political errand takes over.
    // It is session evidence, not a second town-loop implementation in DUM.
    this.lastTownServiceAt = null;
    this.emptyPasses = 0;
    this.roamedFrom = null;
    this.roamedRooms = 0;
    this.unreachable = new Set();   // spawn rooms we could not route to
    this.foeId = null;             // the creature we are part-way through killing
    // A pull that visibly stops closing is evidence about that quarry's current aggro,
    // not about the wall. Briefly skip its room-local id so target selection cannot
    // release it and immediately choose the same non-follower again.
    this.pullTargetCooldowns = new Map();
    // WHERE THE TIME ACTUALLY GOES.
    //
    // "Stalled" was doing too much work as a word. The commonest reason a keeper
    // reported it was `waiting to be healthy enough to fight` — a character sitting
    // down and regenerating, which is the correct thing to be doing and is not stuck
    // in any sense. Counting that as a stall makes the fleet look broken while it is
    // working, and hides the cases where it genuinely is.
    //
    // So: seconds by activity, and STALLED means only one thing — standing about not
    // knowing what to do, while NOT recovering.
    this.time = { fighting: 0, pulling: 0, waiting: 0,
                  recovering: 0, zoning: 0, travelling: 0, trading: 0, stalled: 0 };
    this.doing = null;             // set during a pass; decides which bucket it lands in
    this.visited = new Set();
    // Where the hunting was actually good. Roaming without this wanders off down a
    // one-way gradient and never comes back — it walked a character five rooms out
    // of a rat warren into a town and oscillated there for twenty minutes.
    this.homeRoom = null;
    // Consecutive passes that achieved nothing. A keeper that has done nothing for
    // ten passes is not idle, it is stuck, and the only way anyone found out before
    // was by noticing a number had not moved.
    this.idlePasses = 0;
    this.stalledSince = null;
    this.stalledWhy = null;
    // WHICH loop, and what could act on it. A count of idle passes says a character is not
    // earning; these two say whether anybody can do anything about it. See `stallLever`.
    this.stalledLever = null;
    this.stallRepeats = 0;
    this.lastNoProgressWhy = null;
    // Passes in which the server's room contents did not contain our own object.
    // The usual cause is a save-game renumbering our object id out from under a live
    // session, after which everything that keys on selfId quietly reads as "dead".
    this.selfMissingPasses = 0;

    // THE SAFE SPOT WE ARE STANDING IN, and whether we have any evidence it works.
    // null when we are not holding one. See observe() for how `proven` is earned and
    // holdWorks() for what it entitles us to do.
    this.hold = null;
    // What the world was doing last time we looked, so that "did anything hit me
    // while I was sitting still?" can be answered at all. It is the only question
    // that distinguishes a safe spot from a hopeful one.
    this.lastObs = null;
    // When we last did something a monster is entitled to answer. Damage arriving
    // after one of these is retaliation and says nothing about the spot.
    this.swungAt = 0;
    this.movedAt = 0;
    // When we last did anything at all that ends the entry grace period, and when we
    // last reconnected. The pair exists to stop the keeper proving a safe spot with
    // the grace period rather than with the walls — see observe(). That would be a
    // false positive in the one direction that gets a character killed: believing a
    // bad square is good, on evidence collected while nothing was allowed to hit us.
    this.turnedAt = 0;
    this.rejoinedAt = 0;
    // Set after a reconnect made while holding: health regeneration is gated on
    // having acted since entering the room, and in a safe spot we can afford to act.
    this.needsArming = false;
    // EVERY WINDOW WE ADJUDICATED, INCLUDING THE ONES WE THREW AWAY.
    //
    // The verdict is the cheap thing to report and the useless thing to check. If
    // this measurement is wrong it will be wrong in the DISCARDS — a window dropped
    // as "we swung in it" that we did not swing in, a grace period believed over when
    // it was not, an adjacent monster that was actually a corpse — and a log of
    // conclusions cannot show that, because the conclusion is what is in doubt.
    //
    // So every window records its inputs and what became of them, counted or not, and
    // someone standing in the room watching can disagree with a specific reading
    // rather than with the summary. That is the only kind of disagreement that can
    // find a measurement bug.
    this.trials = [];
  }
  // @autopilot-part ./autopilot/hunt-setup.mjs#1
  // @autopilot-part ./autopilot/training.mjs#1
  // @autopilot-part ./autopilot/gear.mjs#1
  // @autopilot-part ./autopilot/provision.mjs#1
  // @autopilot-part ./autopilot/senses.mjs#1
  // @autopilot-part ./autopilot/bridges.mjs#1
  // @autopilot-part ./autopilot/inventory.mjs#1
  // @autopilot-part ./autopilot/safe-spots.mjs#1
  // @autopilot-part ./autopilot/pull.mjs#1
  // @autopilot-part ./autopilot/sanctuary.mjs#1
  // @autopilot-part ./autopilot/errands.mjs#1
  // @autopilot-part ./autopilot/hunt-books.mjs#1
  // @autopilot-part ./autopilot/pvp-return.mjs#1
  // @autopilot-part ./autopilot/travel.mjs#1
  // @autopilot-part ./autopilot/pvp-response.mjs#1
  // @autopilot-part ./autopilot/threat.mjs#1
  // @autopilot-part ./autopilot/death.mjs#1
  // @autopilot-part ./autopilot/pull.mjs#2
  // @autopilot-part ./autopilot/journal.mjs#1
  // @autopilot-part ./autopilot/status.mjs#1
  // @autopilot-part ./autopilot/faculties.mjs#1

  start() {
    // A start on an inert keeper is a revive. Every caller that held one already pairs
    // its hold with a `start`, so this is what makes the change invisible to them.
    if (this.inert) {
      this.revive('started again');
      if (this.running) { this.note('started', { mode: this.mode, hunt: this.policy.hunt }); return this.status(); }
    }
    if (this.running && this.stopping) {
      this.stopping = false;
      // hard stop turns both of these off immediately, before the current pass
      // has actually yielded. Cancelling that stop must restore the independent
      // eye and close the uptime outage as well as clearing the boolean; otherwise
      // the loop keeps acting while post-mortems call it unattended and no watchdog
      // can interrupt the pass that is still winding down.
      this.startWatchdog();
      // hard stop also erased the timestamp the watchdog uses to decide that
      // the current await is blind. The pass did not actually end, so start a
      // fresh bounded observation window instead of leaving the revived eye
      // unable to pull the handbrake until some later pass.
      this.passStartedAt = Date.now();
      uptime.record(this.s.name, 'start', {
        mode: this.mode, hunt: this.policy?.hunt ?? null,
        resumed_pending_stop: true,
      });
      this.note('start cancelled a stop that had not taken effect yet', {
        why: 'the previous loop was still finishing a pass; it now carries on with the new orders',
        watchdog_restarted: true,
        uptime_resumed: true,
        pass_watch_restored: true });
      return this.status();
    }
    if (this.running) return this.status();
    this.running = true; this.stopping = false; this.startedAt = Date.now();
    this._lastOutfitAt = null;   // allow a fresh outfit attempt on every new keeper run
    // FORGET WHICH LOADOUT WE HAD APPLIED. A keeper that has just started is exactly the
    // case the overlay exists for — a restart builds this object from defaults — so the
    // file must be re-read even though its mtime has not moved since the last keeper.
    this._loadoutPolicyAt = null;
    // The independent eye. Started with the keeper and stopped with it, because it exists
    // to watch this keeper's blind spots and has nothing to watch when there is no keeper.
    this.startWatchdog();
    // WRITTEN OUTSIDE THE KEEPER, because a keeper that is gone cannot record that it is
    // gone. Without this there is no way to tell a death the strategy caused from one
    // that happened while nothing was driving — and a broker restart stops all twenty-one
    // at once, which is exactly why deaths arrive in waves. See m59-uptime.mjs.
    uptime.record(this.s.name, 'start', { mode: this.mode, hunt: this.policy?.hunt ?? null });
    // A fresh start is a new job: whatever room was worth hunting under the last
    // orders is not evidence about these ones, and may not even be reachable now.
    this.homeRoom = null;
    this.roamedFrom = null;
    this.roamedRooms = 0;
    // A room we could not route to from the last job's starting point may be
    // perfectly reachable from this one.
    this.unreachable.clear();
    // Whatever we believed about where we were standing was believed under the last
    // orders and possibly in another room. The BOOK survives — walls do not move, and
    // that is the whole reason it is written down — but the claim to be standing on
    // one does not.
    this.hold = null;
    this.lastObs = null;
    this.campedIds = new Set();
    // A fresh session gets fresh readings. The book persists; the willingness to spend
    // a few seconds re-checking it does not, or a keeper restarted twenty times would
    // never test anything again.
    this.spotTestsRun = 0;
    this.spotTest = null;
    this.progress('started');
    this.note('started', { mode: this.mode, hunt: this.policy.hunt });
    // Deliberately not awaited: the loop outlives the call that started it.
    this.loop().catch(e => { this.lastError = e.message; this.lastErrorAt = Date.now();
                             this.lastErrorLive = !!this.s?.live; this.running = false;
                             this.note('crashed', { why: e.message }); });
    return this.status();
  }

  // STOPPING NOW MEANS GOING INERT, and a real stop has to be asked for.
  //
  // Every caller of this wanted the same thing — stop driving, something else is about to
  // — and none of them wanted the instruments switched off, which is what they were
  // getting. So the default is the one that keeps looking, and `hard` is for the case
  // where the keeper genuinely has to end: the object is being discarded, or the process
  // is going away and the loop must not outlive it.
  //
  // The distinction is worth keeping rather than deleting the hard path: an inert keeper
  // is still a running loop holding a session, and dropAutopilot must be able to get rid
  // of one. See goInert for why everything else should not.
  stop(why = null, { hard = false } = {}) {
    this.clearSurvivalJam('keeper stopped');
    if (currentSurvivalDecision(this.s)) {
      const options={replacement:{strategy:'yield_to_controller',reason:why??'keeper stopped',status:'yielded',reason_code:'keeper_stop'}};
      if(this.s.cancelMovement)this.s.cancelMovement(null,why??'keeper stopped',{...options,origin:keeperOrigin('keeper_stop')});
      else cancelSurvivalDecision(this.s,why??'keeper stopped',options);
    }
    if (!hard) { this.goInert(why); return this.status(); }
    releaseQuarry(this.s.name);
    releaseSpot(this.s.name);
    this.stopping = true;
    this.stopWatchdog();
    this.passStartedAt = null;
    // A hard stop leaves nothing behind to revive, so clear this rather than letting a
    // later start() see a stale hold and report a revive that did not happen.
    this.inert = null;
    if (this.detailFight) {
      const fight = this.detailFight;
      this.detailFight = null;
      this.detailEvent('fighting', 'session', {
        ...fight, ended_at: Date.now(), stopped: why ?? 'keeper stopped',
        safe_spot_pct: fight.duration_ms ? +(100 * fight.safe_spot_ms / fight.duration_ms).toFixed(1) : null,
      });
    }
    // Everything learned about which squares hold, before this keeper goes away.
    // The character is about to be left standing exactly where it is, in whatever room
    // it is in, while everything already swinging at it carries on. That is a fact about
    // the world, not about this keeper, so it goes in the ledger that outlives it.
    uptime.record(this.s.name, 'stop', { why, room: this.s.world?.room?.num ?? null });
    this.note('stopping', why ? { why } : undefined);
    return this.status();
  }

  // Charge the elapsed time of a pass to whatever it turned out to be doing.
  spend(ms) {
    const k = this.doing || 'stalled';
    this.time[k] = (this.time[k] || 0) + ms / 1000;
    this.captureDetailedActivity(k, ms);
    // WHAT THE PASS TURNED OUT TO BE, kept after the reset.
    //
    // `doing` is set part-way through a pass and cleared here at the end of it, so
    // anything reading it at the START of a pass — which is where the post-mortem frame
    // is written — sees null, always. Nine frames of a live character all said "doing:
    // null" while it was plainly farming, and the unit tests missed it because they set
    // the field by hand. This is the pass that just finished, which is the honest answer
    // to "what was it doing" for a frame taken before the next one decides anything.
    this.lastDoing = k;
    this.doing = null;
  }

  captureDetailedActivity(kind, ms) {
    const room = this.s.world?.room;
    const damageNow = this.hitDamageTotal();
    const damage = Math.max(0, damageNow - (this.passDamageStart ?? damageNow));

    if (kind === 'fighting' && detailSettings(this.policy, 'fighting')) {
      const safe = !!(this.hold && this.holdWorks());
      this.detailFight ??= {
        started_at: this.passStartedAt ?? Date.now() - ms,
        duration_ms: 0, safe_spot_ms: 0, damage: 0,
        target: this.policy.hunt ?? null, maps: [],
      };
      const fight = this.detailFight;
      fight.duration_ms += ms;
      if (safe) fight.safe_spot_ms += ms;
      fight.damage += damage;
      let map = fight.maps.at(-1);
      if (!map || map.room !== room?.num || map.from_safe_spot !== safe) {
        map = { room: room?.num ?? null, name: room?.name ?? null,
          duration_ms: 0, damage: 0, from_safe_spot: safe };
        fight.maps.push(map);
      }
      map.duration_ms += ms;
      map.damage += damage;
    } else if (this.detailFight) {
      const fight = this.detailFight;
      this.detailFight = null;
      this.detailEvent('fighting', 'session', {
        ...fight, ended_at: Date.now(),
        safe_spot_pct: fight.duration_ms ? +(100 * fight.safe_spot_ms / fight.duration_ms).toFixed(1) : null,
      });
    }

    if (kind === 'trading' && detailSettings(this.policy, 'trading')) {
      const trade = this.passTrade ?? {};
      this.detailEvent('trading', 'session', {
        started_at: this.passStartedAt ?? Date.now() - ms,
        ended_at: Date.now(), duration_ms: ms,
        room: room?.num ?? null, room_name: room?.name ?? null,
        damage, purse_before: this.passPurseStart ?? null, purse_after: this.purseNow(),
        earned: trade.earned ?? 0, spent: trade.spent ?? 0, banked: trade.banked ?? 0,
        sold: trade.sold ?? [], bought: trade.bought ?? [], deposited: trade.deposited ?? [],
      });
    }
  }

  get activeSeconds() {
    const t = this.time;
    return t.fighting + t.pulling + t.waiting + t.recovering + t.zoning + t.travelling + t.trading;
  }

  // ------------------------------------------------------------------ the watchdog
  //
  // THE KEEPER GOES BLIND FOR MOST OF EVERY DEATH, AND ADDING FRAMES AROUND THE AWAIT DOES
  // NOT FIX IT.
  //
  // Measured over 715 deaths: 645 had a keeper the uptime ledger says was running, and
  // 521 of those — 81% — had it blind at the moment of death. Median gap 18 seconds,
  // p90 219. The cause is structural rather than a missing call: `pass()` is one long
  // async function and a single `await this.travel(...)` inside it can run for minutes,
  // during which nothing re-decides anything.
  //
  // travel() ALREADY records a frame either side of itself — 'setting off' and 'arrived' —
  // and Camilla's post-mortem is the proof that this is not enough. Her last frame reads
  // `why: "setting off"`, 17.8 seconds before she died: the 'arrived' frame in the
  // `finally` never described anything, because she died inside the await. Bracketing a
  // blind interval tells you when it started. It does not make anybody look.
  //
  // So the watchdog is a SEPARATE TIMER that does not care what the pass is doing, and
  // this is the whole point of it being a timer rather than another await: the server
  // PUSHES health (BP_STAT, one packet per change), so `client.vitals()` is live and
  // free whatever the pass is blocked on. Reading it costs no packet, no round trip, and
  // no permission from whatever is holding the call stack.
  //
  // Two jobs, in order of how much they matter:
  //
  //   1. THE RECORD KEEPS BREATHING. A frame whenever health changes, and one every
  //      WATCHDOG_FRAME_MS regardless, so a post-mortem is never a bracket around a hole.
  //   2. IT CAN PULL THE HANDBRAKE. `Session.cancelMovement()` bumps the movement
  //      generation, and travel checks it in twelve places including inside the paced
  //      step loops — so a walk stops within about a second of being told to. If health
  //      crosses the flee line while the pass is blocked in a walk, the walk ends and the
  //      next pass gets to make a survival decision with fresh numbers instead of
  //      arriving as a corpse.
  //
  // What it deliberately does NOT do is decide anything. It has no policy, it never
  // fights, rests or moves, and it cannot take a safe spot. It interrupts, and the
  // ordinary pass — which already knows how to flee, rest and find a wall — does the rest.
  // A second decision-maker running concurrently with the first is how you get two
  // keepers arguing over one body.
  // ── THE WATCHDOG ────────────────────────────────────────────────────────
  // The guard itself now lives in m59-watchdog.mjs, over a HOST rather than a keeper,
  // so the GOAP keeper can run the same one instead of going without. These four are
  // thin delegations on purpose: `this` already satisfies the host interface (s, watch,
  // inert, hold, doing, passes, passStartedAt, lastFrameAt, tally, safety, recordFrame,
  // note, progress), and keeping the method NAMES here means every existing caller and
  // m59-combat-test's direct ticks carry on untouched.
  // THE HOOKS THE WATCHDOG'S INERT RESCUE ASKS FOR. Optional by design -- the tick driver
  // supplies none of them and still gets the cancel -- but this keeper can do all three,
  // and the reason they exist is that reviving alone was measured to be worse than the
  // stall: the destination went with the driver, the ordinary ladder had nothing to offer
  // in a bad room, and the character stood there until it died.
  suspendJourney(trigger) {
    if (this.suspendedJourney) return true; // a recovery detour cannot replace its parent
    const journey = this.travelling;
    if (journey?.to == null) return false;
    // The order this journey belongs to, so a resume is still that issuer's journey and a
    // FleetScript walk can recognise its own order coming back.
    const order = liveMoveOrder(this.s) ?? this.s?.moveOrder ?? null;
    this.suspendedJourney = {
      to: journey.to, why: journey.why ?? 'travelling', at: Date.now(), trigger,
      guard: { ...this.travelGuard(this.inert?.travelling ? this.inert.guard : null) },
      attempts: (journey.attempts ?? 0) + 1, deaths_at: this.tally?.deaths ?? 0,
      ...(order?.origin && Number(order.to) === Number(journey.to) ? { origin: order.origin }
        : journey.origin ? {origin:journey.origin} : {}),
    };
    return true;
  }
  /**
   * IS THIS CHARACTER TOO TIRED TO BE ON A ROAD.
   *
   * One question, asked in three places — the shelter trigger that stops the journey, and the
   * two rests that decide what to fill up before going on — because a floor that decides when
   * to stop but not when to get up is a character that stops for nothing and walks away
   * exactly as tired as it arrived. That is not hypothetical: `REST_VIGOR_WORTH_WAITING`
   * already said "do not wait for vigor from the bottom", so before this existed the two
   * halves actively disagreed.
   *
   * Raw vigor against `travel_vigor_floor` (40), not a fraction: it is the unit the server's
   * own `RUN_VIGOR_FLOOR` of 12 is written in, and the unit every report here prints.
   *
   * Only ever true on a road. A character standing in a town at vigor 3 is not in trouble;
   * it is between errands, and `restBelow` is the number that governs it.
   */
  tooTiredToTravel(vitals = this.s.client?.vitals?.()) {
    if (!this.inert?.travelling && !this.suspendedJourney) return false;
    const raw = vitals?.vigor?.value;
    if (!Number.isFinite(raw)) return false;
    return raw < (this.policy.travelVigorFloor ?? TRAVEL_VIGOR_FLOOR);
  }

  wantForwardShelter(why) { this.wantsForwardShelter = why; }
  // @autopilot-part ./autopilot/watchdog.mjs#1
  // @autopilot-part ./autopilot/wedge.mjs#1

  async loop() {
    // The outer loop is the other half of start()'s cancellation. Between leaving the
    // inner loop and admitting we have stopped there is no await, so a start() can
    // only ever be observed by the outer test — which means a cancelled stop is picked
    // up rather than racing us to the exit.
    do {
      while (!this.stopping) {
        this.passes++;
        const began = Date.now();
        // WHEN THIS PASS STARTED, readable from outside the call stack. The watchdog runs
        // on its own timer and this is the only way it can tell "the keeper is between
        // passes" from "the keeper has been inside one await for ninety seconds".
        this.passStartedAt = began;
        this.passDamageStart = this.hitDamageTotal();
        this.passPurseStart = this.purseNow();
        this.passTrade = { earned: 0, spent: 0, banked: 0, sold: [], bought: [], deposited: [] };
        try {
          await (this.s.runCommand ? this.s.runCommand(() => this.pass()) : this.pass());
          this.spend(Date.now() - began);
          this.notePassSucceeded();
        } catch (e) {
          this.spend(Date.now() - began);
          if (e.code === 'COMBAT_PREEMPTED') continue;
          // A pass that throws must not kill the keeper — the session may simply have
          // gone away underneath it, and the next pass will find out properly.
          this.notePassFailed(e);
          await sleep(5000);
        }
        this.passStartedAt = null;
        if (this.stopping) break;
        await sleep(this.policy.decideMs ?? 1000);
      }
    } while (!this.stopping);
    this.running = false;
    this.note('stopped');
  }

  // WHAT THE PLANNER SAID THIS CHARACTER'S KEEPER SHOULD BE SET TO — APPLIED WHEN THE FILE
  // CHANGES, AND NOT ON EVERY PASS.
  //
  // The problem it solves is real: a broker restart builds keepers from defaults, so a
  // character somebody had aimed at a room and a creature comes back hunting whatever its
  // level implies, silently, until a human notices. Reading the loadout fixes that.
  //
  // But re-applying it every pass is a different thing entirely, and it is worse. The
  // keeper's policy has two other legitimate writers — `m59-supervise.mjs`, which applies a
  // whole orders block every time it deploys a pair, and the `autopilot` MCP tool, which is
  // how an operator or a bot changes one character's mind. An overlay on every pass would
  // silently revert both inside a second, and whoever set it would watch their own setting
  // vanish with nothing saying why. That is the two-homes-for-one-quantity failure this
  // repository keeps re-learning, and here the loser is whoever typed most recently.
  //
  // So the rule is: THE FILE WINS WHEN THE FILE CHANGES. On the first pass after a keeper
  // starts, and on any pass after somebody saves the loadout, the file's policy is applied.
  // Between those moments a runtime set stands. One rule, and it is the one a person would
  // guess — editing the plan re-imposes the plan, and nothing else does.
  //
  // Silence still means "carry on as before": no loadout, no policy block, or a key the
  // author left null all leave the running value exactly where it was.
  applyLoadoutPolicyOverlay() {
    const who = this.s.client?.me?.name ?? this.s.credentials?.character;
    if (!who) return null;
    const mtime = loadoutMtime(who);
    if (mtime === 0) return null;                       // no file, so nothing to say
    if (mtime === this._loadoutPolicyAt) return null;   // unchanged since we last applied it
    this._loadoutPolicyAt = mtime;

    const p = this.loadout()?.policy;
    if (!p || !Object.keys(p).length) return null;

    const applied = {};
    for (const [key, spec] of Object.entries(POLICY_KEYS)) {
      if (p[key] === null || p[key] === undefined) continue;
      if (this.policy[spec.as] !== p[key]) { applied[key] = p[key]; this.policySources?.mark(spec.as, 'loadout'); }
      this.policy[spec.as] = p[key];
    }
    if (Object.keys(applied).length) {
      this.note('took policy from the loadout', {
        ...applied,
        why: 'the loadout file changed, or this keeper has just started, and the file is ' +
             'the standing plan for this character',
        and: 'a runtime `autopilot` set stands until the file is edited again',
      });
    }
    return applied;
  }

  // One decision cycle. Ordered by urgency: being dead, then being in danger, then
  // being hurt, then whatever the mode is for.
  async pass() {
    this._survivalDrainedDecisionId=null;
    await this.passOnce();
    const d=currentSurvivalDecision(this.s);
    // A later stage can select a replacement after the early survival dispatcher
    // has already run. Execute it before returning to loop() and its decideMs sleep.
    if(this.s.live && !this.stopping && d?.status==='pending' && d.strategy!=='yield_to_controller'
        && d.id!==this._survivalDrainedDecisionId)
      await this.continueSurvivalDecision();
  }

  // SPOILED POTIONS OUT OF THE PACK (m59-potion-freshness.mjs): one LOOK at most per pass, each potion every 15 min,
  // and a potion that has soured (24 h after it was made, kod GO_BAD_TIME) is dropped. Only while nothing is busy:
  // not mid-fight, not held, not parked. Drinking still re-checks the exact item first (m59-combat-fallback.mjs).
  async sweepSpoiledPotions() {
    const free = () => this.running && !this.stopping && !this.inert && !this.parking && !this.busyStatus?.()
      && !this.checkFreeze() && !this.s.combat?.active;
    return this.potionFreshness.tick(this.s, { allowed: free, note: r => this.note('potion condition', r) })
      .catch(e => { this.note('potion check failed', { reason: e.message }); return null; });
  }

  async useHealingWand(cancelled = () => false) {
    if(survivalOffOf(this.policy))return null;
    const free = () => this.running && !this.stopping && !this.inert
      && !this.parking && !this.busyStatus?.() && !this.checkFreeze()
      && !this.s.combat?.active;
    const supportAllowed = () => free() && ['farm','idle','survive'].includes(this.mode);
    if (this.farmWandSupport && await this.farmWandSupport.tick({ allowed: supportAllowed, cancelled })) return null;
    const allowed = () => free() && this.mode === 'farm';
    return this.healingWands.tick(this.s, {
      below: this.policy.healWandBelow, allowed, cancelled,
      note: result => this.note('healing wand', result),
    }).catch(e => { this.note('healing wand failed', { reason: e.message }); return null; });
  }

  async passOnce() {
    const s = this.s;
    // THE FARMING STRATEGY FIRST, so everything below this pass reads the file's posture. One stat
    // when nothing changed; a no-op with none assigned. m59-strategy-engine.mjs.
    await this.applyFarmStrategy('pass');
    // INSTALL THE OVERFARM POLICY ON THE SESSION, EVERY PASS. `lootFloor` defaults to it,
    // so this is what reaches the five call sites that are not in this file — the kill tick
    // in m59-decide.mjs, the keeper's own loot action, the `loot` tool, the loot-runner
    // errand and the clean-up sweep. Re-asserted rather than set once because the policy can
    // change under a running keeper and a stale copy on the session would be invisible.
    //
    // The protect list is `protectedItemNames()` — vault items, temporary cargo, whatever
    // the guild plan is still short of, and the declared stockpile floors — so the things
    // this fleet already refuses to sell are also the things it refuses to trade away.
    s.setLootIgnore?.(this.lootIgnoreList());
    s.setOverfarmPolicy?.(this.policy.overfarm ?? null, this.protectedItemNames(),
                          this.carryFloors(), () => this.overfarmKeepIds());
    s.setCursedPickup?.(this.policy.pickupCursed ?? []);
    await this.applyCurseCycle();
    s.setLootOnly?.(this.policy.lootOnly ?? null, { matcherFor: k => this.huntMatch(k) });
    if (!s.live) { this.note('not in game'); return; }
    if (s.combat?.active) {
      await s.combat.tick();
      if (s.combat.active) { this.doing = `combat: ${s.combat.active.phase}`; return; }
    }
    // Operator control stands down autonomous work; PvP above and mortality below remain.
    if(s.world?.room?.num!==1&&this.operatorSurvivalStandDown()){
      this.progress('autonomous survival disabled by operator');return;
    }
    if (effectsAt(s.client, s.client?.self).length) {
      this.doing = await escapeGroundEffect(s) ? 'leaving a ground effect' : 'ground effect: escape blocked';
      return;
    }
    const c = s.client;
    this.survivalInterruptedPass = null;
    observeSurvivalDecision(s);
    // Before GOAP, BT, or any request that could wake the room. Read health again
    // after the await: damage during the poll ends the freeze on this same pass.
    if (this.checkFreeze()) {
      this.doing = 'recovering';
      await s.pacer.submit('read', () => c.stats(1));
      await c.waitFor({ kinds: ['stat'], timeoutMs: 1500 });
      if (this.checkFreeze()) {
        await s.pacer.submit('rest', () => this.checkFreeze() ? c.rest() : false);
        if (this.checkFreeze()) {
          this.note('frozen', { left_s: Math.round((this.frozenUntil - Date.now()) / 1000),
            health: c.vitals()?.health?.value, vigor: c.vitals()?.vigor?.value });
          this.progress('playing dead to avoid a death');
          return;
        }
      }
    }
    if (await this.continueSurvivalDecision()) return;
    // Apply loadout policy overlay BEFORE the BT check so that useBT (and other
    // loadout-driven policy fields) are live on the first pass after a restart.
    // A loadout write lands on keys a strategy may govern: let the strategy answer for them again
    // before this pass decides anything (it reasserts and says so; the loadout value is shadowed).
    const fromLoadout = this.applyLoadoutPolicyOverlay();
    if (fromLoadout && Object.keys(fromLoadout).length) await this.applyFarmStrategy('loadout');
    await this.useHealingWand();
    await this.sweepSpoiledPotions();
    this.jointCurseUpkeep();
    // ------------------------------------------------------------------
    // GOAP KEEPER (opt-in via policy.useGOAP)
    //
    // When policy.useGOAP is true, hand control to the GOAP planner for this
    // pass. The planner reads the world state, plans toward the goal, and
    // executes one step. The next pass() re-plans from the new world state.
    //
    // The safety ladder (Underworld, arming) still runs first: the GOAP
    // planner cannot plan a character out of the Underworld or into a
    // weapon, because those are preconditions, not goals.
    // ------------------------------------------------------------------
    if (this.policy && this.policy.useGOAP === true) {
      const room = s.world?.room ?? c?.room;
      // Underworld: check the CLIENT's room first. The broker's s.world.room
      // can be stale (it lags behind room changes), so the client's wire
      // object is the source of truth. The client reports id: 6 for the
      // Underworld, and roomNameRsc resolves to "The Underworld".
      const clientRoomName = c?.roomNameRsc ? (c.rsc?.get?.(c.roomNameRsc) ?? '') : '';
      const clientRoomId = c?.room?.id;
      const isUnderworld = /underworld/i.test(clientRoomName) || clientRoomId === 6;

      if (c && typeof c.armed === 'function' && !c.armed() && !isUnderworld) {
        const r = await this.passArm({ s, c, room, v: c.vitals?.() ?? {} });
        if (r) return;
      }

      if (!this._goapKeeper) {
        const { GOAPKeeper } = await import('./m59-keeper-goap.mjs');
        this._goapKeeper = new GOAPKeeper({
          client: c,
          session: s,  // the broker session (has the pacer), not the autopilot
          policy: this.policy,
          goal: this.policy.goapGoal ?? 'vigor_ok',
          note: (msg, data) => this.note(msg, data),
        });
      }
      // Override in_underworld when the broker's room tracking says
      // Underworld but the client's room is stale (e.g. right after
      // a reconnect). The GOAP keeper's goal stack picks !in_underworld
      // and plans the escape_underworld atomic.
      const wsOverride = isUnderworld ? { in_underworld: true } : null;
      let r;
      try {
        // Attach the autopilot to the broker session so atomics can
        // call session.ap.fight() etc. The broker session itself has
        // no fight method — that lives on the autopilot.
        s.ap = this;
        r = await this._goapKeeper.pass(wsOverride);
      } catch (e) {
        console.error(`[goap-debug] ${this.name ?? '?'} GOAP pass threw: ${e?.message ?? e}\n${e?.stack?.split('\n').slice(0, 5).join('\n')}`);
        return;
      }
      if (r.acted) { this.progress('goap: ' + r.action); return; }
      // No plan: the GOAP planner could not find a way to reach the goal.
      // This is an answer, not a failure: something the plan needs is
      // absent (no food, no reagents, no merchant in the room). The
      // character falls through to the legacy path, which handles
      // farming, provisioning, and the rest of the lifecycle.
    }
    // ------------------------------------------------------------------
    // BEHAVIOR-TREE GET-ARMED SUBTREE (opt-in via policy.useBT)
    //
    // When policy.useBT is true and the character is NOT yet wielding a weapon at
    // tick start, hand control to the BT for this one decision: try the pack, try
    // conjuring, fall through to travelling to a smith and buying. This is a
    // per-character flag -- the fleet stays on the proven sequential code unless
    // somebody flipped the lever on a specific character, so the BT path is tested
    // in isolation before any fleet-wide rollout.
    //
    // Out of scope here (per docs/BT-PLAN.md): the threat ladder / handle_threat
    // subtree, which is gated on the 383 passing m59-combat-test cases and is the
    // last subtree to land. Event-driven reflexes (watchdog, flee, rest-on-damage,
    // fight-back, death/Underworld) stay on the client and are NEVER moved into the
    // BT.
    // ------------------------------------------------------------------
    if (this.policy && this.policy.useBT === true &&
        c && typeof c.armed === 'function' && !c.armed()) {
      const bb = updateBlackboard(
        this._btBlackboard || (this._btBlackboard = {}),
        { client: c, session: this, policy: this.policy },
      );
      // BUILT ONCE AND KEPT. The tree was being rebuilt on every pass, and both
      // `Action` and `Timeout` key their resumable state off a key generated in the
      // CONSTRUCTOR (`Math.random()`), so a fresh tree every pass meant: a new key every
      // pass, no slot ever found again, every Timeout's clock reset to zero before it
      // could expire, and `bb._bt` growing by one dead entry per pass for ever. The
      // blackboard exists to carry state ACROSS ticks, which a tree rebuilt each tick
      // cannot use.
      const tree = this._btArmedTree ||= getArmedTree({ session: { keeper: this } });
      // tick is synchronous against the slot pattern (m59-bt-nodes.mjs Action
      // factories deliberately avoid returning Promises so the slot is honoured).
      const btResult = await tree.tick(bb);
      // SUCCESS: BT armed us this tick. Clear any inert state the sequential path may
      // have set on a previous pass (stop() calls goInert, which the BT overrides).
      if (c.armed()) {
        if (this.inert) this.revive('BT armed us');
        this.progress('armed itself');
        return;
      }
      // RUNNING: an async action (e.g. travelAndBuy) is in flight. Return now so the
      // sequential body does not race it — in particular, so it cannot call stop() while
      // the buy trip is still walking to the smith.
      //
      // ONLY THE STATUS. This used to also return when `bb._bt` was non-empty, which is
      // not a test for "something is running": `Timeout` writes a slot on its FIRST tick
      // and removes it only when its child reaches a terminal status, so with the tree
      // rebuilt each pass (above) `bb._bt` was non-empty for ever after the first tick.
      // The keeper would then return from `pass()` on every pass, permanently — no flee,
      // no rest, no farm — for as long as the character was unarmed with use_bt on. A
      // stall with every appearance of a healthy row.
      if (btResult === RUNNING) return;
      // FAILURE: BT gave up (e.g. no buy method wired yet). Fall through to the sequential path.
    }

    // Post where we are, every pass. Cheap, and it is the only way one keeper can find
    // another that has wandered — see runProvision, where a quartermaster arrives to
    // find the supplicant has roamed off and would otherwise abandon the errand.
    if (s.world?.room?.num != null) noteWhere(s.name, s.world.room.num, s.world.room.name);
    // And post what we need and what we can spare, for the same reason: the sell and
    // drop paths read the aggregate, and a stale board sells somebody else's herbs.
    this.declareInterest();
    // TAKE WHAT WE ASKED FOR, AND HAND OVER WHAT OTHERS ASKED FOR  in every mode, with no policy
    // (m59-sharing.mjs). Receiving costs one reply when a fleetmate's offer is waiting; giving looks
    // at the board at most once per `shareSpare.every_ms` and only when this body is quiet.
    if(!stationaryTradeActive(s))await withBodyStage(s,'passSharing',()=>this.acceptNeededGift()).catch(error => this.note('gift accept failed', { why: error.message }));
    // IDLE GEAR (m59-castrite.mjs): a casting strategy's say over what is worn when nothing is being
    // cast -- a disciple robe left on outside an inn comes off. A no-op without such a strategy.
    if(!stationaryTradeActive(s))await withBodyStage(s,'passIdleGear',()=>idleGearCheck(s, { why: 'pass' })).catch(error => this.note('idle gear check failed', { why: error.message }));
    // WHAT A TRADE JUST GAVE US is written down before anything that throws things away can run (m59-received.mjs).
    this.noteReceivedGoods();
    // THE POOL OF VIGOR (2510): anyone standing beside it below full vigor drinks (social.mjs drinkAtPoolOfVigor).
    if (!stationaryTradeActive(s)&&await withBodyStage(s,'passSharing',()=>this.drinkAtPoolOfVigor()).catch(error => {
      this.note('pool of vigor drink failed', { why: error.message }); return false; })) return;
    // LOOT EJECTION: the sale pile goes to a station or courier of ours standing here (m59-loot-eject.mjs). Off by default.
    if (!stationaryTradeActive(s)&&await withBodyStage(s,'passSharing',()=>this.ejectLoot()).catch(error => {
      this.note('loot ejection failed', { why: error.message }); return false; })) return;
    if (!stationaryTradeActive(s)&&await withBodyStage(s,'passSharing',()=>this.shareSpareReagents()).catch(error => {
      this.note('sharing pass failed', { why: error.message }); return false; })) return;
    // POST OUR SITUATION FOR OUR PARTNER, every pass and before any decision that reads
    // theirs. A partner acts on health, room and whether we are behind a wall; all
    // three are read from the register rather than asked for over the wire, so a
    // reading nobody refreshed is a decision made about where we were a minute ago.
    // m59-party treats anything older than 90s as absent for exactly that reason.
    if (this.policy.partner) {
      const pv = c?.vitals?.() ?? {};
      party.report(this.s.name, {
        health: pv.health?.max ? pv.health.value / pv.health.max : null,
        room: s.world?.room?.num ?? null,
        holding: this.hold ? { col: this.hold.col, row: this.hold.row } : null,
        doing: this.doing ?? null,
        needs: this.wantsNow ?? [],
      });
    }
    // Remember the purse while we still can. After a death the inventory is already on
    // the corpse, so the only way to know what was lost is to have looked before.
    if (c?.inventory?.length)
      this.lastSeenPurse = c.inventory
        .filter(o => /shilling/i.test(c.rsc.get(o.nameRsc) || ''))
        .reduce((t, o) => t + (o.amount || 1), 0);

    // RESYNC ON A CLOCK, NOT EVERY PASS. See decideMs/resyncMs above: room.objects is
    // maintained by pushes, so between resyncs we are deciding on a live map rather
    // than a stale one, and asking again costs two requests, up to four seconds of
    // waiting, and a NotifyMonstersOfPresence that wakes the room.
    //
    // Resync anyway when we have reason to distrust the cache: right after arriving
    // somewhere, and whenever the last one is older than resyncMs.
    const resyncEvery = this.policy.resyncMs ?? this.policy.idleMs ?? 8000;
    const roomChanged = this.lastResyncRoom !== (s.world?.room?.num ?? null);
    if (roomChanged || !this.lastResyncAt || Date.now() - this.lastResyncAt >= resyncEvery) {
      this.lastResyncAt = Date.now();
      this.lastResyncRoom = s.world?.room?.num ?? null;
      this.resyncs = (this.resyncs || 0) + 1;
      await s.pacer.submit('read', () => c.roomContents());
      await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 });
      await s.pacer.submit('read', () => c.stats(1));
      await c.waitFor({ kinds: ['stat'], timeoutMs: 1500 });
    }

    const room = s.world?.room;
    const v = c.vitals();
    const hp = pct(v.health);

    // BEFORE ANY DECISION: do we still know where we are standing, and is it working?
    // Every branch below reads differently depending on the answer — fleeing, resting
    // and logging off all invert inside a working safe spot — so it has to be settled
    // first and from evidence, not from what the geometry hoped.
    this.observe();

    // A SHORT MEMORY, kept only so that a death can be explained.
    //
    // The ledger samples every five minutes, which is far too coarse to catch a
    // death: it reports where the character was up to five minutes BEFORE it died,
    // which is why the last dozen death records all name inns and towns. Nobody died
    // in an inn. They died somewhere else, minutes later, and the sample was stale.
    //
    // The keeper is the only thing running at the resolution a death happens at.
    //
    // Each frame also records WHAT WE WERE DOING, because "health 22, 14, 6" is a
    // description of dying and not an explanation of it. Standing on a wall at 6 health
    // and running for a door at 6 health are the same three numbers and opposite
    // mistakes, and only the second column tells them apart.
    this.recordFrame();

    // Answer people and take hand-outs before anything else. Cheap, and a player
    // trying to help should not have to wait for a fight to finish.
    // CHALICE FARMING'S CONFIGURATION comes from a private strategy and is re-read at most
    // every 30s; everything that consults it reads the cached copy synchronously.
    await this.refreshChaliceConfig().catch(() => {});
    await this.refreshWandDutyConfig().catch(() => {});
    try { this.chaliceFolWatch(); } catch {}
    // A CUP ON THE FLOOR BEFORE ANYTHING ELSE: it can be stolen in the time a pass takes.
    if (await this.chaliceGuard().catch(e => { this.note('chalice guard failed', { why: e.message }); return false; }))
      return 'chaliceGuard';
    await this.chaliceHandInMoney().catch(e => this.note('money hand-in failed', { why: e.message }));
    await this.social().catch(e => this.note('social failed', { why: e.message }));

    // GIVE BACK ANY SIGNET RING WHOSE OWNER IS STANDING HERE.
    //
    // Each one pays up to ten times its value to a character under 30 max health, and the
    // fleet had been carrying them as loot; Statler had six. The owner is named in the
    // ring's own description, so this costs nothing to ask wherever we happen to be.
    //
    // THIS IS THE FALLBACK NOW, NOT THE WHOLE STRATEGY. I said the owners wander and that
    // an NPC-location table would not help. Four of the nineteen wander; the other fifteen
    // stand in a fixed room in a town — see SIGNET_OWNERS in m59-skills.mjs — so the ring
    // usually names a destination, and `signets` dispatches an errand that goes there. This
    // branch is what catches the four that roam, and what catches a routed ring early if
    // its owner happens to walk past first.
    //
    // Cheap enough to ask every pass ONLY because the answer is cached: a ring's owner
    // never changes, so it is one look per ring ever, and afterwards this is a name
    // comparison against the objects already in the room snapshot. Gated on carrying one
    // at all, which is almost never.
    if ((c.inventory || []).some(o => /signet ring/i.test(c.rsc.get(o.nameRsc) || ''))) {
      const gave = await skills.returnSignetRings(s).catch(() => null);
      if (gave?.returned?.length) {
        this.tally.signets_returned = (this.tally.signets_returned || 0) + gave.returned.length;
        this.progress('returned a signet ring');
        this.note('returned a signet ring', {
          to: gave.returned.map(r => r.to),
          still_carrying: gave.carrying,
          paid: skills.signetPayout({ level: c.vitals()?.health?.max ?? null }),
          why: 'the owner was standing here, and a returned ring pays ten times its value ' +
               'to a character under 30 max health',
        });
      }
    }

    // 0. Do we still know who we are? A `save game` renumbers every object, and a
    //    session that was live across one keeps a selfId the server no longer uses.
    //    Nothing errors. Position reads null, our own object is missing from room
    //    contents, and every check written as "am I still in the room?" concludes we
    //    died — forever, at full health. Re-logging in is the whole fix, because the
    //    id is handed out fresh at login.
    if (!c.self) {
      this.selfMissingPasses++;
      if (this.selfMissingPasses >= 3) {
        this.note('lost our own object id — reconnecting',
                  { passes: this.selfMissingPasses,
                    why: 'not in room contents; usually a save-game renumber' });
        const again = await this.reconnect('recovering a renumbered object id');
        this.selfMissingPasses = 0;
        this.note(again.ok ? 'reconnected' : 'reconnect failed',
                  again.ok ? { object_id: s.client?.selfId } : { why: again.why });
        this.noProgress('reconnecting after losing our object id');
        return;
      }
    } else this.selfMissingPasses = 0;

    // THE LADDER. One ordered list, walked in order, short-circuiting on the first stage
    // that says it dealt with the tick. See PASS_STAGES and HANDLED/CONTINUE above for
    // why the verdict is a sentinel rather than a boolean.
    //
    // Every stage takes the SAME context object, so the list can be a list of names —
    // which is what lets `m59-passorder-test.mjs` assert the order and the short-circuit
    // against this real function rather than against a copy of it.
    //
    // DRESS FROM THE PACK, once a minute while farming, BEFORE THE LADDER. The loot sites catch
    // a piece as it is picked up; this catches the spare that was already aboard. It sat at the
    // top of passFarm first, and Rizzo showed why that is too late: a character cycling
    // "leaving the wall" / "gave up the safe spot" ends every pass in the rest rung and never
    // reaches passFarm at all, so a chain armour sat in his pack for minutes. Here every pass
    // sees it. Not while anything is in reach — nobody changes clothes mid-fight — UNLESS we are
    // holding a proven wall, which is by definition a square the things in reach cannot hit.
    // Without that exception the Icky Cave crew, who spend most passes on walls at the lip of a
    // pocket with orcs 2.8 squares away on the far side, would essentially never dress. Free
    // when no slot is empty, never swaps, stands down under an economy lease.
    if (this.mode === 'farm' && Date.now() - (this.dressedAt ?? 0) > 60_000
        && (!(this.inReachOfUs?.()?.length) || (this.hold && this.holdWorks?.()))) {
      this.dressedAt = Date.now();
      await withBodyStage(this.s,'passDress',()=>this.wearIntoEmptySlots('put on armour we were carrying')).catch(() => false);
    }
    return this.runPassLadder({ s, c, room, v, hp });
  }

  /**
   * RUN ONE RUNG, AND STOP WAITING FOR IT AFTER ITS DEADLINE.
   *
   * See STAGE_DEADLINE_MS for why this exists and what it measured. Three properties, each
   * of which is the difference between this and a bare `Promise.race`:
   *
   *   * At the deadline THE WORK IS NOT CANCELLED, because a promise cannot be. The rung keeps running and
   *     finishes whatever it was doing; only the ladder stops waiting.
   *   * THE RUNG IS MARKED IN FLIGHT until it settles, so `runPassLadder` skips it rather
   *     than starting a second copy on the same body.
   *   * A LATE REJECTION CANNOT CRASH THE PROCESS. Once the race is lost nothing awaits the
   *     original promise, so an abandoned rung that throws five minutes later would be an
   *     unhandled rejection — on a keeper, that is the whole character gone for a bug in a
   *     rung that had already been given up on.
   *
   * A rung that returns before its deadline behaves exactly as it did: same verdict, same
   * throw, same everything. With `M59_STAGE_DEADLINE_MS=0` this is a straight call.
   */
  async runStageBounded(stage, ctx) {
    const ms = stageDeadlineMs(stage);
    if (!(ms > 0)) return withBodyStage(this.s,stage,()=>this[stage](ctx));
    // The async wrapper is what turns a SYNCHRONOUS throw out of the rung into a rejection,
    // so both failure shapes take the same path.
    const stageToken = {cancelled:false};
    const running = withBodyStage(this.s,stage,async()=>this[stage](ctx),stageToken);
    this.stageInFlight ??= new Map();
    const startedAt = Date.now();
    this.stageFlightStartedAt ??= new Map();
    this.stageFlightStartedAt.set(stage, startedAt);
    const settled = running.then(
      v => { this.stageInFlight.delete(stage); this.stageFlightStartedAt.delete(stage); return v; },
      e => { this.stageInFlight.delete(stage); this.stageFlightStartedAt.delete(stage); throw e; });
    // Attached BEFORE the race, because the race is what may stop observing it.
    settled.catch(() => {});
    this.stageInFlight.set(stage, settled);

    let timer = null;
    // DELIBERATELY NOT `unref`. Its lifetime is already bounded by the race — `clearTimeout`
    // in the `finally` below fires the moment the rung answers — so it can never hold a
    // process open. Unreferencing it instead lets node exit while the race is still pending,
    // which in a test is an "unsettled top-level await" and in a keeper would be a pass that
    // vanishes rather than resolves.
    const overran = new Promise(res => { timer = setTimeout(() => res(STAGE_OVERRAN), ms); });
    let stopDanger = () => {};
    const danger = new Promise(resolve => {
      stopDanger = watchFarmDanger(this, stage, stageToken, detail => {
        this.tally.survival_stage_interrupts = (this.tally.survival_stage_interrupts || 0) + 1;
        this.note(stage==='passCooperative'?'cooperative distraction yielded immediately to falling health':'farm action yielded immediately to falling health', {stage, ...detail});
        resolve(STAGE_OVERRAN);
      });
    });
    let verdict;
    try { verdict = await Promise.race([settled, overran, danger]); }
    finally { clearTimeout(timer); stopDanger(); }

    if(stageToken.cancelled)return STAGE_OVERRAN;
    if (verdict === STAGE_OVERRAN) {
      this.tally.stage_overran = (this.tally.stage_overran || 0) + 1;
      this.note('a pass rung overran the ladder deadline — carrying on without it', {
        stage, waited_ms: Date.now() - startedAt, deadline_ms: ms,
        why: 'the ladder stopped waiting so the rungs above this one get a turn again. The ' +
             'rung itself is STILL RUNNING and is not called again until it returns — this ' +
             'abandons the wait, never the work',
        what_it_costs: 'this pass ends here; the next one starts at the top, which is how ' +
                       'passFleeAndRest gets its turn back',
      });
      return STAGE_OVERRAN;
    }
    return verdict;
  }

  // THE LADDER ITSELF, ON ITS OWN, SO THAT THE TEST CAN RUN THE REAL ONE.
  //
  // Kept out of `pass()` deliberately. `pass()` has a long preamble that wants a live
  // session — vitals, the room, the position post, the self-missing check — so a test that
  // wanted to assert the ORDER would have had to either stand up a fake world or write out
  // the ladder a second time and check its copy. The second is what a first draft of
  // `m59-passorder-test.mjs` did, and a test that reimplements the thing it is testing
  // would have passed against the broken version, which is the only version that mattered.
  //
  // Returns the stage that ended the tick, or null if every one of them passed.
  async runPassLadder(ctx) {
    tracePassContext(this.s, ctx);
    // THE ONLY PLACE THAT KNOWS WHICH RUNGS GOT A TURN. Everything else reports the result
    // of this walk; `M59_KEEPER_TRACE=1` reports the walk. Free when off — `traceLadder`
    // returns on its first line — and run-length collapsed when on, so a character stuck
    // for six minutes is one row saying so rather than four hundred saying nothing.
    const ran = [];
    // ---------------------------------------------------------------- SURVIVAL GOES FIRST
    //
    // A BODY BELOW ITS FLEE LINE AND STILL LOSING HEALTH DOES NOT WAIT ITS TURN.
    //
    // The ladder is ordered, and `passFleeAndRest` sits fifth. Everything above it is bounded
    // at fifteen seconds, which is the right bound for a HUNG rung and far too long for a
    // dying one: the measured rate on these deaths is 2 to 8.2 health per second, so fifteen
    // seconds is 30 to 120 damage against characters whose whole bar is 50 to 60. A rung that
    // is merely slow — not hung, so no deadline fires and nothing looks wrong — can therefore
    // spend a character's entire remaining health before the rung that would have saved it is
    // reached.
    //
    // Measured 2026-09-20, on the clean pre-death fields only: 49 of 50 deaths had six or
    // more threats at the worst moment, and three of the last four entered the recorded
    // window already at or below 17% health. Rowlf held 3/50 across four samples in a room
    // with eight threats — not overwhelmed suddenly, but parked at death's door while the
    // ladder did other things.
    //
    // So this runs the survival rung BEFORE the walk, and the walk then skips it. It is the
    // same rung, with the same body of work behind it — the route-adjacent safe spot, the
    // rest, and playing dead in a proven spot — because that tactic is the only one this
    // fleet has ever shown to work, and reimplementing a second copy of it here would be a
    // second thing to keep correct.
    //
    // NOT A NEW POLICY SURFACE. It fires on `safety().fleeAt`, the threshold the keeper
    // already owns, so an operator who moves the flee line moves this with it.
    const danger = this.mortalDanger?.();
    let survivalRanEarly = false;
    if (danger && !this.stageInFlight?.has('passFleeAndRest') && !continuingProvenRefugeLeg(this.s)) {
      survivalRanEarly = true;
      ran.push('passFleeAndRest');
      this.passStage = 'passFleeAndRest';
      this.passStageAt = Date.now();
      this.tally.survival_preempted = (this.tally.survival_preempted || 0) + 1;
      // Said once per occurrence rather than per pass, so a long recovery is one line.
      if (this.lastPreemptPass !== this.passes) {
        this.lastPreemptPass = this.passes;
        this.note('survival ran before its turn', {
          at: `${Math.round(danger.frac * 100)}%`,
          flee_line: `${Math.round(danger.fleeAt * 100)}%`,
          losing_per_s: danger.rate,
          why: 'below the flee line and still losing — the rungs above this one are bounded '
             + 'at 15s each, which is longer than this body has',
        });
      }
      // AND NOTHING WAITS FOR A WALK THAT IS ABOUT TO BE THROWN AWAY.
      //
      // If a movement is in flight when this fires, its destination was chosen by a rung
      // that did not know the body was dying — a hunt approach, a town leg, a pull. The
      // survival rung is about to choose a different destination, so every second spent
      // waiting for the old one is spent at 2 to 8 health per second, and the result is
      // discarded on arrival anyway.
      //
      // CANCEL AND ACT IN THE SAME BREATH, which is the distinction that matters here.
      // Cancelling alone is what killed a character in Ukgoth: the rail was "cancelled by
      // the watchdog rescuing a stalled driver", the ordinary ladder then ran through
      // "could not reach the safe spot", "will not rest in the open here", "could not
      // leave", and the body walked zero squares in fifteen seconds. The cancel is only
      // safe because the rung that will act runs on the very next line rather than on some
      // later pass.
      //
      // This is also the direction the travel guard already takes for a mid-hop trigger —
      // "CANCEL the journey rather than fighting the mover for the body" — and the opposite
      // of what killed Cccc, which was holding the keeper inert THROUGH the trouble.
      const inFlight = this.s?.job && !this.s.job.done ? this.s.job : null;
      if (inFlight && typeof this.s.cancelMovement === 'function') {
        try {
          this.s.cancelMovement(null,
            `below the flee line (${Math.round(danger.frac * 100)}%) and still losing ` +
            `${Math.abs(danger.rate)}/s — the survival rung is choosing a different ` +
            'destination, so this walk is already void', { origin: keeperOrigin('survival_preempt') });
          this.tally.survival_preempt_cancels = (this.tally.survival_preempt_cancels || 0) + 1;
        } catch { /* a handbrake that throws must not stop the rescue */ }
      }
      const verdict = await this.runStageBounded('passFleeAndRest', ctx);
      // The same three outcomes the loop below honours, for the same reasons.
      if (verdict === STAGE_OVERRAN || this.travelInterrupted()) {
        this.traceThisPass(ctx, ran, 'passFleeAndRest');
        return 'passFleeAndRest';
      }
      if (verdict !== CONTINUE) {
        this.traceThisPass(ctx, ran, 'passFleeAndRest');
        return 'passFleeAndRest';
      }
      // CONTINUE means the rung looked and had nothing to do. Fall through to the ordinary
      // ladder rather than ending the tick on a rung that declined.
    }
    for (const stage of PASS_STAGES) {
      // Already given its turn above, and a rung must never be invoked twice in one pass.
      if (survivalRanEarly && stage === 'passFleeAndRest') continue;
      ran.push(stage);
      // WHICH RUNG THE PASS IS SITTING IN, FOR THE POSTMORTEM TO READ.
      //
      // `pass_blocked_ms` says the keeper stopped deciding and does not say WHERE, and that
      // gap has now cost two investigations. 93% of the deaths since 2026-09-01 had the pass
      // blocked over thirty seconds, and the only honest answer to "blocked on what" was a
      // guess, because a pass sitting in an `await` is invisible to every instrument here:
      // `loop_stall` in m59-keeper-process.mjs profiles the EVENT LOOP, which an await does
      // not block, so it reports nothing for exactly this case.
      //
      // A RUNG THAT HAS NOT COME BACK YET IS NOT CALLED AGAIN. See STAGE_DEADLINE_MS: the
      // deadline abandons the WAIT and never the WORK, so the previous invocation is still
      // out there walking a body. Invoking it a second time would put two shopping trips, or
      // two retreats, on one character — which is worse than the hang.
      if (this.stageInFlight?.has(stage)) {
        this.tally.stage_skipped_in_flight = (this.tally.stage_skipped_in_flight || 0) + 1;
        // A portal escape still owns a dead body. Ordinary arming/resting below
        // must not steer or spend mana underneath the unfinished escape.
        if (stage === 'passUnderworld' && (Number(ctx.room?.num) === UNDERWORLD
            || /underworld/i.test(ctx.room?.name ?? ctx.c?.room?.name ?? '')
            || Number(ctx.c?.room?.id) === UNDERWORLD_ROOM_OBJECT_ID)) {
          this.traceThisPass(ctx, ran, stage);
          return stage;
        }
        continue;
      }
      // One assignment per stage, no allocation, no I/O. Read by `postMortem`.
      this.passStage = stage;
      this.passStageAt = Date.now();
      const verdict = await this.runStageBounded(stage, ctx);
      // THE LADDER GAVE UP WAITING. End the pass here rather than falling through: the rung
      // is still running, and starting the next one on top of it is the double-invocation the
      // skip above exists to prevent. The next pass begins at the top, which is the whole
      // point — `passFleeAndRest` gets a turn again.
      if (verdict === STAGE_OVERRAN) {
        this.traceThisPass(ctx, ran, stage);
        return stage;
      }
      // A watchdog can interrupt while this rung awaits a whole shopping trip.
      // Its old context must not send the character into the next errand/farm rung.
      if (this.travelInterrupted()) {
        this.traceThisPass(ctx, ran, stage);
        return stage;
      }
      if (verdict === CONTINUE) continue;
      if (verdict !== HANDLED) {
        // A STAGE THAT ANSWERED NEITHER. Almost certainly a bare `return;` left over from
        // when this was one function. Honoured as HANDLED — that is what it used to mean,
        // and ending the tick early costs one pass while falling through costs a hurt
        // character a fight — but said out loud, because being silent is what made the
        // original fall-through survive a commit.
        this.note('a pass stage gave no verdict', {
          stage, got: String(verdict),
          treated_as: 'handled — the tick ends here',
          why: 'every stage must return HANDLED or CONTINUE; a bare `return;` returns ' +
               'neither, and used to be read as "carry on to the next stage"',
        });
      }
      this.traceThisPass(ctx, ran, stage);
      return stage;
    }
    this.traceThisPass(ctx, ran, null);
    return null;
  }

  // The shape of one walk, for the ladder tracer. Kept out of `runPassLadder` so the ladder
  // reads as the ladder, and wrapped so a diagnostic can never end a tick.
  traceThisPass(ctx, ran, decidedBy) {
    try {
      traceLadder({
        who: this.who?.() ?? this.character ?? '?',
        pass: this.passes ?? 0,
        decided_by: decidedBy,
        ran,
        room: Number(ctx?.room?.num ?? this.s?.world?.room?.num ?? NaN) || null,
        mode: this.mode ?? null,
        doing: this.doing ?? null,
        health: ctx?.hp ?? null,
        vigor: vigorPct(ctx?.v) ?? null,
        // THE FIELD THIS WAS BUILT FOR. A character carrying an objective while some other
        // rung ends every tick is the exact shape that cost this session three rounds.
        suspended_to: this.suspendedJourney?.to ?? null,
        holding: !!this.hold,
        since_full: this.sinceFullHealth?.() ?? null,
      });
    } catch { /* never break the keeper */ }
  }
  // @autopilot-part ./autopilot/death.mjs#2
  // @autopilot-part ./autopilot/pass-travelling.mjs#1
  // @autopilot-part ./autopilot/pass-combat.mjs#1
  // @autopilot-part ./autopilot/pass-survival.mjs#1
  // @autopilot-part ./autopilot/pass-outside.mjs#1
  // @autopilot-part ./autopilot/lever-puzzle.mjs#1
  // @autopilot-part ./autopilot/pass-errand.mjs#1
  // @autopilot-part ./autopilot/buddy.mjs#1
  // @autopilot-part ./autopilot/curse-cycle.mjs#1
  // @autopilot-part ./autopilot/buddy.mjs#2
  // @autopilot-part ./autopilot/pass-farm.mjs#1
  // @autopilot-part ./autopilot/social.mjs#1
  // @autopilot-part ./autopilot/chalice.mjs#1
  // @autopilot-part ./autopilot/wand-duty.mjs#1
  // @autopilot-part ./autopilot/chalice.mjs#2
  // @autopilot-part ./autopilot/desk-practice.mjs#1
  // @autopilot-part ./autopilot/heard.mjs#1
  // @autopilot-part ./autopilot/market.mjs#1
  // @autopilot-part ./autopilot/delivery.mjs#1
  // @autopilot-part ./autopilot/shopping.mjs#1
  // @autopilot-part ./autopilot/town-trip.mjs#1
  // @autopilot-part ./autopilot/hall.mjs#1
  // @autopilot-part ./autopilot/town-shops.mjs#1
  // @autopilot-part ./autopilot/cooperative.mjs#1
  // @autopilot-part ./autopilot/gear-upkeep.mjs#1
  // @autopilot-part ./autopilot/retreat.mjs#1
}
installParts(Autopilot, [
  HuntSetupPart,
  TrainingPart,
  GearPart,
  ProvisionPart,
  SensesPart,
  BridgesPart,
  InventoryPart,
  SafeSpotsPart,
  PullPart,
  SanctuaryPart,
  ErrandsPart,
  HuntBooksPart,
  PvpReturnPart,
  TravelPart,
  PvpResponsePart,
  ThreatPart,
  DeathPart,
  JournalPart,
  StatusPart,
  FacultiesPart,
  WatchdogPart,
  WedgePart,
  PassTravellingPart,
  PassCombatPart,
  PassSurvivalPart,
  PassOutsidePart,
  LeverPuzzlePart,
  PassErrandPart,
  BuddyPart,
  CurseCyclePart,
  PassFarmPart,
  SocialPart,
  ChalicePart,
  WandDutyPart,
  DeskPracticePart,
  HeardPart,
  MarketPart,
  DeliveryPart,
  ShoppingPart,
  TownTripPart,
  HallPart,
  TownShopsPart,
  CooperativePart,
  GearUpkeepPart,
  RetreatPart,
]);

// ONE WALL EACH.
//
// The geometry is deterministic, so every keeper in a room ranks the same squares in
// the same order and they all walk to the identical corner — which is how three
// characters ended up on square (50,21) of the same room, and four stacked on (8,15)
// of the Limping Toad. Sharing a safe spot buys nothing: the wall covers a square, not
// a queue, and standing in a heap makes every one of them look to the others like a
// crowd of attackable things.
//
// A player might share a wall deliberately — one tanking while another heals past them
// is a real tactic.
//
// SO IT IS A SPREAD, NOT AN EXCLUSION. "One each" was right about the failure it was
// written for — four characters stacked on (8,15) of the Limping Toad — and wrong about
// what to do when there are more keepers than squares. A room with four walls and eight
// characters gave four of them a wall and sent the other four to the no-wall path, which
// is the branch that precedes most of the deaths. Two to a wall is worse than one and far
// better than none.
//
// The cap therefore RISES ONLY WHEN IT HAS TO: every square fills to one before any takes
// a second, and to two before any takes a third. takeSafeSpot retries with a higher cap
// when the search comes back empty, so the distribution is a consequence of the search
// rather than a number anybody has to maintain.
//
// The fallback register lives in this module for ordinary in-process callers and offline
// tests. Production keepers do NOT share a process; m59-spotclaims.mjs supplies the same
// API from an atomic file-backed register configured by m59-keeper-process.mjs.
//
// A SQUARE HOLDS A SET, NOT A NAME, because partners share one on purpose (see
// m59-party.mjs). With a single name the second partner to claim simply overwrote the
// first, and the register then believed the first had gone — so releasing the second
// freed a square somebody was still standing on. Everyone who is actually there is
// recorded; who is ALLOWED to join is a separate question, answered below.
const claimedSpots = new Map();        // "room:col,row" -> Set<agent name>
const spotKey = (room, col, row) => `${room}:${col},${row}`;

export function snapshotSpotClaims() {
  if (fileSpotClaimsEnabled()) {
    try { return { kind: 'file', value: fileSpotClaimSnapshot() }; }
    catch (error) { return { kind: 'unavailable', error }; }
  }
  return { kind: 'memory', value: new Map(
    [...claimedSpots].map(([key, who]) => [key, new Set(who)])) };
}

// Publish a partnership to the cross-process register. `mayShareSpot` remains the
// in-process authority; the file record is its symmetric equivalent for two keepers that
// cannot see each other's m59-party Map.
export function rememberSpotClaimPartner(agent, partner = null) {
  if (!fileSpotClaimsEnabled()) return false;
  try { return rememberFileSpotPartner(agent, partner); }
  catch { return false; }
}

export function claimSpot(agent, room, col, row, { cap = Infinity, partner = undefined } = {}) {
  if (fileSpotClaimsEnabled()) {
    try {
      return claimFileSpot(agent, room, col, row,
        { cap, partner, mayShare: (a, b) => mayShareSpot(a, b) });
    } catch { return false; }           // fail closed: do not walk into an unreserved wall
  }
  releaseSpot(agent);                  // one square each; claiming a new one gives up the old
  const k = spotKey(room, col, row);
  let held = claimedSpots.get(k);
  if (!held) claimedSpots.set(k, held = new Set());
  held.add(agent);
  return true;
}

// Quarry-bound walls follow a stricter contract than general shelter: nobody else,
// including a deliberate party partner, may reserve the square. This is atomic in the
// production file store and uses the same one-claim-per-agent move semantics in tests.
export function claimExclusiveSpot(agent, room, col, row) {
  if (fileSpotClaimsEnabled()) {
    try {
      return !!claimFileSpot(agent, room, col, row,
        { cap: 1, partner: null, mayShare: () => false });
    } catch { return false; }
  }
  const k = spotKey(room, col, row);
  const current = claimedSpots.get(k);
  if (current && [...current].some(who => who !== agent)) return false;
  releaseSpot(agent);
  const held = claimedSpots.get(k) ?? new Set();
  held.add(agent);
  claimedSpots.set(k, held);
  return true;
}
export function releaseSpot(agent) {
  if (fileSpotClaimsEnabled()) {
    try { return releaseFileSpot(agent); }
    catch { return 0; }
  }
  let released = 0;
  for (const [k, who] of claimedSpots) {
    if (!who.delete(agent)) continue;
    released++;
    if (!who.size) claimedSpots.delete(k);
  }
  return released;
}
// WHO IS IN THE WAY — meaning who is standing here that this agent may not join.
//
// Partners are not in the way. That is the exception the ONE WALL EACH note above
// carves out, and it is the only one: every other keeper is still refused, so an
// uncoordinated fleet cannot pile onto the same corner.
// How many OTHERS are standing here that this agent is not deliberately sharing with.
// Partners are not crowding us — that is the exception m59-party.mjs relies on — so they
// do not count toward the cap.
export function spotOccupancy(agent, room, col, row, snapshot = null) {
  snapshot ??= snapshotSpotClaims();
  if (snapshot.kind === 'unavailable') return Number.MAX_SAFE_INTEGER;
  if (snapshot.kind === 'file')
    return fileSpotOccupancy(agent, room, col, row,
      { snapshot: snapshot.value, mayShare: (a, b) => mayShareSpot(a, b) });
  const held = snapshot.value.get(spotKey(room, col, row));
  if (!held) return 0;
  let n = 0;
  for (const who of held) {
    if (who === agent) continue;
    if (mayShareSpot(agent, who)) continue;
    n++;
  }
  return n;
}
// `cap` is how many strangers this agent will tolerate on the square. 1 is the old
// behaviour and stays the default, so every existing caller is unchanged; takeSafeSpot
// raises it a step at a time when nothing is free at the current level, which is what
// turns "one each" into "spread evenly".
export function spotTakenByAnother(agent, room, col, row, cap = 1, snapshot = null) {
  snapshot ??= snapshotSpotClaims();
  if (snapshot.kind === 'unavailable') return 'wall claim store unavailable';
  if (snapshot.kind === 'file')
    return fileSpotTakenByAnother(agent, room, col, row, cap,
      { snapshot: snapshot.value, mayShare: (a, b) => mayShareSpot(a, b) });
  const held = snapshot.value.get(spotKey(room, col, row));
  if (!held) return null;
  if (spotOccupancy(agent, room, col, row, snapshot) < cap) return null;
  for (const who of held) {
    if (who === agent) continue;
    if (mayShareSpot(agent, who)) continue;
    return who;
  }
  return null;
}

export function spotClaimedByAnotherExclusive(agent, room, col, row, snapshot = null) {
  snapshot ??= snapshotSpotClaims();
  if (snapshot.kind === 'unavailable') return 'wall claim store unavailable';
  if (snapshot.kind === 'file') {
    const found = (snapshot.value?.claims ?? []).find(r =>
      r.agent !== agent && Number(r.room) === Number(room)
      && Number(r.col) === Number(col) && Number(r.row) === Number(row));
    return found?.agent ?? null;
  }
  const held = snapshot.value.get(spotKey(room, col, row));
  if (!held) return null;
  return [...held].find(who => who !== agent) ?? null;
}
// How deep the stacking is allowed to get before a wall stops being worth sharing. Four
// on one square is the pile-up this register exists to prevent; three is the point where
// the wall covers less than it costs.
// The value the opt-in spread strategy inherits. It is exported as data rather than
// wired into takeSafeSpot: strategy off means unlimited, strategy on with no override
// reproduces the historical cap of three bots per wall.
export const SPOT_SHARE_CAP = 3;
export const claimedSpotList = () => {
  const snapshot = snapshotSpotClaims();
  if (snapshot.kind === 'unavailable') return [];
  if (snapshot.kind === 'file') return fileClaimedSpotList({ snapshot: snapshot.value });
  return [...snapshot.value.entries()]
    .flatMap(([k, who]) => [...who].map(agent => ({ at: k, agent })));
};

// A room number can contain disconnected monster-movement components. Players can
// sometimes bridge them only by stepping through another room; monsters cannot. Under
// confinement that bridge is permitted only when its intermediate room is permitted too.
// Keep this as a pure predicate so quarry selection and the last-moment movement guard can
// be tested independently: the latter remains the safety backstop for every other caller.
export function quarryPermittedByConfinement({
  map, room, geo, from, target, confineRooms,
} = {}) {
  if (!Array.isArray(confineRooms) || !confineRooms.length) return true;
  const roomNum = Number(room?.num ?? room);
  const bridge = sameRoomIslandBridgePlan(map, roomNum, geo, from, target);
  if (!bridge) return true;       // same component, or no route that would leave the room
  // An internal door keeps the entire journey in this room. Prefer it over a
  // neighbouring-room detour before treating the quarry as outside confinement.
  if (sameRoomDoorPlan(map, roomNum, geo, from, target)?.doors?.length) return true;
  const permitted = new Set(confineRooms.map(Number));
  return permitted.has(Number(bridge.viaRoom));
}

// SPREAD THE FLEET ACROSS THE ROOM'S QUARRY.
//
// Every keeper sees the same object list and findCreature sorts it only by distance.
// Characters gathered at the same wall therefore choose the same nearest skeleton,
// spend a pull window on it, and discover that somebody else killed it. A claim is a
// preference, not an exclusion: when there are fewer monsters than keepers the least-
// claimed creature wins, so every creature gets one hunter before any gets a second.
// Partners do not count as contention because converging is their explicit strategy.
//
// Claims are in-process and expire quickly. A crashed keeper, a long trip, or a broker
// restart cannot reserve a monster indefinitely; retaining foeId still wins so a keeper
// never throws away advancement credit merely to make the distribution prettier.
const QUARRY_CLAIM_MS = 90_000;
const claimedQuarries = new Map();     // "room:id" -> Map(agent -> refreshedAt)
const quarryKey = (room, id) => `${room}:${id}`;

function pruneQuarryClaims(now = Date.now()) {
  for (const [k, held] of claimedQuarries) {
    for (const [agent, at] of held) if (now - at > QUARRY_CLAIM_MS) held.delete(agent);
    if (!held.size) claimedQuarries.delete(k);
  }
}

export function releaseQuarry(agent) {
  for (const [k, held] of claimedQuarries) {
    if (!held.delete(agent)) continue;
    if (!held.size) claimedQuarries.delete(k);
  }
}

export function quarryOccupancy(agent, room, id, { now = Date.now() } = {}) {
  pruneQuarryClaims(now);
  const held = claimedQuarries.get(quarryKey(room, id));
  if (!held) return 0;
  let n = 0;
  for (const other of held.keys()) {
    if (other === agent || mayShareSpot(agent, other)) continue;
    n++;
  }
  return n;
}

export function claimQuarry(agent, room, id, { now = Date.now() } = {}) {
  if (room == null || id == null) return false;
  releaseQuarry(agent);
  pruneQuarryClaims(now);
  const k = quarryKey(room, id);
  let held = claimedQuarries.get(k);
  if (!held) claimedQuarries.set(k, held = new Map());
  held.set(agent, now);
  return true;
}

export function rankQuarries(agent, room, candidates = [],
                              { preferId = null, now = Date.now() } = {}) {
  pruneQuarryClaims(now);
  return candidates.map((o, order) => ({
    o, order,
    preferred: preferId != null && o.id === preferId,
    occupancy: quarryOccupancy(agent, room, o.id, { now }),
  })).sort((a, b) =>
    Number(b.preferred) - Number(a.preferred) ||
    a.occupancy - b.occupancy || a.order - b.order)
    .map(x => x.o);
}

export const claimedQuarryList = () => {
  pruneQuarryClaims();
  return [...claimedQuarries.entries()].flatMap(([at, who]) =>
    [...who.keys()].map(agent => ({ at, agent })));
};

// WHICH ROOM EACH KEEPER IS IN, refreshed every pass.
//
// Errands name a destination room, and by the time the character has walked there the
// target may have roamed — the supervisor runs the fleet with roam on, so they move
// constantly. Without this, a quartermaster that arrives to an empty room can only give
// up, and the commonest provisioning outcome was "they had moved on". One shared map in
// the module, the same trick as claimedSpots: every session in a broker is this process.
export const lastRoom = new Map();            // agent -> { room, name, at }
export function noteWhere(agent, room, name = null) {
  lastRoom.set(agent, { room: Number(room), name, at: Date.now() });
}
export function whereIs(agent, { staleMs = 120000 } = {}) {
  const r = lastRoom.get(agent);
  if (!r) return null;
  return (Date.now() - r.at) > staleMs ? null : r;   // a stale reading is worse than none
}

// ONE OUTBOUND COURIER PER DESTINATION ROOM. A claim is in-process coordination, not
// durable state: a broker restart abandons the trip and lets a new seller claim it. The
// TTL covers a long Barloque round trip without allowing a dead courier to block a room.
const farmDeliveryClaims = new Map();   // room -> { agent, at }
export function claimFarmDelivery(room, agent) {
  const key = Number(room), now = Date.now();
  const held = farmDeliveryClaims.get(key);
  if (held && held.agent !== agent && now - held.at < 30 * 60_000) return false;
  farmDeliveryClaims.set(key, { agent, at: now });
  return true;
}
export function releaseFarmDelivery(room, agent) {
  const key = Number(room), held = farmDeliveryClaims.get(key);
  if (held?.agent === agent) farmDeliveryClaims.delete(key);
}

// Where a particular keeper is standing, for the one case that WANTS to share: a loot
// runner sheltering on the farmer's wall while it picks up behind them.
export function spotHeldBy(agent) {
  const snapshot = snapshotSpotClaims();
  if (snapshot.kind === 'unavailable') return null;
  if (snapshot.kind === 'file') return fileSpotHeldBy(agent, { snapshot: snapshot.value });
  for (const [k, who] of snapshot.value) {
    if (!who.has(agent)) continue;
    const [room, rc] = k.split(':');
    const [col, row] = rc.split(',');
    return { room: Number(room), col: Number(col), row: Number(row) };
  }
  return null;
}

// One keeper per agent, held by the broker.
const pilots = new Map();
let POLICY_DEFAULTS = null;
/** The Autopilot's default policy object, or null before any orderless Autopilot was built. A copy. */
export const policyDefaults = () => POLICY_DEFAULTS ? JSON.parse(JSON.stringify(POLICY_DEFAULTS)) : null;
export function autopilotFor(session) {
  if (!pilots.has(session.name)) pilots.set(session.name, new Autopilot(session));
  return pilots.get(session.name);
}
export function dropAutopilot(name) {
  const p = pilots.get(name);
  // HARD, because the object is being thrown away. An inert keeper is a running loop
  // holding a session; leaving one behind here would keep a discarded autopilot alive and
  // recording against a character nobody is tracking any more.
  if (p) p.stop('the keeper is being discarded', { hard: true });
  pilots.delete(name);
}
export const autopilotIfAny = (name) => pilots.get(name) || null;
export const allAutopilots = () => [...pilots.entries()].map(([name, p]) => ({ name, ...p.status() }));

// EVERY KEEPER JOURNEY IS A MOVE ORDER WITH AN ORIGIN (m59-move-origin.mjs). Wrapped rather than
// edited into `travel`'s body, the way Session's walkers carry their intent observers, so the
// body and the source-shape tests that read it are untouched. A caller inside the keeper names
// its subsystem (`keeperOrigin('town_trip')`); one that names none inherits a live order, and
// with nothing to inherit it is `keeper:unattributed` — an admitted gap, not a guess.
installMoveOrders(Autopilot.prototype, {
  methods: { travel: 'travel' },
  sessionOf: ap => ap?.s,
  defaultOrigin: ap => keeperOrigin('unattributed', ap?.doing ? { why: `doing: ${ap.doing}` } : {}),
});
