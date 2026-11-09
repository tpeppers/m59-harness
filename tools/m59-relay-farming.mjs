// Relay turns vigor that can be replaced by resting into vigor above a fleetmate's
// resting cap. Keep the transfer strictly between opted-in farmers in the same room.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { OF } from './m59-parse.mjs';
import { allyVerdict } from './m59-ally.mjs';
import { readFleetHealth } from './m59-fleet-health.mjs';
import { claimFleetAid } from './m59-heal-claims.mjs';
import { loadSpawns } from './m59-spawns.mjs';
import { survivalOffOf } from './m59-hazards.mjs';
import { withCastRite } from './m59-castrite.mjs';
import { sendRecoverySpell } from './m59-recovery-cast.mjs';
import { currentSurvivalDecision, isActiveRecoveryDecision } from './m59-survival-decision.mjs';

const SPAWN_FILE = process.env.M59_SPAWN_FILE || new URL('../substrate/m59-spawns.json', import.meta.url);
const RELAY = 'relay', MAX_TARGET_VIGOR = 150, MANA_COST = 5, MIN_DONOR_VIGOR = 15;
const REPORT_MAX_AGE_MS = 3500, CLAIM_COOLDOWN_MS = 4000;
const cycles = new WeakMap();
const fleetScopes = new Map();
const relayRooms = new WeakMap();
const fold = value => String(value ?? '').trim().toLowerCase();

function fleetScope(s) {
  if (!s?.fleetStateFile || !s.credentials?.host || !(s.credentials.port > 0)) return null;
  const file = process.platform === 'win32' ? resolve(s.fleetStateFile).toLowerCase() : resolve(s.fleetStateFile);
  if (!fleetScopes.has(file)) fleetScopes.set(file, createHash('sha256').update(file).digest('hex'));
  return fleetScopes.get(file);
}

/** The wire carries the personal resting threshold, including temporary gear and skill changes. */
export function relayRestCap(vitals) {
  const cap = vitals?.vigor?.rest_threshold;
  return Number.isInteger(cap) && cap >= 10 && cap <= 100 ? cap : null;
}

export function roomDropsRelayMushrooms(room, spawns = loadSpawns(SPAWN_FILE)) {
  if (!spawns || !Number.isInteger(room)) return false;
  let rooms = relayRooms.get(spawns);
  if (!rooms) {
    const snackSources = new Set(Object.values(spawns.creatures ?? {})
      .filter(c => c.loot?.items?.some(i => i.item === 'Snack' && i.per_roll_percent > 0))
      .map(c => fold(c.cls)));
    rooms = new Set(Object.entries(spawns.rooms ?? {}).filter(([, entries]) =>
      entries.some(entry => entry.huntable && snackSources.has(fold(entry.cls)))).map(([id]) => Number(id)));
    relayRooms.set(spawns, rooms);
  }
  return rooms.has(room);
}

function relaySpell(c) {
  return c?.spells?.find(sp => fold(c.rsc?.get?.(sp.nameRsc) ?? sp.name) === RELAY && Number.isInteger(sp.id));
}

function secondWind(c, cap) {
  // A threshold of 10 is ambiguous with cursed gear, but without a complete
  // enchantment list we cannot promise a Relay would help such a body.
  return cap === 10 || c.enchantments?.().some(e => fold(e.name) === 'second wind') === true;
}

function automatedFarmer(pilot, s, c) {
  const now = Date.now();
  // Evidence can run on a pushed stat. Do not call checkFreeze(), busyStatus(),
  // facultyOwner() or operatorSurvivalStandDown(), which can mutate keeper state.
  return pilot.mode === 'farm' && pilot.running !== false && !pilot.stopping && !pilot.inert &&
    !(pilot.busy?.until > now) && !survivalOffOf(pilot.policy, now) &&
    c.combatReady && c.state === 'game' && s.live && !s.combat?.active?.pvp &&
    !['work', 'movement', 'survival', 'recovery'].some(key => pilot.claims?.get(key)?.until > now);
}

function farmingBody(pilot, s, c, room) {
  return pilot.policy?.relayBeforeRest === true && automatedFarmer(pilot, s, c) &&
    !pilot.suspendedJourney && !pilot.recoverUntilWhole && !pilot.parking && !pilot.frozenUntil &&
    (!s.job || s.job.done === true) && !c.trade && !c.self?.predicted &&
    (pilot.policy.assignedRoom == null || Number(pilot.policy.assignedRoom) === room) &&
    (!pilot.policy.confineRooms?.length || pilot.policy.confineRooms.includes(room));
}

