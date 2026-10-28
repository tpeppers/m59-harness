#!/usr/bin/env node
// The compendium's /reports/ pages: the markdown renderer, the frontmatter reader, and the
// route — offline, no socket, no fleet.
//
//   node tools/m59-compendium-reports-test.mjs
//
// The renderer is hand-written (every tool here is zero-dependency), so this pins the
// shapes the m59-research corpus actually uses, each one a way it came out wrong first:
// a bold that wraps a line break rendered as literal `**`, and a `:-:` separator that
// turned a 40-row food table into one paragraph of pipes. If the real corpus is on this
// machine it is rendered in full as well, and every page is checked for leftover syntax.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseReport, markdown, inline, headingId, isCitation, serveReports, loadReports,
         renderReport, reportsDir } from '../compendium/tools/reports.mjs';

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`FAIL ${name}${detail !== undefined ? `\n     ${String(detail).slice(0, 400)}` : ''}`);
}
const has = (html, frag, name) => ok(html.includes(frag), name, html);
const lacks = (html, frag, name) => ok(!html.includes(frag), name, html);
const md = (s, opts) => markdown(s, opts).html;

// ---------------------------------------------------------------- frontmatter

{
  const { meta, body } = parseReport(`---
title: "Disciple quests: the gate"
status: current
tags: [quests, spells]
answers:
  - What is the disciple quest?
  - How do I become a disciple of Qor?
sources:
  - kod/object/passive/quest.kod
repo_commit: 1fb1f514
verified: 2026-09-18
---

# Disciple quests

Body.
`);
  ok(meta.title === 'Disciple quests: the gate', 'a quoted title loses its quotes', meta.title);
  ok(meta.tags.join() === 'quests,spells', 'an inline list is a list', meta.tags);
  ok(meta.answers.length === 2 && meta.answers[1] === 'How do I become a disciple of Qor?', 'a block list is a list', meta.answers);
  ok(meta.entities.length === 0, 'a list key that is absent is an empty list');
  ok(meta.repo_commit === '1fb1f514' && meta.verified === '2026-09-18', 'scalars read as written');
  ok(body.startsWith('\n# Disciple') || body.startsWith('# Disciple'), 'the body starts after the closing fence', JSON.stringify(body.slice(0, 30)));
  const crlf = parseReport('---\r\ntitle: x\r\ntags: [a]\r\n---\r\nhi\r\n');
  ok(crlf.meta.title === 'x' && crlf.meta.tags[0] === 'a', 'CRLF frontmatter reads the same');
  ok(Object.keys(parseReport('no frontmatter').meta).length === 4, 'no frontmatter is empty lists, not an error');
}

// ---------------------------------------------------------------- inline

ok(headingId('What the fleet logs are missing (URGENT)') === 'what-the-fleet-logs-are-missing-urgent', 'GitHub anchor: punctuation dropped');
ok(headingId('Shal\'ille — the guardian-angel rule') === 'shalille--the-guardian-angel-rule', 'GitHub anchor: an em dash leaves two hyphens', headingId('Shal\'ille — the guardian-angel rule'));
has(inline('`a **b** c`'), '<code>a **b** c</code>', 'nothing inside a code span is emphasis');
has(inline('say `<name>` and <credits>'), '&lt;credits&gt;', 'raw HTML is escaped, not passed through');
has(inline('a<br>b'), 'a<br>b', '<br> is the one tag let through');
has(inline('fight_above_vigor and rest_below'), 'fight_above_vigor and rest_below', 'snake_case is not italic');
has(inline('a *b* and _c_'), '<em>b</em>', 'single-star emphasis');
has(inline('a *b* and _c_'), '<em>c</em>', 'underscore emphasis at word edges');
has(inline('3 * 4 * 5'), '3 * 4 * 5', 'arithmetic is not emphasis');
has(inline('`kod/util/library.kod:120`'), 'class="cite-code"', 'a kod citation is marked as one');
ok(isCitation('temples.kod:52-73') && isCitation('blakserv/ccode.c') && !isCitation('m59.py find'), 'citation shapes');
{
  const link = (h) => (h === 'other.md' ? 'other.html' : null);
  has(inline('see [the `other` one](other.md)', { link }), '<a href="other.html">the <code>other</code> one</a>', 'a code span inside link text resolves');
  has(inline('see [design](../design/x.md)', { link }), 'class="deadlink"', 'a link this server cannot serve is text, not a 404');
}

