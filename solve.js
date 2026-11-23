// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01).
//
// run(input) returns exactly the answer makefun-site 1.0.0 returns for the
// same input — the output tree, byte for byte. The reference implementation
// (vendor/makefun-site in the kit) is the spec wherever the README and the
// code disagree. Speed comes from not redoing the reference's repeated
// work, never from changing a rule:
//
//   * Markdown renders in a single fused pass over the body's lines: no
//     token array, no second walk, and inline markup is scanned once with
//     its HTML escaping fused into that scan.
//   * Templates compile once per case into plain JavaScript functions
//     (new Function, with a small tree-walking interpreter as fallback):
//     a lookup becomes a direct property read, a loop a real for loop, an
//     include a direct call. The scope is one flat object whose loop
//     bindings are saved and restored, which is exactly the reference's
//     scope chain (loops nest, includes share the scope).
//   * slugify is memoised per case and has an ASCII fast path (NFKD is
//     the identity on ASCII); tag slugs and heading ids are computed once.
//   * Front matter is parsed by scanning only the header lines; the body
//     is never split twice. Word counting is a single char-code scan.
//   * Cards are built once per source (the reference rebuilds them for
//     every page render) and reading_minutes is counted once.
//
// Nothing is cached from one case to the next: every cache is created
// inside run(). The build reads no clock, no environment and no file.

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPABLE_CHARS = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const compareStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const REPORT_NAME = 'build-report.txt';
const OWN_DIRS = ['posts', 'tags', 'page'];

/** `text` with & < > " and ' escaped. Regex scan (C++), no allocation when clean. */
const ESCAPE_RE = /[&<>"']/g;
export function htmlEscape(text) {
  ESCAPE_RE.lastIndex = 0;
  let m = ESCAPE_RE.exec(text);
  if (m === null) return text;
  const out = [];
  let start = 0;
  do {
    const i = m.index;
    out.push(text.slice(start, i), HTML_ESCAPES[text[i]]);
    start = i + 1;
  } while ((m = ESCAPE_RE.exec(text)) !== null);
  out.push(text.slice(start));
  return out.join('');
}

/** A YYYY-MM-DD date in words, from the string alone. */
function dateInWords(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
}

function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** The slug of `text`, memoised in `cache` (fresh per case). */
function slugOf(cache, text) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  let gap = false;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  cache.set(text, slug);
  return slug;
}

function takeSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** Words in `text`: runs of non-whitespace, counted in one char-code scan.
 *  Printable ASCII (the common case) is one comparison per character. */
