#!/usr/bin/env node
// THE BOARDS, WITH TWO GUILD HALLS. Offline: scratch directories, a loopback server on port 0, no
// broker, no fleet, no game.
//
//   node tools/m59-multiguild-boards-test.mjs
//
// The roster can hold several guilds, allied, each with its own hall. A chest is named by its square,
// and "r18c2" is a chest in more than one hall -- so every board that shows chests, a plan or rent has
// to show ONE hall at a time and say which. The failures this pins are all quiet ones:
//
//   * a board that merges two halls' chests ranks one guild's stock against the other guild's plan;
//   * a plan save that guesses its hall is an instruction to every keeper for the wrong chests;
//   * a gate computed with the newest rent reading lets one guild's balance open the other's hall;
//   * and with ONE hall, none of this may show -- the page must look as it always did.
//
// Everything is under a temp dir via M59_STORAGE_DIR / M59_GUILD_PLAN / M59_GUILD_PLANS_DIR (and the
// economy's ledger dirs), set BEFORE the modules are imported, because they read them at load time.
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'm59-multiguild-boards-'));
for (const d of ['storage', 'plans', 'history', 'banks', 'abilities']) mkdirSync(join(root, d), { recursive: true });
process.env.M59_STORAGE_DIR = join(root, 'storage');
process.env.M59_GUILD_PLAN = join(root, 'guild-plan.json');
process.env.M59_GUILD_PLANS_DIR = join(root, 'plans');
process.env.M59_LEDGER_DIR = join(root, 'history');
process.env.M59_BANK_DIR = join(root, 'banks');
process.env.M59_ABILITY_DIR = join(root, 'abilities');