// ---------------------------------------------------------------- blocks

{
  const p = md('**Bold that\nwraps** a line.');
  has(p, '<strong>Bold that\nwraps</strong>', 'bold across a wrapped line is one span');
  lacks(p, '**', 'no literal ** left behind');
}
{
  const t = md('| Food | Value |\n|---|:-:|\n| Soup | `a|b` |\n| Pie | 2<br>3 |');
  has(t, '<table class="data md">', 'a `:-:` separator is a table');
  has(t, '<td style="text-align:center"><code>a|b</code></td>', 'a pipe inside a code span is not a column');
  has(t, '2<br>3', '<br> inside a cell');
  lacks(md('a | b\n---'), '<table', 'a pipe above a rule with no pipe is not a table');
}
{
  const l = md('1. one\n   continued\n2. two\n   - nested a\n   - nested b\n3. three');
  has(l, '<ol><li>one\ncontinued</li>', 'an ordered item keeps its continuation, tight');
  has(l, '<ul><li>nested a</li>\n<li>nested b</li></ul>', 'a nested list stays nested');
  has(md('3. three\n4. four'), '<ol start="3">', 'an ordered list keeps its start');
  has(md('- a\n\n- b'), '<li><p>a</p></li>', 'a blank between items makes the list loose');
}
{
  const q = md('> **URGENT** read this.\n> 1. first\n>    still first\n> 2. second');
  has(q, '<blockquote><p><strong>URGENT</strong> read this.</p>', 'a block quote holds a paragraph');
  has(q, '<ol><li>first\nstill first</li>', 'a list inside a quote');
}
{
  const c = md('```kod\nif a < b { x }\n```');
  has(c, '<pre data-lang="kod"><code>if a &lt; b { x }</code></pre>', 'a fenced block is escaped and keeps its language');
  const h = markdown('## Same\n## Same');
  ok(h.headings.map((x) => x.id).join() === 'same,same-1', 'a repeated heading is numbered like GitHub', h.headings.map((x) => x.id));
}

// ---------------------------------------------------------------- the route

