#!/usr/bin/env node
// NO CLASS MAY DEFINE THE SAME METHOD TWICE. Opens no socket and joins nobody.
//
// This file exists because the same defect has now shipped twice in m59-broker.mjs, and
// both times it was invisible: JavaScript takes the LAST definition in a class body, with
// no warning from the runtime, no lint in this repo, and no test that would fail.
//
// The shape is always the same. `KeeperProxy` carries a block of catch-all stubs under the
// comment "Fallback for any method not explicitly defined: return null or empty. This
// prevents 'is not a function' errors" — written when the proxy genuinely had none of them.
// The class then grew a REAL implementation of one, three hundred lines higher up, and the
// stub below silently shadowed it.
//
// What it cost, measured 2026-09-08: `bankKnown() { return false; }` shadowed the real
// bankbook read, so every fleet row reported `banked: false` for a fleet holding tens of
// thousands of shillings — Beaker 21,625, Robin 26,664, Janice 13,027 — and any decision
// that asked "can this character afford it" got the wrong answer for all twenty-one.
//
// Nothing here understands JavaScript properly, and it does not need to: it walks each
// `class` body by brace depth and collects names at depth 1. Getters, setters, statics and
// `#private` names are kept apart, because a getter and a setter of the same name are legal
// and common, and only a genuine redefinition is a fault.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let passed = 0, failed = 0;
const ok = (what, cond) => {
  if (cond) { passed++; console.log('  ok  ', what); }
  else { failed++; console.log('  FAIL', what); }
};

// A method definition at the top level of a class body: optional modifiers, a name, then
// `(`. Deliberately conservative — it is better to miss an exotic definition than to
// report a property whose value happens to be a function call.
const METHOD = /^\s*(static\s+)?(async\s+)?(get\s+|set\s+)?(\*\s*)?([A-Za-z_$#][\w$]*)\s*\(/;
const SKIP = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function']);

export function shadowedMethods(source) {
  const lines = source.split(/\r?\n/);
  const found = [];
  let depth = 0, inClass = null, classDepth = 0, className = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Strip line comments and string bodies crudely; a brace inside either would only ever
    // make this MISS a duplicate, never invent one.
    const code = line.replace(/\/\/.*$/, '').replace(/(['"`]).*?\1/g, '""');

    if (!inClass) {
      const m = code.match(/\bclass\s+([A-Za-z_$][\w$]*)/);
      if (m) { inClass = new Map(); className = m[1]; classDepth = depth; }
    } else if (depth === classDepth + 1) {
      const m = code.match(METHOD);
      if (m && !SKIP.has(m[5])) {
        // `static`, `get` and `set` each make a distinct slot from a plain method.
        const kind = `${m[1] ? 'static ' : ''}${(m[3] || '').trim()}`.trim();
        const key = `${kind}${kind ? ' ' : ''}${m[5]}`;
        const seen = inClass.get(key);
        if (seen != null) found.push({ class: className, method: key, first: seen + 1, again: i + 1 });
        else inClass.set(key, i);
      }
    }

    for (const ch of code) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (inClass && depth === classDepth) { inClass = null; className = null; }
      }
    }
  }
  return found;
}

console.log('\nthe detector finds a shadowed method');
{
  const dup = shadowedMethods(`class A {\n  foo() { return 'real'; }\n  bar() {}\n  foo() { return false; }\n}`);
  ok('a redefinition is reported', dup.length === 1 && dup[0].method === 'foo');
  ok('it names both lines', dup[0].first === 2 && dup[0].again === 4);
}

console.log('\nand does not cry wolf');
{
  ok('a getter and a setter of one name are legal',
    shadowedMethods(`class A {\n  get x() {}\n  set x(v) {}\n  x() {}\n}`).length === 0);
  ok('a static and an instance method of one name are legal',
    shadowedMethods(`class A {\n  static make() {}\n  make() {}\n}`).length === 0);
  ok('two classes may each define the same method',
    shadowedMethods(`class A {\n  go() {}\n}\nclass B {\n  go() {}\n}`).length === 0);
  ok('a nested function call is not a method',
    shadowedMethods(`class A {\n  go() {\n    if (x) return f();\n    if (y) return f();\n  }\n}`).length === 0);
}

console.log('\nno shipped tool has one');
{
  const dir = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.includes('-test.'));
  const hits = [];
  for (const f of files)
    for (const d of shadowedMethods(readFileSync(join(dir, f), 'utf8')))
      hits.push(`${f}: ${d.class}.${d.method} defined at line ${d.first}, again at ${d.again}`);
  for (const h of hits) console.log('       ', h);
  ok(`${files.length} tool file(s) define every method once`, hits.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