const { StorageCache } = await import('./m59-storage.mjs');
const { GuildRegistry } = await import('./m59-guild-registry.mjs');
const { hallChoices, pickHall, rentForHall } = await import('./m59-hall-select.mjs');
const { renderInventory } = await import('./m59-inventory-page.mjs');
const { createServer } = await import('./m59-compendium.mjs');
const { summarise } = await import('./m59-hall-chests.mjs');

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? `  ${extra}` : ''}`); }
};

const store = new StorageCache();
const registry = new GuildRegistry({ dir: store.dir });
// The chests section only: the page's other text is not under test and may mention anything.
const chestsOf = html => html.slice(html.indexOf('<h2>Guild chests'), html.indexOf('Magic markers'));

console.log('\none hall: nothing new on the page');
{
  store.writeChest('r18c2', { room: 714, items: [{ name: 'elderberry', amount: 40 }], by: 'Kermit', at: 1000 });
  const html = renderInventory({ live: [], characters: new Set() });
  ok('no hall picker with one hall', !/class="halls"/.test(html));
  ok('the heading is the plain one', /<h2>Guild chests<\/h2>/.test(html));
  ok('the Bookmaker\'s sentence still applies to 714', /The Bookmaker's hall builds 3/.test(html));
  ok('its chest is listed', /elderberry/.test(chestsOf(html)));
  const halls = hallChoices({ store, registry });
  ok('one choice', halls.length === 1 && halls[0].room === 714, JSON.stringify(halls.map(h => h.room)));
  ok('and it is the default', pickHall(halls, null).room === 714);
}

console.log('\ntwo halls, two guilds');
{
  registry.recordRoster({ name: 'Guild A', members: [{ name: 'Kermit', rank: 5 }] }, { at: 2000 });
  registry.recordRoster({ name: 'Guild B', members: [{ name: 'Gonzo', rank: 5 }] }, { at: 2001 });
  registry.recordHall(714, 'Guild A');
  registry.recordHall(705, 'Guild B');
  registry.recordAlliance('Guild A', 'Guild B');
  store.writeChest('r18c2', { room: 705, items: [{ name: 'sapphire', amount: 2 }], by: 'Gonzo', at: 3000 });
  // Only Guild B has asked Frular. Guild A's hall must NOT be opened by B's balance.
  store.writeRent({ in_guild: true, due: -500, credit: 500, guild: 'Guild B', by: 'Gonzo', at: 3001 });

  const halls = hallChoices({ store, registry });
  ok('both halls are choices, each with its owner',
     halls.length === 2 && halls.find(h => h.room === 714)?.guild === 'Guild A'
       && halls.find(h => h.room === 705)?.guild === 'Guild B', JSON.stringify(halls));
  ok('with 714 read, the default is 714', pickHall(halls, null).room === 714);
  ok('a named hall is taken', pickHall(halls, '705').room === 705 && pickHall(halls, '705').explicit);
  ok('a room that is not a hall comes back invalid, with the default',
     pickHall(halls, '999').invalid === '999' && pickHall(halls, '999').room === 714);
  ok('rent for 705 is Guild B\'s', rentForHall({ store, registry, room: 705 }).rent?.guild === 'Guild B');
  const a = rentForHall({ store, registry, room: 714 });
  ok('rent for 714 is NOT Guild B\'s — Guild A has none, and says so',
     a.rent == null && /Guild A/.test(a.why ?? ''), JSON.stringify(a));

  const def = renderInventory({ live: [], characters: new Set() });
  ok('the picker appears with two halls', /class="halls"/.test(def));
  ok('it links each hall by room', /href="\?hall=714&amp;hours=168"/.test(def) && /href="\?hall=705&amp;hours=168"/.test(def));
  ok('the default shows 714\'s chest and not 705\'s',
     /elderberry/.test(chestsOf(def)) && !/sapphire/.test(chestsOf(def)));

  const b = renderInventory({ live: [], characters: new Set(), hall: '705' });
  const bc = chestsOf(b);
  ok('?hall=705 shows 705\'s chest and not 714\'s', /sapphire/.test(bc) && !/elderberry/.test(bc));
  ok('it names the hall and its guild', /West Tower Guild Hall/.test(bc) && /Guild B/.test(bc));
  ok('and the guild\'s rent', /rent credit 500/.test(bc), bc.slice(0, 600));
  ok('and marks 705 as the selected tab', /href="\?hall=705&amp;hours=168" class="on"/.test(bc));
  ok('the Bookmaker\'s-only sentence is not said of another hall', !/The Bookmaker's hall builds/.test(bc));

  const bad = renderInventory({ live: [], characters: new Set(), hall: 'nonsense' });
  ok('a bad ?hall falls back to the default and says so',
     /elderberry/.test(chestsOf(bad)) && /is not a guild hall room/.test(bad));
}

console.log('\nthe compendium planner: GET and POST /_guildplan');
{
  const server = createServer({ access: 'local' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = q => fetch(`${base}/_guildplan${q}`).then(async r => ({ status: r.status, j: await r.json() }));
  const post = (q, body) => fetch(`${base}/_guildplan${q}`, { method: 'POST', body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, j: await r.json() }));
  try {
    const d = await get('');
    ok('no hall: the default (714), and the list of halls',
       d.status === 200 && d.j.hall === 714 && d.j.halls?.length === 2, JSON.stringify(d.j).slice(0, 300));
    ok('714 is not available: its owner has no rent reading', d.j.available === false && /Guild A/.test(d.j.why ?? ''));
    const g = await get('?hall=705');
    ok('?hall=705: that hall, its guild, only its chests',
       g.j.hall === 705 && g.j.guild === 'Guild B' && g.j.chests.length === 1
         && g.j.chests[0].chest_id === '705/r18c2' && g.j.available === true, JSON.stringify(g.j).slice(0, 400));
    ok('a bad hall on a GET is a 400', (await get('?hall=12')).status === 400);

    const plan = { chests: { r18c2: { items: [{ item: 'sapphire', target: 5 }] } } };
    ok('a POST that names no hall is refused when there are two', (await post('', plan)).status === 400);
    ok('a POST naming a room that is not a hall is refused', (await post('', { ...plan, hall: 'abc' })).status === 400);
    ok('a POST to 714 is refused by ITS gate, not let through by 705\'s rent',
       (await post('?hall=714', plan)).status === 409);
    const p = await post('', { ...plan, hall: 705 });
    ok('a POST with a hall field saves', p.status === 200 && p.j.hall === 705, JSON.stringify(p.j));
    const file = join(root, 'plans', '705.json');
    const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    ok('...to that hall\'s plan file', saved?.chests?.r18c2?.items?.[0]?.item === 'sapphire');
    ok('...without the request\'s `hall` field in it', saved && !('hall' in saved));
    ok('...and 714\'s plan is untouched', !existsSync(join(root, 'guild-plan.json')));
    const g2 = await get('?hall=705');
    ok('reading it back: the plan and the shortfall are that hall\'s',
       g2.j.plan?.r18c2?.[0]?.item === 'sapphire'
         && g2.j.shortfall?.some(s => s.item === 'sapphire' && s.short === 3), JSON.stringify(g2.j.shortfall));
  } finally { await new Promise(r => server.close(r)); }
}

console.log('\na hall with only a plan is still a choice');
{
  writeFileSync(join(root, 'plans', '711.json'), JSON.stringify({ chests: {} }));
  const halls = hallChoices({ store, registry });
  ok('711 is listed because a plan for it exists', halls.some(h => h.room === 711 && h.has_plan), JSON.stringify(halls));
}

console.log('\nm59-hall-chests: each chest says its hall and guild');
{
  const rows = summarise(store.allChests(), { owners: room => registry.ownerOfHall(room) });
  ok('both halls\' r18c2 are listed, told apart by chest_id',
     rows.map(r => r.chest_id).sort().join(',') === '705/r18c2,714/r18c2', JSON.stringify(rows.map(r => r.chest_id)));
  ok('each carries its owner', rows.find(r => r.room === 705)?.guild === 'Guild B' && rows.find(r => r.room === 714)?.guild === 'Guild A');
  const one = summarise(store.allChests({ room: 705 }), {});
  ok('one hall\'s readings only, as --hall asks', one.length === 1 && one[0].room === 705 && one[0].guild === null);
}

console.log('\nthe economy board: one rent per guild');
{
  const { renderEconomy } = await import('./m59-economy-page.mjs');
  const one = renderEconomy({ hours: 6 });
  ok('one guild\'s rent renders as it always did, with no per-guild heading',
     /rent credit/.test(one) && !/<h4[^>]*>Guild B/.test(one));
  store.writeRent({ in_guild: true, due: 250, credit: -250, guild: 'Guild A', by: 'Kermit', at: 4000 });
  const two = renderEconomy({ hours: 6 });
  ok('two guilds: a block each, headed by the guild', /<h4[^>]*>Guild A/.test(two) && /<h4[^>]*>Guild B/.test(two));
  ok('each linking its own hall\'s chests', /href="\/inventory\?hall=714"/.test(two) && /href="\/inventory\?hall=705"/.test(two));
  ok('and neither balance hides the other', /rent owed/.test(two) && /rent credit/.test(two));
}

console.log('\nthe fleet\'s three halls: 714, 713 and 703 (the Den of Shadows)');
{
  // The roster's own three guilds and halls: Second Swines in 714, Rowlfs of War in 713, Rizzo's
  // Revenge in 703. 703's two chests are r26c9 and r29c9 (guildh3.kod CreateStandardObjects).
  registry.recordHall(713, 'Rowlfs of War');
  registry.recordHall(703, "Rizzo's Revenge");
  store.writeChest('r26c9', { room: 703, items: [{ name: 'mushroom', amount: 22 }], by: 'Rizzo', at: 5000 });
  store.writeChest('r29c9', { room: 703, items: [{ name: 'garnet', amount: 4 }], by: 'Rizzo', at: 5000 });
  store.writeChest('r12c24', { room: 713, items: [{ name: 'orc tooth', amount: 9 }], by: 'Gonzo', at: 5000 });
  const halls = hallChoices({ store, registry });
  ok('703 is a choice, with its guild and two chests',
     halls.some(h => h.room === 703 && h.guild === "Rizzo's Revenge" && h.chests === 2), JSON.stringify(halls.find(h => h.room === 703)));
  ok('...named the Den of Shadows', halls.find(h => h.room === 703)?.name === 'The Den of Shadows');
  ok('713 is a choice too, and the list is sorted by room',
     halls.some(h => h.room === 713) && halls.map(h => h.room).join(',') === [...halls.map(h => h.room)].sort((a, b) => a - b).join(','),
     halls.map(h => h.room).join(','));
  ok('714 is still the default', pickHall(halls, null).room === 714);
  ok('?hall=703 is taken', pickHall(halls, '703').room === 703 && pickHall(halls, '703').explicit);
  const page = renderInventory({ live: [], characters: new Set(), hall: '703' });
  const pc = chestsOf(page);
  ok("?hall=703 shows 703's chests and nobody else's", /garnet/.test(pc) && /mushroom/.test(pc) && !/sapphire/.test(pc) && !/elderberry/.test(pc));
  ok('and marks 703 as the selected tab', /href="\?hall=703&amp;hours=168" class="on"/.test(page));
  const rows = summarise(store.allChests({ room: 703 }), { owners: room => registry.ownerOfHall(room) });
  ok("m59-hall-chests files them as 703's, Rizzo's Revenge's",
     rows.map(r => r.chest_id).sort().join(',') === '703/r26c9,703/r29c9' && rows.every(r => r.guild === "Rizzo's Revenge"),
     JSON.stringify(rows.map(r => [r.chest_id, r.guild])));
}

try { rmSync(root, { recursive: true, force: true }); } catch { /* a scratch dir left behind is harmless */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
