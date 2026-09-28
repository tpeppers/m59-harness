#!/usr/bin/env node
// Offline: the vault desk (m59-vault-desk.mjs) against a fake broker — parsing what people say, who is
// served where, and whole tickets: a withdrawal at the window, one through the inn, a person's
// deposit through the inn, and the rule that the manager never walks through the main door.
//
//   node tools/m59-vault-desk-test.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVaultRequest, cleanLine, resolveWanted, routeFor, specsFor, VaultDesk, HALL, INN } from './m59-vault-desk.mjs';
import { DEFAULTS, TicketBook } from './m59-vault-broker.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, detail = '') => { if (cond) { passed++; console.log(`  ok   ${what}`); }
  else { failed++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); } };
const section = s => console.log(`\n${s}`);

section('what people say');
{
  const w = parseVaultRequest('100 elders');
  ok('"100 elders" is a withdrawal of 100 elders', w?.kind === 'withdraw' && w.items[0].amount === 100 && w.items[0].name === 'elders');
  const m = parseVaultRequest('withdraw 100 elders, 20 emeralds and a long sword');
  ok('several at once, with "a"', m?.items?.length === 3 && m.items[2].name === 'long sword' && m.items[2].amount === 1, JSON.stringify(m));
  ok('"emerald 5" reads the other way round', parseVaultRequest('emerald 5')?.items?.[0]?.amount === 5);
  ok('"1,000 shillings" is one thousand', parseVaultRequest('1,000 shillings')?.items?.[0]?.amount === 1000);
  ok('deposit', parseVaultRequest('Deposit.')?.kind === 'deposit');
  ok('services / cancel / status', parseVaultRequest('services')?.kind === 'menu'
     && parseVaultRequest('cancel')?.kind === 'cancel' && parseVaultRequest('status')?.kind === 'status');
  ok('chat is not an order', parseVaultRequest('hello there') === null && parseVaultRequest('thanks') === null);
  const c = cleanLine('~B~k[Service Request] ~b 100 elders');
  ok('the operator\'s coloured prefix is recognised and stripped', c.prefixed && c.body === '100 elders', JSON.stringify(c));
}

section('names');
{
  const check = n => (n === 'emeralds' ? { ok: true, canonical: 'emerald' } : n === 'long sord'
    ? { ok: false, suggestions: ['long sword'] } : { ok: false, suggestions: [] });
  ok('elders -> elderberry', resolveWanted('elders', check).item === 'elderberry');
  ok('a plural the datastore knows', resolveWanted('emeralds', check).item === 'emerald');
  ok('one suggestion is taken', resolveWanted('long sord', check).item === 'long sword');
  ok('nothing close is asked about, not guessed', !!resolveWanted('widget', check).why);
}

section('who is served where');
ok('30+ max health: the window', routeFor({ health: '45/45' }) === 'window');
ok('under 30: the inn (the angel keeps them out of the foyer)', routeFor({ health: '24/29' }) === 'inn');
{
  const s = specsFor([{ id: 1, name: 'elderberry', amount: 60 }, { id: 2, name: 'elderberry', amount: 60 },
                      { id: 3, name: 'long sword' }, { id: 4, name: 'long sword' }], 'elderberry', 100);
  ok('stacks split to the amount', s.specs.length === 2 && s.specs[1].amount === 40 && s.short === 0, JSON.stringify(s));
  const w = specsFor([{ id: 3, name: 'long sword' }, { id: 4, name: 'long sword' }], 'long sword', 1);
  ok('a non-stacking item is one id', w.specs.length === 1 && w.specs[0] === 3);
}

