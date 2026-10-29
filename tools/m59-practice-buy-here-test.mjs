#!/usr/bin/env node
// PRACTICE BUYS ITS REAGENTS IN THE ROOM IT STANDS IN (practice_spells.buy_here) -- offline, no socket, no roster.
//
//   node tools/m59-practice-buy-here-test.mjs
//
// Operator, 2026-10-29: "train Bless (until it's 99), using the shillings he has to buy reagents as needed ... a new 'buy
// reagents in the room you're in while you train' feature ... should be a standard feature". What this pins:
//   * buy_here is off by default; true is the defaults; bad keys are reported and the broker would refuse them;
//   * a reagent is counted EXACTLY: "mushroom" is not "blue mushroom" (Bless wants the plain one), teeth are a tooth;
//   * only spells it knows, below 99 and not set aside, and only reagents short NOW, each topped up to `casts` casts' worth
//     plus what is kept;
//   * the keeper asks only the counters in this room, buys within the purse above keep_shillings, counts what entered the
//     pack, names what nobody here sells, and asks again no sooner than every_ms.
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};
const D = await import('./m59-deskpractice.mjs');
const A = await import('./m59-autopilot.mjs');
const { OF } = await import('./m59-parse.mjs');

console.log('the setting');
{
  ok('off by default', D.PRACTICE_DEFAULTS.buy_here === null && D.normalizePractice({ spells: ['bless'] }).buy_here === null);
  const t = D.normalizePractice({ spells: ['bless'], buy_here: true });
  ok('true is the defaults (10 casts, keep 0, 60 s)', t.buy_here.casts === 10 && t.buy_here.keep_shillings === 0 && t.buy_here.every_ms === 60_000 && !t.problems.length);
  const o = D.normalizePractice({ spells: ['bless'], buy_here: { casts: 20, keep_shillings: 500, say: ['sapphires'] } });
  ok('an object is read', o.buy_here.casts === 20 && o.buy_here.keep_shillings === 500 && o.buy_here.say.join() === 'sapphires');
  const bad = D.normalizePractice({ spells: ['bless'], buy_here: { casts: 0, walk: true } });
  ok('bad values are reported (so the broker refuses them)', bad.problems.some(p => /buy_here\.casts/.test(p)) && bad.problems.some(p => /buy_here\.walk/.test(p)));
  ok('{enabled:false} is off', D.normalizePractice({ spells: ['bless'], buy_here: { enabled: false } }).buy_here === null);
}

console.log('a reagent by its exact name');
{
  ok('mushroom is mushroom(s)', D.isReagent('mushroom', 'mushroom') && D.isReagent('Mushrooms', 'mushroom'));
  ok('a blue mushroom is not a mushroom', !D.isReagent('blue mushroom', 'mushroom'));
  ok('sapphires, herbs, elderberries, orc teeth', D.isReagent('sapphires', 'sapphire') && D.isReagent('herbs', 'herb')
     && D.isReagent('elderberries', 'elderberry') && D.isReagent('orc teeth', 'orc tooth'));
}

console.log('what to buy');
{
  const practice = D.normalizePractice({ spells: ['bless', 'blink'], buy_here: true });
  const pack = { mushroom: 1, sapphire: 0 };
  const w = D.buyHereWants({ practice, spells: [{ name: 'bless', ability: 61 }, { name: 'blink', ability: 23 }],
    exact: i => pack[i] ?? 0, reserve: { reagents: {} } });
  ok('bless short of both: each topped up to 20', w.wants.get('mushroom') === 19 && w.wants.get('sapphire') === 20, JSON.stringify([...w.wants]));
  ok('blink takes no reagents: nothing for it', [...w.for.values()].flat().every(n => n === 'bless'));
  const enough = D.buyHereWants({ practice, spells: [{ name: 'bless', ability: 61 }], exact: () => 2, reserve: { reagents: {} } });
  ok('one cast on hand of each: nothing to buy yet', enough.wants.size === 0);
  const half = D.buyHereWants({ practice, spells: [{ name: 'bless', ability: 61 }], exact: i => (i === 'mushroom' ? 9 : 1), reserve: { reagents: {} } });
  ok('only the SHORT reagent is bought', half.wants.size === 1 && half.wants.get('sapphire') === 19);
  ok('a spell at 99 buys nothing', D.buyHereWants({ practice, spells: [{ name: 'bless', ability: 99 }], exact: () => 0 }).wants.size === 0);
  ok('an unknown spell buys nothing', D.buyHereWants({ practice, spells: [], exact: () => 0 }).wants.size === 0);
  ok('a spell set aside buys nothing', D.buyHereWants({ practice, spells: [{ name: 'bless', ability: 61 }], exact: () => 0,
    refusedUntil: new Map([['bless', 10]]), now: 5 }).wants.size === 0);
  const kept = D.normalizePractice({ spells: ['bless'], buy_here: true, keep: { sapphire: 4 } });
  ok('what is kept is bought on top', D.buyHereWants({ practice: kept, spells: [{ name: 'bless', ability: 61 }], exact: () => 0 }).wants.get('sapphire') === 24);
}