// All automated farmers report spell knowledge on the existing health path.
// Only opted-in bodies add changing vigor data and can receive a Relay.
export function relayFarmPeerEvidence(pilot, vitals = pilot.s?.client?.vitals?.()) {
  const s = pilot.s, c = s?.client, room = s?.world?.room?.num;
  if (!s || !c || !Number.isInteger(c.room?.id) || !Number.isInteger(c.selfId) ||
      !automatedFarmer(pilot, s, c)) return null;
  const scope = fleetScope(s);
  if (!scope) return null;
  const knows = relaySpell(c) ? true : Array.isArray(c.spells) && (c.spells.length > 0 || Number.isFinite(c.spellsAt)) ? false : null;
  const capability = { scope, room_object_id: c.room.id, knows_relay: knows,
    opted_in: pilot.policy?.relayBeforeRest === true };
  if (!capability.opted_in) return capability;
  const cap = relayRestCap(vitals), vigor = vitals?.vigor?.value;
  const usableVigor = Number.isFinite(vigor) && vigor >= 0 && vigor <= 200;
  const fightFloor = pilot.wantedFightFloor?.() ?? pilot.policy.vigorFloor ?? pilot.policy.fightAboveVigor;
  return { ...capability,
    can_receive: knows === true && farmingBody(pilot, s, c, room) && cap != null && usableVigor && !secondWind(c, cap),
    vigor: usableVigor ? vigor : null, rest_cap: cap,
    fight_floor: Number.isFinite(fightFloor) && fightFloor >= 0 && fightFloor <= 200 ? fightFloor : null };
}

function peerFor(c, room, scope, credentials, object, now, read) {
  if (!object || object.id === c.selfId || !(object.flags & OF.PLAYER)) return null;
  const name = c.rsc?.get?.(object.nameRsc) ?? object.name;
  if (allyVerdict({ name, flags: object.flags }).basis !== 'fleetmate') return null;
  const identity = { ...credentials, character: name };
  const bodyId = object.id;
  const report = read(identity, { now, room, bodyId, maxAgeMs: REPORT_MAX_AGE_MS });
  const peer = report?.relay_farm;
  const save = c.idsAsOf?.();
  if (!peer || peer.scope !== scope || peer.room_object_id !== c.room.id || save?.saving ||
      (Number.isFinite(save?.last_save_began_at) && report.at <= save.last_save_began_at)) return null;
  const optedIn = peer.opted_in === true;
  const canReceive = optedIn && peer.can_receive === true && Number.isFinite(peer.vigor) && peer.vigor >= 0 && peer.vigor <= 200 &&
    Number.isInteger(peer.rest_cap) && peer.rest_cap > 10 && peer.rest_cap <= 100;
  return { bodyId, name, identity, knows: peer.knows_relay, optedIn, canReceive, vigor: peer.vigor, cap: peer.rest_cap,
    fightFloor: Number.isFinite(peer.fight_floor) && peer.fight_floor >= 0 && peer.fight_floor <= 200
      ? peer.fight_floor : MAX_TARGET_VIGOR };
}

function cycleFor(pilot, c, cap, vigor) {
  let cycle = cycles.get(pilot);
  const roomId = c?.room?.id;
  if (cycle?.client !== c || cycle?.roomId !== roomId || !cycle || (cap != null && vigor >= cap && cycle.sent)) {
    cycle = { client: c, roomId, sent: false };
    cycles.set(pilot, cycle);
  }
  return cycle;
}

export function relayFarmVigor(pilot, ctx = {}, { now = Date.now(), read = readFleetHealth, spawns } = {}) {
  if (pilot.policy?.relayBeforeRest !== true) return { active: false, belowCap: false, cap: null };
  const s = ctx.s ?? pilot.s, c = ctx.c ?? s?.client, room = ctx.room?.num ?? s?.world?.room?.num;
  const vitals = c?.vitals?.() ?? ctx.v;
  const cap = relayRestCap(vitals), vigor = vitals?.vigor?.value;
  const cycle = cycleFor(pilot, c, cap, vigor);
  const inactive = { active: false, belowCap: false, cap };
  if (cap == null || !(vigor < cap)) return inactive;
  const own = relayFarmPeerEvidence(pilot, vitals);
  if (!own?.can_receive || !roomDropsRelayMushrooms(room, spawns)) return inactive;
  const { scope } = own;
  const peers = [...(c.room.objects?.values?.() ?? [])].map(o => peerFor(c, room, scope, s.credentials, o, now, read)).filter(Boolean);
  if (!peers.some(peer => peer.optedIn) || peers.some(peer => peer.knows !== true)) return inactive;
  return { active: true, belowCap: true, cap, scope, peers, cycle };
}

function edibleMushrooms(c) {
  if (!Number.isFinite(c.inventoryAt) || !Array.isArray(c.inventory)) return 0;
  return c.inventory.reduce((count, item) =>
    /^edible mushrooms?$/.test(fold(c.rsc?.get?.(item.nameRsc) ?? item.name))
      ? count + (Number(item.amount) || 1) : count, 0);
}

