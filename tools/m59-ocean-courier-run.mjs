// One production courier, with native recovery remaining in control during travel.
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { call, fleetScript } from './m59-fleetscript.mjs';
import { fleetName, stateFileFor } from './m59-fleetpath.mjs';
import { dibsFile } from './m59-dibs.mjs';
import { readReceived } from './m59-loot-eject.mjs';
import { supervisorHeartbeat } from './m59-supervisor-heartbeat.mjs';
import { farmFoodCacheFile } from './m59-farm-food-cache-record.mjs';
import { farmGearCacheFile } from './m59-farm-gear-cache-record.mjs';
import {
  OCEAN_COURIER, oceanCourierReserveFood, oceanDistance, oceanItemCount, oceanLapDue, oceanMedicHerbsFile, oceanMedicOutcome,
  oceanSaleValue, oceanTradeGoodsSale,
  oceanProvisionRecord, oceanSaleWardPath, oceanUnitsFit, renewOceanSaleClaims, writeOceanCache,
} from './m59-ocean-courier-cache.mjs';
import {
  oceanDepartVigor, oceanCourierIdentity, oceanCourierReady, oceanCourierReturnSteps, oceanCourierWaiting, oceanWardReady,
  oceanLastRequestHold, oceanWardScan, oceanWardWaiting, script, setOceanTradeGoods,
} from './fleetscripts/ocean-courier.mjs';

const { agent, holder, room } = OCEAN_COURIER;
const medic = 'hk1';
const fleet = fleetName();
if (fleet !== 'prod' || !process.argv.includes('--run'))
  throw Error('start explicitly with --fleet prod --run after verifying the production roster');

