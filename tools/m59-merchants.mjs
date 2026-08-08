#!/usr/bin/env node
// Who buys what, who sells what, and where they stand.
//
//   node tools/m59-merchants.mjs build      write substrate/m59-merchants.json
//   node tools/m59-merchants.mjs who-buys <thing>
//   node tools/m59-merchants.mjs who-sells <thing>
//   node tools/m59-merchants.mjs show <name>
//
//   node tools/m59-merchants.mjs enrich     re-apply what the SOURCE knows, no server
//
// Merchants are picky, and the pickiness is not in the protocol. A merchant decides
// whether it wants an item in `ObjectDesired`, which is a kod METHOD overridden per
// merchant — the Barloque apothecary buys reagents but refuses gems, and it says so
// out loud rather than in any flag. So there are two halves to this catalogue and
// they come from different places:
//
//   from the RUNNING SERVER, over the admin socket:
//     which objects are merchants (viAttributes & MOB_BUYER / MOB_RECEIVE),
//     which room each is in, its markup, and its plFor_sale — the stock list, the
//     spells and skills it teaches, and any fixed prices
//
//   from the SOURCE TREE, which is the only place the buying rule exists at all:
//     each merchant class's ObjectDesired body, kept verbatim as a note, because a
//     rule expressed as code cannot be reduced to data without losing the cases —
//     and who the merchant IS, which the server cannot tell us either
//
// SLOT 2 OF plFor_sale IS SKILLS, AND THIS FILE USED TO THROW IT AWAY. The structure
// is four positional slots — `AssembleForSaleList` (monster.kod:4819) names them
// "(items, skills, spells, conditionals)" in its own docstring — and the reader here
// took only slot 3 as abilities, calling slot 2 "?" in this header. So EVERY SKILL
// SOLD BY A LIVE MERCHANT WAS DROPPED, silently, for the entire life of the catalogue.
//
// It cost a whole answer. Jonas D'Accor sells `block`, the only shield skill in the
// game; he was in the index the whole time, standing still in Pietro's Wicked Brews,
// teaching nine spells and — as far as any tool could see — no skills at all. The only
// trace of block was the source-derived, never-seen JealousGeneral entry, so
// `who-teaches block` answered with a WANDERER and nothing else, and an errand built on
// that would have sent characters chasing a man who was sitting in a bar.
//
// WHICH IS THE SAME MAN. A merchant here is a CLASS, and a person can wear more than
// one: RebelLiege and JealousGeneral are both "Jonas D'Accor", teach the same list, and
// differ only in that one stands still and one walks a circuit. Nothing in the protocol
// says so — the server hands out object ids and class names, and two ids with two class
// names look like two people. The NAME RESOURCE in the source is what says otherwise,
// so classes sharing one are linked as `also`, and a wanderer is never reported as the
// only source of something his stationary self also sells.
//
// The catalogue is a starting point, not an oracle. The authoritative test is still
// to offer the thing and read what the merchant says — `sell` with confirm:false
// quotes a price without committing, which is exactly that test.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = process.env.M59_HOST || '127.0.0.1';
const ADMIN_PORT = Number(process.env.M59_ADMIN_PORT || 9998);
const M59_ROOT = process.env.M59_ROOT || 'C:/code/meridian59';
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.M59_MERCHANTS || path.join(here, '..', 'substrate', 'm59-merchants.json');

// kod/include/blakston.khd
const MOB_BUYER = 0x00000008, MOB_RECEIVE = 0x00000010;

function adminBatch(cmds, quietMs = 900, capMs = 240000) {
  return new Promise((resolve, reject) => {
    const s = net.connect(ADMIN_PORT, HOST);
    let buf = '', quiet, hard;
    const finish = () => { clearTimeout(quiet); clearTimeout(hard); s.destroy(); resolve(buf); };
    s.on('connect', () => {
      s.write(cmds.join('\r\n') + '\r\n');
      quiet = setTimeout(finish, quietMs); hard = setTimeout(finish, capMs);
    });
    s.on('data', d => { buf += d; clearTimeout(quiet); quiet = setTimeout(finish, quietMs); });
    s.on('error', e => { clearTimeout(quiet); clearTimeout(hard); reject(e); });
  });
}

function splitObjectBlocks(text) {
  const blocks = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const head = /OBJECT (\d+) is CLASS (\w+)/.exec(raw);
    if (head) { cur = { id: Number(head[1]), cls: head[2], lines: [] }; blocks.push(cur); continue; }
    if (cur) cur.lines.push(raw);
  }
  return blocks;
}
const prop = (lines, name, kind = 'INT') => {
  const re = new RegExp(`${name}\\s+= ${kind} (-?\\d+)`);
  for (const l of lines) { const m = re.exec(l); if (m) return Number(m[1]); }
  return null;
};

// ------------------------------------------------- what the source tree can be asked
//
// One pass over the kod, because four different questions used to walk the whole tree
// separately and they all want the same file open.

