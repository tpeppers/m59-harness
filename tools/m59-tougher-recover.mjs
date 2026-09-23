// Recover only gains proved by retained evidence. Dry run unless --apply is given.
// --history DIR --characters names.json [--announcements gains.json] [--apply]
// --combat-evidence evidence.json also enriches exact announcements from retained combat text.
// M59_TOUGHER_DIR must explicitly name the book being repaired. Apply while writers are stopped.
import { createReadStream, readFileSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tougherCombatMessage, guessTougherCreature } from './m59-tougher-attribution.mjs';
import { loadGains, commitGain, TOUGHER_DIR, TOUGHER_LINE } from './m59-tougher.mjs';

export function recoverInterval(before, after, known) {
  if (!Number.isInteger(before.level) || !Number.isInteger(after.level) ||
      before.level < 1 || after.level > 200 || after.level <= before.level || after.t <= before.t)
    return [];
  // These samples prove a lower bound, not gross gains: a death can hide a gain.
  // Account for ALL announcements in the interval, even if a later death changed HP.
  const recorded = known.filter(g => g.at > before.t && g.at <= after.t && !g.recovery_id);
  const count = Math.max(0, after.level - before.level - recorded.length);
  if (!count) return [];
  const targets = [];
  for (let to = before.level + 1; to <= after.level; to++)
    if (!recorded.some(g => g.to === to)) targets.push(to);
  return targets.slice(-count).map(to => ({
    at: after.t, interval_start: before.t, from: to - 1, to,
    source: 'sample_recovery', recovery_id: `sample:${before.t}:${after.t}:${to}`,
    creature: null, room: null, room_num: null,
    attributed: 'minimum gain proved by consecutive max-health samples; time and kill unknown',
  }));
}

export async function recoveryPlan({ history, characters, announcements = [], combatEvidence = [] }) {
  const books = new Map([...characters].map(c => [c, loadGains(c).gains]));
  const additions = [];
  for (const g of announcements) {
    const known = books.get(g.character);
    if (!known || known.some(x => !x.recovery_id && Math.abs(x.at - g.at) <= 1000)) continue;
    const gain = { ...g, creature: null, room: null, room_num: null,
      attributed: 'recovered server announcement; kill not attributed' };
    known.push(gain); additions.push(gain);
  }
  const last = new Map();
  for (const file of readdirSync(history).filter(f => /^fleet-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()) {
    const lines = createInterface({ input: createReadStream(join(history, file)), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('"sample"')) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row.type !== 'sample' || !characters.has(row.character) || !Number.isFinite(row.t) ||
          !Number.isInteger(row.level)) continue;
      const before = last.get(row.character);
      if (before && row.t <= before.t) continue;
      last.set(row.character, row);
      if (!before) continue;
      const known = books.get(row.character);
      for (const g of recoverInterval(before, row, known)) {
        if (known.some(x => x.recovery_id === g.recovery_id)) continue;
        const gain = { character: row.character, ...g };
        additions.push(gain); known.push(gain);
      }
    }
  }
  const updates = [];
  for (const evidence of combatEvidence) {
    if (!characters.has(evidence.character) || !TOUGHER_LINE.test(evidence.event?.text ?? '')) continue;
    const found = books.get(evidence.character).find(g => !g.recovery_id && g.at === evidence.event.at);
    if (!found) continue; // A sample interval has no exact announcement to pair.
    const message = evidence.guess?.attribution;
    const candidate = tougherCombatMessage({ ...message, kind: 'message' }, evidence.character);
    const guess = candidate && guessTougherCreature([candidate], evidence.event);
    if (!guess || (found.attribution?.source === 'combat_message' &&
        found.attribution.distance_ms <= guess.attribution.distance_ms)) continue;
    updates.push({ character: evidence.character, ...found, ...guess });
  }
  return { additions, updates, latest: Object.fromEntries(last) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const arg = n => { const i = process.argv.indexOf(n); return i < 0 ? null : process.argv[i + 1]; };
  if (!arg('--history') || !arg('--characters') || !process.env.M59_TOUGHER_DIR)
    throw new Error('Required: --history DIR --characters names.json and M59_TOUGHER_DIR');
  const characters = new Set(JSON.parse(readFileSync(arg('--characters'), 'utf8')));
  const announcements = arg('--announcements') ? JSON.parse(readFileSync(arg('--announcements'), 'utf8')) : [];
  const combatEvidence = arg('--combat-evidence') ? JSON.parse(readFileSync(arg('--combat-evidence'), 'utf8')) : [];
  const plan = await recoveryPlan({ history: arg('--history'), characters, announcements, combatEvidence });
  const counts = {};
  for (const g of plan.additions) counts[g.character] = (counts[g.character] ?? 0) + 1;
  console.log(JSON.stringify({ additions: plan.additions.length, attributions_updated: plan.updates.length, by_character: counts,
    last72h: plan.additions.filter(g => g.at >= Date.now() - 72 * 3600000).length,
    latest_total_hp: Object.values(plan.latest).reduce((n, s) => n + s.level, 0) }, null, 2));
  if (process.argv.includes('--apply') && (plan.additions.length || plan.updates.length)) {
    const backup = join(TOUGHER_DIR, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
    mkdirSync(backup, { recursive: true });
    for (const file of readdirSync(TOUGHER_DIR).filter(f => f.endsWith('.json')))
      copyFileSync(join(TOUGHER_DIR, file), join(backup, file));
    for (const { character, ...gain } of [...plan.additions, ...plan.updates]) commitGain(character, gain);
    console.log(`Applied; original books backed up to ${backup}`);
  }
}
