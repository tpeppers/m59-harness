// WHAT A FLEETSCRIPT PARAMETER MEANS, AS A PICKER IN THE CLIENT'S MANAGE TAB.
//
// A FleetScript describes its parameters (`script.params`: { key: {type, required, default,
// describe, ...} }), and the MANAGE tab used to render every one of them as a text box. So the
// operator typed agent names from memory, typed a merchant's name with the apostrophe in the right
// place, typed a room number, and found out at the counter. Every one of those has a known,
// finite answer the fleet already holds: the roster, the merchant catalogue, the room list, the
// bank books. This module turns a parameter into the picker that answers it.
//
// THE VOCABULARY (a script opts in by declaring `type`; untyped params are guessed, below):
//
//   type: 'agents'               multi-select of the fleet (the piloted character left out)
//   type: 'boolean'              checkbox
//   type: 'number'               number box; `min`/`max` give it a slider.
//                                `bounds: 'balance', bank: '<param>'` caps it at the most any
//                                fleet character has banked in the account that bank serves
//   type: 'room'                 dropdown of every room, number and name; free text accepted
//   type: 'merchant'             dropdown of every merchant in the catalogue, with his room
//   type: 'item', of: '<param>'  what the merchant named by <param> sells -- goods AND the
//                                spells and skills he teaches -- narrowed as the merchant changes
//   type: 'bank'                 the three bank counters (and "none" when optional)
//   type: 'wanderer'             Maleval, Parrin, Miriana, Tendrath, Izzio
//   type: 'script', paramsIn: '<param>'
//                                another FleetScript, configured in a nested form; its params go
//                                into <param> as JSON (island-trip's task/taskParams, chain.mjs)
//   options: [v | {value,label}]  a fixed choice, whatever the type
//
// GUESSES, for the scripts written before this existed: a number param named like a room
// (home, room, bankRoom, ...Room) becomes a room dropdown; a string named seller/teacher/vaultman/
// smith/apothecary becomes a merchant dropdown; `npc` a wanderer one. Each is a COMBO -- free text
// still accepted -- because a guess must never stop a value the script would have taken.
//
// Every list here is read from a file and cached on its mtime: the desk asks once a second.
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WANDERERS } from './m59-worldbook.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..');

const CACHE = new Map();
function cachedFile(file, build, fallback) {
  let t;
  try { t = statSync(file).mtimeMs; } catch { return fallback; }
  const c = CACHE.get(file);
  if (c && c.t === t) return c.v;
  let v;
  try { v = build(JSON.parse(readFileSync(file, 'utf8'))); } catch { v = fallback; }
  CACHE.set(file, { t, v });
  return v;
}
const firstExisting = files => files.find(f => { try { statSync(f); return true; } catch { return false; } }) ?? files[0];

// ------------------------------------------------------------------ rooms
export function rooms() {
  return cachedFile(join(REPO, 'compendium', 'data', 'zones.json'), z => Object.values(z.rooms ?? {})
    .filter(r => Number.isFinite(r.ridValue))
    .map(r => ({ room: r.ridValue, name: String(r.name ?? r.cls ?? '').trim() }))
    .sort((a, b) => a.room - b.room), []);
}
export const roomName = n => rooms().find(r => r.room === Number(n))?.name ?? null;

