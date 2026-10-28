// reports.mjs -- the m59-research reports, served as compendium pages.
//
//   /reports/              the catalogue: every report, filterable by tag and question
//   /reports/<slug>.html   one report, rendered
//   /reports/<slug>.md     the same report, as written
//   /reports/search.json   entries for the site-wide search box
//   /reports/entities.json entity name -> the reports that name it, for entity pages
//
// The rest of the compendium is compiled from kod and committed. These pages are not:
// the reports live in another repository (`m59-research`, a directory on this machine),
// are rewritten by other sessions all day, and are this machine's research rather than
// this repository's. So they are RENDERED ON REQUEST from wherever the reports are —
// nothing is copied in, nothing is generated into the tree, and a report edited there
// is the page served here on the next load. No build step can fall behind.
//
// WHERE THEY ARE, most explicit first:
//
//   M59_RESEARCH_REPORTS=<dir>     the reports directory itself
//   M59_RESEARCH=<dir>             the m59-research checkout; reports/ under it
//   C:/code/m59-research/reports   this machine's, as it always was
//
// A directory that is not there is not an error: the catalogue says so, and the nav link
// that site.js adds only appears when /reports/search.json answers. A copy of the
// compendium with no research beside it simply has no Reports tab.
//
// THE MARKDOWN IS RENDERED HERE, NOT BY A LIBRARY. Every tool in this tree is zero-
// dependency, and the reports use a small, stable subset: frontmatter, headings, tables,
// fenced code, nested lists, block quotes, links between reports. Raw HTML is ESCAPED,
// except `<br>` (941 of them, all inside table cells): reports quote kod placeholders like
// `<name>` and `<credits>` as text, and a renderer that passed HTML through would eat them.
//
// STALENESS is computed the way `bin/m59.py stale` computes it — the report's cited
// sources that changed between its pinned `repo_commit` and the Meridian59 HEAD — so the
// page and the research repository's own tooling never disagree about which report needs
// re-reading.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
export const COMPENDIUM = path.join(HERE, '..');
export const M59 = process.env.M59_ROOT || 'C:/code/Meridian59';

export function reportsDir(env = process.env) {
  if (env.M59_RESEARCH_REPORTS) return path.resolve(env.M59_RESEARCH_REPORTS);
  if (env.M59_RESEARCH) return path.resolve(env.M59_RESEARCH, 'reports');
  return path.resolve('C:/code/m59-research/reports');
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i;

// ---------------------------------------------------------------- text

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// GitHub's heading anchor, because that is what the reports' own `#fragment` links were
// written against: lower case, punctuation dropped (letters, digits, `-` and `_` kept,
// any script), spaces to hyphens. "What the fleet logs are missing (URGENT)" becomes
// `what-the-fleet-logs-are-missing-urgent`.
export function headingId(text) {
  return String(text).toLowerCase().trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

export function plain(md) {
  return String(md ?? '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|~~/g, '').replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, '$1$2')
    .replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function clip(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), n - 20)).replace(/[,;:]$/, '') + '…';
}

// ---------------------------------------------------------------- frontmatter

// The same reading `bin/m59.py parse` gives: `key: value`, `key: [a, b]`, and a block list
// of `  - item` lines under a bare `key:`. Quotes around a scalar are dropped, which m59.py
// does not do — its INDEX.md prints one title with its quotes on.
const LIST_KEYS = ['tags', 'entities', 'answers', 'sources'];
export function parseReport(text) {
  text = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const meta = {};
  let body = text;
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) {
      const raw = text.slice(3, end);
      body = text.slice(end + 4).replace(/^[^\n]*\n/, '');
      let key = null;
      for (const line of raw.split('\n')) {
        if (!line.trim() || line.trimStart().startsWith('#')) continue;
        if (/^\s/.test(line) && line.trimStart().startsWith('- ')) {
          if (key) (Array.isArray(meta[key]) ? meta[key] : (meta[key] = [])).push(unquote(line.trimStart().slice(2).trim()));
          continue;
        }
        const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
        if (!m) continue;
        key = m[1];
        const val = m[2].trim();
        if (val.startsWith('[') && val.endsWith(']'))
          meta[key] = val.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter(Boolean);
        else meta[key] = val ? unquote(val) : (LIST_KEYS.includes(key) ? [] : '');
      }
    }
  }
  for (const k of LIST_KEYS) {
    const v = meta[k];
    meta[k] = Array.isArray(v) ? v.filter(Boolean) : v ? [v] : [];
  }
  return { meta, body };
}

