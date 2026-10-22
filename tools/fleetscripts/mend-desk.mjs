// MEND DESK: A CHARACTER WHO KNOWS MEND STANDS IN ONE ROOM AND SERVES practice-bow's MEND TICKETS.
// Written by m59-bard-69 as a local pad on 2026-10-22 and promoted here unchanged apart from import paths.
//
//   mend-desk agents=t9 room=38 hours=12
//
// Operator, 2026-10-22: "Have Camilla learn mend and provide a mend desk". practice-bow (tools/fleetscripts) is the
// ARCHER's half: it picks a desk out of the chalice store that lists Mend (pickMendDesk), drops the bow at the desk's
// feet, files a `mend` ticket and waits for it to close. The SERVER's half lives in the keeper, but only for the
// chalice holder (autopilot chalicePublishDesk / chaliceServeTicket, `role === 'holder'`), and the holder (Loial)
// does not know Mend -- so on 2026-10-22 no published desk listed it and every practice-bow run ended at its first mend.
// This is that server half for anybody else, done the way the keeper does it:
//   * publish a desk row every minute (store.setDesk), menu = Mend only, ok while one sapphire and one orc tooth are
//     spare above `keep_*` -- a row older than 15 minutes is ignored by pickMendDesk, so a stopped desk vanishes;
//   * claim the oldest open mend ticket NOT filed by ourselves (store.claimNext), cast mend on each named item that
//     is on OUR floor (mend.kod:106-110 reaches only the caster's pack or floor), mark it done with `mended`.
// The server checks nothing about the item: mend.kod refuses a broken or full one before any reagent is spent, and
// the archer reads the condition back. With room=38 (Castle Victoria, the archers' own practice room) practice-bow
// mends in place without walking.
import { walk, verify } from '../m59-fleetscript.mjs';
import { fleetName } from '../m59-fleetpath.mjs';
import { chaliceStoreFor } from '../m59-chalice.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const count = (items, rx) => (items ?? []).filter(i => rx.test(String(i.name ?? ''))).reduce((n, i) => n + (Number(i.amount) || 1), 0);
const SAPPHIRE = /sapphire/i, TOOTH = /orc (tooth|teeth)/i;

export const script = {
  name: 'mend-desk',
  describe: 'Stand in `room` as a Mend desk: publish it in the chalice store and cast mend on practice-bow tickets.',
  params: {
    agents:      { type: 'agents', required: true, describe: 'the server (one), who knows Mend' },
    room:        { type: 'number', default: 38, describe: 'where the desk stands; practice-bow files tickets naming it' },
    hours:       { type: 'number', default: 12, describe: 'stop after this long' },
    keep_sapphire: { type: 'number', default: 0, describe: 'sapphires never spent' },
    keep_tooth:  { type: 'number', default: 0, describe: 'orc teeth never spent' },
    max_items:   { type: 'number', default: 3, describe: 'items mended per ticket' },
  },
  async steps(p) {
    const agent = p.agent, room = Number(p.room), fleet = fleetName();
    return [
      walk(room, { why: 'the mend desk' }),
      verify(async ({ call }) => {
        const store = chaliceStoreFor({ fleet });
        const ab = await call('abilities', { agent, kind: 'spells' }, 60_000).catch(() => null);
        if (!(ab?.spells ?? []).some(s => String(s.name).toLowerCase() === 'mend' && s.known !== false))
          return { ok: false, why: `${agent} does not know mend` };
        const me = (await call('status', { agent }, 30_000).catch(() => null))?.character || agent;
        const until = Date.now() + Number(p.hours) * 3600_000;
        let said = 0, served = 0, casts = 0;
        const spare = items => ({ s: count(items, SAPPHIRE) - Number(p.keep_sapphire), t: count(items, TOOTH) - Number(p.keep_tooth) });
        while (Date.now() < until) {
          const items = (await call('inventory', { agent }, 60_000).catch(() => null))?.items ?? [];
          const sp = spare(items), ok = sp.s >= 1 && sp.t >= 1;
          if (Date.now() - said > 60_000) {
            said = Date.now();
            try { store.setDesk(me, { menu: [{ kind: 'mend', label: 'Mend', ok, ...(ok ? {} : { why: 'Req. reagents' }) }], room }); } catch {}
          }
          const t = ok ? store.claimNext(me, { kind: 'mend' }) : null;
          if (!t) { await sleep(10_000); continue; }
          const here = Number((await call('status', { agent }, 30_000).catch(() => null))?.room?.num);
          if (here !== room) { try { store.mark(t.id, 'abandoned', { note: `desk is in ${here}, not ${room}` }); } catch {} return { ok: false, why: `pushed out of ${room} (now ${here})` }; }
          // practice-bow drops the bow and then files; a ticket can land a beat before the floor shows it.
          let floor = new Set();
          for (let i = 0; i < 5; i++) {
            const look = await call('look', { agent }, 30_000).catch(() => null);
            floor = new Set((look?.objects ?? []).map(o => Number(o.id)));
            if ((t.items ?? []).some(x => floor.has(Number(x.id)))) break;
            await sleep(2_000);
          }
          let done = 0;
          for (const item of (t.items ?? []).slice(0, Number(p.max_items))) {
            if (!floor.has(Number(item.id))) continue;
            const left = spare((await call('inventory', { agent }, 60_000).catch(() => null))?.items);
            if (left.s < 1 || left.t < 1) break;
            const r = await call('cast', { agent, spell: 'mend', target: Number(item.id) }, 60_000).catch(e => ({ error: e.message }));
            const cast = !r?.error && r?.cast !== false && r?.ok !== false;
            if (cast) { done++; casts++; }
            console.log(`  ${agent}: mend on ${item.name ?? item.id} for ${t.traveller}: ${cast ? 'cast' : JSON.stringify(r?.error ?? r?.why ?? r).slice(0, 140)}`);
          }
          try { store.mark(t.id, 'done', { note: `mend cast on ${done} of ${(t.items ?? []).length} (mend-desk ${me})`, mended: done }); } catch {}
          served++;
        }
        console.log(`  ${agent}: desk closed after ${p.hours}h: ${served} tickets, ${casts} casts`);
        return true;
      }, 'serve mend tickets at the desk'),
    ];
  },
};