// Everything between a bracket and its match. `plFor_Sale = [$, [ SKID_BLOCK ], [...]]`
// cannot be read with a regex — the slots nest — so find the close by counting.
export function balanced(text, open, pair = '[]') {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === pair[0]) depth++;
    else if (text[i] === pair[1] && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

// Split a kod list body on the commas BETWEEN slots, ignoring the ones inside them.
export function splitTopLevel(body) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of String(body ?? '')) {
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

// POSITION IS THE ONLY THING THAT SAYS SKILL OR SPELL. The numbers are drawn from two
// different tables that overlap, so a bare number is ambiguous and its SLOT is not —
// slot 2 is skills, slot 3 is spells (monster.kod:4819). A class may declare several
// variants (jGeneral.kod has one with shatterlock and one without), so take the union:
// a merchant that sells a thing under any condition can sell it.
export function forSaleFromSource(text) {
  const skills = new Set(), spells = new Set();
  for (const m of String(text ?? '').matchAll(/plFor_sale\s*=\s*(?=\[)/gi)) {
    const slots = splitTopLevel(balanced(text, m.index + m[0].length));
    // Upper-cased on capture. The constant is spelled `SID_FORESIGHT` in blakston.khd
    // and `SID_Foresight` in the class that implements it, and a Map keyed on the
    // as-written spelling silently loses whichever one it did not see first.
    for (const c of (slots[1] ?? '').matchAll(/\bSKID_(\w+)/gi)) skills.add(`SKID_${c[1]}`.toUpperCase());
    for (const c of (slots[2] ?? '').matchAll(/\bSID_(\w+)/gi))  spells.add(`SID_${c[1]}`.toUpperCase());
  }
  return { skills: [...skills], spells: [...spells] };
}

// WHAT THE GAME CALLS SOMETHING, WHICH IS NEVER SAFE TO GUESS FROM THE CONSTANT.
// `SKID_PROFICIENCY_MACE` is called "mace fighting" and `SKID_PROFICIENCY_SWORD` is
// called "fencing"; deriving a name from the constant invents seven of the eight weapon
// proficiencies, which this repository has already done once and had to undo. So follow
// the `vrName = <rsc>` reference to the string it points at.
//
// Two casings to survive, both of which cost a whole category before they were noticed:
// resource names are case-insensitive and the tree uses that freely (`Izzio` declares
// `izzio_name_rsc`), and so are property names (`viSkill_num` in block.kod against
// `viSkill_Num` in slash.kod).
export function resourceValue(text, cls, prop, quoted = true) {
  const fallback = `${cls}_${prop.replace(/^vr/, '').toLowerCase()}_rsc`;
  const ref = new RegExp(`^\\s*${prop}\\s*=\\s*(\\w+)`, 'im').exec(text)?.[1] ?? fallback;
  return new RegExp(`^\\s*${ref}\\s*=\\s*${quoted ? '"([^"]*)"' : '(\\S+)'}`, 'im').exec(text)?.[1] ?? null;
}

// KOD CLASS NAMES ARE CASE-INSENSITIVE, AND THE TREE USES THAT — THIRD TIME.
//
// `crnthtwn.kod` declares `CorNothTown`; `cngrocer.kod` says `CornothGrocer is
// CornothTown`. Both are the same class to the compiler (`kodbase.txt` lists it once)
// and two different keys to a plain Map, so every walk up that chain stopped dead at
// the first hop.
//
// It fails SILENTLY and in the safe-looking direction: `descendsFrom` returns false, so
// Solomon in Cor Noth was reported as standing still whether or not he does, and the
// finite-stock resolver could not classify him at all. Nothing errors — a broken chain
// and a chain that genuinely ends both look like "no".
//
// This is the same trap resourceValue already carries for resource names (`Izzio`
// declares `izzio_name_rsc`) and property names (`viSkill_num` against `viSkill_Num`).
// It cost a category each time, so the lookup is fixed here rather than at each caller:
// entries keep the spelling the file used — `build` iterates them — while `get` and
// `has` ignore case.
class ClassMap extends Map {
  #ci = new Map();
  set(k, v) { this.#ci.set(String(k).toLowerCase(), k); return super.set(k, v); }
  get(k) {
    if (super.has(k)) return super.get(k);
    const canonical = this.#ci.get(String(k).toLowerCase());
    return canonical === undefined ? undefined : super.get(canonical);
  }
  has(k) { return super.has(k) || this.#ci.has(String(k).toLowerCase()); }
}

// Read every class once: who it is, what it descends from, what it sells and teaches,
// where it walks, and the rule it buys by.
export function readSourceClasses(root = M59_ROOT) {
  const out = new ClassMap();
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.kod')) continue;
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const decl = /^(\w+)\s+is\s+(\w+)/m.exec(text);
      if (!decl) continue;
      const cls = decl[1];
      const file = path.relative(root, full).split(path.sep).join('/');

      // WHO THIS IS, AND WHAT HE LOOKS LIKE. The class name is ours; the name and icon
      // resources are the game's, and together they are the only thing that can tell one
      // man in two coats from two men with one name.
      //
      // See resourceValue: the reference is followed rather than the name guessed.

      // Where a wanderer walks. RID_ constants, resolved to room numbers by the caller.
      const destIdx = text.indexOf('   CreateDestinationList(');
      const dests = destIdx < 0 ? [] : [...new Set(
        [...text.slice(destIdx, destIdx + 2000).matchAll(/\b(RID_\w+)/g)].map(m => m[1]))];

      // The buying rule, kept as text: "buys reagents but not gems" is a thing a rule
      // can say and a flag cannot. Take to the closing brace at METHOD indentation —
      // kod methods are indented three spaces and closed by a brace in column 4, while
      // braces inside the body are deeper. The tree is CRLF, so match the line ending
      // rather than assuming "\n", which runs the capture on into the next method.
      let desired = null;
      const di = text.indexOf('   ObjectDesired(');
      if (di >= 0) {
        const rest = text.slice(di);
        const end = /\r?\n {3}\}\r?\n/.exec(rest);
        desired = { file, body: (end ? rest.slice(0, end.index + end[0].length) : rest.slice(0, 1200)).trimEnd() };
      }

      // DOES THIS ONE KEEP A REAL PACK? Almost nobody does — `Monster` declares
      // `vbSellFromInventory = FALSE` and the list is assembled on demand, which is why
      // an ordinary counter can never run out and why "the shop had none" is almost
      // always a failed read rather than an empty shelf. Two classes override it, and
      // for those two the flag changes what every answer means.
      //
      // Captured as declared-or-null rather than resolved here, because it is
      // INHERITED: a subclass of Izzio would be finite without saying so, and a `false`
      // written in at this level would be indistinguishable from "did not mention it".
      // sellsFromInventory() below walks the chain.
      const declared = /^\s*vbSellFromInventory\s*=\s*(TRUE|FALSE)/im.exec(text)?.[1] ?? null;
      const cap = /^\s*MAX_FORSALE\s*=\s*(\d+)/im.exec(text)?.[1] ?? null;

      out.set(cls, {
        cls, parent: decl[2], file,
        name: resourceValue(text, cls, 'vrName'),
        icon: resourceValue(text, cls, 'vrIcon', false),
        isMerchant: /^ {3}SetForSale/m.test(text),
        sellsFromInventoryDeclared: declared === null ? null : declared.toUpperCase() === 'TRUE',
        maxForSale: cap == null ? null : Number(cap),
        // What it stocks, read straight out of SetForSale. Class names only — the
        // running world gives quantities, the source gives the roster.
        stocks: [...new Set([...text.matchAll(/Create\(&(\w+)/g)].map(m => m[1]))],
        ...forSaleFromSource(text),
        destinations: dests,
        objectDesired: desired,
      });
    }
  };
  walk(path.join(root, 'kod'));
  return out;
}

// A MERCHANT THAT CAN RUN OUT — OF STOCK, AND OF SHELF SPACE.
//
// `vbSellFromInventory = TRUE` means this one sells the actual objects it is holding
// rather than a list assembled per buyer, and it is the single most consequential flag
// on a merchant because it makes THREE different silences possible that no other
// merchant has:
//
//   it has none left            — so "sells no elderberry" is literally true
//   its pack is full            — MAX_FORSALE, so a SELL is refused
//   it already holds that kind  — so a sell is refused even with room, per item
//
// Every one of those is a sentence spoken to the room (`izzio_Full_rsc`,
// `JunkMan_too_many_rsc`, `..._AlreadyHaveOne_rsc`) and NONE of them is an error on the
// wire. A caller that trusts "the call did not complain" learns nothing.
//
// Only two classes in the tree set it — Izzio and the Ko'catan shopkeeper, both
// MAX_FORSALE = 25 — and `Monster` sets it FALSE, so the walk always terminates. It
// matters that this is resolved through the PARENT CHAIN rather than read off the class:
// the flag is inherited, and a class that says nothing is answering with its parent's
// answer, not with "no".
//
// Do not generalise the finite reading to anyone else. It cost a wrong diagnosis: two
// characters were told "202 sells no elderberry after all" and 202 is MarionInnkeeper,
// which inherits FALSE and cannot run out — a third character bought from that counter
// seconds later.
export function sellsFromInventory(classes, cls, limit = 24) {
  for (let c = cls, i = 0; c && i < limit; i++) {
    const node = classes.get(c);
    if (!node) break;
    if (node.sellsFromInventoryDeclared !== null)
      return { finite: node.sellsFromInventoryDeclared, from: node.cls,
               max_for_sale: node.maxForSale ?? classes.get(cls)?.maxForSale ?? null };
    c = node.parent;
  }
  // Nothing in the chain said. `Monster` does, so this is a class we could not resolve
  // rather than a merchant that is genuinely undecided — reported as unknown rather
  // than defaulted to false, because "we could not tell" and "it cannot run out" lead
  // to different decisions at a counter.
  return { finite: null, from: null, max_for_sale: null };
}

// Does this class descend from Wanderer? A wanderer's recorded room is where he was
// STANDING, which for him is a rumour with a timestamp rather than an address.
export function descendsFrom(classes, cls, ancestor, limit = 24) {
  for (let c = cls, i = 0; c && i < limit; i++) {
    const node = classes.get(c);
    if (!node) return false;
    if (node.parent === ancestor) return true;
    c = node.parent;
  }
  return false;
}

// blakston.khd is the one place that turns a constant into a number, for room ids and
// for ability ids alike.
export function readConstants(root = M59_ROOT) {
  const rooms = new Map(), abilities = new Map();
  let khd = '';
  try { khd = fs.readFileSync(path.join(root, 'kod/include/blakston.khd'), 'utf8'); } catch { return { rooms, abilities }; }
  for (const m of khd.matchAll(/^\s*(RID_\w+)\s*=\s*(\d+)/gim)) rooms.set(m[1].toUpperCase(), Number(m[2]));
  for (const m of khd.matchAll(/^\s*(SID|SKID)_(\w+)\s*=\s*(\d+)/gim))
    abilities.set(`${m[1]}_${m[2]}`.toUpperCase(), Number(m[3]));
  return { rooms, abilities };
}

// WHAT A SKILL OR SPELL COSTS, which is a function of its LEVEL and nothing else —
// `Skill.GetValue` (skill.kod:128) and `Spell.GetValue` (spell.kod:353) are the same
// doubling, and `Monster.GetPrice` says in its own docstring "No markup for skills or
// spells" (monster.kod:4880). So a teacher's mood, markup and faction bonus, all of
// which move the price of a hat, do not move this. Written as the kod writes it rather
// than as a power, because the off-by-one is the whole question: a level 1 skill is
// 500, not 250.
export function priceOfLevel(level) {
  if (!(level >= 1)) return null;
  let j = 2;
  for (let i = 1; i < level; i++) j *= 2;
  return 250 * j;
}

// Level and REAL NAME, per ability constant, from the class that defines it.
export function readAbilityLevels(root = M59_ROOT) {
  const out = new Map();
  for (const [sub, numProp, lvlProp] of [['skill', 'viSkill_num', 'viSkill_level'],
                                         ['spell', 'viSpell_num', 'viSpell_level']]) {
    const walk = dir => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!e.name.endsWith('.kod')) continue;
        let text;
        try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
        const num = new RegExp(`^\\s*${numProp}\\s*=\\s*(\\w+)`, 'im').exec(text);
        if (!num) continue;
        const lvl = new RegExp(`^\\s*${lvlProp}\\s*=\\s*(\\d+)`, 'im').exec(text);
        const cls = /^(\w+)\s+is\s+\w+/m.exec(text)?.[1] ?? '';
        out.set(num[1].toUpperCase(), {
          kind: sub,
          level: lvl ? Number(lvl[1]) : 1,
          name: resourceValue(text, cls, 'vrName'),
          file: path.relative(root, full).split(path.sep).join('/'),
        });
      }
    };
    walk(path.join(root, 'kod/object/passive', sub));
  }
  return out;
}