function safeDonor(pilot, s, c, duringRite = false) {
  const v = c.vitals?.(), hp = v?.health;
  if (!farmingBody(pilot, s, c, s.world?.room?.num) || s.combat?.active || !c.self || (!duringRite && s._rite) ||
      ['work', 'movement', 'survival', 'recovery'].some(key => pilot.facultyHeld?.(key)) ||
      isActiveRecoveryDecision(currentSurvivalDecision(s)) || c.ailments?.()?.length ||
      !(hp?.max > 0 && hp.value / hp.max >= Math.max(0.95, pilot.safety?.()?.engageAt ?? 0.95)) ||
      !(v?.vigor?.value > MIN_DONOR_VIGOR) || !(v.vigor.value < relayRestCap(v)) ||
      secondWind(c, relayRestCap(v)) || !(v?.mana?.value >= MANA_COST + 4) || !edibleMushrooms(c)) return false;
  return !(pilot.threat?.()?.landing > 0) && (pilot.holdWorks?.() === true || !pilot.inReachOfUs?.()?.length);
}

function receiverUseful(peer, vigor, reserve) {
  // No guessed spell power: cap the worst possible donation using the
  // receiver's actual remaining headroom, preserving the donor's escape bar.
  const headroom = MAX_TARGET_VIGOR - peer.vigor;
  return peer.canReceive && peer.vigor >= peer.cap && headroom > 0 && headroom <= vigor - reserve &&
    (peer.vigor < peer.fightFloor || headroom >= 8);
}

function receiverRank(peer) {
  const deficit = peer.fightFloor - peer.vigor, headroom = MAX_TARGET_VIGOR - peer.vigor;
  // Rank by possible benefit using the server's raw cap and bonus, never a
  // predicted spell power. A smaller remaining gap has a better chance to clear.
  if (deficit > 0 && deficit <= Math.floor(headroom * 1.25)) return [0, deficit];
  return [deficit <= 0 ? 1 : 2, headroom];
}

export async function tryFarmRelay(pilot, ctx = {}, profile = relayFarmVigor(pilot, ctx),
                                  { now = Date.now, read = readFleetHealth, claim = claimFleetAid } = {}) {
  if (!profile.active || !profile.belowCap || !profile.cycle || profile.cycle.sent) return false;
  const s = ctx.s ?? pilot.s, c = s.client, room = s.world?.room?.num;
  const spell = relaySpell(c);
  if (!spell || typeof s.faceToward !== 'function' || !safeDonor(pilot, s, c)) return false;
  const reserve = Math.max(20, pilot.policy.ordinaryVigorFloor ?? 20);
  const vigor = c.vitals().vigor.value;
  const ranked = profile.peers.filter(peer => receiverUseful(peer, vigor, reserve))
    .map(peer => ({ peer, rank: receiverRank(peer) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.peer.bodyId - b.peer.bodyId)
    .map(row => row.peer);
  const self = c.selfId, roomId = c.room.id, save = c.saveCount, generation = s.movementGeneration;
  for (const candidate of ranked) {
    const target = () => c.room.objects.get(candidate.bodyId);
    const valid = () => {
      if (s.client !== c || c.selfId !== self || c.room?.id !== roomId || c.saveCount !== save ||
          s.world?.room?.num !== room || s.movementWasCancelled?.(generation) ||
          !safeDonor(pilot, s, c, true) || relaySpell(c)?.id !== spell.id) return false;
      const peer = peerFor(c, room, profile.scope, s.credentials, target(), now(), read);
      return !!peer && fold(peer.name) === fold(candidate.name) && receiverUseful(peer, c.vitals().vigor.value, reserve);
    };
    if (!valid() || !claim(candidate.identity, { kind: RELAY, scope: profile.scope, room, bodyId: candidate.bodyId,
      now: now(), cooldownMs: CLAIM_COOLDOWN_MS })) continue;
    const seq = c.evSeq;
    let result;
    try {
      result = await withCastRite(s, { spell, targets: [candidate.bodyId], why: 'Relay before resting' }, async () => {
        if (!valid()) return null;
        await s.faceToward(target(), { beforePacket: () => { if (!valid()) throw new Error('Relay target changed'); } });
        return sendRecoverySpell(s, c, spell, [candidate.bodyId], valid);
      });
    } catch (error) {
      pilot.note?.('farm relay declined', { target: candidate.name, why: error.message });
      return false;
    }
    if (!result?.sent) return false;
    profile.cycle.sent = true;
    const reply = await c.waitFor?.({ since: seq, kinds: ['message'], timeoutMs: 1200,
      match: e => /give part of your vigor|additional vigor|not have enough vigor|unsuccessful in casting/i.test(e.text ?? '') })
      .catch(() => null);
    const said = reply?.events?.find(e => /give part of your vigor|additional vigor|not have enough vigor|unsuccessful in casting/i.test(e.text ?? ''))?.text;
    const ok = /give part of your vigor/i.test(said ?? '');
    pilot.note?.('farm relay before resting', { target: candidate.name, target_vigor: candidate.vigor,
      donor_vigor: vigor, rest_cap: profile.cap, confirmed: ok, said: said ?? null });
    pilot.recordCast?.(RELAY, { ok, target: candidate.name, why: said ?? 'cast sent; transfer unconfirmed' });
    return true;
  }
  return false;
}
