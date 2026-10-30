#!/usr/bin/env node
// WHAT THIS PINS: the fast shadow clone's decisions, and the logoff it depends on.
//
//   node tools/m59-shadow-clone-test.mjs
//
// Offline. No socket, no roster, no broker, no lab. Each case below is something that went
// wrong on the first live runs of m59-shadow-clone.mjs on 2026-10-29:
//
//   - a prod keeper's /state carries stat group 2 AFTER gear (Clifford: might 53, cap 50), so
//     base attributes have to come from the sheet when there is one;
//   - rarity arrives as a number and the item planner wants the name ("unidentified");
//   - an unidentified wand is told apart only by its palette translation, which is kept;
//   - the keeper said `in_game: false` after /leave while the server still held the body,
//     because M59Client had no close() and every caller swallowed the TypeError;
//   - seven roster passwords no longer matched the lab and read as a slow login.
import { createHash } from 'node:crypto';
import { recordFromState, bodyCmds, factionCmds, credentialMismatches, refusals,
         translateOrders, passwordSlotsToFix, SHADOW_PASSWORD } from './m59-shadow-clone.mjs';
import { M59Client } from './m59-client.mjs';
import { iconHoldingClass } from './m59-shadow-fidelity.mjs';

let passed = 0, failed = 0;
const ok = (cond, what) => { if (cond) { passed++; console.log(`  ok   ${what}`); }
                             else { failed++; console.log(`  FAIL ${what}`); } };

const state = {
  agent: 't15', character: 'Clifford', in_game: true,
  attributes: { might: 53, intellect: 10, stamina: 50, agility: 45, mysticism: 15, aim: 33, karma: -44 },
  hp: { value: 100, max: 114 }, mana: { value: 20, max: 23 }, vigor: { value: 110 },
  room: { name: 'The Remote Trading Post', num: 2101, object_id: 1032 },
  you: { col: 12, row: 13, x: 827, y: 884 },
  equipment_items: [{ name: 'nerudite sword', id: 10877 }, { name: 'shield of the rebel militia', id: 9684 }],
  items: [
    { name: 'shield of the rebel militia', amount: 0, rarity: 0, icon_rsc: 29507, translation: 135 },
    { name: 'wand', amount: 0, rarity: 100, icon_rsc: 30513, translation: 223 },
    { name: 'shilling', amount: 5540, rarity: 0, icon_rsc: 29665, translation: 0 },
  ],
  skills: [{ name: 'slash' }, { name: 'parry' }], spells: [{ name: 'blink' }],
};
const sheet = { captured_at_iso: '2026-09-10T00:00:00Z',
  attributes: { might: 45, intellect: 10, stamina: 50, agility: 45, mysticism: 15, aim: 35 } };
const book = { read_at: { skills: 5, spells: 7 },
  skills: { slash: { ability: 99 }, parry: { ability: null } }, spells: { blink: { ability: 40 } } };

console.log('\nexport: a keeper snapshot becomes a snapshot record');
const r = recordFromState(state, { sheet, book, faction: { faction: 'rebel', soldier: true, observed_at: 9 } });
ok(r.attributes.might === 45 && r.attributes.aim === 35, 'base attributes come from the sheet, not the geared stat group');
ok(r.attributes_from.startsWith('sheet'), 'and the record says where they came from');
ok(recordFromState(state).attributes.might === 53, 'with no sheet the keeper numbers are used (and say so)');
ok(r.karma === -44 && r.max_health === 114 && r.health === 100 && r.mana === 20 && r.vigor === 110, 'karma and vitals carried');
ok(r.room === 2101 && r.row === 13 && r.col === 12, 'room NUMBER and square, never the object id');
ok(r.initialFine?.x === 827 && r.initialFine?.y === 884, 'fine position kept when it agrees with the square');
ok(!recordFromState({ ...state, you: { col: 12, row: 13, x: 5, y: 5 } }).initialFine, 'and dropped when it does not');
ok(r.inventory.find(x => x.name === 'wand')?.rarity === 'unidentified', 'numeric rarity becomes its name');
ok(r.inventory.find(x => x.name === 'wand')?.translation === 223, 'a wand keeps its palette translation');
ok(r.inventory.find(x => x.name === 'shield of the rebel militia')?.translation == null, 'other items do not');
ok(!('rarity' in r.inventory.find(x => x.name === 'shilling')), 'normal grade is not written');
ok(r.purse === 5540, 'purse summed from the pack');
ok(r.equipment.join('|') === 'nerudite sword|shield of the rebel militia', 'worn names from equipment_items');
ok(r.abilities.skills.length === 1 && r.abilities.skills[0].ability === 99, 'abilities with a number are copied');
ok(r.abilities_unnumbered.join() === 'parry', 'a known ability with no number is NAMED, not zeroed');
ok(r.faction.faction === 'rebel' && r.faction.soldier === true, 'faction carried from the cache');
ok(recordFromState(state, { faction: { faction: 'unknown' } }).faction === null, 'an unknown faction is not invented');

