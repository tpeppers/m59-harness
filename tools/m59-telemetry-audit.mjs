#!/usr/bin/env node
// Static coverage audit: never import or execute a FleetScript or scratch driver.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function auditTelemetry(root) {
  const rows = [];
  function scan(dir) {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || /^(archive|node_modules|history)/i.test(e.name)) continue;
      const file = join(dir, e.name);
      if (e.isDirectory()) { scan(file); continue; }
      if (!e.name.endsWith('.mjs') || /test|fixture/.test(e.name)) continue;
      const text = readFileSync(file, 'utf8');
      const casts = /\b(?:call|rpc)\s*\(\s*['"]cast['"]|castVerified\s*\(/.test(text);
      const supply = /\b(?:call|rpc)\s*\(\s*['"](?:supply|shop)['"]/.test(text);
      const stock = /\b(?:call|rpc)\s*\(\s*['"](?:hall_withdraw|vault|bank|loot)['"]/.test(text);
      const runner = /m59-fleetscript|m59-fleetlib|m59-fleet-repl/.test(text);
      const hint = /practice|drill|courier|resuppl|restock|hanla|arrow|mystic/i.test(e.name);
      const bypass = /\bkeeper\s*\(\s*['"]cast['"]|\.cast\s*\(/.test(text);
      if (!(casts || supply || hint || bypass)) continue;
      rows.push({ file: relative(root, file).replaceAll('\\', '/'), runner, casts, supply, stock, bypass,
        lifecycle: runner ? 'shared FleetScript executor' : 'standalone: broker action receipts',
        outcomes: casts || supply || stock ? 'broker dispatch observer' : bypass ? 'review direct keeper/socket path' : 'pure helper, reader or keeper-policy setter; no direct cast/transfer' });
    }
  }
  scan(join(root, 'tools', 'fleetscripts'));
  scan(join(root, 'substrate', 'fleetscripts'));
  scan(join(root, 'substrate', 'scratch'));
  return { root, files: rows.length, sharedRunner: rows.filter(r => r.runner).length,
    directBroker: rows.filter(r => !r.runner && (r.casts || r.supply || r.stock)).length, directBypass: rows.filter(r => r.bypass).length, rows };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const i = process.argv.indexOf('--root'), root = resolve(i >= 0 ? process.argv[i + 1] : '.');
  const report = auditTelemetry(root);
  console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) :
    `${report.files} related source files: ${report.sharedRunner} use the shared runner, ${report.directBroker} standalone broker callers, ${report.directBypass} direct paths to inspect.\n` + report.rows.map(r => `${r.file}: ${r.lifecycle}; ${r.outcomes}`).join('\n'));
}