// ------------------------------------------------------------------ a fake broker
function world() {
  const W = {
    rows: {
      t3: { agent: 't3', character: 'Statler', health: '60/60', room_num: HALL, where: 'booth', pack: { weight: 10, bulk: 10, max: 2000 } },
      t2: { agent: 't2', character: 'Pepe', health: '55/55', room_num: INN, pack: { weight: 10, bulk: 10, max: 2000 } },
      hk2: { agent: 'hk2', character: 'Marco Polo', health: '25/25', room_num: INN, pack: { weight: 50, bulk: 50, max: 150 } },
      t9: { agent: 't9', character: 'Camilla', health: '70/70', room_num: 2, pack: { weight: 40, bulk: 40, max: 200 } },
      op: { agent: 'op', character: 'Operator Toon', health: '20/20', room_num: INN, pack: { weight: 5, bulk: 5, max: 150 } },
    },
    packs: { t3: [{ id: 30, name: 'elderberry', amount: 30 }, { id: 31, name: 'fairy wing', amount: 10 }], t2: [], hk2: [{ id: 40, name: 'emerald', amount: 25 }],
             t9: [], op: [{ id: 50, name: 'orc tooth', amount: 12 }] },
    chests: { elderberry: 500, emerald: 10 },
    chat: { t3: [], t2: [] }, told: [], walks: [], mainDoor: 0, nextId: 100, trade: null,
  };
  const count = (p, n) => p.filter(o => o.name === n).reduce((a, o) => a + (o.amount || 1), 0);
  const add = (agent, name, n) => { const p = W.packs[agent]; const s = p.find(o => o.name === name);
    if (s) s.amount += n; else p.push({ id: W.nextId++, name, amount: n }); };
  const remove = (agent, name, n) => { const p = W.packs[agent]; let left = n;
    for (const o of p.filter(x => x.name === name)) { const t = Math.min(o.amount || 1, left); o.amount = (o.amount || 1) - t; left -= t; }
    W.packs[agent] = p.filter(o => o.amount > 0); return n - left; };
  const byId = (agent, spec) => W.packs[agent].find(o => o.id === (typeof spec === 'object' ? spec.id : spec));
  W.call = async (tool, a) => {
    switch (tool) {
      case 'fleet': return { fleet: Object.values(W.rows).map(r => ({ ...r })) };
      case 'inventory': return { items: W.packs[a.agent].map(o => ({ ...o })) };
      case 'chat': {
        const lines = W.chat[a.agent].filter(l => l.seq > (a.since ?? 0));
        return { seq: { [a.agent]: Math.max(a.since ?? 0, ...W.chat[a.agent].map(l => l.seq)) }, messages: lines };
      }
      case 'say': W.told.push({ from: a.agent, to: a.to, text: a.text }); return { echoed: a.text };
      case 'hall_post': {
        const r = W.rows[a.agent];
        if (W.stumbles > 0) { W.stumbles--; return { ok: false, why: 'counter door trigger (2,19) not reached' }; }
        if (r.where === 'foyer') return { ok: false, why: 'refused from the foyer: that is the main door' };
        W.walks.push(a.where); r.where = a.where; return { ok: true };
      }
      case 'hall_withdraw': {
        const r = W.rows[a.agent];
        if (r.where === 'foyer') { W.mainDoor++; r.where = 'chests'; }
        if (r.where !== 'chests') return { ok: false, why: 'guild position is outside the known passage' };
        if (Array.isArray(a.stash)) { W.stashedBy = [...(W.stashedBy ?? []), a.agent];
          for (const o of [...W.packs[a.agent]]) if (!a.stash.some(k => o.name.includes(k)) && !(W.protect ?? []).includes(o.name)) {
            W.chests[o.name] = (W.chests[o.name] ?? 0) + (o.amount || 1); W.packs[a.agent] = W.packs[a.agent].filter(x => x !== o); } }
        for (const d of (a.deposit ?? []).filter(d => !d.startsWith('id:'))) for (const o of W.packs[a.agent].filter(x => x.name.includes(d))) {
          W.chests[o.name] = (W.chests[o.name] ?? 0) + (o.amount || 1); W.packs[a.agent] = W.packs[a.agent].filter(x => x !== o); }
        for (const d of a.deposit ?? []) { const o = W.packs[a.agent].find(x => `id:${x.id}` === d);
          if (o) { W.chests[o.name] = (W.chests[o.name] ?? 0) + (o.amount || 1); W.packs[a.agent] = W.packs[a.agent].filter(x => x !== o); } }
        const took = {}, short = {};
        for (const w of a.wants) { const n = Math.min(w.amount, W.chests[w.item] ?? 0); W.chests[w.item] = (W.chests[w.item] ?? 0) - n;
          if (n) { add(a.agent, w.item, n); took[w.item] = n; } if (n < w.amount) short[w.item] = w.amount - n; }
        return { ok: true, took, short };
      }
      case 'travel': W.rows[a.agent].room_num = a.to; W.rows[a.agent].where = a.to === HALL ? 'foyer' : null; W.walks.push(`${a.agent}->${a.to}`); return { arrived: true };
      case 'supply': {
        const from = W.rows[a.from], to = W.rows[a.to];
        if (a.who_travels === 'to') { to.room_num = from.room_num; to.where = null; W.walks.push(`${a.to}->${from.room_num}`); }
        if (from.room_num !== to.room_num) return { ok: false, why: 'not together' };
        for (const spec of a.what) { const o = byId(a.from, spec); if (!o) continue;
          const n = typeof spec === 'object' ? spec.amount : 1; remove(a.from, o.name, n); add(a.to, o.name, n); }
        return { ok: true };
      }
      case 'trade': {
        // The person is 'op'. It counters at once, or offers its orc teeth when asked for a deposit.
        if (a.action === 'offer') { W.trade = { role: 'offerer', withName: a.to, ours: a.what ?? a.items, mayAccept: true, agent: a.agent }; return { offered: true }; }
        if (a.action === 'status') {
          if (!W.trade && W.personOffers && W.rows[a.agent].room_num === W.rows.op.room_num) {
            W.trade = { role: 'recipient', withName: 'Operator Toon', theirs: [{ id: 50, name: 'orc tooth', amount: 12 }], mayAccept: false, agent: a.agent };
            W.personOffers = false;
          }
          return { trade: W.trade };
        }
        if (a.action === 'accept') { for (const spec of W.trade.ours) { const o = byId(a.agent, spec); const n = typeof spec === 'object' ? spec.amount : 1; remove(a.agent, o.name, n); add('op', o.name, n); } W.trade = null; return { accepted: true }; }
        if (a.action === 'counter') { remove('op', 'orc tooth', 12); add(a.agent, 'orc tooth', 12); W.trade = null; return { countered: true }; }
        if (a.action === 'cancel') { W.trade = null; return { cancelled: true }; }
      }
    }
    throw new Error(`fake broker: no ${tool}`);
  };
  W.count = count;
  return W;
}