// ------------------------------------------------------------------ item names
// The catalogue holds kod CLASSES ("PurpleMushroom", "Herbs"); the shop list a buyer reads holds
// what vrName says ("purple mushroom", "herbs"). vrName is inherited, so walk the parent chain.
export function displayNameOf(cls) {
  const db = cachedFile(join(REPO, 'compendium', 'data', 'koddb.json'), j => j.classes ?? {}, {});
  for (let k = String(cls ?? '').toLowerCase(), hop = 0; k && hop < 24; hop++) {
    const c = db[k];
    if (!c) break;
    const n = c.classvars?.vrName?.rsc?.value ?? c.classvars?.vrName?.value;
    if (typeof n === 'string' && n.trim()) return n.trim();
    k = String(c.parent ?? '').toLowerCase();
  }
  return String(cls ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

// ------------------------------------------------------------------ merchants
// One row per PERSON (two classes can wear one name: RebelLiege and JealousGeneral are both Jonas
// D'Accor), with goods and teachings merged. Source-only rows (never seen, no room) are kept but
// sorted last and say so.
export function merchants(substrate) {
  const file = firstExisting([...(substrate ? [join(substrate, 'm59-merchants.json')] : []), join(REPO, 'substrate', 'm59-merchants.json')]);
  return cachedFile(file, j => {
    const byName = new Map();
    for (const m of j.merchants ?? []) {
      const name = String(m.name ?? m.cls ?? '').trim();
      if (!name) continue;
      const row = byName.get(name) ?? { name, rooms: new Set(), wanders: false, seen: false, goods: new Map(), teaches: new Map() };
      if (m.room != null) row.rooms.add(Number(m.room));
      row.wanders ||= !!m.wanders; row.seen ||= m.seen !== false;
      for (const s of m.sells ?? []) {
        const n = displayNameOf(s.cls);
        if (!row.goods.has(n)) row.goods.set(n, { name: n, cls: s.cls, quantity: s.quantity ?? null });
      }
      for (const t of m.teaches ?? []) {
        const n = String(t.spell ?? t.skill ?? t.name ?? '').trim();
        if (n && !row.teaches.has(n)) row.teaches.set(n, { name: n, kind: t.kind ?? 'ability', level: t.level ?? null, price: t.price ?? null });
      }
      byName.set(name, row);
    }
    return [...byName.values()].map(r => ({ ...r, rooms: [...r.rooms].sort((a, b) => a - b),
      goods: [...r.goods.values()].sort((a, b) => a.name.localeCompare(b.name)),
      teaches: [...r.teaches.values()].sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || a.name.localeCompare(b.name)) }))
      .sort((a, b) => (b.seen - a.seen) || a.name.localeCompare(b.name));
  }, []);
}
export const merchantNamed = (substrate, name) => {
  const f = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return merchants(substrate).find(m => f(m.name) === f(name)) ?? null;
};
export function merchantLabel(m) {
  const where = m.wanders ? `wanders: ${m.rooms.join(', ') || '?'}` : m.rooms.length
    ? m.rooms.map(r => `${roomName(r) ?? 'room'} (${r})`).join(', ') : 'never seen in the world';
  const what = [m.goods.length ? `${m.goods.length} goods` : '', m.teaches.length ? `${m.teaches.length} abilities` : ''].filter(Boolean).join(', ');
  return `${m.name} — ${where}${what ? ` — ${what}` : ''}`;
}
// What a merchant offers, as `item` option values. An ability is prefixed "learn:" so the buyer
// knows to use the learn verb (an ability never enters the pack; see learn-skill.mjs).
export function wares(m) {
  return [...m.goods.map(g => ({ value: g.name, label: `${g.name}${g.quantity != null ? ` (stock ${g.quantity})` : ''}` })),
          ...m.teaches.map(t => ({ value: `learn:${t.name}`, label: `learn ${t.kind} ${t.name}${t.level != null ? ` L${t.level}` : ''}${t.price != null ? ` — ${t.price.toLocaleString('en-US')}` : ''}` }))];
}

// ------------------------------------------------------------------ banks
// Exactly three counters (m59-broker.mjs `bank` tool): Jasper and Tos share one account, Ko'catan
// keeps another. Barloque has none -- Setag'lib is a class nothing creates.
export const BANKS = Object.freeze([
  { room: 376, name: 'The Royal Bank of Jasper', account: 'jasper-tos-barloque' },
  { room: 54, name: 'First Royal Bank of Tos', account: 'jasper-tos-barloque' },
  { room: 2005, name: "The Hungry Vaults (Ko'catan)", account: 'kocatan' },
]);
export const bankAt = room => BANKS.find(b => b.room === Number(room)) ?? null;
// The last balance each character was told, per account (tools/m59-bank.mjs books).
export function balancesOf(substrate, character) {
  if (!character) return {};
  const file = join(substrate ?? join(REPO, 'substrate'), 'banks', `${String(character).replace(/[^A-Za-z0-9_-]/g, '')}.json`);
  return cachedFile(file, j => Object.fromEntries(Object.entries(j.accounts ?? {}).map(([k, v]) => [k, { balance: Number(v.balance) || 0, at: v.at ?? null }])), {});
}

// ------------------------------------------------------------------ the fleet
export function fleetOptions(ctx) {
  const me = ctx.client?.agent ?? null;
  return (ctx.agents ?? []).filter(a => a.agent && a.agent !== me).map(a => {
    const bank = Object.values(balancesOf(ctx.substrate, a.character)).reduce((n, b) => n + b.balance, 0);
    return { value: a.agent, label: `${a.agent}${a.character ? ` · ${a.character}` : ''}${bank ? ` · ${bank.toLocaleString('en-US')} banked` : ''}` };
  }).sort((x, y) => x.value.localeCompare(y.value, undefined, { numeric: true }));
}
// The most any fleet character has in one account: the top of a withdraw slider.
export function richestIn(ctx, account) {
  let best = 0;
  for (const a of ctx.agents ?? []) best = Math.max(best, balancesOf(ctx.substrate, a.character)[account]?.balance ?? 0);
  return best;
}

// ------------------------------------------------------------------ params -> args
const ROOMISH = /^(home|room|back|destination|bankRoom|shopRoom|smithRoom|vaultRoom|teacherRoom|meetRoom|stageRoom|toothRoom|herbShop|emeraldShop|light_wait_room)$|Room$|_room$/;
const SELLERISH = /^(seller|teacher|vaultman|smith|apothecary|herbSeller|emeraldSeller|merchant)$/;
export const argId = key => String(key).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40);

export function kindOf(key, spec = {}) {
  if (Array.isArray(spec.options)) return 'options';
  const t = spec.type;
  if (['agents', 'boolean', 'room', 'merchant', 'item', 'bank', 'wanderer', 'script'].includes(t)) return t;
  if ((t === 'number' || t == null) && ROOMISH.test(key)) return 'roomGuess';
  if ((t === 'string' || t == null) && SELLERISH.test(key)) return 'merchantGuess';
  if (t == null && key === 'npc') return 'wandererGuess';
  if (t === 'number') return 'number';
  return 'text';
}