function wordCount(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 33 && c <= 126) {
      if (!inWord) {
        n++;
        inWord = true;
      }
    } else if (c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8239 || c === 8287 || c === 12288 || c === 8232 || c === 8233 || c === 65279) {
      inWord = false;
    } else if (!inWord) {
      n++;
      inWord = true;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const FRONT_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function lineIsBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

function trimSpacesTabs(line) {
  if (line.length === 0) return line;
  const first = line[0];
  const last = line[line.length - 1];
  if (first !== ' ' && first !== '\t' && last !== ' ' && last !== '\t') return line;
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

function parseQuoted(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function parseValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = parseQuoted(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      let y = 0;
      let mo = 0;
      let d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        y = Number(raw.slice(0, 4));
        mo = Number(raw.slice(5, 7));
        d = Number(raw.slice(8, 10));
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; i < raw.length && ok; i++) {
        const c = raw[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let prevDash = true;
      for (let i = 0; i < raw.length && ok; i++) {
        const c = raw[i];
        if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) prevDash = false;
        else if (c === '-' && !prevDash) prevDash = true;
        else ok = false;
      }
      if (ok && prevDash) ok = false;
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  let pos = nl === -1 ? text.length : nl + 1;
  let closeStart = -1;
  let closeEnd = -1;
  while (pos <= text.length) {
    const e = text.indexOf('\n', pos);
    const lineEnd = e === -1 ? text.length : e;
    if (text.slice(pos, lineEnd) === '---') {
      closeStart = pos;
      closeEnd = e;
      break;
    }
    if (e === -1) break;
    pos = e + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const headerStart = nl === -1 ? 0 : nl + 1;
  const header = text.slice(headerStart, closeStart);
  const lines = header === '' ? [] : header.slice(0, -1).split('\n');
  const data = {};
  for (let j = 0; j < lines.length; j++) {
    const line = lines[j];
    if (lineIsBlank(line) || line.startsWith('#')) continue;
    let k = 0;
    while (k < line.length && ((line[k] >= 'a' && line[k] <= 'z') || line[k] === '_')) k++;
    if (k === 0 || line[k] !== ':') return { error: `line ${j + 2} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line[k + 1] === ' ') raw = line.slice(k + 2);
    else return { error: `line ${j + 2} is not "key: value"` };
    raw = raw.replace(/[ \t]+$/, '');
    if (!FRONT_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = parseValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === -1 ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- Markdown

function backslashEscapes(s, j) {
  let k = j - 1;
  let n = 0;
  while (k >= 0 && s[k] === '\\') {
    n++;
    k--;
  }
  return (n % 2) === 1;
}

function findStrongClose(s, from) {
  let j = s.indexOf('**', from);
  while (j !== -1) {
    if (!backslashEscapes(s, j)) return j;
    j = s.indexOf('**', j + 1);
  }
  return -1;
}

function findStarClose(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (backslashEscapes(s, j)) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

function findBracketClose(s, from) {
  let j = s.indexOf(']', from);
  while (j !== -1) {
    if (!backslashEscapes(s, j)) return j;
    j = s.indexOf(']', j + 1);
  }
  return -1;
}

/** `s` rendered inline; `link(target)` resolves a link's href.
 *  A regex finds the next interesting character (C++ scan); plain runs
 *  between them are pushed raw, so text with no markup costs one scan. */
function renderInline(s, link) {
  const RE = /[\\`*\[&<>"']/g;
  let m = RE.exec(s);
  if (m === null) return s;
  const out = [];
  let start = 0;
  do {
    const i = m.index;
    const c = s[i];
    if (c === '\\') {
      const nx = s[i + 1];
      if (nx !== undefined && ESCAPABLE_CHARS.has(nx)) {
        if (i > start) out.push(s.slice(start, i));
        out.push(HTML_ESCAPES[nx] || nx);
        start = i + 2;
        RE.lastIndex = i + 2;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<code>', htmlEscape(s.slice(i + 1, j)), '</code>');
        start = j + 1;
        RE.lastIndex = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findStrongClose(s, i + 2);
        if (j > i + 2) {
          if (i > start) out.push(s.slice(start, i));
          out.push('<strong>', renderInline(s.slice(i + 2, j), link), '</strong>');
          start = j + 2;
          RE.lastIndex = j + 2;
        } else RE.lastIndex = i + 2;
        continue;
      }
      const j = findStarClose(s, i + 1);
      if (j > i + 1) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<em>', renderInline(s.slice(i + 1, j), link), '</em>');
        start = j + 1;
        RE.lastIndex = j + 1;
      }
      continue;
    }
    if (c === '[') {
      const k = findBracketClose(s, i + 1);
      if (k !== -1 && s[k + 1] === '(') {
        const mm = s.indexOf(')', k + 2);
        const target = mm === -1 ? '' : s.slice(k + 2, mm);
        if (target !== '' && !/\s/.test(target)) {
          if (i > start) out.push(s.slice(start, i));
          out.push('<a href="', htmlEscape(link(target)), '">', renderInline(s.slice(i + 1, k), link), '</a>');
          start = mm + 1;
          RE.lastIndex = mm + 1;
          continue;
        }
      }
      continue;
    }
    if (i > start) out.push(s.slice(start, i));
    out.push(HTML_ESCAPES[c]);
    start = i + 1;
  } while ((m = RE.exec(s)) !== null);
  if (s.length > start) out.push(s.slice(start));
  return out.join('');
}

function fenceLanguage(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let j = 3;
  while (j < line.length) {
    const c = line[j];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-') j++;
    else break;
  }
  const lang = line.slice(3, j);
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  return j === line.length ? lang : null;
}

function fenceEnd(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let j = 3; j < line.length; j++) {
    if (line[j] !== ' ' && line[j] !== '\t') return false;
  }
  return true;
}

function parseHeading(line) {
  if (line[0] !== '#') return null;
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  if (line[n] !== ' ' && line[n] !== '\t') return null;
  const text = trimSpacesTabs(line.slice(n));
  return text === '' ? null : { depth: n, text };
}

function lineIsHr(line) {
  if (line.length < 3) return false;
  const dashes = line[0] === '-' && line[1] === '-' && line[2] === '-';
  const stars = line[0] === '*' && line[1] === '*' && line[2] === '*';
  if (!dashes && !stars) return false;
  for (let j = 3; j < line.length; j++) {
    if (line[j] !== ' ' && line[j] !== '\t') return false;
  }
  return true;
}

function breaksParagraph(line) {
  return lineIsBlank(line) || fenceLanguage(line) !== null || parseHeading(line) !== null || lineIsHr(line);
}

function orderedItemStart(line) {
  let j = 0;
  while (j < line.length && line[j] >= '0' && line[j] <= '9') j++;
  if (j === 0 || j > 9) return null;
  if (line[j] !== '.' || line[j + 1] !== ' ') return null;
  return { start: Number(line.slice(0, j)), textAt: j + 2 };
}

function lineIsContinuation(line) {
  return line[0] === ' ' && line[1] === ' ' && line.length > 2 && /\S/.test(line[2]);
}

/**
 * `src` rendered in one pass: its HTML, its table of contents (level 2/3
 * headings) and its excerpt (first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link, slugCache) {
  const lines = src.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  // Word count fused into this walk: every line index is consumed exactly
  // once (i only advances, one i++ per line), and '\n' resets wordCount's
  // inWord state, so summing wordCount(line) over lines equals
  // wordCount(src). `counted` flushes lines consumed by the previous block.
  let words = 0;
  let counted = 0;
  while (i < n) {
    while (counted < i) words += wordCount(lines[counted++]);
    const line = lines[i];
    if (lineIsBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLanguage(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !fenceEnd(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${htmlEscape(lang)}"`;
      const inner = [];
      for (const l of body) inner.push(htmlEscape(l), '\n');
      out.push(`<pre><code${cls}>${inner.join('')}</code></pre>\n`);
      continue;
    }
    const heading = parseHeading(line);
    if (heading !== null) {
      const id = takeSlug(slugOf(slugCache, heading.text), ids);
      const html = renderInline(heading.text, link);
      out.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (lineIsHr(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (line[0] === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') {
        let l = lines[i++];
        l = l.startsWith('> ') ? l.slice(2) : l.slice(1);
        body.push(trimSpacesTabs(l));
      }
      const kept = body.filter((l) => l !== '');
      out.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${renderInline(kept.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    }
    const bullet = (line[0] === '-' || line[0] === '*') && line[1] === ' ';
    const ordered = bullet ? null : orderedItemStart(line);
    if (bullet || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < n) {
        if (isOrdered) {
          const m = orderedItemStart(lines[i]);
          if (m !== null) {
            items.push([trimSpacesTabs(lines[i].slice(m.textAt))]);
            i++;
            continue;
          }
        } else if ((lines[i][0] === '-' || lines[i][0] === '*') && lines[i][1] === ' ') {
          items.push([trimSpacesTabs(lines[i].slice(2))]);
          i++;
          continue;
        }
        if (items.length > 0 && lineIsContinuation(lines[i])) {
          items[items.length - 1].push(trimSpacesTabs(lines[i]));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.start !== 1 ? `<ol start="${ordered.start}">` : `<${tag}>`;
      let block = `${open}\n`;
      for (const parts of items) block += `<li>${renderInline(parts.join('\n'), link)}</li>\n`;
      block += `</${tag}>\n`;
      out.push(block);
      continue;
    }
    const body = [trimSpacesTabs(line)];
    i++;
    while (i < n && !breaksParagraph(lines[i])) body.push(trimSpacesTabs(lines[i++]));
    const html = renderInline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  while (counted < n) words += wordCount(lines[counted++]);
  return { html: out.join(''), toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- Templates

class TemplateError extends Error {}

const PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_PATTERN = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_PATTERN = /^if (not )?(\S+)$/;
const INCLUDE_PATTERN = /^include "([a-z0-9-]+)"$/;

function splitPath(name, text) {
  if (!PATH_PATTERN.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenizeTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: splitPath(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTemplate(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_PATTERN.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: splitPath(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_PATTERN.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: splitPath(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_PATTERN.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: string itself, a number in JavaScript's digits, true/false, an array's items joined by ", ", else "". */
function valueAsText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += valueAsText(v[i]);
    }
    return s;
  }
  return '';
}

function isTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The value at `path` in the flat scope `S` (first name an own property, then own properties down). */
function scopeLookup(S, path) {
  if (!Object.hasOwn(S, path[0])) return undefined;
  let v = S[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

const TEMPLATE_HELPERS = { esc: htmlEscape, txt: valueAsText, tr: isTruthy };

function pathExpression(path) {
  let e = `(Object.hasOwn(S,${JSON.stringify(path[0])})?S[${JSON.stringify(path[0])}]:undefined)`;
  for (let k = 1; k < path.length; k++) {
    e = `((_v=${e})!=null&&typeof _v==="object"&&Object.hasOwn(_v,${JSON.stringify(path[k])})?_v[${JSON.stringify(path[k])}]:undefined)`;
  }
  return e;
}

function emitCode(nodes, out) {
  for (const n of nodes) {
    if (n.kind === 'text') out.push(`out.push(${JSON.stringify(n.text)});`);
    else if (n.kind === 'var') out.push(`out.push(H.esc(H.txt(${pathExpression(n.path)})));`);
    else if (n.kind === 'raw') out.push(`out.push(H.txt(${pathExpression(n.path)}));`);
    else if (n.kind === 'if') {
      out.push(`if(${n.not ? '!' : ''}H.tr(${pathExpression(n.path)})){`);
      emitCode(n.then, out);
      if (n.else !== null) {
        out.push('}else{');
        emitCode(n.else, out);
      }
      out.push('}');
    } else if (n.kind === 'for') {
      const nm = JSON.stringify(n.name);
      out.push(`{const _xs=${pathExpression(n.path)};if(Array.isArray(_xs)){const _hn=Object.hasOwn(S,${nm});const _on=S[${nm}];const _hl=Object.hasOwn(S,"loop");const _ol=S.loop;const _lo={index:0,first:false,last:false,length:_xs.length};S.loop=_lo;for(let _i=0;_i<_xs.length;_i++){S[${nm}]=_xs[_i];_lo.index=_i+1;_lo.first=_i===0;_lo.last=_i===_xs.length-1;`);
      emitCode(n.body, out);
      out.push(`}if(_hl)S.loop=_ol;else delete S.loop;if(_hn)S[${nm}]=_on;else delete S[${nm}];}}`);
    } else if (n.kind === 'include') {
      out.push(`{if(depth<8){const _f=F[${JSON.stringify(n.name)}];if(_f)_f(out,S,depth+1);}}`);
    }
  }
}

function compileTemplate(nodes, templates) {
  const parts = ['let _v;'];
  emitCode(nodes, parts);
  const factory = new Function('H', 'F', `return function(out,S,depth){\n${parts.join('\n')}\n}`);
  return factory(TEMPLATE_HELPERS, templates);
}

/** Tree-walking fallback, used only when a template cannot be compiled. */
function renderNodesSlow(nodes, out, S, depth, F) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(htmlEscape(valueAsText(scopeLookup(S, n.path))));
        break;
      case 'raw':
        out.push(valueAsText(scopeLookup(S, n.path)));
        break;
      case 'if': {
        const v = isTruthy(scopeLookup(S, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodesSlow(branch, out, S, depth, F);
        break;
      }
      case 'for': {
        const xs = scopeLookup(S, n.path);
        if (!Array.isArray(xs)) break;
        const hn = Object.hasOwn(S, n.name);
        const on = S[n.name];
        const hl = Object.hasOwn(S, 'loop');
        const ol = S.loop;
        const lo = { index: 0, first: false, last: false, length: xs.length };
        S.loop = lo;
        for (let k = 0; k < xs.length; k++) {
          S[n.name] = xs[k];
          lo.index = k + 1;
          lo.first = k === 0;
          lo.last = k === xs.length - 1;
          renderNodesSlow(n.body, out, S, depth, F);
        }
        if (hl) S.loop = ol;
        else delete S.loop;
        if (hn) S[n.name] = on;
        else delete S[n.name];
        break;
      }
      case 'include': {
        const f = F[n.name];
        if (f !== undefined && depth < 8) f(out, S, depth + 1);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

function resolveRelative(dirParts, rel) {
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const parentDirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function hasUrlScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const report = [];
  const templates = Object.create(null);
  for (const name of Object.keys(input.templates).sort(compareStrings)) {
    let nodes;
    try {
      nodes = parseTemplate(name, input.templates[name]);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
      continue;
    }
    try {
      templates[name] = compileTemplate(nodes, templates);
    } catch {
      templates[name] = (out, S, depth) => renderNodesSlow(nodes, out, S, depth, templates);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => compareStrings(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = OWN_DIRS.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (templates[layout] === undefined) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? OWN_DIRS : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : parentDirOf(s.path);
    s.slug = takeSlug(s.data.slug ?? slugOf(slugCache, s.data.title), takenIn(dir));
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = parentDirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const srcPath = s.path;
    const link = (target) => {
      if (hasUrlScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolveRelative(dirParts, rel);
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) return `${pg.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${srcPath} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.reading = Math.max(1, Math.ceil(md.words / 200));
  }

  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => compareStrings(y.data.date, x.data.date) || compareStrings(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugOf(slugCache, name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ name, slug });
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || compareStrings(x.slug, y.slug));

  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : dateInWords(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : dateInWords(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.reading,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const fn = templates[name];
    if (fn === undefined) return null;
    const S = { site, tags: allTags, recent, ...vars };
    const out = [];
    fn(out, S, 0);
    return out.join('');
  };
  for (const s of kept) {
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(compareStrings);
  const pagesCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_NAME] = `${lines.join('\n')}\n`;
  return output;
}