console.log('the keeper at the counter');
function keeper({ purse = 100, stock = [{ name: 'mushroom', cost: 10 }], pack = [] } = {}) {
  const inv = [{ id: 1, nameRsc: 'shilling', amount: purse }, ...pack.map((p, i) => ({ id: 10 + i, nameRsc: p.name, amount: p.amount }))];
  const said = [], asked = [];
  const rows = stock.map((r, i) => ({ id: 100 + i, ...r }));
  let seq = 0;
  const c = {
    inventory: inv, rsc: { get: x => x }, evSeq: 0, said,
    room: { objects: new Map([[5, { id: 5, flags: OF.BUYABLE, nameRsc: 'Frisconar' }], [6, { id: 6, flags: 0, nameRsc: 'a torch' }]]) },
    say: w => said.push(w), buy: id => { asked.push(id); c.evSeq = ++seq; },
    waitFor: async ({ kinds }) => ({ events: kinds.includes('shop') ? [{ kind: 'shop', sellerId: 5, items: rows }] : [] }),
    requestInventory: () => { c.evSeq = ++seq; },
    buyItems: (seller, [line]) => {
      const row = rows.find(r => r.id === line.id);
      const money = inv.find(i => i.nameRsc === 'shilling');
      const n = Math.min(line.amount, Math.floor(money.amount / row.cost));
      money.amount -= n * row.cost;
      const have = inv.find(i => i.nameRsc === row.name);
      if (have) have.amount += n; else inv.push({ id: 900 + inv.length, nameRsc: row.name, amount: n });
    },
  };
  const k = Object.create(A.Autopilot.prototype);
  Object.assign(k, { notes: [], asked, policy: {}, s: { need: () => c, client: c, pacer: { submit: async (_, f) => f() } } });
  k.note = function (m, d) { this.notes.push({ m, d }); };
  k.hereRoom = () => 53;
  k.travelInterrupted = () => false;
  k.recordPurchase = () => {};
  return k;
}
{
  const cfg = D.normalizePractice({ spells: ['bless'], buy_here: true });
  const spells = [{ name: 'bless', ability: 61 }];
  const k = keeper({ purse: 100, pack: [{ name: 'blue mushroom', amount: 30 }] });
  const used = await k.practiceBuyHere(cfg, spells, { reagents: {} }, 1_000_000);
  ok('it asked the counter in this room (not the torch)', used === true && k.asked.join() === '5');
  ok('bought mushrooms within the purse: 10 at 10 each', k.reagentExact('mushroom') === 10 && k.purseNow() === 0, JSON.stringify(k.practiceBuyState));
  ok('the blue mushrooms were never counted as the plain ones', k.practiceBuyState.bought.mushroom === 10);
  ok('sapphires are named as not sold here', k.practiceBuyState.not_sold_here.includes('sapphire'));
  ok('it says so', k.notes.some(n => /bought reagents in this room/.test(n.m)));
  ok('and does not ask again inside every_ms', await k.practiceBuyHere(cfg, spells, { reagents: {} }, 1_000_000 + 30_000) === false && k.asked.length === 1);

  const rich = keeper({ purse: 5000, stock: [{ name: 'mushroom', cost: 10 }, { name: 'sapphire', cost: 120 }] });
  const cfg2 = D.normalizePractice({ spells: ['bless'], buy_here: { casts: 10, keep_shillings: 2000, say: ['sapphires'] } });
  await rich.practiceBuyHere(cfg2, spells, { reagents: {} }, 1);
  ok('the words are said first', rich.s.client.said.join() === 'sapphires');
  ok('keep_shillings is never spent', rich.purseNow() >= 2000, `purse ${rich.purseNow()}`);
  ok('both reagents bought toward 10 casts', rich.reagentExact('mushroom') === 20 && rich.reagentExact('sapphire') > 0, JSON.stringify(rich.practiceBuyState.bought));

  const none = keeper({ purse: 100 });
  none.s.client.room.objects = new Map();
  ok('nobody to buy from: the pass is handed back', await none.practiceBuyHere(cfg, spells, { reagents: {} }, 1) === false);
}

console.log('the drill buys before it chooses, and the broker carries the key');
{
  const { readToolSource } = await import('./autopilot/source.mjs');
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const at = src.indexOf('  async practiceAtDesk(');
  const body = src.slice(at, src.indexOf('\n  }\n', at));
  ok('practiceAtDesk buys (outside a session) before choosePractice', body.indexOf('practiceBuyHere(') > 0
     && body.indexOf('practiceBuyHere(') < body.indexOf('choosePractice(') && /!session && cfg\.buy_here/.test(body));
  const broker = (await import('node:fs')).readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  ok('the broker schema names buy_here', /buy_here: \{ type: \['object', 'boolean', 'null'\]/.test(broker));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
