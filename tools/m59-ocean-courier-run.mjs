// One production courier, with native recovery remaining in control during travel.
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { call, fleetScript } from './m59-fleetscript.mjs';
import { fleetName, stateFileFor } from './m59-fleetpath.mjs';
import { dibsFile, itemKey } from './m59-dibs.mjs';
import { farmFoodCacheFile } from './m59-farm-food-cache-record.mjs';
import { farmGearCacheFile } from './m59-farm-gear-cache-record.mjs';
import {
  OCEAN_COURIER, OCEAN_SALE_PRICE, oceanDistance, oceanItemCount, oceanProvisionRecord, writeOceanCache,
} from './m59-ocean-courier-cache.mjs';
import {
  oceanCourierIdentity, oceanCourierReady, oceanCourierReturnSteps, oceanWardReady, oceanWardScan, script,
} from './fleetscripts/ocean-courier.mjs';

const { agent, holder, room, sale, name } = OCEAN_COURIER;
const medic = 'hk1';
const itemsForSale = Object.keys(OCEAN_SALE_PRICE);
const fleet = fleetName();
if (fleet !== 'prod' || !process.argv.includes('--run'))
  throw Error('start explicitly with --fleet prod --run after verifying the production roster');

const substrate = dirname(dirname(stateFileFor(fleet)));
const lockPath = join(substrate, 'ocean-courier-prod.lock');
const stopPath = join(substrate, 'scratch', 'great-ocean.stop');
const wardPath = process.env.M59_FARM_SALE_CACHE_WARD_FILE || join(substrate, 'farm-sale-cache-ward-prod.json');
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
  if (!Array.isArray(raw.claims)) throw Error('unreadable floor reservations');
  const now = Date.now(), ttl = 12 * 60_000;
  const owns = claim => claim.source === 'ocean-sale-cache' && claim.room === room &&
    claim.for?.length === 1 && claim.for[0] === name && claim.near?.radius === 0 && position(claim.near, sale);
  if (itemsForSale.every(item => raw.claims.some(claim => owns(claim) && itemKey(claim.item) === item &&
      Date.parse(claim.until) > now + ttl / 2))) return;
  const claims = itemsForSale.map(item => ({
    source: 'ocean-sale-cache', room, item, for: [name], near: { ...sale, radius: 0 },
    at: new Date(now).toISOString(), until: new Date(now + ttl).toISOString(),
    by: 'ocean-courier', why: 'Exact registered keeper sale parcels for the Marion courier',
  }));
  writeOceanCache(file, { ...raw, claims: [...raw.claims.filter(claim => !owns(claim)), ...claims] });
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
  const amount = Math.min((herb?.amount ?? 0) - reserve, 180 - stock,
    Math.floor((before.carry?.room_for?.bulk ?? 0) / 4), Math.floor((before.carry?.room_for?.weight ?? 0) / 2));
  if (amount < 5) return;
  const receipt = await call('supply', { from: agent, to: medic, stationary: true,
    who_travels: 'neither', no_dropoff: true, ids_as_of: carrier.ids_as_of,
    what: [{ id: herb.id, name: 'herb', amount }] }, 35000);
  const [sender, receiver] = await Promise.all([status(agent), status(medic)]);
  const verified = sender.last_save_at === carrier.last_save_at && receiver.last_save_at === before.last_save_at &&
    bodyId(sender) === bodyId(carrier) && bodyId(receiver) === bodyId(before) &&
    oceanItemCount(carrier, 'herb') - oceanItemCount(sender, 'herb') === amount &&
    oceanItemCount(receiver, 'herb') >= stock + amount - 3;
  log('medic supply', { amount, verified, reason: receipt.reason ?? receipt.error ?? null });
}

const server = await oceanCourierIdentity(fleet);
acquire();
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
log('courier online', { pid: process.pid, agent, room });
maintain();
try {
  while (!stopping && !existsSync(stopPath)) {
    try {
      const carrier = await status(agent);
      const recovery = oceanCourierReturnSteps(carrier);
      if (recovery) {
        const result = await run(recovery, 'ocean-courier return checkback', [agent]);
        if (!result?.ok) log('return deferred', { reason: result?.why ?? 'inspect the verified courier corridor' });
      } else if (oceanCourierReady(carrier, room) && carrier.autopilot_status.faculties?.work === 'keeper') {
        await deliverHerbs(carrier);
        const [fresh, singer] = await Promise.all([status(agent), status(holder)]);
        if (oceanCourierReady(fresh, room, 140) && oceanWardReady(singer) && !stopping) {
          const steps = await script.steps({ agent });
          active = true;
          const result = await run(steps);
          active = false;
          if (!result?.ok) log('lap deferred', { reason: result?.why ?? 'inspect courier step receipts' });
        }
      }
    } catch (error) {
      log('courier check deferred', { active, reason: error.message });
      active = false;
    }
    if (!stopping) await sleep(40_000);
  }
} finally {
  clearInterval(timer);
  await maintenance;
  if (Number(readFileSync(lockPath, 'utf8')) === process.pid) unlinkSync(lockPath);
}
