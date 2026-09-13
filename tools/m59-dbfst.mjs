#!/usr/bin/env node
// DUM-Bot-FleetScript Terminal. Staged, reflective FleetScratch overlays; zero dependencies.
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { ControlClient, ControlDraft, discoverControls } from './m59-control-client.mjs';

export async function runDBFST({ brokerUrl = process.env.M59_CONTROL_URL ?? 'http://127.0.0.1:8901', fleet = null, url = null, agents = [] } = {}) {
  if (!process.stdin.isTTY) throw new Error('DBFST requires an interactive operator terminal');
  const client = new ControlClient(await discoverControls({ brokerUrl, fleet, url }));
  const draft = new ControlDraft(await client.read(agents));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let filter = '', page = 0;
  const show = () => {
    const fields = draft.snapshot.fields.filter(f => (f.id + ' ' + f.title + ' ' + f.group).toLowerCase().includes(filter.toLowerCase()));
    const sample = fields.slice(page * 8, page * 8 + 8);
    console.log(`\nDBFST · fleet ${draft.snapshot.fleet} · DUM PID ${draft.snapshot.pid} · ${draft.snapshot.agents.join(', ')}\n` +
      '[R] Reset to current    [S] Save to live fleet    [Q] Exit without saving\n' +
      `${Object.keys(draft.patch).length + draft.inherit.length} staged changes · page ${page + 1}/${Math.max(1, Math.ceil(fields.length / 8))}`);
    for (const f of sample) {
      const value = side => {
        const values = draft.snapshot.agents.map(a => JSON.stringify(draft.snapshot.rows[a][side][f.id]));
        return values.every(v => v === values[0]) ? values[0] : 'mixed (show this setting to inspect each bot)';
      };
      console.log(`${f.id} — ${String(f.description ?? f.title).slice(0, 160)}\n` +
        `  current=${value('current')}  restart=${value('restart')}  desired=${draft.inherit.includes(f.id) ? 'inherit' : Object.hasOwn(draft.patch, f.id) ? JSON.stringify(draft.patch[f.id]) : 'unchanged'}\n`);
    }
    console.log('list [filter] | next | show <field> | set <field> <JSON value/on/off> | inherit <order>\n' +
      'agents <IDs,comma separated> | templates | template <strategy ID> | patch | restart\n' + draft.snapshot.restart_note);
  };
  show();
  try {
    while (true) {
      const line = (await rl.question('DBFST> ')).trim();
      if (/^(q|quit|exit)$/i.test(line)) break;
      try {
        if (/^(r|reset|reset to current)$/i.test(line)) { draft.reset(await client.read(draft.snapshot.agents)); show(); }
        else if (/^(s|save|save to live fleet)$/i.test(line)) {
          console.log('Saving explicit patch to live fleet…');
          const result = await client.save(draft);
          draft.reset(result); console.log(result.ok ? 'Saved; actual keeper values reloaded.' : JSON.stringify(result.results, null, 2)); show();
        } else if (/^agents\s/i.test(line)) { draft.reset(await client.read(line.slice(7).split(',').map(s => s.trim()).filter(Boolean))); page = 0; show(); }
        else if (/^list(?:\s|$)/i.test(line)) { filter = line.slice(4).trim(); page = 0; show(); }
        else if (/^next$/i.test(line)) { page++; show(); }
        else if (/^show\s/i.test(line)) console.log(draft.describe(draft.field(line.slice(5))).join('\n'));
        else if (/^inherit\s/i.test(line)) console.log('Staged inheritance for ' + draft.inheritField(line.slice(8)).id);
        else if (line === 'templates') console.log(draft.snapshot.templates.map(t => `${t.id} — ${t.description}`).join('\n'));
        else if (line.startsWith('template ')) {
          const t = draft.snapshot.templates.find(t => t.id === line.slice(9));
          if (!t) throw new Error('unknown template');
          console.log(JSON.stringify({ format: 'fleetscratch-control/1', extends: t.extends, patch: Object.fromEntries(Object.entries(draft.patch).filter(([k]) => t.fields.includes(k))) }, null, 2));
          filter = 'strategy.' + t.id + '.'; page = 0; show();
        } else if (line === 'patch') console.log(JSON.stringify({ format: 'fleetscratch-control/1', extends: 'live', ...draft.payload() }, null, 2));
        else if (line === 'restart') console.log(JSON.stringify(Object.fromEntries(Object.entries(draft.snapshot.rows).map(([a, r]) => [a, r.restart])), null, 2));
        else if (line) { const f = draft.assignment(line); console.log('Staged only. ' + draft.describe(f).join('\n')); }
      } catch (e) { console.error(e.message); }
    }
  } finally { rl.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = key => { const i = process.argv.indexOf(key); return i < 0 ? null : process.argv[i + 1]; };
  runDBFST({ brokerUrl: arg('--control') ?? undefined, fleet: arg('--fleet'), url: arg('--url'),
    agents: (arg('--agents') ?? '').split(',').filter(Boolean) }).catch(e => { console.error(e.message); process.exitCode = 1; });
}
