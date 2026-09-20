#!/usr/bin/env node
// THE FLEET IN THREE NUMBERS, IN A COLUMN NARROW ENOUGH TO READ ANYWHERE.
//
//   node tools/m59-fs.mjs              the three numbers
//   node tools/m59-fs.mjs --minutes 60 a different kills window
//   node tools/m59-fs.mjs --json       the same, for something else to read
//
// Operator, 2026-09-19: kills per minute, max health, and total money — banked plus on
// hand — with a HARD WIDTH LIMIT of 43 columns. The width is the requirement, not a
// preference, so it is asserted rather than described: `--json` carries `width_ok`, and a
// line that grows past the limit fails the offline test rather than wrapping on somebody's
// phone. A layout rule nobody checks is a layout rule that lasts one commit.
//
// WHAT IT DOES NOT DO. It is not a dashboard and it does not replace `m59-minimal.mjs`,
// which owns the health and kill arithmetic and is called here rather than re-implemented.
// The only thing this adds is money, because that was the number nothing totalled.
//
// MONEY HAS TWO HALVES AND THEY ARE NOT EQUALLY TRUSTWORTHY.
//
//   purse    a live field on the fleet board. Current, for every character.
//   banked   `{balance, at, observed}`, and the balance is PROSE the banker spoke once
//            (Lm_bnkr_balance, monster.kod:136). There is no packet for it and no way to
//            ask again without walking to a teller, so what is recorded is as old as the
//            last visit — sometimes a month.
//
// So the total is reported WITH the age of its oldest component. A month-old balance is
// not money you have; it is money you had. Summing the two halves and printing one
// confident figure would be the most misleading thing this file could do, which is why
// the staleness line is not optional and is not a footnote.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// THE CONSTRAINT, AS A CONSTANT. 43 is the operator's line, measured rather than guessed.
export const MAX_WIDTH = 43;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const CONTROL = process.env.M59_CONTROL_URL || 'http://127.0.0.1:8901';

async function fleetRows() {
  const res = await fetch(`${CONTROL}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                           params: { name: 'fleet', arguments: {} } }),
  });
  const j = await res.json();
  const text = j.result?.content?.[0]?.text ?? '{}';
  const f = JSON.parse(text);
  return f.characters ?? f.fleet ?? f.rows ?? [];
}

/** min/avg/max health and kills, from the tool that already owns that arithmetic. */
function minimal(minutes) {
  const out = execFileSync(process.execPath,
    [join(HERE, 'm59-minimal.mjs'), '--json', '--minutes', String(minutes)],
    { encoding: 'utf8', timeout: 120_000 });
  return JSON.parse(out);
}

const comma = n => Number(n ?? 0).toLocaleString('en-US');
const days = ms => Math.floor(ms / 86_400_000);

export function render({ chars, kpm, hp, purse, banked, bankedFrom, bankedOf, oldestMs }) {
  const L = [];
  L.push(`FLEET ${chars}`.padEnd(22) + `kills/min ${kpm.toFixed(2)}`);
  L.push(`max hp    ${hp.min} / ${Math.round(hp.avg)} / ${hp.max}`.padEnd(30) + 'lo/av/hi');
  L.push('');
  L.push('purse'.padEnd(12) + comma(purse).padStart(12));
  L.push('banked'.padEnd(12) + comma(banked).padStart(12) + `  ${bankedFrom}/${bankedOf}`);
  L.push('TOTAL'.padEnd(12) + comma(purse + banked).padStart(12));
  // NEVER SILENT. A balance is prose from a banker's mouth and can be a month old; a total
  // that hides that is worse than no total.
  if (oldestMs != null) L.push(`oldest bank read ${days(oldestMs)}d — may be stale`);
  return L;
}

async function main() {
  const minutes = Number(arg('minutes', 30));
  const rows = await fleetRows();
  const m = minimal(minutes);

  let purse = 0, banked = 0, bankedFrom = 0, oldest = null;
  const now = Date.now();
  for (const r of rows) {
    const p = Number(r.purse);
    if (Number.isFinite(p)) purse += p;
    const b = r.banked;
    if (b && Number.isFinite(Number(b.balance))) {
      banked += Number(b.balance);
      bankedFrom++;
      if (Number.isFinite(Number(b.at))) {
        const age = now - Number(b.at);
        if (oldest == null || age > oldest) oldest = age;
      }
    }
  }

  const data = {
    characters: rows.length,
    window_minutes: minutes,
    kills_per_minute_fleet: m.kills_per_minute_fleet ?? 0,
    max_health: m.max_health,
    purse, banked, total: purse + banked,
    banked_from: bankedFrom, banked_of: rows.length,
    oldest_bank_read_ms: oldest,
  };

  const lines = render({
    chars: rows.length, kpm: data.kills_per_minute_fleet, hp: m.max_health,
    purse, banked, bankedFrom, bankedOf: rows.length, oldestMs: oldest,
  });
  const widest = Math.max(...lines.map(l => l.length));
  data.width_ok = widest <= MAX_WIDTH;
  data.widest = widest;

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(data, null, 1));
    return;
  }
  for (const l of lines) console.log(l);
  if (!data.width_ok) console.log(`!! ${widest} cols > ${MAX_WIDTH}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error(String(e.message || e)); process.exit(1); });
}
