// THE KEEPER'S SOURCE AS ONE TEXT, for the tests that read it.
//
// About a hundred offline tests pin the keeper by reading m59-autopilot.mjs and asserting on its
// text — "this method checks X before Y", sliced between two method names. The methods now live
// in tools/autopilot/*.mjs, so those tests read `autopilotSource()` instead: the core file with
// every `// @autopilot-part ./autopilot/<file>#<n>` marker replaced by the block between that
// file's `// @part <n>` and `// @end <n>`. The result is the original single file, in the
// original order, so a slice between any two methods means what it meant before.
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = fileURLToPath(new URL('../', import.meta.url));
const cache = new Map();

export function autopilotSource(encoding = 'utf8') { return autopilotSourceAt(TOOLS, encoding); }

export function autopilotSourceAt(tools, encoding = 'utf8') {
  const key = `${resolve(tools)}|${encoding}`;
  if (cache.has(key)) return cache.get(key);
  const read = f => readFileSync(join(tools, f), encoding);
  const files = new Map();
  const text = read('m59-autopilot.mjs').replace(/^ {2}\/\/ @autopilot-part \.\/(autopilot\/[\w.-]+)#(\d+)$/gm, (_, file, n) => {
    if (!files.has(file)) files.set(file, read(file));
    const body = files.get(file);
    const start = body.indexOf(`  // @part ${n}\n`), end = body.indexOf(`\n  // @end ${n}`);
    if (start < 0 || end < start) throw new Error(`${file} has no part ${n}`);
    return body.slice(start + `  // @part ${n}\n`.length, end);
  });
  cache.set(key, text);
  return text;
}

// `readFileSync`, except that the keeper is read whole. A test that reads tools as text — one
// file, a list of them, or every file in tools/ — calls this instead, and needs no other change.
// Any checkout's keeper is rebuilt from that checkout's own parts, never this one's.
export function readToolSource(path, ...rest) {
  const file = path instanceof URL ? fileURLToPath(path) : typeof path === 'string' ? path : null;
  if (file == null || basename(file) !== 'm59-autopilot.mjs') return readFileSync(path, ...rest);
  const enc = typeof rest[0] === 'object' ? rest[0]?.encoding : rest[0];
  const text = autopilotSourceAt(dirname(resolve(file)), enc ?? 'utf8');
  return enc ? text : Buffer.from(text, 'utf8');
}
