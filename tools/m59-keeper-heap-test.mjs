// Offline. The keeper heap ceiling: env, then substrate/keeper-heap-mb, then 640 (m59-keeper-heap.mjs).
import assert from 'node:assert/strict';
import { keeperHeapMb, keeperHeapArgs, DEFAULT_KEEPER_HEAP_MB } from './m59-keeper-heap.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('ok  ', name); } catch (e) { fail++; console.log('FAIL', name, '-', e.message); } };
const file = 'keeper-heap-mb';
const reads = text => () => { if (text === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return text; };

t('nothing set: the committed 640', () =>
  assert.deepEqual(keeperHeapArgs({ env: {}, file, read: reads(null) }), [`--max-old-space-size=${DEFAULT_KEEPER_HEAP_MB}`]));
t('the file raises it, which a live handover cannot do through env', () =>
  assert.deepEqual(keeperHeapArgs({ env: {}, file, read: reads('1024\n') }), ['--max-old-space-size=1024']));
t('the environment beats the file', () =>
  assert.equal(keeperHeapMb({ env: { M59_KEEPER_HEAP_MB: '800' }, file, read: reads('1024') }).mb, 800));
t('an empty environment value is silence, not 0', () =>
  assert.equal(keeperHeapMb({ env: { M59_KEEPER_HEAP_MB: '' }, file, read: reads('1024') }).source, 'file'));
t('0 leaves the Node default (no flag)', () =>
  assert.deepEqual(keeperHeapArgs({ env: {}, file, read: reads('0') }), []));
t('a file that does not parse is not 0: it keeps 640 and says so', () => {
  const r = keeperHeapMb({ env: {}, file, read: reads('lots') });
  assert.equal(r.mb, DEFAULT_KEEPER_HEAP_MB); assert.match(r.warning, /does not hold a number/);
});
t('read at every call: a changed file takes effect on the next spawn', () => {
  let text = '640';
  const read = () => text;
  assert.equal(keeperHeapMb({ env: {}, file, read }).mb, 640);
  text = '1024';
  assert.equal(keeperHeapMb({ env: {}, file, read }).mb, 1024);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