const substrate = dirname(dirname(stateFileFor(fleet)));
const lockPath = join(substrate, 'ocean-courier-prod.lock');
const stopPath = join(substrate, 'scratch', 'great-ocean.stop');
const wardPath = oceanSaleWardPath(fleet);
const log = (event, fields = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
const status = who => call('status', { agent: who, brief: true }, 9000);
const floor = (who, what) => oceanWardScan(call, who, what);
const position = (a, b) => oceanDistance(a, b) === 0;
const bodyId = s => s.you?.object_id ?? s.you?.id;

function acquire() {
  let descriptor;
  try { descriptor = openSync(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = Number(readFileSync(lockPath, 'utf8'));
    if (!Number.isSafeInteger(owner) || owner < 1) throw Error('inspect the courier lock before retrying');
    try { process.kill(owner, 0); }
    catch (cause) {
      if (cause.code !== 'ESRCH') throw cause;
      unlinkSync(lockPath);
      descriptor = openSync(lockPath, 'wx');
    }
    if (descriptor === undefined) throw Error(`courier already running as PID ${owner}`);
  }
  try { writeFileSync(descriptor, String(process.pid)); }
  finally { closeSync(descriptor); }
}

function maintainClaims() {
  const file = dibsFile(fleet);
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { format: 'm59-dibs/1', claims: [] };
  const renewed = renewOceanSaleClaims(raw);
  if (renewed) writeOceanCache(file, renewed);
}

async function refreshManifest(server, ward, ground, kind, file) {
  if (!existsSync(file)) return;
  const source = readFileSync(file, 'utf8');
  const record = JSON.parse(source);
  const saved = kind === 'food' ? [record.item] : record.items;
  if (!Array.isArray(saved) || !saved.every(Boolean) || record.schema !== `m59-farm-${kind}-cache/1` ||
      record.server?.host !== server.host || record.server.port !== Number(server.port) ||
      record.room !== room || record.room_security !== ward.room_wire?.room_security_u32 ||
      record.holder?.id !== bodyId(ward) || !position(record.holder, ward.you) ||
      record.observed_at <= ward.last_save_at || record.expires_at > Date.now() + 120_000) return;
  const items = ground.items.filter(item => saved.some(prior => item.id === prior.id &&
    item.name === prior.name && position(item, prior)));
  if (items.length && readFileSync(file, 'utf8') === source)
    writeOceanCache(file, oceanProvisionRecord({ host: server, ward, items, kind }));
}

async function maintainWard(server) {
  const [ward, seen] = await Promise.all([
    status(holder), floor(medic, ['loaf of bread', 'axe', 'leather armor']).catch(() => null),
  ]);
  if (!oceanWardReady(ward) || !seen?.ok || seen.ids_stale !== false || seen.room !== room ||
      seen.last_save_at !== ward.last_save_at) return;
  const now = Date.now();
  // Keeper receipts can live five minutes. Give a fresh pin enough runway
  // for parcels deposited while the courier is on a round trip.
  const expires_at = Math.min(now + 7 * 60_000, ward.next_save_expected_at - 30_000);
  const room_security = ward.room_wire?.room_security_u32;
  if (Number.isSafeInteger(ward.last_save_at) && Number.isSafeInteger(room_security) &&
      ward.last_save_at < now && expires_at > now + 30_000 &&
      position(seen.near, ward.you)) {
    const view = await call('look', { agent: medic, cached: true, projection: 'render' }, 9000);
    const anchor = view.objects?.find(object => object.id === bodyId(ward) && object.is_player &&
      object.name === ward.character && position(object, ward.you));
    if (anchor && view.room?.num === room && view.ids_stale === false &&
        view.last_save_at === ward.last_save_at && view.room_wire?.room_security_u32 === room_security) {
      writeOceanCache(wardPath, { schema: 'm59-farm-sale-cache-ward/1', room, room_security,
        last_save_at: ward.last_save_at, observed_at: now, expires_at,
        anchor: { id: anchor.id, name: ward.character, row: anchor.row, col: anchor.col } });
    }
  }
  await refreshManifest(server, ward, seen, 'food', farmFoodCacheFile(fleet));
  await refreshManifest(server, ward, seen, 'gear', farmGearCacheFile(fleet));
}

// A capacity refusal halves the next offer until one is verified (2026-11-12: 88, 87, 85 herbs offered to a Loial who
// could not hold them, three laps running); the outcome is written for the lap plan, which buys no more than he takes.
let medicCap = Infinity;
async function deliverHerbs(carrier) {
  const before = await status(medic);
  const healer = before.autopilot_status;
  const reserve = 5;
  const stock = oceanItemCount(before, 'herb');
  if (!before.in_game || before.ids_stale !== false || before.character !== 'Loial the Ogier' ||
      before.room?.num !== room || before.hp?.value !== before.hp?.max || before.karma?.value <= 0 ||
      healer?.policy?.neverAttack !== true || !healer.policy.healSpells?.includes('minor heal') ||
      healer.faculties?.work !== 'keeper' || before.movement?.order || before.combat?.active ||
      carrier.last_save_at !== before.last_save_at || stock >= 165) return;
  const herb = carrier.items.find(item => item.name === 'herb');
  const amount = Math.min((herb?.amount ?? 0) - reserve, 180 - stock, oceanUnitsFit(before, 'herb'), medicCap);
  if (amount < 5) return;
  const receipt = await call('supply', { from: agent, to: medic, stationary: true,
    who_travels: 'neither', no_dropoff: true, ids_as_of: carrier.ids_as_of,
    what: [{ id: herb.id, name: 'herb', amount }] }, 35000);
  const [sender, receiver] = await Promise.all([status(agent), status(medic)]);
  const verified = sender.last_save_at === carrier.last_save_at && receiver.last_save_at === before.last_save_at &&
    bodyId(sender) === bodyId(carrier) && bodyId(receiver) === bodyId(before) &&
    oceanItemCount(carrier, 'herb') - oceanItemCount(sender, 'herb') === amount &&
    oceanItemCount(receiver, 'herb') >= stock + amount - 3;
  const outcome = oceanMedicOutcome({ amount, verified, reason: receipt.reason ?? receipt.error ?? null });
  medicCap = outcome.refused === 'capacity' ? Math.max(5, Math.floor(amount / 2)) : verified ? Infinity : medicCap;
  try { writeOceanCache(oceanMedicHerbsFile(fleet), outcome); } catch { /* the plan then buys by capacity alone */ }
  log('medic supply', { amount, verified, reason: receipt.reason ?? receipt.error ?? null, next_cap: medicCap });
}

let nextMealCheck = 0;
async function restoreCourierVigor(before) {
  const meal = oceanCourierReserveFood(before);
  if (!meal || Date.now() < nextMealCheck || !oceanCourierReady(before, room) ||
      before.autopilot_status.faculties?.work !== 'keeper') return before;
  nextMealCheck = Date.now() + 90_000;
  await call('act', { agent, verb: 'eat', target: meal.id, ids_as_of: before.ids_as_of }, 12_000);
  const after = await status(agent);
  const verified = oceanCourierReady(after, room) && bodyId(after) === bodyId(before) &&
    after.last_save_at === before.last_save_at && after.connection_revision === before.connection_revision &&
    oceanItemCount(before, meal.name) - oceanItemCount(after, meal.name) === 1 &&
    after.vigor.value > before.vigor.value;
  if (verified) nextMealCheck = 0;
  log('courier reserve meal', { item: meal.name, verified, vigor: after.vigor?.value });
  return after;
}

const server = await oceanCourierIdentity(fleet);
acquire();
// A DUM SUPERVISOR (2026-11-12). The prod doctrine declares this courier `must`: DUM reads this heartbeat to know it is up
// and from which commit, starts it when it is not (the lock above refuses a second copy), and stops it with
// <state dir>/ocean-courier.stop -- which, like great-ocean.stop, lets the current lap finish.
const heartbeat = supervisorHeartbeat({ id: 'ocean-courier', fleet, entry: import.meta.url,
  paths: [fileURLToPath(new URL('./fleetscripts/ocean-courier.mjs', import.meta.url)),
          fileURLToPath(new URL('./m59-ocean-courier-cache.mjs', import.meta.url))] }).start();
const stopAsked = () => existsSync(stopPath) || heartbeat.stopRequested();
let active = false, stopping = false, maintenance = null;
const maintain = () => {
  if (maintenance || stopping) return;
  maintenance = Promise.resolve().then(() => maintainClaims()).then(() => maintainWard(server))
    .catch(error => log('ward check deferred', { reason: error.message }))
    .finally(() => { maintenance = null; });
};
const timer = setInterval(maintain, 30_000);
const run = (steps, reason = script.name, controls = script.controls) => fleetScript({ name: reason, agents: [agent], controls,
  fleet, steps, unsafe: script.unsafe, minHealth: 1, pollMs: 1500,
  budgetFloorMs: 90_000, budgetCapMs: 180_000, survivalPauseMs: 150_000 });
const stop = () => { stopping = true; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
// SAY WHY IT IS WAITING. Every gate here answered a bare false, so on 2026-11-11 the courier sat out an unknown save
// epoch for hours with "courier online" as its only line. A changed reason is logged at once, an unchanged one every
// ten minutes.
let waitingWhy = null, waitingAt = 0;
const LAP_PLAN_EVERY_MS = 5 * 60_000;
let lastPlanAt = 0;
function waiting(why) {
  if (why === waitingWhy && Date.now() - waitingAt < 10 * 60_000) return;
  waitingWhy = why;
  waitingAt = Date.now();
  if (why) log('courier waiting', { why });
}

// TRADE GOODS ARE TAKEN ONLY BETWEEN LAPS. Farmers hand Zheng their sale piles (loot ejection) while he waits in the
// Ocean. The lap switches the acceptance off the moment it decides to depart (setOceanTradeGoods in the first step);
// this loop switches it back on whenever he is home and idle. Each push is confirmed by the keeper and made only on a
// change, so an idle courier does not refuse offers (a refused farmer backs off for five minutes).
const tradeGoods = on => setOceanTradeGoods(call, on);

log('courier online', { pid: process.pid, agent, room });
maintain();
try {
  while (!stopping && !stopAsked()) {
    try {
      const carrier = await status(agent);
      const recovery = oceanCourierReturnSteps(carrier, { fleet, server });
      if (recovery) {
        waiting(null);
        const result = await run(recovery, 'ocean-courier return checkback', [agent]);
        if (!result?.ok) log('return deferred', { reason: result?.why ?? 'inspect the verified courier corridor' });
      } else if (oceanCourierReady(carrier, room) && carrier.autopilot_status.faculties?.work === 'keeper') {
        await deliverHerbs(carrier);
        await tradeGoods(true);
        const [carrierNow, singer] = await Promise.all([status(agent), status(holder)]);
        const fresh = await restoreCourierVigor(carrierNow);
        const why = oceanCourierWaiting(fresh, room, oceanDepartVigor(fresh)) ?? (oceanWardWaiting(singer) && `ward: ${oceanWardWaiting(singer)}`);
        // A FULL LAP PLAN CLAIMS ZHENG'S FACULTIES, and a farmer whose offer lands in that window backs off for five
        // minutes. So while nothing in his own pack makes the road worth it, the full plan (ward, desk axes, bread)
        // runs at most every LAP_PLAN_EVERY_MS and he stands in the Ocean taking trade goods in between.
        const pack = await call('inventory', { agent, fresh: true }, 9000).catch(() => null);
        const quick = pack?.ids_stale === false ? oceanLapDue({ saleValue: oceanSaleValue(oceanTradeGoodsSale(pack, readReceived(agent), oceanLastRequestHold() ?? {})),
          fullness: (pack.carry?.load?.bulk ?? 0) / Math.max(1, (pack.carry?.load?.bulk ?? 0) + (pack.carry?.room_for?.bulk ?? 0)) })
          : { go: true };
        if (!why && !stopping && !quick.go && Date.now() - lastPlanAt < LAP_PLAN_EVERY_MS) waiting(quick.why);
        else if (!why && !stopping) {
          waiting(null);
          lastPlanAt = Date.now();
          const steps = await script.steps({ agent });
          active = true;
          try {
            const result = await run(steps);
            if (!result?.ok) log('lap deferred', { reason: result?.why ?? 'inspect courier step receipts' });
          } finally {
            active = false;
            await tradeGoods(true).catch(error => log('trade goods acceptance deferred', { reason: error.message }));
          }
        } else waiting(why);
      } else {
        waiting(carrier?.autopilot_status?.faculties?.work !== 'keeper' && oceanCourierReady(carrier, room)
          ? 'a lease holds the work faculty of Zheng' : `Zheng: ${oceanCourierWaiting(carrier, room)}`);
      }
    } catch (error) {
      log('courier check deferred', { active, reason: error.message });
      active = false;
    }
    if (!stopping) await sleep(40_000);
  }
} finally {
  clearInterval(timer);
  heartbeat.stopping();
  await maintenance;
  if (Number(readFileSync(lockPath, 'utf8')) === process.pid) unlinkSync(lockPath);
  heartbeat.stop();
}
