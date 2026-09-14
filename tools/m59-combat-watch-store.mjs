// One socket owner writes one small, credential-free standing order. Scope it
// to the exact roster, game endpoint and character, never only the agent handle.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function combatWatchStore({ directory, fleetPath, host, port, agent, character }) {
  const subject = createHash('sha256').update(JSON.stringify({
    roster: resolve(fleetPath).replaceAll('\\', '/').toLowerCase(),
    host: String(host).toLowerCase(), port: Number(port), agent, character,
  })).digest('hex');
  const path = join(directory, subject + '.json');
  return {
    path,
    read() {
      let record;
      try { record = JSON.parse(readFileSync(path, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (record.schema !== 'm59-combat-watch/v1' || record.subject !== subject)
        throw Error('combat watch storage identity mismatch');
      return record.watch;
    },
    write(watch) {
      mkdirSync(directory, { recursive: true });
      const temporary = path + '.' + process.pid + '.tmp';
      writeFileSync(temporary, JSON.stringify({ schema: 'm59-combat-watch/v1', subject,
        _owner: 'm59-harness combat_order: explicit operator standing order', watch }, null, 2) + '\n');
      renameSync(temporary, path);
    },
  };
}