function fakeReq(method = 'GET') { return { method }; }
function fakeRes() {
  const r = { code: 0, headers: {}, body: '', headersSent: false };
  r.writeHead = (code, h) => { r.code = code; Object.assign(r.headers, h || {}); r.headersSent = true; return r; };
  r.end = (b) => { if (b !== undefined) r.body += b; return r; };
  return r;
}
async function get(url, dir, method) {
  const res = fakeRes();
  const handled = await serveReports(fakeReq(method), res, url, { dir });
  return { handled, ...res };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm59-reports-test-'));
fs.writeFileSync(path.join(tmp, 'alpha.md'), `---
title: Alpha report
tags: [combat, karma]
entities: [fungus beast]
answers:
  - How does alpha work?
---

# Alpha report

**Bottom line:** alpha beats beta,
so pick alpha.

## Detail

See [beta](beta.md#why) and [the zone](http://localhost:8099/zones/x.html).
`);
fs.writeFileSync(path.join(tmp, 'beta.md'), `---
title: Beta
tags: [combat]
---

# Beta

Source: the kod tree.

Vault these:

| a | b |
|---|---|

Plain.
`);
fs.writeFileSync(path.join(tmp, 'gamma.md'), `---
title: Gamma
---

# Gamma

**Bottom line: there are thirteen.** Eight
are static.

## More
`);
fs.writeFileSync(path.join(tmp, 'not a slug.md'), 'ignored');
try {
  ok((await get('/zones/x.html', tmp)).handled === false, 'a path outside /reports/ falls through to the static server');
  const cat = await get('/reports/', tmp);
  ok(cat.code === 200 && cat.body.includes('Alpha report') && cat.body.includes('href="beta.html"'), 'the catalogue lists every report', cat.body.slice(0, 200));
  lacks(cat.body, 'not a slug', 'a file name that is not a slug is not served');
  has(cat.body, 'data-tag="combat"', 'the catalogue offers its tags');
  const page = await get('/reports/alpha.html', tmp);
  ok(page.code === 200, 'a report page renders');
  has(page.body, '<div class="bottomline">', 'the bottom line is lifted into its own box');
  has(page.body, 'alpha beats beta,\nso pick alpha.', 'the whole wrapped bottom line, not its first line');
  ok(!/alpha beats beta/.test(page.body.split('<div class="rbody">')[1]), 'the bottom line is not repeated in the body');
  ok((page.body.match(/<h1/g) || []).length === 1, 'the body H1 does not repeat the title');
  has(page.body, 'href="beta.html#why"', 'a link to another report becomes its page');
  has(page.body, 'href="../zones/x.html"', 'a localhost:8099 link becomes a link into this compendium');
  has(page.body, 'How does alpha work?', 'the questions it answers are on the page');
  const beta = await get('/reports/beta.html', tmp);
  has(beta.body, 'href="alpha.html"', 'a report lists the reports that cite it');
  const all = loadReports(tmp);
  const gamma = renderReport(all.find((r) => r.slug === 'gamma'), all, new Map());
  has(gamma, '<div class="bl-label">Bottom line</div><div><p><strong>there are thirteen.</strong> Eight', 'a label inside the bold is taken off and the bold kept');
  ok(all.find((r) => r.slug === 'gamma').summary.startsWith('there are thirteen. Eight are static'), 'the summary is the bottom line, label off');
  ok(all.find((r) => r.slug === 'beta').summary === 'Plain.', 'no bottom line: the summary skips the Source line, the lead-in and the table', all.find((r) => r.slug === 'beta').summary);
  const raw = await get('/reports/alpha.md', tmp);
  ok(raw.code === 200 && raw.body.startsWith('---\ntitle: Alpha'), 'the markdown is served as written');
  ok((await get('/reports/delta.html', tmp)).code === 404, 'an unknown report is a 404');
  ok((await get('/reports/..%2f..%2fCLAUDE.md', tmp)).code === 404, 'a traversal is a 404, never a file');
  ok((await get('/reports/%E0%A4%A', tmp)).handled === false, 'a malformed escape falls through');
  const search = JSON.parse((await get('/reports/search.json', tmp)).body);
  ok(search.length === 3 && search[0].u === 'reports/alpha.html' && search[0].q.includes('How does alpha'), 'search entries carry the questions', JSON.stringify(search[0]));
  const ents = JSON.parse((await get('/reports/entities.json', tmp)).body);
  ok(ents['fungus beast']?.[0]?.u === 'alpha', 'entities map to the reports naming them', JSON.stringify(ents));
  const head = await get('/reports/alpha.html', tmp, 'HEAD');
  ok(head.code === 200 && head.body === '', 'HEAD answers without a body');

  const gone = path.join(tmp, 'nope');
  const missing = await get('/reports/', gone);
  ok(missing.code === 200 && missing.body.includes('No reports directory'), 'a missing directory says so on the page');
  ok((await get('/reports/search.json', gone)).code === 404, 'a missing directory has no search index, so no nav link');
  ok((await get('/reports', tmp)).code === 301, '/reports redirects to /reports/');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------- the real corpus

const dir = reportsDir();
const corpus = loadReports(dir);
if (!corpus) {
  console.log(`(no reports at ${dir}; corpus pass skipped)`);
} else {
  const stale = new Map();
  let bad = 0;
  for (const r of corpus) {
    const html = renderReport(r, corpus, stale);
    // Leftover syntax outside code: what a reader would see as a rendering bug.
    const prose = html.replace(/<pre[\s\S]*?<\/pre>/g, '').replace(/<code[\s\S]*?<\/code>/g, '');
    const why = [];
    if (/\*\*/.test(prose)) why.push('literal **');
    if (/```/.test(prose)) why.push('literal fence');
    if (/<p>\|/.test(prose)) why.push('table rendered as a paragraph');
    if (/\u0000/.test(html)) why.push('placeholder leaked');
    if (/^#{1,6} /m.test(prose)) why.push('literal heading');
    if (why.length) { bad++; console.log(`  ${r.slug}: ${why.join(', ')}`); }
  }
  ok(bad === 0, `every report in ${dir} renders without leftover markdown (${corpus.length} reports)`, `${bad} bad`);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