// A merchant's stock. plFor_sale is a list of lists and `show list` prints it
// nested, so read one level and resolve object ids to names.
async function readForSale(listId) {
  if (!listId) return null;
  const dump = await adminBatch([`show list ${listId}`], 1200);
  // POSITION IS MEANING here — plFor_sale is a fixed four-slot structure
  // [ items, skills, spells, conditional prices ] — and an empty slot prints
  // as `$ 0`. Dropping those placeholders silently shifts every later slot left, so
  // the spells a merchant teaches would be read as though they were something else.
  const groups = [];
  let cur = null, depth = 0;
  for (const raw of dump.split(/\r?\n/)) {
    const line = raw.replace(/^:\s?/, '').trim();
    if (line === '[') { depth++; if (depth === 2) cur = []; continue; }
    if (line === ']') { if (depth === 2) { groups.push(cur); cur = null; } depth--; continue; }
    if (depth === 1 && /^\$\s+0$/.test(line)) { groups.push([]); continue; }   // empty slot
    const m = /^(?:INT|OBJECT|LIST)\s+(-?\d+)$/.exec(line);
    if (!m) continue;
    const entry = { kind: line.split(/\s+/)[0], v: Number(m[1]) };
    if (depth >= 2 && cur) cur.push(entry);
    else if (depth === 1) groups.push([entry]);
  }
  return groups;
}

