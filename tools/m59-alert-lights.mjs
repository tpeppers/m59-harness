// Durable optional light effects for tripwires. A failed bulb never blocks a fleet posture.
import { resolveBulb, setLight, redState, restorableLight, macKey } from './m59-kasa.mjs';

export const lightKey = spec => spec.mac ? `mac:${macKey(spec.mac)}` : `alias:${spec.alias.trim().toLowerCase()}`;

/** One effect per bulb, shared by all tripwires that name it. Persist before a write so a
 * restart never saves the alert colour as the original. Retry failures once a minute. */
export async function syncLights(tripwires, states, records, {
  now = Date.now(), dry = false, save = () => {}, log = () => {},
  resolve = resolveBulb, set = setLight,
} = {}) {
  const groups = new Map();
  for (const [name, t] of Object.entries(tripwires)) {
    const spec = t.then?.kasa; if (!spec) continue;
    const key = lightKey(spec), group = groups.get(key) ?? { spec, owners: [] };
    if (states[name]?.active || states[name]?.last_observation?.hits > 0) group.owners.push(name);
    groups.set(key, group);
  }
  // Disabled/removed alerts still restore the state they changed.
  for (const [key, r] of Object.entries(records)) if (!groups.has(key)) groups.set(key, { spec: r.spec, owners: [] });
  for (const [key, { spec, owners }] of groups) {
    let r = records[key]; const active = owners.length > 0;
    if (!active && !r?.pending) continue;
    if (dry) { log(active ? 'would_set_light' : 'would_restore_light', { light: key, owners }); continue; }
    const desired = active ? redState(spec) : null;
    if (active && r?.applied && JSON.stringify(r.desired) === JSON.stringify(desired)) continue;
    if (r?.retry_at > now) continue;
    try {
      const device = await resolve({ ...spec, ...(r?.device ? { host: r.device.host, mac: r.device.mac } : {}) });
      if (!device.mac) throw new Error('Kasa bulb has no MAC identity');
      if (active) {
        if (!r?.pending) {
          r = records[key] = { spec, device, before: restorableLight(device.light_state), pending: true, applied: false };
          save(records);
        }
        r.device = { host: device.host, alias: device.alias, model: device.model, mac: device.mac };
        r.desired = desired; r.applied = false; save(records);
        await set(device, desired);
        r.applied = true; r.retry_at = null; r.error = null; save(records);
        log('light_set', { light: key, host: device.host, owners, state: desired });
      } else {
        if (r.spec.clear !== 'leave') await set(device, r.before);
        log(r.spec.clear === 'leave' ? 'light_left' : 'light_restored', { light: key, host: device.host });
        delete records[key]; save(records);
      }
    } catch (e) {
      r = records[key] ??= { spec, pending: false };
      r.retry_at = now + 60_000; r.error = e.message; save(records);
      log('light_failed', { light: key, owners, error: e.message, retry_at: r.retry_at });
    }
  }
  return records;
}
