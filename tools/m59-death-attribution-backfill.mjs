#!/usr/bin/env node
// Derived-field repair only. Original bytes are backed up before atomic replacement.
import {readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {applyDeathAttribution} from './m59-death-attribution.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function backfill({dir, since = 0, until = Date.now() - 30000, killer = null, apply = false}) {
  dir = resolve(dir);
  const changes = [], errors = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try {
      const source = join(dir, file), original = readFileSync(source), pm = JSON.parse(original);
      if (pm.reason !== 'died' || !(pm.at >= since && pm.at <= until)) continue;
      const before = structuredClone(pm.summary);
      applyDeathAttribution(pm);
      const a = pm.death_attribution;
      if (!a.cause_observed || (killer && (!a.observed || a.killer?.toLowerCase() !== killer.toLowerCase()))) continue;
      if (JSON.stringify(JSON.parse(original)) === JSON.stringify(pm)) continue;
      changes.push({file, at: pm.at, character: pm.character, before, after: pm.summary,
        attribution: a, original, updated: Buffer.from(JSON.stringify(pm, null, 2) + '\n')});
    } catch (e) { errors.push({file, error: e.message}); }
  }
  changes.sort((a,b) => a.at-b.at);
  const backup = apply && changes.length ? resolve(dir, '..', 'attribution-backups',
    new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0,8)) : null;
  const entries = changes.map(({file,at,character,before,after,attribution,original,updated}) =>
    ({file,at,character,before,after,attribution,original_sha256:hash(original),updated_sha256:hash(updated)}));
  if (backup) {
    mkdirSync(backup, {recursive:true});
    for (const c of changes) writeFileSync(join(backup,c.file), c.original, {flag:'wx'});
    writeFileSync(join(backup,'manifest.json'), JSON.stringify({schema:'m59-attribution-backfill/v1',dir,entries},null,2));
    for (const c of changes) {
      const source = join(dir,c.file);
      if (hash(readFileSync(source)) !== hash(c.original)) throw Error('record changed during repair: '+c.file);
      const temp = source + '.' + randomUUID() + '.tmp';
      writeFileSync(temp,c.updated,{flag:'wx'}); renameSync(temp,source);
    }
  }
  return {apply,dir,since,until,backup,changed:entries.length,errors,entries};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args=process.argv.slice(2), arg=(name, fallback=null) => {
    const i=args.indexOf('--'+name); return i<0 ? fallback : args[i+1];
  };
  if (!arg('postmortems')) throw Error('--postmortems <directory> is required');
  const since=arg('since') ? Date.parse(arg('since')) : 0;
  if (!Number.isFinite(since)) throw Error('invalid --since ISO date');
  console.log(JSON.stringify(backfill({dir:arg('postmortems'),since,
    killer:arg('killer'),apply:args.includes('--apply')}),null,2));
}

