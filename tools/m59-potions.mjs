// KOD-derived potion identity/condition facts. Which effects to use is private policy.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile as compileSpells } from './m59-spells.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const POTIONS_FILE = process.env.M59_POTIONS || join(HERE, '../substrate/m59-potions.json');
const norm = s => String(s ?? '').replace(/~[A-Za-z]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
function resource(text, key) {
  if (!key) return null;
  const start = new RegExp('^\\s*' + key + '\\s*=', 'mi').exec(text);
  if (!start) return null;
  const tail = text.slice(start.index + start[0].length);
  const next = /\r?\n\s*(?:\w+\s*=|classvars:|properties:|messages:)/i.exec(tail);
  return [...tail.slice(0, next?.index ?? tail.length).matchAll(/"([^"]*)"/g)].map(m => m[1]).join('') || null;
}
export function compilePotions(root = process.env.M59_ROOT || 'C:/code/meridian59') {
  const consts = new Map([...readFileSync(join(root, 'kod/include/blakston.khd'), 'utf8')
    .matchAll(/^\s*(SID_\w+)\s*=\s*(\d+)/gm)].map(m => [m[1].toUpperCase(), +m[2]]));
  const spells = new Map(compileSpells(root).map(s => [s.num, s]));
  const dir = join(root, 'kod/object/item/passitem/spelitem/potion');
  return readdirSync(dir).filter(f => f.endsWith('.kod')).sort().flatMap(file => {
    const text = readFileSync(join(dir, file), 'utf8').replace(/^\s*%.*$/gm, '');
    const value = key => new RegExp('^\\s*' + key + '\\s*=\\s*(\\w+)', 'mi').exec(text)?.[1];
    const spell = spells.get(consts.get(value('viSpellEffect')?.toUpperCase()));
    const name = resource(text, value('vrLabelName')), good = resource(text, value('vrDesc')), bad = resource(text, value('vrBadDesc'));
    if (!spell || !name || !good || !bad || norm(good) === norm(bad)) return [];
    return [{ name, effect: spell.name, harmful: spell.harmful, post_cast_ms: spell.post_cast_ms,
      good_description: good, bad_description: bad, source: 'kod/object/item/passitem/spelitem/potion/' + file }];
  });
}
let catalogue;
export function potionCatalogue() {
  if (!catalogue) {
    try { catalogue = new Map(JSON.parse(readFileSync(POTIONS_FILE, 'utf8')).potions.map(p => [norm(p.name), p])); }
    catch { catalogue = new Map(); }
  }
  return catalogue;
}
export function potionCondition(potion, description) {
  const text = norm(description), good = norm(potion?.good_description), bad = norm(potion?.bad_description);
  if (!text || !good || !bad || good === bad) return { safe: false, reason: 'condition_unknown' };
  if (text.includes(bad)) return { safe: false, reason: 'spoiled' };
  // A fresh affirmative description is required; absence of a poison word is not proof.
  return text.startsWith(good) ? { safe: true, reason: 'fresh_description' } : { safe: false, reason: 'condition_unknown' };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] !== 'build') throw Error('usage: node tools/m59-potions.mjs build');
  const potions = compilePotions();
  writeFileSync(POTIONS_FILE, JSON.stringify({ potions }, null, 2) + '\n');
  console.log(potions.length + ' potion identities/condition descriptions compiled');
}