// ------------------------------------------------------------------ enrichment
//
// Everything the SOURCE knows about a merchant, applied to a catalogue that may have
// come from a server run months ago — or from a server that is not up now. Both `build`
// and `enrich` go through here so the two paths cannot drift apart.

// A HARD-WON DISTINCTION, RECORDED PER ABILITY. `from: 'server'` is what an instance
// standing in the world was actually holding. `from: 'source'` is what the class says
// it sells, which is a LEAD rather than an observation — the live list is per-instance
// and can differ (jGeneral toggles shatterlock on and off), and the offer list is
// filtered per BUYER anyway, so acting on a lead costs one look at a shop list.
export function enrichCatalogue(data, { root = M59_ROOT } = {}) {
  const classes = readSourceClasses(root);
  const { rooms: RID, abilities: CONST } = readConstants(root);
  const levels = readAbilityLevels(root);

  const skillByNum = new Map(), spellByNum = new Map();
  for (const [constant, info] of levels) {
    const num = CONST.get(constant);
    if (num == null) continue;
    (info.kind === 'skill' ? skillByNum : spellByNum).set(num, { ...info, constant });
  }
  // A number blakston.khd names but no class implements. Rare, and the constant is
  // still better than nothing — but it is the guessed name, so say which it was.
  const constByNum = new Map([...CONST].map(([c, n]) => [n, c]));
  // A LAST RESORT, AND IT LIES. "proficiency mace" is a name nothing answers to; the
  // class calls it "mace fighting". Used only when no class could be found for the
  // number at all, and worth noticing in the output when it happens.
  const pretty = c => String(c).replace(/^(SKID|SID)_/, '').toLowerCase().replace(/_/g, ' ');

  // Name a number. Kind comes from the ability's OWN class — `viSkill_num` and
  // `viSpell_num` are declared on different classes, so the number knows what it is
  // without us having to remember which slot it arrived in. A number claimed by both
  // tables keeps the old both-candidates hedge rather than picking one.
  const describe = (num, { kind = null, from = 'server' } = {}) => {
    const sk = skillByNum.get(num), sp = spellByNum.get(num);
    const settled = kind ?? (sk && sp ? null : sk ? 'skill' : sp ? 'spell' : null);
    const info = settled === 'skill' ? sk : settled === 'spell' ? sp : (sk ?? sp);
    const guessed = !info?.name && constByNum.has(num);
    const name = info?.name ?? (constByNum.has(num) ? pretty(constByNum.get(num)) : undefined);
    return {
      num, from,
      ...(settled ? { kind: settled } : {}),
      // Kept as they always were, so anything reading t.spell || t.skill still works.
      ...(settled === 'skill' || (!settled && sk) ? { skill: name } : {}),
      ...(settled === 'spell' || (!settled && sp) || (!settled && !sk && !sp) ? { spell: name } : {}),
      ...(info ? { constant: info.constant, level: info.level, price: priceOfLevel(info.level) }
               : constByNum.has(num) ? { constant: constByNum.get(num) } : {}),
      ...(guessed ? { name_guessed_from_constant: true } : {}),
    };
  };

  for (const m of data.merchants) {
    const src = classes.get(m.cls) ?? null;
    m.name = src?.name ?? null;
    m.wanders = descendsFrom(classes, m.cls, 'Wanderer');
    // Whether this one keeps a real pack. See sellsFromInventory: only two do, and for
    // those two an empty shop list and a refused sale are both things that HAPPEN
    // rather than things that mean the read failed.
    const stock = sellsFromInventory(classes, m.cls);
    if (stock.finite) {
      m.finite_stock = true;
      m.max_for_sale = stock.max_for_sale;
      m.finite_stock_note =
        `sells the objects it is actually holding (vbSellFromInventory on ${stock.from}), ` +
        `up to ${stock.max_for_sale ?? '?'} at a time. It can be OUT of something, and it ` +
        `can be too FULL to buy from you — it refuses per item, out loud, with no error ` +
        `on the wire. Read the purse afterwards; do not trust the call.`;
    } else {
      delete m.finite_stock; delete m.max_for_sale; delete m.finite_stock_note;
      // Only when the chain could not be resolved at all. A merchant we cannot classify
      // is worth a line, because the default reading assumes it cannot run out.
      if (stock.finite === null && src) m.finite_stock_unknown = true;
      else delete m.finite_stock_unknown;
    }
    // Where he WALKS, which for a wanderer is the real answer to "where is he" — the
    // recorded room is only where somebody last saw him.
    const circuit = (src?.destinations ?? []).map(r => RID.get(r)).filter(n => n != null);
    if (m.wanders) m.circuit = circuit;
    else delete m.circuit;

    const byNum = new Map();
    for (const t of m.teaches ?? []) {
      if (t.num == null) continue;
      byNum.set(t.num, describe(t.num, { kind: t.kind ?? null, from: t.from ?? 'server' }));
    }
    // Whatever the class declares and the recorded list did not carry. This is where a
    // skill dropped by the old slot-blind reader comes back without a server.
    for (const [constants, kind] of [[src?.skills ?? [], 'skill'], [src?.spells ?? [], 'spell']]) {
      for (const c of constants) {
        const num = CONST.get(String(c).toUpperCase());
        if (num == null || byNum.has(num)) continue;
        byNum.set(num, describe(num, { kind, from: 'source' }));
      }
    }
    m.teaches = [...byNum.values()];
    if (src && !m.source) m.source = src.file;
  }

  // ONE MAN, TWO CLASSES. Nothing on the wire can tell you this: the server hands out
  // an object id and a class name, and Jonas D'Accor standing still is a different id
  // and a different class from Jonas D'Accor walking. The name resource is the join.
  //
  // BUT A SHARED NAME IS NOT BY ITSELF A SHARED PERSON, and the tree contains the
  // counter-example that proves it: the Barloque and Tos blacksmiths are BOTH
  // "Fehr'loi Qan", standing still in two towns at once. The icon separates the cases —
  // Jonas wears `wngenera.bgf` in both of his classes, while the two smiths draw as
  // `bqsmith.bgf` and `bsmith.bgf`. So the link is recorded either way, because either
  // way it is a second place to buy the same thing, and only the icon match is called
  // the same man.
  const byName = new Map();
  for (const m of data.merchants) {
    if (!m.name) continue;
    if (!byName.has(m.name)) byName.set(m.name, []);
    byName.get(m.name).push(m);
  }
  for (const m of data.merchants) {
    const src = classes.get(m.cls) ?? null;
    const kin = (byName.get(m.name) ?? []).filter(x => x.cls !== m.cls);
    if (!kin.length) { delete m.also; delete m.also_note; continue; }
    m.also = kin.map(x => ({
      cls: x.cls, room: x.room, seen: x.seen, wanders: x.wanders,
      same_person: !!(src?.icon && classes.get(x.cls)?.icon === src.icon),
    }));
    m.also_note = m.also.some(x => x.same_person)
      ? 'the same man under another class — same name, same icon. One of these usually stands still.'
      : 'answers to the same name but draws differently, so probably a different person — ' +
        'still a second place to buy the same things.';
  }

  data.enrichedAt = new Date().toISOString();
  return data;
}