function unquote(s) {
  const m = /^(["'])([\s\S]*)\1$/.exec(s);
  return m ? m[2] : s;
}

// ---------------------------------------------------------------- inline markdown

// `link(href)` decides what a link becomes: a string href, or null to render the text
// without an anchor (a link to something this server cannot serve).
export function inline(src, { link = (h) => h } = {}) {
  const held = [];
  let s = held_(String(src), link, held);
  // A held piece can itself hold pieces (a code span inside link text), so resolve until
  // nothing is left.
  while (/\u0000\d+\u0000/.test(s)) s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[i]);
  return s;
}

function held_(s, link, held) {
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;

  // Code spans first, so nothing inside one is read as emphasis or a link.
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, ticks, code) => {
    const c = code.length > 2 && code.startsWith(' ') && code.endsWith(' ') ? code.slice(1, -1) : code;
    return hold(`<code${isCitation(c) ? ' class="cite-code"' : ''}>${esc(c)}</code>`);
  });
  s = s.replace(/\\([\\`*_{}\[\]()#+\-.!|<>~])/g, (_, ch) => hold(esc(ch)));
  s = s.replace(/<br\s*\/?>/gi, () => hold('<br>'));
  s = s.replace(/<(https?:\/\/[^\s>]+)>/g, (_, url) => {
    const h = link(url);
    return hold(h ? anchor(h, esc(url)) : esc(url));
  });

  // Links: the text is itself inline markdown; the href may carry a parenthesised title.
  s = s.replace(/!?\[((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (whole, text, href) => {
    const inner = held_(text, link, held);
    const h = link(href);
    return hold(h ? anchor(h, inner) : `<span class="deadlink" title="${esc(href)} is not served here">${inner}</span>`);
  });

  s = esc(s);
  return s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?![\w])/g, '$1<strong>$2</strong>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/(^|[^\w*])\*(?=[^\s*])([\s\S]*?[^\s*])\*(?![\w*])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\w])/g, '$1<em>$2</em>');
}

function anchor(href, inner) {
  const ext = /^https?:/i.test(href);
  return `<a href="${esc(href)}"${ext ? ' target="_blank" rel="noopener"' : ''}>${inner}</a>`;
}

// `kod/object/passive/spell.kod:482`, `blakserv/ccode.c`, `temples.kod:52-73`.
export function isCitation(s) {
  return /^(?:kod|blakserv|clientd3d|module|include|resource|run|util)\/[\w./-]+(?::[\d,\s:-]+)?$/.test(s)
    || /^[\w-]+\.(?:kod|khd|c|h|cpp|lkod)(?::[\d,\s:-]+)?$/.test(s);
}

// ---------------------------------------------------------------- block markdown

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^( *)([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (l) => /^ */.exec(l)[0].length;
const blank = (l) => !l.trim();
const startsBlock = (l) => FENCE.test(l) || HEADING.test(l) || HR.test(l) || /^ {0,3}>/.test(l) || BULLET.test(l);
// A header row with pipes, then a separator row with pipes. `:-:` is a separator too — one
// dash is enough, and requiring two is how the food table came out as a paragraph.
const isTableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length
  && lines[i + 1].includes('|') && TABLE_SEP.test(lines[i + 1]);

// Returns { html, headings: [{level, id, text}] }. `ids` is shared across one document so
// a repeated heading gets `-1`, `-2` as GitHub does.
export function markdown(md, opts = {}) {
  const ctx = { link: opts.link || ((h) => h), ids: new Map(), headings: [] };
  const html = blocks(String(md).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'), ctx);
  return { html, headings: ctx.headings };
}

function blocks(lines, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }

    let m;
    if ((m = FENCE.exec(line))) {
      const fence = m[1], lang = m[2], pad = indentOf(line);
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i].slice(Math.min(pad, indentOf(lines[i]))));
        i++;
      }
      i++;
      out.push(`<pre${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if ((m = HEADING.exec(line))) {
      const level = m[1].length;
      let id = headingId(plain(m[2])) || 'section';
      const n = ctx.ids.get(id) ?? 0;
      ctx.ids.set(id, n + 1);
      if (n) id = `${id}-${n}`;
      ctx.headings.push({ level, id, text: plain(m[2]) });
      out.push(`<h${level} id="${esc(id)}">${inline(m[2], ctx)}<a class="hlink" href="#${esc(id)}" aria-label="link to this section">#</a></h${level}>`);
      i++;
      continue;
    }
    if (HR.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const quoted = [];
      while (i < lines.length && !blank(lines[i]) && (/^ {0,3}>/.test(lines[i]) || !startsBlock(lines[i]))) {
        quoted.push(lines[i].replace(/^ {0,3}> ?/, ''));
        i++;
      }
      out.push(`<blockquote>${blocks(quoted, ctx)}</blockquote>`);
      continue;
    }
    if (isTableStart(lines, i)) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '');
      i += 2;
      const rows = [];
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) rows.push(cells(lines[i++]));
      const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c, ctx)}</${tag}>`;
      out.push(`<div class="tablewrap"><table class="data md">
<thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead>
<tbody>${rows.map((r) => `<tr>${head.map((_, k) => td('td', r[k] ?? '', k)).join('')}</tr>`).join('\n')}</tbody></table></div>`);
      continue;
    }
    if ((m = BULLET.exec(line))) { i = list(lines, i, ctx, out); continue; }

    const para = [];
    while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i])
           && !isTableStart(lines, i)) {
      para.push(lines[i]);
      i++;
    }
    if (!para.length) { para.push(line); i++; }
    out.push(`<p>${paragraph(para, ctx)}</p>`);
  }
  return out.join('\n');
}

// One inline pass over the whole paragraph, not one per line: a bold or a link that wraps
// across a line break is one span.
function paragraph(lines, ctx) {
  return inline(lines.map((l, k) => {
    const hard = k < lines.length - 1 && (/ {2,}$/.test(l) || /\\$/.test(l));
    return l.trim().replace(/\\$/, '') + (hard ? '<br>' : '');
  }).join('\n'), ctx);
}

// A table row's cells. A pipe inside a code span is not a column break.
function cells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out = [];
  let cur = '', ticks = 0;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '`') {
      let run = 1;
      while (s[k + run] === '`') run++;
      ticks = ticks === run ? 0 : ticks || run;
      cur += s.slice(k, k + run);
      k += run - 1;
      continue;
    }
    if (ch === '\\' && s[k + 1] === '|') { cur += '\\|'; k++; continue; }
    if (ch === '|' && !ticks) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out.map((c) => c.replace(/\\\|/g, '|'));
}

