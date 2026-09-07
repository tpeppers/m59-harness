import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
const start = source.indexOf('      if (a.background) {', source.indexOf('      const startTravel = ()'));
const end = source.indexOf('      const r = await startTravel().promise;', start);
const run = new Function('KeeperProxy', 's', 'startTravel',
  `return (async () => { const a = { background: true }, where = { num: 114 };
    ${source.slice(start, end)} })();`);
class KeeperProxy {}
const proxy = new KeeperProxy();
let settle;
const response = new Promise(resolve => { settle = resolve; });
let returned = false;
const task = run(KeeperProxy, proxy, () => ({ promise: response }))
  .then(value => { returned = true; return value; });
await Promise.resolve();
assert.equal(returned, false, 'a transport request is not an accepted journey');
settle({ error: 'busy: previous journey is finishing' });
assert.match((await task).error, /busy/);
assert.equal((await run(KeeperProxy, proxy,
  () => ({ promise: Promise.resolve({ started: true }) }))).started, true);
console.log('background travel waits for the keeper acknowledgement and preserves refusals');