console.log('\nunidentified items by icon');
{
  const icons = { 30434: { class: 'DiscordScroll', chain: ['DiscordScroll', 'Scroll', 'Item'] },
                  30298: { class: 'Potion', chain: ['Potion', 'SpellItem', 'Item'] } };
  const classOf = id => icons[id] ?? null;
  const subclasses = cls => (cls === 'Potion' ? 29 : 0);
  const rec = recordFromState({ ...state, items: [{ name: 'scroll', amount: 0, rarity: 100, icon_rsc: 30434 },
                                                  { name: 'long sword', amount: 0, rarity: 0, icon_rsc: 29999 }] });
  ok(rec.inventory[0].icon_rsc === 30434, 'a bare scroll keeps its icon resource id');
  ok(rec.inventory[1].icon_rsc == null, 'a named item does not need one');
  const scroll = iconHoldingClass({ name: 'scroll', icon_rsc: 30434 }, { classOf, subclasses });
  ok(scroll.ok && scroll.class === 'DiscordScroll' && scroll.stack === false, 'a leaf class icon names the scroll exactly');
  const potion = iconHoldingClass({ name: 'potion', icon_rsc: 30298 }, { classOf, subclasses });
  ok(potion && !potion.ok && /29 subclasses/.test(potion.why), 'a base-class icon is shared by its subclasses and refused, not guessed');
  ok(iconHoldingClass({ name: 'scroll of discord', icon_rsc: 30434 }, { classOf, subclasses }) === null,
     'an identified item is resolved by its own name, not its icon');
  ok(iconHoldingClass({ name: 'scroll', icon_rsc: 1 }, { classOf, subclasses }) === null, 'an icon nobody owns resolves nothing');
}

console.log('\ndress: commands');
const cmds = bodyCmds(7232, { attributes: sheet.attributes, max_health: 114, health: 100, karma: -44, vigor: 110, mana: 20 });
ok(cmds.includes('set object 7232 piMight INT 45'), 'attributes written');
ok(['piHealth', 'piMax_Health', 'piBase_Max_Health'].every(p => cmds.includes(`set object 7232 ${p} INT 114`)), 'all three health properties carry the level');
ok(cmds.indexOf('set object 7232 piHealth INT 100') > cmds.indexOf('set object 7232 piBase_Max_Health INT 114'), 'then health down to prod\'s current');
ok(cmds.includes('set object 7232 piKarma INT -4400'), 'karma in hundredths');
ok(cmds.includes('send object 7232 NewVigor') && cmds.includes('set object 7232 piExertion INT 0'), 'vigor with exertion reset');
ok(bodyCmds(1, { max_health: 50, health: 50 }).filter(c => c === 'set object 1 piHealth INT 50').length === 1,
   'full health needs no second write');
ok(factionCmds(7232, 99, { faction: 'duke' }).join('|') ===
   'send object 7232 ResetFaction faction INT 1|send object 99 MoveToFaction who OBJECT 7232 faction INT 1',
   'faction through ResetFaction and the Parliament list, never JoinFaction');
ok(factionCmds(7232, 99, null).length === 0, 'no faction recorded, nothing sent');