const roomOptions = () => rooms().map(r => ({ value: String(r.room), label: `${r.room} — ${r.name}` }));

/**
 * The client arguments for a script's params, required first then in declaration order.
 * `scripts` (name -> script) and `taskId` (name -> entry id) are needed only for `script` params.
 */
export function argsFor(script, ctx = {}, { scripts = null, taskId = null } = {}) {
  const params = Object.entries(script.params ?? {});
  const hidden = new Set(params.filter(([, s]) => s?.type === 'script' && s.paramsIn).map(([, s]) => s.paramsIn));
  const out = [];
  for (const [key, spec = {}] of params) {
    if (hidden.has(key) || spec.hidden) continue;
    const id = argId(key), kind = kindOf(key, spec);
    const a = { id, key, kind, title: `${key}${spec.required ? '' : ' (optional)'}`, type: 'text',
                default: spec.default != null ? String(spec.default) : '', help: spec.describe ?? '', optional: !spec.required };
    const none = label => (spec.required ? [] : [{ value: '', label }]);
    if (kind === 'agents') Object.assign(a, { type: 'agents', options: fleetOptions(ctx),
      excluded: ctx.client?.agent ? [{ value: ctx.client.agent, why: 'the character you are piloting — a FleetScript drives keepers, and yours is offline while you play' }] : [] });
    else if (kind === 'boolean') Object.assign(a, { type: 'boolean', default: String(spec.default === true || spec.default === 'true') });
    else if (kind === 'options') {
      const opts = spec.options.map(o => typeof o === 'object' ? { value: String(o.value), label: String(o.label ?? o.value) } : { value: String(o), label: String(o) });
      Object.assign(a, { type: 'choice', options: [...(opts.some(o => o.value === a.default) ? [] : none('(default)')), ...opts] });
    }
    else if (kind === 'room' || kind === 'roomGuess') Object.assign(a, { type: 'combo', options: roomOptions() });
    else if (kind === 'merchant') Object.assign(a, { type: 'choice', options: [...none('(none)'), ...merchants(ctx.substrate).map(m => ({ value: m.name, label: merchantLabel(m) }))] });
    else if (kind === 'merchantGuess') Object.assign(a, { type: 'combo', options: merchants(ctx.substrate).map(m => ({ value: m.name, label: merchantLabel(m) })) });
    else if (kind === 'item') {
      const of = argId(spec.of ?? 'seller');
      Object.assign(a, { type: 'choice', options: merchants(ctx.substrate).flatMap(m => wares(m).map(w => ({ ...w, when: `${of}=${m.name}` }))) });
    }
    else if (kind === 'bank') Object.assign(a, { type: 'choice', options: [...(spec.required ? [] : [{ value: '0', label: 'none — do not stop at a bank' }]),
      ...BANKS.map(b => ({ value: String(b.room), label: `${b.name} (${b.room})` }))] });
    else if (kind === 'wanderer') Object.assign(a, { type: 'choice', options: [...none('(none)'), ...Object.entries(WANDERERS).map(([k, w]) => ({ value: k, label: `${w.npc} — rooms ${w.rooms.join(', ')}` }))] });
    else if (kind === 'wandererGuess') Object.assign(a, { type: 'combo', options: Object.entries(WANDERERS).map(([k, w]) => ({ value: k, label: `${w.npc} — rooms ${w.rooms.join(', ')}` })) });
    else if (kind === 'script') {
      const exclude = new Set([script.name, ...(spec.exclude ?? [])]);
      const names = [...(scripts?.keys() ?? [])].filter(n => !exclude.has(n) && !scripts.get(n)?.unsafe).sort();
      Object.assign(a, { type: 'task', options: [...none('(none)'), ...names.map(n => ({ value: taskId ? taskId(n) : n,
        label: `${n} — ${String(scripts.get(n)?.describe ?? '').slice(0, 90)}` }))], default: '' });
    }
    else if (kind === 'number') {
      Object.assign(a, { type: 'number' });
      const bounds = [];
      if (spec.bounds === 'balance') {
        const bankKey = spec.bank ?? 'bank', bankSpec = script.params?.[bankKey];
        const bid = argId(bankKey);
        // No balance on record is "unknown", not "zero": that bank gets no range rather than a 0-0 one.
        for (const b of BANKS) {
          const most = richestIn(ctx, b.account);
          if (most > 0) bounds.push({ min: spec.min ?? 0, max: most, when: `${bid}=${b.room}`, why: `the most anyone has banked in ${b.name}` });
        }
        if (!bankSpec?.required) bounds.push({ min: 0, max: 0, when: `${bid}=0`, why: 'no bank chosen' });
      } else if (Number.isFinite(spec.min) && Number.isFinite(spec.max)) bounds.push({ min: spec.min, max: spec.max });
      if (bounds.length) a.bounds = bounds;
    }
    out.push(a);
  }
  return [...out.filter(a => !a.optional), ...out.filter(a => a.optional)];
}