const dir = mkdtempSync(join(tmpdir(), 'vault-desk-'));
const deskFor = (W, extra = {}) => new VaultDesk({ call: W.call, cfg: { ...DEFAULTS, manager: 't3', go_between: 't2', meet_ms: 50, offer_ms: 200, ...extra },
  book: new TicketBook(join(dir, `t-${Math.random()}.json`)), humans: () => W.humans ?? {}, log: () => {}, sleep: async () => {},
  practice: async ({ agent }) => { W.practised = (W.practised ?? 0) + 1; return { cast: true, agent }; } });

try {
  section('a withdrawal at the window: Camilla (70 HP) in the foyer');
  {
    const W = world();
    W.rows.t3.where = 'booth';
    W.rows.t9.room_num = HALL; W.rows.t9.where = 'foyer';
    const d = deskFor(W);
    W.chat.t3.push({ seq: 1, channel: 'dm', name: 'Camilla', text: '~B~k[Service Request] ~b 100 elders' });
    await d.poll();
    const t = d.book.open()[0];
    ok('filed from her tell', t?.kind === 'withdraw' && t.items[0].item === 'elderberry' && t.items[0].amount === 100, JSON.stringify(t));
    ok('and she is told where to stand', W.told.some(x => x.to === 'Camilla' && /foyer/.test(x.text)));
    const r = await d.turn();
    ok('done', r.worked?.status === 'done', JSON.stringify(r));
    ok('she has 100 elderberry', W.count(W.packs.t9, 'elderberry') === 100);
    ok('the chests gave 100', W.chests.elderberry === 400);
    ok('booth -> chests -> booth', W.walks.join(',') === 'chests,booth', W.walks.join(','));
    ok('the main door never opened', W.mainDoor === 0);
    ok('the manager kept its own practice berries', W.count(W.packs.t3, 'elderberry') === 30);
  }

  section('a withdrawal through the inn: Marco Polo (25 HP)');
  {
    const W = world();
    const d = deskFor(W);
    d.book.request({ kind: 'withdraw', from: 'hk2', items: [{ item: 'elderberry', amount: 60 }] });
    const r = await d.turn();
    ok('done', r.worked?.status === 'done', JSON.stringify(r));
    ok('Marco has 60 elderberry', W.count(W.packs.hk2, 'elderberry') === 60);
    ok('Pepe walked to the foyer and back', W.walks.includes('t2->714') && W.walks.at(-1) !== 't2->714' && W.rows.t2.room_num === INN, W.walks.join(','));
    ok('Pepe carries nothing home', W.count(W.packs.t2, 'elderberry') === 0);
    ok('the main door never opened', W.mainDoor === 0);
  }

  section('more than the manager pack holds: several trips, all of it delivered');
  {
    const W = world();
    W.rows.t3.pack = { weight: 10, bulk: 10, max: 200 };        // 120 free after keep_free: 40 elderberry a trip
    W.rows.t9.room_num = HALL;
    const d = deskFor(W);
    d.book.request({ kind: 'withdraw', from: 't9', items: [{ item: 'elderberry', amount: 100 }] });
    const r = await d.turn();
    ok('done', r.worked?.status === 'done', JSON.stringify(r));
    ok('in three trips (40 + 40 + 20)', W.walks.join(',') === 'chests,booth,chests,booth,chests,booth', W.walks.join(','));
    ok('all 100 arrived', W.count(W.packs.t9, 'elderberry') === 100);
  }

  section('the chests are short: said, not hidden');
  {
    const W = world();
    W.rows.t9.room_num = HALL;
    const d = deskFor(W);
    d.book.request({ kind: 'withdraw', from: 't9', items: [{ item: 'emerald', amount: 25 }] });
    const r = await d.turn();
    ok('closed as short', r.worked?.status === 'short' && /15 emerald/.test(r.worked.note ?? ''), JSON.stringify(r));
    ok('with the 10 there were', W.count(W.packs.t9, 'emerald') === 10);
    ok('and she is told', W.told.some(x => x.to === 'Camilla' && /short 15 emerald/.test(x.text)));
  }

  section('a customer who does not come: the carrier holds it, and hands it over when they do');
  {
    const W = world();
    W.rows.hk2.room_num = 2;
    const d = deskFor(W);
    d.book.request({ kind: 'withdraw', from: 'hk2', items: [{ item: 'elderberry', amount: 20 }] });
    const r = await d.turn();
    ok('waiting, held by the go-between', r.worked?.status === 'waiting' && W.count(W.packs.t2, 'elderberry') === 20, JSON.stringify(r));
    W.rows.hk2.room_num = INN;
    const r2 = await d.turn();
    ok('handed over on arrival', r2.worked?.status === 'done' && W.count(W.packs.hk2, 'elderberry') === 20, JSON.stringify(r2));
  }

  section('a person deposits through the inn');
  {
    const W = world();
    W.humans = { 'operator toon': { character: 'Operator Toon', pid: process.pid, seen_at: Date.now() } };
    W.personOffers = true;
    const d = deskFor(W);
    W.chat.t2.push({ seq: 1, channel: 'dm', name: 'Operator Toon', text: '[Service Request] deposit' });
    await d.poll();
    const r = await d.turn();
    ok('done', r.worked?.status === 'done', JSON.stringify(r));
    ok('the teeth are in the chests', W.chests['orc tooth'] === 12);
    ok('nobody is left carrying them', W.count(W.packs.t2, 'orc tooth') === 0 && W.count(W.packs.t3, 'orc tooth') === 0);
    ok('the main door never opened', W.mainDoor === 0);
  }

  section('a bot deposits at the window, and the manager\'s practice berries survive it');
  {
    const W = world();
    W.rows.t9.room_num = HALL;
    W.packs.t9.push({ id: 60, name: 'elderberry', amount: 40 });
    const d = deskFor(W);
    d.book.request({ kind: 'deposit', from: 't9', items: [{ item: 'elderberry', amount: 40 }] });
    const r = await d.turn();
    ok('done', r.worked?.status === 'done', JSON.stringify(r));
    ok('40 went in', W.chests.elderberry === 540, String(W.chests.elderberry));
    ok('the manager still has its 30 to practise with', W.count(W.packs.t3, 'elderberry') === 30, String(W.count(W.packs.t3, 'elderberry')));
  }

  section('strangers are not served; the idle desk practises');
  {
    const W = world();
    const d = deskFor(W);
    W.chat.t2.push({ seq: 1, channel: 'dm', name: 'Some Stranger', text: '[Service Request] 100 elders' });
    await d.poll();
    ok('no ticket for a stranger', d.book.open().length === 0);
    ok('and no reply either', W.told.length === 0);
    const r = await d.turn();
    ok('nothing to do: one practice cast', r.idle?.cast === true && W.practised === 1);
  }

  section('a walk that stops short inside the hall is tried again');
  {
    const W = world();
    W.rows.t9.room_num = HALL;
    W.stumbles = 2;
    const d = deskFor(W);
    d.book.request({ kind: 'withdraw', from: 't9', items: [{ item: 'elderberry', amount: 10 }] });
    const r = await d.turn();
    ok('done despite two stumbles', r.worked?.status === 'done', JSON.stringify(r));
  }

  section('deskers eat bread: the manager re-draws it; the go-between is sent bread across the window');
  {
    const W = world();
    W.chests['loaf of bread'] = 100;
    const d = deskFor(W, { shift_kit: { t2: { 'loaf of bread': 20 } } });
    d.practice = async ({ agent }) => ({ cast: true, foodRestock: true, agent });
    await d.idle();                                    // the manager: a chest visit
    ok('the manager drew bread', W.count(W.packs.t3, 'loaf of bread') === 10, String(W.count(W.packs.t3, 'loaf of bread')));
    await d.idle();                                    // the go-between: a ticket
    const t = d.book.open()[0];
    ok('a bread ticket for the go-between', t?.from === 'Pepe' && t.items[0].item === 'loaf of bread' && t.items[0].amount === 20, JSON.stringify(t));
    await d.idle();
    ok('only one at a time', d.book.open().length === 1);
    d.practice = async () => ({ cast: true });
    const r = await d.turn();
    ok('served', r.worked?.status === 'done', JSON.stringify(r));
    ok('Pepe has his bread', W.count(W.packs.t2, 'loaf of bread') === 20, String(W.count(W.packs.t2, 'loaf of bread')));
    ok('and is back at the inn', W.rows.t2.room_num === INN);
  }

  section('a standing deposit: the courier in town is noticed, walked to, and his keep list goes in');
  {
    const W = world();
    W.rows.hk2.room_num = 109;                                       // selling at the Sparkling Stone
    W.packs.hk2 = [{ id: 80, name: 'emerald', amount: 25 }, { id: 81, name: 'sapphire', amount: 9 },
                   { id: 82, name: 'meat pie', amount: 3 }, { id: 83, name: 'elderberry', amount: 120 }];
    const d = deskFor(W, { auto_deposit: { hk2: { items: ['emerald', 'sapphire', 'meat pie'], skip: ['meat pie'] } }, town_rooms: [102, 106, 109] });
    const filed = await d.noticeDepositors();
    ok(filed.length === 1 && filed[0].items.length === 2, 'one ticket, his food left out', JSON.stringify(filed));
    ok((await d.noticeDepositors()).length === 0, 'not twice');
    const r = await d.turn();
    ok(r.worked?.status === 'done', 'done', JSON.stringify(r));
    ok(W.chests.emerald === 35 && W.chests.sapphire === 9, 'the gems are in the chests', JSON.stringify(W.chests));
    ok(W.count(W.packs.hk2, 'meat pie') === 3 && W.count(W.packs.hk2, 'elderberry') === 120, 'his food and his carry stock stayed');
    ok(W.walks.includes('t2->109'), 'Pepe walked to him', W.walks.join(','));
    ok(W.rows.t2.room_num === INN && W.mainDoor === 0, 'and went home by the window, the main door shut');
    W.rows.hk2.room_num = 2;
    d.noticedAt = 0;
    W.packs.hk2.push({ id: 84, name: 'diamond', amount: 4 });
    ok((await d.noticeDepositors()).length === 0, 'out of town: nothing filed');
  }

  section('opening the shift from the foyer walks in once, then only the booth');
  {
    const W = world();
    W.rows.t3.where = 'foyer';
    const d = deskFor(W);
    await d.startShift();
    ok('in through the main door once, to the chests', W.mainDoor === 1);
    ok('then to the booth', W.rows.t3.where === 'booth');
    ok('the go-between is at the inn', W.rows.t2.room_num === INN);
    await d.endShift();
    ok('closing leaves nobody in the booth', W.rows.t3.where === 'chests');
  }
  section('shift_stash: both inside empty their packs to the kit; off by default');
  {
    const W = world();
    W.rows.t2.room_num = HALL; W.rows.t2.position = { row: 18, col: 6 }; W.rows.t2.where = 'chests';
    W.packs.t2 = [{ id: 70, name: 'herb', amount: 132 }, { id: 71, name: 'elderberry', amount: 96 }];
    W.packs.t3.push({ id: 72, name: 'herb', amount: 250 }, { id: 73, name: 'shilling', amount: 1784 });
    await deskFor(W).startShift();
    ok('off by default: nothing stashed', !W.stashedBy);
    const W2 = world();
    W2.rows.t2.room_num = HALL; W2.rows.t2.position = { row: 18, col: 6 }; W2.rows.t2.where = 'chests';
    W2.packs.t2 = [{ id: 70, name: 'herb', amount: 132 }, { id: 71, name: 'elderberry', amount: 96 }];
    W2.packs.t3.push({ id: 72, name: 'herb', amount: 250 }, { id: 73, name: 'shilling', amount: 1784 });
    W2.chests.elderberry = 0;
    W2.protect = ['herb', 'elderberry'];                 // the disciples protect their training reagents
    await deskFor(W2, { shift_stash: true, shift_kit: { t2: { elderberry: 60, 'fairy wing': 20 }, t3: { elderberry: 30 } } }).startShift();
    ok('both stashed', W2.stashedBy?.includes('t2') && W2.stashedBy?.includes('t3'), JSON.stringify(W2.stashedBy));
    ok('herbs went in', W2.chests.herb === 382 && W2.count(W2.packs.t3, 'herb') === 0);
    ok('money stayed', W2.count(W2.packs.t3, 'shilling') === 1784);
    ok('each its own kit back', W2.count(W2.packs.t3, 'elderberry') === 30 && W2.count(W2.packs.t2, 'elderberry') === 60,
       `${W2.count(W2.packs.t3, 'elderberry')}/${W2.count(W2.packs.t2, 'elderberry')}`);
    ok('manager at the booth, go-between at the inn', W2.rows.t3.where === 'booth' && W2.rows.t2.room_num === INN);
    ok('the main door never opened', W2.mainDoor === 0);
  }
  section('the manager re-draws practice reagents when it runs out, not the go-between');
  {
    const W = world();
    W.packs.t3 = [];
    const d = deskFor(W);
    d.practice = async ({ agent }) => ({ cast: false, restock: true, agent });
    await d.idle();                                    // the manager's turn
    ok('a chest visit, back at the booth', W.walks.join(',') === 'chests,booth', W.walks.join(','));
    ok('with its practice kit', W.count(W.packs.t3, 'elderberry') === 30);
    await d.idle(); await d.idle();
    ok('the go-between never walks for it, and no second visit inside ten minutes', W.walks.length === 2, W.walks.join(','));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