// One list, starting at line i, whose items all share the first marker's indent and kind.
function list(lines, i, ctx, out) {
  const first = BULLET.exec(lines[i]);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let loose = false;
  while (i < lines.length) {
    const m = BULLET.exec(lines[i]);
    if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
    const contentAt = m[1].length + m[2].length + Math.min(Math.max(m[3].length, 1), 4);
    const body = [m[4]];
    i++;
    let sawBlank = false;
    while (i < lines.length) {
      const l = lines[i];
      if (blank(l)) {
        // A blank line ends the item unless what follows is indented into it.
        let j = i + 1;
        while (j < lines.length && blank(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]) >= contentAt) { body.push(''); sawBlank = true; i++; continue; }
        if (j < lines.length) {
          const next = BULLET.exec(lines[j]);
          if (next && next[1].length === base && /\d/.test(next[2]) === ordered) loose = true;
        }
        break;
      }
      if (indentOf(l) >= contentAt) { body.push(l.slice(contentAt)); i++; continue; }
      const nm = BULLET.exec(l);
      if (nm && nm[1].length <= base) break;
      if (nm && nm[1].length > base) { body.push(l.slice(Math.min(indentOf(l), contentAt))); i++; continue; }
      if (startsBlock(l) || sawBlank) break;
      body.push(l.trim()); // lazy continuation of the item's paragraph
      i++;
    }
    if (sawBlank && body.slice(0, -1).some(blank)) loose = true;
    items.push(body);
  }
  const lis = items.map((body) => {
    let h = blocks(body, ctx);
    if (!loose) h = h.replace(/^<p>([\s\S]*?)<\/p>(?=\n|$)/, '$1');
    return `<li>${h}</li>`;
  });
  out.push(ordered
    ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${lis.join('\n')}</ol>`
    : `<ul>${lis.join('\n')}</ul>`);
  return i;
}

// ---------------------------------------------------------------- the corpus

const cache = new Map(); // file -> { mtimeMs, size, report }

export function loadReports(dir = reportsDir()) {
  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && SLUG_RE.test(f.slice(0, -3))); }
  catch { return null; }
  const out = [];
  for (const f of names.sort()) {
    const file = path.join(dir, f);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) { out.push(hit.report); continue; }
    const report = describe(f.slice(0, -3), fs.readFileSync(file, 'utf8'), st);
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, report });
    out.push(report);
  }
  return out;
}

// Not the `m` flag: with it, `$` ends the match at the first line break, and a bottom line
// is usually a whole wrapped paragraph. Two spellings are in the corpus: `**Bottom line:**
// text` and `**Bottom line: text.** more` — in the second the label is inside the bold, so
// the bold has to be reopened once the label is taken off.
const BOTTOM_LINE = /(?:^|\n)\*\*(?:Bottom line|TL;DR|Summary)\s*[:.]?\s*(\*\*:?\s*)?([\s\S]*?)(?=\n\s*\n|(?![\s\S]))/i;
const bottomLineOf = (m) => (m ? (m[1] ? '' : '**') + m[2].trim() : '');

// Without a bottom line, the summary is the first paragraph that says something: not a
// table, a list or a code block, and not the "Source: ..." preamble several reports open with.
function firstProse(body) {
  for (const para of body.replace(/^#.*$/gm, '').split(/\n\s*\n/)) {
    const t = para.trim();
    if (!t || /^(\||[-*+] |\d+[.)] |```|~~~|>)/.test(t)) continue;
    if (/^(Sources?|Companion to|This report)\b/i.test(plain(t))) continue;
    if (/:$/.test(t)) continue; // "Vault these when they drop:" introduces a table; it is not a summary
    return t;
  }
  return '';
}

function describe(slug, text, st) {
  const { meta, body } = parseReport(text);
  const h1 = /^#\s+(.+)$/m.exec(body);
  const title = meta.title || (h1 ? plain(h1[1]) : slug.replace(/-/g, ' '));
  // The template's first paragraph is "**Bottom line:** ..." and is the part a reader acts on.
  const bottomLine = bottomLineOf(BOTTOM_LINE.exec(body));
  const links = new Set();
  for (const m of body.matchAll(/\]\((?:\.{0,2}\/)?(?:reports\/)?([a-z0-9][a-z0-9._-]*)\.md(?:#[^)]*)?\)/gi)) links.add(m[1]);
  links.delete(slug);
  return {
    slug, title, meta, body, text,
    bottomLine,
    summary: plain(bottomLine || firstProse(body)),
    links: [...links],
    mtime: st.mtimeMs,
    words: body.split(/\s+/).length,
  };
}

// ---------------------------------------------------------------- staleness

const git = (args, timeout = 8000) => new Promise((resolve) =>
  execFile('git', ['-C', M59, ...args], { timeout, windowsHide: true, maxBuffer: 16 << 20 },
    (err, stdout) => resolve(err ? null : stdout.trim())));

let headMemo = { at: 0, value: null };
const diffMemo = new Map(); // `${pin}..${head}` -> Set of changed paths, or null

async function m59Head() {
  if (Date.now() - headMemo.at < 60_000) return headMemo.value;
  headMemo = { at: Date.now(), value: await git(['rev-parse', 'HEAD']) };
  return headMemo.value;
}

// { state: 'current' | 'stale' | 'unknown', changed: [...], why }
export async function staleness(reports) {
  const head = await m59Head();
  const out = new Map();
  if (!head) {
    for (const r of reports) out.set(r.slug, { state: 'unknown', changed: [], why: `no git tree at ${M59}` });
    return out;
  }
  const pins = [...new Set(reports.map((r) => r.meta.repo_commit).filter(Boolean))];
  await Promise.all(pins.map(async (pin) => {
    const key = `${pin}..${head}`;
    if (diffMemo.has(key)) return;
    const raw = await git(['diff', '--name-only', `${pin}..${head}`]);
    diffMemo.set(key, raw === null ? null : new Set(raw.split('\n').filter(Boolean)));
  }));
  for (const r of reports) {
    const pin = r.meta.repo_commit;
    if (!pin) { out.set(r.slug, { state: 'unknown', changed: [], why: 'not pinned' }); continue; }
    const changed = diffMemo.get(`${pin}..${head}`);
    if (!changed) { out.set(r.slug, { state: 'unknown', changed: [], why: `pinned commit ${pin.slice(0, 8)} is not in ${M59}` }); continue; }
    const hits = r.meta.sources.filter((s) => {
      const p = s.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
      return changed.has(p) || [...changed].some((c) => c.startsWith(p + '/'));
    });
    out.set(r.slug, { state: hits.length ? 'stale' : 'current', changed: hits, why: '' });
  }
  return out;
}

// ---------------------------------------------------------------- the compendium beside it

// Entity names that are also compendium pages, from the compendium's own search index.
let siteIndex = { at: 0, map: null };
function compendiumIndex() {
  const file = path.join(COMPENDIUM, 'search.json');
  try {
    const st = fs.statSync(file);
    if (siteIndex.map && siteIndex.at === st.mtimeMs) return siteIndex.map;
    const map = new Map();
    for (const e of JSON.parse(fs.readFileSync(file, 'utf8'))) {
      const k = String(e.n).toLowerCase();
      if (!map.has(k)) map.set(k, e);
    }
    siteIndex = { at: st.mtimeMs, map };
    return map;
  } catch { return new Map(); }
}

// The built home page's nav IS the site's nav; borrowing it means a category added to the
// compendium appears here without this file knowing about it.
function siteNav() {
  try {
    const html = fs.readFileSync(path.join(COMPENDIUM, 'index.html'), 'utf8');
    const m = /<nav>([\s\S]*?)<\/nav>/.exec(html);
    if (m) return m[1].replace(/ class="on"/g, '').replace(/href="\.\//g, 'href="../');
  } catch {}
  return '<a href="../index.html">Home</a><a href="../guides/index.html">Guides</a>';
}

// A link inside a report: another report, a page of this compendium written as a
// localhost URL, the outside world, or something in the research repository that is not
// served here (rendered as text, never as a 404).
function linker(known) {
  return (href) => {
    if (/^#/.test(href)) return href;
    const local = /^https?:\/\/(?:localhost|127\.0\.0\.1):8099\/(.*)$/i.exec(href);
    if (local) return '../' + local[1];
    if (/^(https?:|mailto:)/i.test(href)) return href;
    const rep = /^(?:\.{0,2}\/)?(?:reports\/)?([a-z0-9][a-z0-9._-]*)\.md(#.*)?$/i.exec(href);
    if (rep && known.has(rep[1])) return `${rep[1]}.html${rep[2] || ''}`;
    return null;
  };
}

// ---------------------------------------------------------------- pages

function shell({ title, desc = '', body, crumbs = '' }) {
  const nav = siteNav() + '<a href="index.html" class="on">Reports</a>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Meridian 59 Compendium</title>
${desc ? `<meta name="description" content="${esc(desc)}">` : ''}
<link rel="stylesheet" href="../assets/style.css">
<link rel="stylesheet" href="../assets/reports.css">
<script>(function(){try{var t=localStorage.getItem('m59-theme');if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
</head>
<body class="reports">
<header class="topbar">
  <a class="brand" href="../index.html">Meridian&nbsp;<span>59</span> Compendium</a>
  <nav>${nav}</nav>
  <input id="q" type="search" placeholder="Search everything…" autocomplete="off" spellcheck="false">
  <button class="theme-toggle" id="themeToggle" title="Toggle light/dark">◐</button>
  <div id="results"></div>
</header>
<main class="wide">
${crumbs ? `<p class="crumbs">${crumbs}</p>` : ''}
${body}
</main>
<footer class="sitefoot">
Reports are the research corpus in <code>m59-research</code>, rendered as they stand on disk
each time a page is asked for. Each one is pinned to the Meridian 59 commit it was read
against; <em>stale</em> means a source it cites has changed since. Citations are
<code>file:line</code> in that tree.
</footer>
<script>window.M59_REL="..";</script>
<script src="../assets/site.js"></script>
<script src="../assets/reports.js"></script>
</body>
</html>`;
}

const fmtDate = (s) => (/^\d{4}-\d{2}-\d{2}/.test(s || '') ? s.slice(0, 10) : s || '');
const shortSha = (s) => (s ? String(s).slice(0, 8) : '');

function staleBadge(st) {
  if (!st) return '';
  if (st.state === 'stale') return `<span class="rbadge stale" title="${esc(st.changed.join(', '))}">stale</span>`;
  if (st.state === 'unknown') return `<span class="rbadge unknown" title="${esc(st.why)}">unverified pin</span>`;
  return '';
}

export function renderCatalog(reports, stale, dir) {
  const tagCount = new Map();
  for (const r of reports) for (const t of r.meta.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  const tags = [...tagCount].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const nStale = [...stale.values()].filter((s) => s.state === 'stale').length;
  const nQs = reports.reduce((n, r) => n + r.meta.answers.length, 0);

  const cards = reports.map((r) => {
    const st = stale.get(r.slug);
    const hay = [r.title, r.summary, ...r.meta.tags, ...r.meta.answers, ...r.meta.entities].join(' \u0001 ').toLowerCase();
    return `<a class="rcard" href="${esc(r.slug)}.html" data-tags="${esc(r.meta.tags.join('|'))}"
  data-hay="${esc(hay)}" data-verified="${esc(fmtDate(r.meta.verified))}" data-qs="${r.meta.answers.length}"
  data-title="${esc(r.title.toLowerCase())}" data-stale="${st?.state === 'stale' ? 1 : 0}" data-mtime="${Math.round(r.mtime)}">
  <span class="rcard-head"><span class="rcard-t">${esc(r.title)}</span>${staleBadge(st)}${r.meta.status && r.meta.status !== 'current' ? `<span class="rbadge draft">${esc(r.meta.status)}</span>` : ''}</span>
  <span class="rcard-d">${esc(clip(r.summary, 260))}</span>
  <span class="rcard-tags">${r.meta.tags.slice(0, 6).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</span>
  <span class="rcard-foot"><span>${r.meta.answers.length} question${r.meta.answers.length === 1 ? '' : 's'}</span><span>verified ${esc(fmtDate(r.meta.verified) || '—')}</span><span class="rq-hit"></span></span>
</a>`;
  }).join('\n');

  const body = `<div class="rhero">
  <h1>Research reports</h1>
  <p class="lede">${reports.length} reports on how the game actually works, each read from the server
  source and pinned to the commit it was read against — ${nQs} questions answered so far.
  Search matches the questions each report was written to answer, not only its title.</p>
  <div class="rstats"><span><b>${reports.length}</b> reports</span><span><b>${nQs}</b> questions</span><span><b>${tags.length}</b> topics</span>${nStale ? `<span class="warnstat"><b>${nStale}</b> stale</span>` : ''}</div>
</div>
<div class="filterbar rfilter">
  <input id="rq" type="search" placeholder="Ask it a question, or filter by word…" autocomplete="off" spellcheck="false">
  <select id="rsort" aria-label="Sort">
    <option value="title">A–Z</option>
    <option value="verified">Recently verified</option>
    <option value="mtime">Recently edited</option>
    <option value="qs">Most questions</option>
  </select>
  <label class="rchk"><input type="checkbox" id="rstale"> stale only</label>
  <span class="count" id="rcount"></span>
</div>
<div class="rtags" id="rtags">${tags.map(([t, n]) => `<button type="button" class="tag rtag" data-tag="${esc(t)}">${esc(t)} <small>${n}</small></button>`).join('')}</div>
<div class="rgrid" id="rgrid">${cards}</div>
<p class="rnone" id="rnone" hidden>No report matches. The research repository answers new questions with
<code>python bin/m59.py find "&lt;question&gt;"</code>.</p>
<p class="muted rsrc">Source: <code>${esc(dir)}</code></p>`;
  return shell({ title: 'Research reports', desc: `${reports.length} research reports on Meridian 59 mechanics`, body });
}

export function renderReport(r, reports, stale) {
  const known = new Set(reports.map((x) => x.slug));
  const bySlug = new Map(reports.map((x) => [x.slug, x]));
  const link = linker(known);

  // The body's own H1 repeats the title the header already shows, and the bottom line is
  // lifted into its own box — so both come out of the flow before rendering.
  let body = r.body.replace(/^\s*#\s+.+\n/, '');
  if (r.bottomLine) body = body.replace(BOTTOM_LINE, '\n');
  const { html, headings } = markdown(body, { link });
  const st = stale.get(r.slug);

  const toc = headings.filter((h) => h.level === 2 || h.level === 3);
  const backlinks = reports.filter((x) => x.slug !== r.slug && x.links.includes(r.slug));
  const outlinks = r.links.filter((s) => bySlug.has(s)).map((s) => bySlug.get(s));
  const site = compendiumIndex();
  const pages = [];
  const seen = new Set();
  for (const e of r.meta.entities) {
    const hit = site.get(e.toLowerCase());
    if (hit && !seen.has(hit.u)) { seen.add(hit.u); pages.push(hit); }
  }

  const meta = [
    r.meta.status ? `<span class="rbadge ${r.meta.status === 'current' ? 'ok' : 'draft'}">${esc(r.meta.status)}</span>` : '',
    staleBadge(st),
    r.meta.verified ? `<span>verified <b>${esc(fmtDate(r.meta.verified))}</b></span>` : '',
    r.meta.repo_commit ? `<span>pinned <code>${esc(shortSha(r.meta.repo_commit))}</code></span>` : '',
    `<span>${Math.max(1, Math.round(r.words / 230))} min read</span>`,
    `<a href="${esc(r.slug)}.md">markdown</a>`,
  ].filter(Boolean).join('');

  const staleNote = st?.state === 'stale'
    ? `<div class="warn"><p><strong>Stale.</strong> ${st.changed.length === 1 ? 'A source' : `${st.changed.length} sources`} this report
       cites changed after it was pinned at <code>${esc(shortSha(r.meta.repo_commit))}</code>:
       ${st.changed.map((c) => `<code>${esc(c)}</code>`).join(', ')}. The sections citing ${st.changed.length === 1 ? 'it' : 'them'}
       may no longer be true; <code>python bin/m59.py stale</code> in m59-research says the same.</p></div>` : '';

  const side = [];
  if (toc.length > 1) side.push(`<nav class="rtoc"><h4>On this page</h4><ol>${toc.map((h) =>
    `<li class="l${h.level}"><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`).join('')}</ol></nav>`);
  if (pages.length) side.push(`<section class="rside"><h4>In the compendium</h4><ul class="rpages">${pages.map((p) =>
    `<li><a href="../${esc(p.u)}">${p.i ? `<img src="../${esc(p.i)}" alt="" onerror="this.remove()">` : ''}<span>${esc(p.n)}</span><small>${esc(p.k)}</small></a></li>`).join('')}</ul></section>`);
  if (outlinks.length || backlinks.length) {
    const li = (x) => `<li><a href="${esc(x.slug)}.html">${esc(x.title)}</a></li>`;
    side.push(`<section class="rside"><h4>Related reports</h4>
${outlinks.length ? `<p class="rsub">cited here</p><ul>${outlinks.map(li).join('')}</ul>` : ''}
${backlinks.length ? `<p class="rsub">cite this one</p><ul>${backlinks.map(li).join('')}</ul>` : ''}</section>`);
  }

  const qs = r.meta.answers.length ? `<details class="rqs"${r.meta.answers.length <= 6 ? ' open' : ''}>
<summary>${r.meta.answers.length} question${r.meta.answers.length === 1 ? '' : 's'} this report answers</summary>
<ul>${r.meta.answers.map((q) => `<li>${esc(q)}</li>`).join('')}</ul></details>` : '';

  const sources = r.meta.sources.length ? `<details class="rsources"><summary>Sources read (${r.meta.sources.length})</summary>
<ul class="src-list">${r.meta.sources.map((s) => `<li><code${st?.changed?.includes(s) ? ' class="changed" title="changed since the pin"' : ''}>${esc(s)}</code></li>`).join('')}</ul></details>` : '';

  const entities = r.meta.entities.length ? `<details class="rentities"><summary>Entities (${r.meta.entities.length})</summary>
<div class="tags">${r.meta.entities.map((e) => {
    const hit = site.get(e.toLowerCase());
    return hit ? `<a class="tag" href="../${esc(hit.u)}">${esc(e)}</a>` : `<span class="tag">${esc(e)}</span>`;
  }).join('')}</div></details>` : '';

  const page = `<div class="rlayout">
<article class="rdoc">
  <header class="rhead">
    <h1>${esc(r.title)}</h1>
    <div class="rmeta">${meta}</div>
    ${r.meta.tags.length ? `<div class="tags">${r.meta.tags.map((t) => `<a class="tag" href="index.html#tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}</div>` : ''}
  </header>
  ${staleNote}
  ${r.bottomLine ? `<div class="bottomline"><div class="bl-label">Bottom line</div><div>${markdown(r.bottomLine, { link }).html}</div></div>` : ''}
  ${qs}
  <div class="rbody">${html}</div>
  <footer class="rfoot">${sources}${entities}</footer>
</article>
${side.length ? `<aside class="raside">${side.join('\n')}</aside>` : ''}
</div>`;
  return shell({
    title: r.title, desc: clip(r.summary, 200), body: page,
    crumbs: `<a href="../index.html">Compendium</a> › <a href="index.html">Reports</a>`,
  });
}

// ---------------------------------------------------------------- the route

// Handles everything under /reports/. Returns false for any other path, so a server can
// put this in front of its static handler and fall through.
export async function serveReports(req, res, urlPath, { dir = reportsDir() } = {}) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return false; }
  if (p === '/reports') { res.writeHead(301, { location: '/reports/' }).end(); return true; }
  if (!p.startsWith('/reports/')) return false;
  const rest = p.slice('/reports/'.length);
  const send = (code, type, bodyText) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : bodyText);
    return true;
  };
  const notFound = (why) => send(404, 'text/plain; charset=utf-8', why);

  const reports = loadReports(dir);
  if (!reports) {
    if (rest === 'search.json' || rest === 'entities.json') return notFound('no reports directory');
    return send(200, 'text/html; charset=utf-8', shell({
      title: 'Research reports',
      body: `<h1>Research reports</h1><div class="note"><p>No reports directory at <code>${esc(dir)}</code>.
Point <code>M59_RESEARCH_REPORTS</code> (or <code>M59_RESEARCH</code>) at an m59-research checkout and restart the compendium.</p></div>`,
    }));
  }

  if (rest === '' || rest === 'index.html')
    return send(200, 'text/html; charset=utf-8', renderCatalog(reports, await staleness(reports), dir));

  if (rest === 'search.json')
    return send(200, 'application/json; charset=utf-8', JSON.stringify(reports.map((r) => ({
      n: r.title, u: `reports/${r.slug}.html`, k: 'report', d: clip(r.summary, 120),
      q: r.meta.answers.join(' \u0001 ') + ' ' + r.meta.tags.join(' '),
    }))));

  if (rest === 'entities.json') {
    const map = {};
    for (const r of reports) for (const e of r.meta.entities) {
      const k = e.toLowerCase();
      (map[k] ||= []).some((x) => x.u === r.slug) || map[k].push({ u: r.slug, t: r.title });
    }
    return send(200, 'application/json; charset=utf-8', JSON.stringify(map));
  }

  const m = /^([a-z0-9][a-z0-9._-]*)\.(html|md)$/i.exec(rest);
  const r = m && reports.find((x) => x.slug === m[1]);
  if (!r) return notFound(`no report: ${rest}`);
  if (m[2] === 'md') return send(200, 'text/plain; charset=utf-8', r.text);
  return send(200, 'text/html; charset=utf-8', renderReport(r, reports, await staleness([r])));
}