console.log('\ncredentials against the lab save');
const md5 = s => createHash('md5').update(s).digest('hex');
const accounts = `ACCOUNT 63:shadow04:${md5('right')}:0:1:2:0\nACCOUNT 64:shadow05:${md5('also')}:0:1:2:0\n`;
const roster = { shadow04: { credentials: { account: 'shadow04', password: 'wrong' } },
                 shadow05: { credentials: { account: 'shadow05', password: 'also' } },
                 shadow06: { credentials: { account: 'shadow06', password: 'unsaved' } } };
const bad = credentialMismatches(roster, accounts);
ok(bad.join() === 'shadow04', 'a password the lab does not hold is named');
ok(!bad.includes('shadow06'), 'an account the save does not contain yet is not called wrong');

console.log('\nrefusals');
const base = { fleet: 'shadow', gameHost: '127.0.0.1', gamePort: 15959, adminHost: '127.0.0.1',
               roster: 'C:/x/substrate/fleets/shadow.json', httpPort: 8971 };
ok(refusals(base).length === 0, 'the lab shadow fleet is allowed');
ok(refusals({ ...base, fleet: 'prod' }).length > 0, 'prod is refused');
ok(refusals({ ...base, roster: 'C:/x/substrate/fleets/prod.json' }).length > 0, 'a non-shadow roster is refused');
ok(refusals({ ...base, gameHost: '76.214.42.186' }).length > 0, 'a remote game server is refused');
ok(refusals({ ...base, gamePort: 5959 }).length > 0, 'port 5959 is refused');
ok(refusals({ ...base, httpPort: 8901 }).length > 0, 'the production broker port is refused');

console.log('\nprod orders, translated');
{
  const names = new Map([['t1', 'shadow06'], ['Kermit', 'Ffff'], ['hk3', 'shadow24']]);
  const o = translateOrders({ mode: 'farm', policy: { buddy: 'Kermit', hunt: 'troll', deliverTo: ['hk3', 'Kermitt'],
                                                      perAgent: { t1: { room: 38 } } } }, names);
  ok(o.policy.buddy === 'Ffff', 'a prod character named in an order becomes its clone');
  ok(o.policy.deliverTo.join() === 'shadow24,Kermitt', 'agents too, inside lists — and only whole strings');
  ok(o.policy.perAgent.shadow06?.room === 38, 'a key that names an agent is translated');
  ok(o.policy.hunt === 'troll' && o.mode === 'farm', 'everything else is left exactly');
}

console.log('\nthe fixed shadow password');
{
  const md5s = s => createHash('md5').update(s).digest('hex');
  const r = { a: { credentials: { account: 'shadow01', password: SHADOW_PASSWORD } },
              b: { credentials: { account: 'shadow02', password: 'random' } },
              c: { credentials: { account: 'shadow03', password: SHADOW_PASSWORD } } };
  const acc = `ACCOUNT 1:shadow01:${md5s('shadow')}:0:1:2:0\nACCOUNT 3:shadow03:${md5s('old')}:0:1:2:0\n`;
  ok(SHADOW_PASSWORD === 'shadow', 'the password is "shadow"');
  ok(passwordSlotsToFix(r, acc).join() === 'b,c', 'a roster off the password, and a server off it, both need the switch');
  ok(passwordSlotsToFix({ a: r.a }, acc).length === 0, 'a slot already on it needs nothing');
}

console.log('\nM59Client.close() logs off');
{
  const c = new M59Client({ host: '127.0.0.1', port: 1, verbose: false });
  let destroyed = 0;
  c.sock = { destroyed: false, destroy() { destroyed++; this.destroyed = true; } };
  c.state = 'game';
  ok(typeof c.close === 'function', 'the method exists (it did not, and every caller swallowed the TypeError)');
  c.close();
  ok(destroyed === 1, 'a direct connection is dropped, which is how blakserv logs a user off');
  c.close();
  ok(destroyed === 1, 'closing twice does nothing more');
}
{
  const c = new M59Client({ host: '127.0.0.1', port: 1, verbose: false });
  const order = [];
  c.attach = true; c.state = 'game';
  c.sock = { destroyed: false, write(_b, cb) { order.push('quit'); cb?.(); }, destroy() { order.push('destroy'); this.destroyed = true; } };
  c.close();
  await new Promise(r => setTimeout(r, 20));
  ok(order.join() === 'quit,destroy', 'an attached socket asks the proxy to quit before it is dropped');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