async function build() {
  process.stderr.write('reading the room registry...\n');
  const sys = await adminBatch(['show object 0'], 900);
  const roomListId = prop(sys.split(/\r?\n/), 'plRooms', 'LIST');
  const roomDump = await adminBatch([`show list ${roomListId}`], 1500);
  const roomIds = [...new Set([...roomDump.matchAll(/OBJECT (\d+)/g)].map(m => Number(m[1])))];

  // Merchants live in rooms, so sweep each room's active list rather than guessing an
  // object-id range — the same reason the room graph uses SYS.plRooms.
  process.stderr.write(`sweeping ${roomIds.length} rooms for their contents...\n`);
  const roomInfo = new Map();
  const activeLists = [];
  for (let i = 0; i < roomIds.length; i += 300) {
    const slice = roomIds.slice(i, i + 300);
    for (const b of splitObjectBlocks(await adminBatch(slice.map(id => `show object ${id}`)))) {
      const num = prop(b.lines, 'piRoom_num');
      if (num === null) continue;
      const active = prop(b.lines, 'plActive', 'LIST');
      roomInfo.set(b.id, { objId: b.id, cls: b.cls, num });
      if (active) activeLists.push({ room: b.id, list: active });
    }
    process.stderr.write(`\r  ${Math.min(i + 300, roomIds.length)}/${roomIds.length}`);
  }
  process.stderr.write('\n');

  process.stderr.write('reading room contents...\n');
  const candidates = [];
  for (let i = 0; i < activeLists.length; i += 200) {
    const slice = activeLists.slice(i, i + 200);
    const text = await adminBatch(slice.map(x => `show list ${x.list}`), 1500);
    const parts = text.split(/(?=show list \d+)/);
    for (const part of parts) {
      const lid = Number(/^show list (\d+)/.exec(part.trim())?.[1]);
      const owner = slice.find(x => x.list === lid);
      if (!owner) continue;
      for (const m of part.matchAll(/OBJECT (\d+)/g)) candidates.push({ id: Number(m[1]), room: owner.room });
    }
    process.stderr.write(`\r  ${Math.min(i + 200, activeLists.length)}/${activeLists.length} rooms`);
  }
  process.stderr.write(`\n  ${candidates.length} objects standing in rooms\n`);

  process.stderr.write('checking which are merchants...\n');
  const merchants = [];
  const uniq = [...new Map(candidates.map(c => [c.id, c])).values()];
  for (let i = 0; i < uniq.length; i += 300) {
    const slice = uniq.slice(i, i + 300);
    for (const b of splitObjectBlocks(await adminBatch(slice.map(c => `show object ${c.id}`)))) {
      const attrs = prop(b.lines, 'viAttributes');
      const forSale = prop(b.lines, 'plFor_sale', 'LIST');
      const wanted = prop(b.lines, 'plWantedItems', 'LIST');
      // viAttributes is a classvar and does not appear in `show object`; fall back to
      // the presence of a stock list, which only merchants carry.
      const looksLikeMerchant = forSale || wanted ||
        (attrs !== null && (attrs & (MOB_BUYER | MOB_RECEIVE)));
      if (!looksLikeMerchant) continue;
      const home = uniq.find(c => c.id === b.id);
      merchants.push({
        id: b.id, cls: b.cls,
        roomObjId: home?.room ?? null,
        roomNum: home ? roomInfo.get(home.room)?.num ?? null : null,
        markup: prop(b.lines, 'viMerchant_markup'),
        forSaleList: forSale, wantedList: wanted,
      });
    }
    process.stderr.write(`\r  ${Math.min(i + 300, uniq.length)}/${uniq.length}, ${merchants.length} merchants`);
  }
  process.stderr.write('\n');

  // Stock lists, and names for everything in them.
  process.stderr.write('reading stock lists...\n');
  const itemIds = new Set();
  for (const m of merchants) {
    m.forSale = await readForSale(m.forSaleList);
    for (const g of m.forSale || []) for (const e of g) if (e.kind === 'OBJECT') itemIds.add(e.v);
  }
  const nameById = new Map();
  const ids = [...itemIds];
  for (let i = 0; i < ids.length; i += 300) {
    const slice = ids.slice(i, i + 300);
    for (const b of splitObjectBlocks(await adminBatch(slice.map(id => `show object ${id}`)))) {
      nameById.set(b.id, { cls: b.cls, number: prop(b.lines, 'piNumber') });
    }
  }

  const classes = readSourceClasses();
  const inSource = new Map([...classes].filter(([, v]) => v.isMerchant));
  process.stderr.write(`${[...classes.values()].filter(c => c.objectDesired).length} classes define ` +
                       `ObjectDesired; ${inSource.size} merchant classes in the source\n`);

  const out = { builtAt: new Date().toISOString(), merchants: [] };
  for (const m of merchants) {
    const stock = [];
    const teaches = [];
    // FOUR POSITIONAL SLOTS: items, SKILLS, SPELLS, conditional prices
    // (AssembleForSaleList, monster.kod:4819). Slot 2 was read as nothing for the whole
    // life of this catalogue, which is why no live merchant ever appeared to sell a
    // skill. The numbers are named and classified downstream, by the ability's own
    // class, so nothing here has to know which table a number came from.
    (m.forSale || []).forEach((group, gi) => {
      for (const e of group) {
        if (e.kind === 'OBJECT') {
          const info = nameById.get(e.v);
          stock.push({ id: e.v, cls: info?.cls ?? null, quantity: info?.number ?? null });
        } else if (gi === 1) teaches.push({ num: e.v, kind: 'skill', from: 'server' });
        else if (gi === 2)   teaches.push({ num: e.v, kind: 'spell', from: 'server' });
      }
    });
    const od = classes.get(m.cls)?.objectDesired ?? null;
    out.merchants.push({
      seen: true,
      id: m.id, cls: m.cls, room: m.roomNum, markup: m.markup,
      sells: stock,
      teaches,
      buying_rule: od ? { source: od.file, kod: od.body } : null,
      buys_anything: !od,     // the base Monster.ObjectDesired returns TRUE
    });
  }
  // Anything the source defines but the world was not showing. Its room may simply
  // not have been visited, or it may spawn only for a quest — either way an agent
  // asking "who buys gems" deserves to hear about it, flagged as unconfirmed.
  const seen = new Set(out.merchants.map(m => m.cls));
  for (const [cls, info] of inSource) {
    if (seen.has(cls)) continue;
    if (cls === 'Monster') continue;            // the base class, not a merchant
    out.merchants.push({
      seen: false,
      id: null, cls, room: null, markup: null,
      sells: info.stocks.map(c => ({ id: null, cls: c, quantity: null })),
      teaches: [],                              // filled from the source by enrichCatalogue
      buying_rule: info.objectDesired ? { source: info.objectDesired.file, kod: info.objectDesired.body } : null,
      buys_anything: !info.objectDesired,
      source: info.file,
      note: 'defined in the source but no instance was standing in the world when this was built',
    });
  }

  return enrichCatalogue(out);
}

