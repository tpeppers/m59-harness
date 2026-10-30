// Offline guard for the PvP reagent reserve (tools/m59-reagent-reserve.mjs) and its hook in client.cast. No socket,
// no roster: the reserve file lives in a temp directory.
//
//   node tools/m59-reagent-reserve-test.mjs
//
// FIRST: no file, no reserve, nothing refused. Then floors from the kod's own costs, counted only for spells the
// character knows; exact pack names (a stack of red mushrooms is not plain mushrooms); a farming cast refused at the
// floor and the SAME cast allowed inside a PvP fight; and the refusal really keeps the packet off the wire.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-reserve-'));
process.env.M59_REAGENT_RESERVE_FILE = join(dir, 'reserve.json');
const R = await import('./m59-reagent-reserve.mjs');
const { M59Client } = await import('./m59-client.mjs');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok ${name}`); };
let clock = 1_000_000;
const write = book => { writeFileSync(process.env.M59_REAGENT_RESERVE_FILE, JSON.stringify(book)); clock += 5000; };

try {
  test('no file: no reserve, nothing refused', () => {
    assert.equal(R.resolveReserve(R.readReserve(process.env.M59_REAGENT_RESERVE_FILE, clock), { agent: 't8' }), null);
  });

  test('floors come from the kod costs, only for spells this character knows', () => {
    const reserve = R.resolveReserve({ default: { spells: { bless: 4, 'magic shield': 3, deflect: 5 } } }, { agent: 't9' });
    const f = R.floorsFor(reserve, ['bless', 'magic shield']);
    assert.equal(f.get('sapphire'), 8, 'bless: 2 sapphires x 4');
    assert.equal(f.get('mushroom'), 8 + 6, 'bless 2x4 + magic shield 2x3');
    assert.equal(f.get('red mushroom'), 3);
    assert.equal(f.has('kriipa claw'), false, 'deflect is not known: nothing reserved for it');
  });

  test('most specific wins, and null switches a character off', () => {
    const book = { default: { spells: { bless: 4 } }, agents: { t8: { spells: { bless: 1, deflect: 8 } } }, characters: { Zoot: null } };
    assert.deepEqual(R.resolveReserve(book, { agent: 't8', character: 'Robin' }).spells, { bless: 1, deflect: 8 });
    assert.equal(R.resolveReserve(book, { agent: 't17', character: 'Zoot' }), null);
  });

  test('pack names fold exactly: red mushrooms are not plain mushrooms; vials of solagh are solagh', () => {
    const pack = [{ name: 'red mushroom', amount: 60 }, { name: 'mushroom', amount: 3 }, { name: 'vials of solagh', amount: 4 }];
    assert.equal(R.countReagent(pack, 'mushroom'), 3);
    assert.equal(R.countReagent(pack, 'solagh'), 4);
  });

  test('a farming cast at the floor is refused; the same cast in a PvP fight is not', () => {
    const reserve = R.resolveReserve({ default: { spells: { bless: 4 } } }, {});
    const pack = [{ name: 'sapphire', amount: 9 }, { name: 'mushroom', amount: 20 }];
    // Discordance costs 2 sapphires: 9 - 2 = 7 < 8 reserved for bless.
    assert.deepEqual(R.reserveBreach({ spell: 'discordance', known: ['bless', 'discordance'], pack, reserve }),
      { spell: 'discordance', reagent: 'sapphire', have: 9, need: 2, floor: 8 });
    assert.equal(R.reserveBreach({ spell: 'discordance', known: ['bless', 'discordance'], pack, reserve, inPvp: true }), null);
    assert.equal(R.reserveBreach({ spell: 'discordance', known: ['bless', 'discordance'], pack: [{ name: 'sapphire', amount: 10 }], reserve }), null, 'free sapphires above the floor are spendable');
    assert.ok(R.reserveBreach({ spell: 'bless', known: ['bless'], pack: [{ name: 'sapphire', amount: 8 }, { name: 'mushroom', amount: 20 }], reserve }),
      'practising the reserved spell itself spends the reserve too');
  });

  test('client.cast: a vetoed cast never reaches the wire, and nobody named means no veto', () => {
    write({ default: { spells: { bless: 4 } } });
    const sent = [];
    const c = Object.create(M59Client.prototype);
    Object.assign(c, { send: (...a) => sent.push(a), spells: [{ id: 70, name: 'discordance' }, { id: 71, name: 'bless' }],
      inventory: [{ id: 1, name: 'sapphire', amount: 9 }, { id: 2, name: 'mushroom', amount: 20 }], rsc: new Map() });
    let inPvp = false, who = null;
    const s = { recorder: { line() {} } };
    c.castVeto = R.makeCastVeto(s, c, { who: () => who, inPvp: () => inPvp, now: () => clock });
    try { c.cast(70, []); } catch { /* the rest of cast() needs a live client; the packet is what matters */ }
    assert.equal(sent.length, 1, 'nobody named: sent');
    who = { fleet: 'prod', agent: 't4', character: 'Waldorf' };
    sent.length = 0;
    assert.equal(c.cast(70, []), false);
    assert.equal(sent.length, 0, 'reserve: not sent');
    assert.equal(s.lastReserveVeto.reagent, 'sapphire');
    inPvp = true;
    try { c.cast(70, []); } catch {}
    assert.equal(sent.length, 1, 'in a PvP fight: sent');
  });

  console.log(`\n${passed} passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
