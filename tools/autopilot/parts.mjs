// THE KEEPER IN PARTS: how tools/autopilot/*.mjs become methods of Autopilot.
//
// `Autopilot` (tools/m59-autopilot.mjs) was one class of 33,000 lines. Its methods now live in
// files named for the faculty they serve — travel.mjs, pass-farm.mjs, chalice.mjs — each a class
// whose body is the original methods, verbatim. `installParts` copies each part's methods,
// getters and statics onto Autopilot, so `this` inside them is the keeper exactly as before and
// every caller, test and subclass sees the same object it always did.
//
// THE ONE RULE IT ENFORCES: NO NAME TWICE. JavaScript takes the last definition in a class body
// silently, and m59-shadowed-method-test.mjs exists because that has shipped twice. Across files
// nothing would catch it, so a part that defines a name the class or an earlier part already has
// is refused at load time, loudly, before any keeper runs.
//
// A part is not a plug-in. To REPLACE a behaviour, use a joint (tools/m59-joints.mjs); a part is
// only where the keeper's own code for a faculty is written down.
export function installParts(target, parts) {
  const owner = new Map();
  for (const name of Object.getOwnPropertyNames(target.prototype)) owner.set(`proto:${name}`, target.name);
  for (const name of Object.getOwnPropertyNames(target)) owner.set(`static:${name}`, target.name);
  for (const part of parts) {
    for (const [where, from, to, skip] of [
      ['proto', part.prototype, target.prototype, ['constructor']],
      ['static', part, target, ['length', 'name', 'prototype']],
    ]) {
      for (const [name, desc] of Object.entries(Object.getOwnPropertyDescriptors(from))) {
        if (skip.includes(name)) continue;
        const key = `${where}:${name}`;
        if (owner.has(key)) throw new Error(`${part.name} redefines ${where === 'static' ? 'static ' : ''}${name}, already defined by ${owner.get(key)}`);
        owner.set(key, part.name);
        Object.defineProperty(to, name, desc);
      }
    }
  }
  target.parts = Object.freeze(parts.map(p => p.name));
  return target;
}