// --------------------------------------------------------------------- query

export function loadMerchants(file = OUT) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const cat = m => `${m.name ? `${m.name} [${m.cls}]` : m.cls}${m.room != null ? ` (room ${m.room})` : ''}`;

// A teacher is worth reaching only if he is where the catalogue says. Say which kind
// this is, in one line, rather than leaving it to be discovered by walking there.
const whereabouts = (m) => m.wanders
  ? `WANDERS${m.circuit?.length ? ` between rooms ${m.circuit.join(', ')}` : ''}` +
    `${m.room != null ? `; last seen in ${m.room}` : ''}`
  : m.room != null ? `stands in room ${m.room}` : 'never seen standing anywhere';

if (import.meta.filename === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'build') {
    const data = await build();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(data, null, 1));
    console.log(`\nwrote ${OUT}`);
    console.log(`${data.merchants.length} merchants ` +
                `(${data.merchants.filter(m => m.seen).length} standing in the world, ` +
                `${data.merchants.filter(m => !m.seen).length} known from the source only)`);
    console.log(`${data.merchants.filter(m => m.sells.length).length} with stock, ` +
                `${data.merchants.filter(m => m.teaches.length).length} teaching spells or skills`);
    console.log(`${data.merchants.filter(m => m.buying_rule).length} with a specific buying rule; ` +
                `${data.merchants.filter(m => m.buys_anything).length} inherit the default (buy anything)`);
    process.exit(0);
  }

  // RE-APPLY THE SOURCE WITHOUT A SERVER. `build` needs the admin socket, which is not
  // up whenever the server is not — and the half of this catalogue that says who a
  // merchant IS, where he walks, and what a skill costs never needed the server at all.
  // So a correction to the reading of the source can reach the file on disk today
  // rather than waiting for the next build.
  if (cmd === 'enrich') {
    const data = loadMerchants();
    const before = data.merchants.reduce((n, m) => n + m.teaches.filter(t => t.kind === 'skill').length, 0);
    enrichCatalogue(data);
    const after = data.merchants.reduce((n, m) => n + m.teaches.filter(t => t.kind === 'skill').length, 0);
    fs.writeFileSync(OUT, JSON.stringify(data, null, 1));
    console.log(`enriched ${OUT}`);
    console.log(`${data.merchants.filter(m => m.name).length} of ${data.merchants.length} merchants named`);
    console.log(`${data.merchants.filter(m => m.wanders).length} wander; ` +
                `${data.merchants.filter(m => m.also?.some(x => x.same_person)).length} are one person under ` +
                `more than one class, ${data.merchants.filter(m => m.also?.length && !m.also.some(x => x.same_person)).length} ` +
                `merely share a name with somebody`);
    console.log(`skills on offer: ${before} -> ${after}`);
    const finite = data.merchants.filter(m => m.finite_stock);
    console.log(`${finite.length} sell from a real pack and can run out, or fill up: ` +
                `${finite.map(m => `${m.name ?? m.cls} (holds ${m.max_for_sale})`).join(', ') || 'none'}`);
    const unsure = data.merchants.filter(m => m.finite_stock_unknown);
    if (unsure.length) console.log(`${unsure.length} could not be resolved either way: ` +
                                   unsure.map(m => m.cls).join(', '));
    process.exit(0);
  }

  const data = loadMerchants();

  if (cmd === 'who-teaches') {
    const q = rest.join(' ').toLowerCase();
    const matches = t => (t.spell || '').includes(q) || (t.skill || '').includes(q) || String(t.num) === q;
    // Stationary first. A wanderer's room is where he WAS, and walking there is a coin
    // toss — worth taking when there is no other seller, and never worth taking first.
    const hits = data.merchants.filter(m => m.teaches.some(matches))
                               .sort((a, b) => (a.wanders ? 1 : 0) - (b.wanders ? 1 : 0));
    console.log(hits.length ? `${hits.length} merchant(s) teach something matching "${q}":` : `nothing matches "${q}"`);
    for (const m of hits) {
      const t = m.teaches.filter(matches);
      const price = t.map(x => x.price).filter(Boolean)[0];
      console.log(`  ${cat(m).padEnd(40)} ${t.map(x => x.spell || x.skill || '#' + x.num).join(', ')}` +
                  `${price ? `  ${price}sh` : ''}${t.some(x => x.from === 'source') ? '  (source, unconfirmed)' : ''}`);
      console.log(`    ${whereabouts(m)}`);
      if (m.also?.length) {
        const still = m.also.filter(x => !x.wanders && x.room != null);
        const same = m.also.some(x => x.same_person);
        console.log(`    ${same ? 'the same man as' : 'shares a name with'} ${m.also.map(x => x.cls).join(', ')}` +
                    `${still.length ? ` — and ${still[0].cls} STANDS STILL in room ${still[0].room}, go there` : ''}`);
      }
    }
    console.log('\nBuying a spell or skill is the same shop transaction as buying an item.');
    console.log('A price is fixed by LEVEL and carries no markup (monster.kod:4880), so it is the ' +
                'same from every teacher.');
    process.exit(0);
  }

  if (cmd === 'who-sells') {
    const q = rest.join(' ').toLowerCase();
    const hits = data.merchants.filter(m => m.sells.some(s => (s.cls || '').toLowerCase().includes(q)));
    console.log(hits.length ? `${hits.length} merchant(s) sell something matching "${q}":` : `nothing matches "${q}"`);
    for (const m of hits) {
      const items = m.sells.filter(s => (s.cls || '').toLowerCase().includes(q));
      console.log(`  ${cat(m).padEnd(38)} ${items.map(i => i.cls + (i.quantity > 1 ? ` x${i.quantity}` : '')).join(', ')}` +
                  `${m.finite_stock ? `  <- FINITE, may be out (holds ${m.max_for_sale})` : ''}`);
    }
    // A merchant that can be out of the thing you walked across the map for is worth
    // saying at the bottom of the list rather than leaving in the JSON.
    const finite = hits.filter(m => m.finite_stock);
    if (finite.length)
      console.log(`\n${finite.length} of those sell from a real pack and CAN BE OUT: ` +
                  `${finite.map(m => m.name ?? m.cls).join(', ')}. Everyone else assembles ` +
                  `the list on demand and cannot run dry — so an empty offer list from them ` +
                  `is a failed read, not an empty shelf.`);
    process.exit(0);
  }

  if (cmd === 'who-buys') {
    const q = rest.join(' ').toLowerCase();
    // The rule is CODE, so this greps the code. It cannot tell "buys gems" from
    // "buys anything except gems" — the Barloque apothecary's rule mentions gems
    // precisely in order to refuse them — so negations are flagged rather than
    // silently counted as matches.
    const hits = data.merchants.filter(m =>
      m.buying_rule ? m.buying_rule.kod.toLowerCase().includes(q) : false);
    console.log(`${hits.length} merchant rule(s) MENTION "${q}" — mentioning is not the same as accepting:`);
    for (const m of hits) {
      const line = m.buying_rule.kod.split(/\r?\n/).find(l => l.toLowerCase().includes(q)) || '';
      const negated = /\bNOT\b/i.test(line);
      console.log(`  ${cat(m).padEnd(36)} ${negated ? 'EXCLUDES it: ' : ''}${line.trim().slice(0, 70)}`);
    }
    const anyone = data.merchants.filter(m => m.buys_anything);
    console.log(`\n${anyone.length} merchant(s) inherit the default ObjectDesired and will consider anything:`);
    for (const m of anyone.slice(0, 12)) console.log(`  ${cat(m)}`);
    console.log('\nThe only certain test is to offer it: sell with confirm:false quotes a price without committing.');
    process.exit(0);
  }

  if (cmd === 'show') {
    const q = rest.join(' ').toLowerCase();
    const m = data.merchants.find(x => x.cls.toLowerCase().includes(q) || String(x.room) === q);
    if (!m) { console.error(`no merchant matches "${q}"`); process.exit(1); }
    console.log(`${m.name ?? m.cls} [${m.cls}]  markup ${m.markup ?? '(default)'}`);
    console.log(whereabouts(m));
    // Loud, and above the stock list, because it changes what the stock list MEANS —
    // for these two it is what he happens to be holding right now, not a menu.
    if (m.finite_stock) console.log(`\nFINITE STOCK — ${m.finite_stock_note}\n`);
    if (m.also?.length) console.log(`${m.also.some(x => x.same_person) ? 'the same man as' : 'shares a name with'} ` +
      m.also.map(x => `${x.cls} (${x.wanders ? 'wanders' : x.room != null ? `room ${x.room}` : 'never seen'})`).join(', ') +
      `\n${m.also_note}`);
    if (m.sells.length) console.log(`sells: ${m.sells.map(s => s.cls + (s.quantity > 1 ? ` x${s.quantity}` : '')).join(', ')}`);
    if (m.teaches.length) console.log(`teaches: ${m.teaches.map(t =>
      `${t.spell || t.skill || '#' + t.num} (${t.kind ?? '?'} ${t.num}` +
      `${t.price ? `, ${t.price}sh` : ''}${t.from === 'source' ? ', unconfirmed' : ''})`).join(', ')}`);
    console.log(m.buying_rule
      ? `\nbuying rule (${m.buying_rule.source}):\n${m.buying_rule.kod}`
      : '\nno ObjectDesired override — inherits the default, which accepts anything');
    process.exit(0);
  }

  console.error('usage: m59-merchants.mjs build | enrich | who-sells <thing> | who-buys <thing> | ' +
                'who-teaches <thing> | show <class|room>');
  process.exit(1);
}
