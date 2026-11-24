// main.ts is mend, the CLI SPEC.md specifies (MIT, kit starter + this implementation).
// It does all of SPEC.md: the command line, output and exit codes, safe paths, format
// detection, the three matching tiers, unified diffs, SEARCH/REPLACE blocks, V4A patches,
// JSON edits and the all-or-nothing write. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** Successful move edits, as [old, new] pairs, for the `R` output lines (section 2). */
const MOVES: Array<[string, string]> = [];

/** A file's lines with its own line break and whether it ends with one (section 3). */
interface FileState {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const strip = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstrip(a) === rstrip(b);
  return strip(a) === strip(b);
}

/** Every 0-based position where O occurs in `lines` at `tier`, at or after `from`. */
function occurrences(o: string[], lines: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(o[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) with an occurrence at or after `from`. */
function findTier(o: string[], lines: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrences(o, lines, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** Tier-2 re-indentation (section 5): replace a leading P with F on a non-blank line. */
function reindent(line: string, f: string, p: string): string {
  if (line === '' || line.trim() === '') return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

/** One body op: a context line, an old line, or a new line. */
type Op = { kind: 'ctx' | 'old' | 'new'; text: string };

/**
 * Replace the O lines at position `i` with the ops' N lines. Context lines are written
 * as the file's own matched lines; at tier 2 the new lines are re-indented (section 5).
 * O must be non-empty and `i` a valid occurrence start.
 */
function applyOps(lines: string[], i: number, ops: Op[], tier: number): string[] {
  const out = lines.slice();
  const oLines = ops.filter((o) => o.kind !== 'new').map((o) => o.text);
  const f = leadingWs(lines[i]!);
  const p = leadingWs(oLines[0]!);
  const repl: string[] = [];
  let oi = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      repl.push(lines[i + oi]!);
      oi += 1;
    } else if (op.kind === 'old') {
      oi += 1;
    } else {
      repl.push(tier === 2 ? reindent(op.text, f, p) : op.text);
    }
  }
  out.splice(i, oLines.length, ...repl);
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

type Edit = (tree: Tree) => void;

/* ---------------- Unified diffs (section 6) ---------------- */

interface Hunk {
  a: number;
  ops: Op[];
  /** A `\` line follows the hunk's last context or `+` line (for the final-break rule). */
  backslashAfterLast: boolean;
  /** A `\` line follows the hunk's last `+` line, or null when it has no `+` line. */
  lastNewBackslash: boolean | null;
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` / `+++ ` line: after the four characters, up to the first tab, trimmed, without a leading a/ or b/. */
function dashPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function renamePath(rest: string): string {
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  return rest.trim();
}

function parseHunkHeader(line: string, idx: number): { a: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) throw new Exit2(`error: parse ${idx + 1}`);
  return { a: parseInt(m[1]!, 10) };
}

type BodyItem = { kind: 'ctx' | 'old' | 'new' | 'backslash'; text: string };

/** A hunk body starting at `start`: its ops and backslash flags, and the index where it ends. */
function collectBody(lines: string[], start: number): { ops: Op[]; backslashAfterLast: boolean; lastNewBackslash: boolean | null; end: number } {
  const items: BodyItem[] = [];
  let j = start;
  const n = lines.length;
  while (j < n) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      items.push({ kind: 'ctx', text: '' });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      items.push({ kind: 'ctx', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '-') {
      items.push({ kind: 'old', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '+') {
      items.push({ kind: 'new', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '\\') {
      items.push({ kind: 'backslash', text: l.slice(1) });
      j++;
      continue;
    }
    break;
  }
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') items.pop();
    else break;
  }
  const ops: Op[] = items
    .filter((it) => it.kind !== 'backslash')
    .map((it) => ({ kind: it.kind as 'ctx' | 'old' | 'new', text: it.text }));
  let backslashAfterLast = false;
  let lastNewBackslash: boolean | null = null;
  let lastIdx = -1;
  let lastNewIdx = -1;
  for (let k = 0; k < items.length; k++) {
    if (items[k]!.kind === 'ctx' || items[k]!.kind === 'new') lastIdx = k;
    if (items[k]!.kind === 'new') lastNewIdx = k;
  }
  if (lastIdx >= 0) backslashAfterLast = items[lastIdx + 1]?.kind === 'backslash';
  if (lastNewIdx >= 0) lastNewBackslash = items[lastNewIdx + 1]?.kind === 'backslash';
  return { ops, backslashAfterLast, lastNewBackslash, end: j };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const sections: USection[] = [];
  let i = 0;
  let cur: USection | null = null;
  let inHeader = false;
  while (i < n) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ \t]+) b\/([^ \t]+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { gitOld: m[1]!, gitNew: m[2]!, pairOld: null, pairNew: null, renameFrom: null, renameTo: null, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (!inHeader && line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = { gitOld: null, gitNew: null, pairOld: dashPath(line), pairNew: dashPath(lines[i + 1]!), renameFrom: null, renameTo: null, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.pairOld = dashPath(line);
        cur.pairNew = dashPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (line.startsWith('+++ ')) {
        if (cur.pairNew === null) cur.pairNew = dashPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (cur.renameFrom === null) cur.renameFrom = renamePath(line.slice(12));
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (cur.renameTo === null) cur.renameTo = renamePath(line.slice(10));
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        const h = parseHunkHeader(line, i);
        const body = collectBody(lines, i + 1);
        cur.hunks.push({ a: h.a, ops: body.ops, backslashAfterLast: body.backslashAfterLast, lastNewBackslash: body.lastNewBackslash });
        inHeader = false;
        i = body.end;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const h = parseHunkHeader(line, i);
      const body = collectBody(lines, i + 1);
      cur.hunks.push({ a: h.a, ops: body.ops, backslashAfterLast: body.backslashAfterLast, lastNewBackslash: body.lastNewBackslash });
      i = body.end;
      continue;
    }
    i++;
  }
  return sections.map((sec) => unifiedEdit(sec, strict));
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    let oldP = sec.pairOld ?? sec.renameFrom ?? sec.gitOld;
    let newP = sec.pairNew ?? sec.renameTo ?? sec.gitNew;
    if (oldP === '/dev/null') oldP = null;
    if (newP === '/dev/null') newP = null;
    const isCreate = oldP === null || sec.newFile;
    const isDelete = newP === null || sec.deletedFile;
    if (isCreate) {
      const p = newP;
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const op of h.ops) if (op.kind === 'new') plus.push(op.text);
      if (plus.length === 0) {
        tree.now.set(p, '');
        return;
      }
      let noBreak = false;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        const b = sec.hunks[k]!.lastNewBackslash;
        if (b !== null) {
          noBreak = b;
          break;
        }
      }
      tree.now.set(p, plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP;
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldPath = oldP!;
    const newPath = newP!;
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (oldPath !== newPath && !safe(newPath)) throw new Fail('unsafe', newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (oldPath !== newPath && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    let st = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const oLines = h.ops.filter((o) => o.kind !== 'new').map((o) => o.text);
      const nLines = h.ops.filter((o) => o.kind !== 'old').map((o) => o.text);
      if (oLines.length === 0) {
        let idx = h.a + d;
        if (idx < 0) idx = 0;
        if (idx > st.lines.length) idx = st.lines.length;
        const atEnd = idx === st.lines.length;
        st.lines.splice(idx, 0, ...nLines);
        if (atEnd) st.final = !h.backslashAfterLast;
        d += nLines.length;
      } else {
        const found = findTier(oLines, st.lines, strict);
        if (!found) throw new Fail('no-match', oldPath);
        const target = h.a - 1 + d;
        let best = found.pos[0]!;
        let bestDist = Math.abs(best - target);
        for (const p of found.pos) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
        const reachesEnd = best + oLines.length === st.lines.length;
        st.lines = applyOps(st.lines, best, h.ops, found.tier);
        if (reachesEnd) st.final = !h.backslashAfterLast;
        d += nLines.length - oLines.length;
      }
    }
    const content = joinFile(st);
    if (oldPath !== newPath) {
      tree.now.set(newPath, content);
      tree.now.set(oldPath, null);
      MOVES.push([oldPath, newPath]);
    } else {
      tree.now.set(oldPath, content);
    }
  };
}

/* ---------------- SEARCH/REPLACE blocks (section 7) ---------------- */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const edits: Edit[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let prevEnd = 0;
  while (true) {
    let s = -1;
    for (let k = i; k < n; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        s = k;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let k = s - 1; k >= prevEnd; k--) {
      const t = lines[k]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = s + 1; k < n; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${s + 1}`);
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < n; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${s + 1}`);
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const content = tree.get(p);
      if (content === null) throw new Fail('missing', p);
      const st = splitFile(content);
      const found = findTier(oldLines, st.lines, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const at = found.pos[0]!;
      const f = leadingWs(st.lines[at]!);
      const pp = leadingWs(oldLines[0]!);
      const repl = newLines.map((l) => (found.tier === 2 ? reindent(l, f, pp) : l));
      st.lines.splice(at, oldLines.length, ...repl);
      tree.now.set(p, joinFile(st));
    });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/* ---------------- V4A patches (section 8) ---------------- */

interface V4AChunk {
  anchor: string | null;
  ops: Op[];
  endAnchored: boolean;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const fileLines: string[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (l === '') {
          fileLines.push('');
          i++;
          continue;
        }
        if (l.startsWith('+')) {
          fileLines.push(l.slice(1));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      const p = path;
      const fl = fileLines;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fl.length === 0 ? '' : fl.join('\n') + '\n');
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      let firstLine = true;
      let seenChunk = false;
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last && !isSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (firstLine && l.startsWith('*** Move to: ')) {
          moveTo = l.slice('*** Move to: '.length).trim();
          firstLine = false;
          i++;
          continue;
        }
        firstLine = false;
        if (l.startsWith('@@')) {
          closeChunk();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, ops: [], endAnchored: false };
          seenChunk = true;
          i++;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.endAnchored = true;
          closeChunk();
          i++;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (seenChunk) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, ops: [], endAnchored: false };
            seenChunk = true;
          }
          if (l === '') cur.ops.push({ kind: 'ctx', text: '' });
          else if (l.startsWith(' ')) cur.ops.push({ kind: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) cur.ops.push({ kind: 'old', text: l.slice(1) });
          else cur.ops.push({ kind: 'new', text: l.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur !== null) {
        while (cur.ops.length > 0) {
          const o = cur.ops[cur.ops.length - 1]!;
          if (o.kind === 'ctx' && o.text === '') cur.ops.pop();
          else break;
        }
        chunks.push(cur);
        cur = null;
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      const p = path;
      const mt = moveTo;
      const ch = chunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const content = tree.get(p);
        if (content === null) throw new Fail('missing', p);
        if (mt !== null) {
          if (tree.get(mt) !== null) throw new Fail('exists', mt);
        }
        const st = splitFile(content);
        let cursor = 0;
        for (const chunk of ch) {
          if (chunk.anchor !== null) {
            const f = findTier([chunk.anchor], st.lines, strict, cursor);
            if (!f) throw new Fail('no-match', p);
            cursor = f.pos[0]! + 1;
          }
          const oLines = chunk.ops.filter((o) => o.kind !== 'new').map((o) => o.text);
          const nLines = chunk.ops.filter((o) => o.kind !== 'old').map((o) => o.text);
          if (oLines.length === 0) {
            const idx = chunk.endAnchored ? st.lines.length : cursor;
            st.lines.splice(idx, 0, ...nLines);
            cursor = idx + nLines.length;
          } else {
            const found = findTier(oLines, st.lines, strict, cursor);
            if (!found) throw new Fail('no-match', p);
            let pos = -1;
            for (const pp of found.pos) {
              if (chunk.endAnchored) {
                if (pp + oLines.length === st.lines.length) {
                  pos = pp;
                  break;
                }
              } else {
                pos = pp;
                break;
              }
            }
            if (pos < 0) throw new Fail('no-match', p);
            st.lines = applyOps(st.lines, pos, chunk.ops, found.tier);
            cursor = pos + nLines.length;
          }
        }
        const out = joinFile(st);
        if (mt !== null) {
          tree.now.set(mt, out);
          tree.now.set(p, null);
          MOVES.push([p, mt]);
        } else {
          tree.now.set(p, out);
        }
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of MOVES) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of changed) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of changed.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
