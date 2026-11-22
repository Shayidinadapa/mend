// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
  readonly moves: Array<[string, string]> = [];
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

type Edit = (tree: Tree) => void;

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

// ---------- SPEC.md section 3: a file's lines, break and final break ----------
interface FileParts { lines: string[]; br: string; ends: boolean; }
function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}
function joinFile(f: FileParts): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

// ---------- SPEC.md section 5: matching lines at three tiers ----------
const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => { const m = /^[ \t]*/.exec(s); return m ? m[0] : ''; };
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}
/** Occurrences of the non-empty O in file lines, at the first tier with at least one (tier 0 only when strict). */
function findOccurrences(file: string[], O: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos: number[] = [];
    for (let i = 0; i + O.length <= file.length; i++) {
      let ok = true;
      for (let k = 0; k < O.length; k++) {
        if (!lineEq(file[i + k]!, O[k]!, tier)) { ok = false; break; }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}
/** The replacement lines for N at a match at pos, tier. nToO maps each N index to its O index (context) or null. */
function buildReplacement(file: string[], O: string[], N: string[], nToO: (number | null)[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const F = tier === 2 ? leadWs(file[pos] ?? '') : '';
  const P = tier === 2 ? leadWs(O[0] ?? '') : '';
  for (let j = 0; j < N.length; j++) {
    const oIdx = nToO[j];
    if (oIdx !== null && oIdx !== undefined) {
      out.push(file[pos + oIdx]!);
    } else {
      let line = N[j]!;
      if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(P)) line = F + line.slice(P.length);
      out.push(line);
    }
  }
  return out;
}

/** One unified hunk or V4A chunk: O and N with the context mapping, and whether a `\` line follows the last context/`+` line (noFinal) or the last `+` line (noFinalPlus). */
interface Hunk {
  A: number;
  O: string[];
  N: string[];
  nToO: (number | null)[];
  noFinal: boolean;
  noFinalPlus: boolean;
}
/** Apply one hunk to a file. d is the line shift from this section's earlier hunks. */
function applyHunk(f: FileParts, h: Hunk, d: number, strict: boolean, path: string): FileParts {
  if (h.O.length > 0) {
    const found = findOccurrences(f.lines, h.O, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.A - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) { best = p; bestDist = dist; }
    }
    const rep = buildReplacement(f.lines, h.O, h.N, h.nToO, best, found.tier);
    const lines = [...f.lines.slice(0, best), ...rep, ...f.lines.slice(best + h.O.length)];
    const ends = best + h.O.length === f.lines.length ? !h.noFinal : f.ends;
    return { lines, br: f.br, ends };
  }
  const ins = Math.max(0, Math.min(h.A + d, f.lines.length));
  const lines = [...f.lines.slice(0, ins), ...h.N, ...f.lines.slice(ins)];
  const ends = ins === f.lines.length ? !h.noFinal : f.ends;
  return { lines, br: f.br, ends };
}

// ---------- SPEC.md section 6: unified diffs ----------
interface UniSection {
  oldP: string | null;
  newP: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hasPair: boolean;
  hunks: Hunk[];
}
/** A `---`/`+++` path: text after the four characters, up to the first tab, surrounding spaces removed; `/dev/null` is no file; a leading `a/` or `b/` is removed. */
function cleanUniPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const diffRe = /^diff --git a\/(.+?) b\/(.+?)\s*$/;
  let cur: UniSection | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const n = i + 1;
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${n}`);
      cur = { oldP: m[1]!, newP: m[2]!, isCreate: false, isDelete: false, hasPair: false, hunks: [] };
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${n}`);
      const m = hunkRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${n}`);
      const A = parseInt(m[1]!, 10);
      const body: Array<{ type: string; text: string }> = [];
      i++;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') { body.push({ type: 'ctx', text: '' }); i++; continue; }
        const c = bl[0]!;
        if (c === ' ') { body.push({ type: 'ctx', text: bl.slice(1) }); i++; continue; }
        if (c === '-') { body.push({ type: 'old', text: bl.slice(1) }); i++; continue; }
        if (c === '+') { body.push({ type: 'new', text: bl.slice(1) }); i++; continue; }
        if (c === '\\') { body.push({ type: 'backslash', text: bl.slice(1) }); i++; continue; }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.type === 'ctx' && body[body.length - 1]!.text === '') body.pop();
      const O: string[] = [];
      const N: string[] = [];
      const nToO: (number | null)[] = [];
      for (const item of body) {
        if (item.type === 'ctx') { nToO.push(O.length); O.push(item.text); N.push(item.text); }
        else if (item.type === 'old') O.push(item.text);
        else if (item.type === 'new') { nToO.push(null); N.push(item.text); }
      }
      let lastCtxNew = -1;
      let lastNew = -1;
      for (let k = 0; k < body.length; k++) {
        if (body[k]!.type === 'ctx' || body[k]!.type === 'new') lastCtxNew = k;
        if (body[k]!.type === 'new') lastNew = k;
      }
      const noFinal = lastCtxNew >= 0 && body[lastCtxNew + 1] !== undefined && body[lastCtxNew + 1]!.type === 'backslash';
      const noFinalPlus = lastNew >= 0 && body[lastNew + 1] !== undefined && body[lastNew + 1]!.type === 'backslash';
      cur.hunks.push({ A, O, N, nToO, noFinal, noFinalPlus });
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && !cur.hasPair) {
        cur.oldP = cleanUniPath(line.slice(4));
        cur.newP = cleanUniPath(lines[i + 1]!.slice(4));
        cur.hasPair = true;
      } else {
        cur = { oldP: cleanUniPath(line.slice(4)), newP: cleanUniPath(lines[i + 1]!.slice(4)), isCreate: false, isDelete: false, hasPair: true, hunks: [] };
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${n + 1}`);
      if (line.startsWith('rename from ') && !cur.hasPair) { cur.oldP = cleanUniPath(line.slice(12)); i++; continue; }
      if (line.startsWith('rename to ') && !cur.hasPair) { cur.newP = cleanUniPath(line.slice(10)); i++; continue; }
      if (line.startsWith('new file mode')) { cur.isCreate = true; i++; continue; }
      if (line.startsWith('deleted file mode')) { cur.isDelete = true; i++; continue; }
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => sectionToEdit(s, strict));
}
function sectionToEdit(s: UniSection, strict: boolean): Edit {
  const oldP = s.oldP;
  const newP = s.newP;
  const isCreate = s.isCreate || oldP === null;
  const isDelete = !isCreate && (s.isDelete || newP === null);
  if (isCreate && newP !== null) {
    const np = newP;
    return (tree) => {
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let noFinalPlus = false;
      for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const h = s.hunks[hi]!;
        let hasPlus = false;
        for (let j = 0; j < h.N.length; j++) {
          if (h.nToO[j] === null) { hasPlus = true; break; }
        }
        if (hasPlus) { noFinalPlus = h.noFinalPlus; break; }
      }
      for (const h of s.hunks) {
        for (let j = 0; j < h.N.length; j++) {
          if (h.nToO[j] === null) plus.push(h.N[j]!);
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noFinalPlus ? '' : '\n'));
    };
  }
  if (isDelete && oldP !== null) {
    const op = oldP;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
    };
  }
  if (!isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP) {
    const op = oldP;
    const np = newP;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      let f = splitFile(before);
      let d = 0;
      for (const h of s.hunks) {
        f = applyHunk(f, h, d, strict, op);
        d += h.N.length - h.O.length;
      }
      tree.now.set(np, joinFile(f));
      tree.now.set(op, null);
      tree.moves.push([op, np]);
    };
  }
  if (!isCreate && !isDelete && oldP !== null && newP !== null) {
    const p = oldP;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      let f = splitFile(before);
      let d = 0;
      for (const h of s.hunks) {
        f = applyHunk(f, h, d, strict, p);
        d += h.N.length - h.O.length;
      }
      tree.now.set(p, joinFile(f));
    };
  }
  return (_tree) => { /* a section naming no file: nothing to do */ };
}

// ---------- SPEC.md section 7: SEARCH/REPLACE blocks ----------
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eqIdx = -1;
    let repIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trimEnd() === '<<<<<<< SEARCH') break;
      if (eqIdx < 0 && l.trimEnd() === '=======') { eqIdx = j; continue; }
      if (eqIdx >= 0 && l.trimEnd() === '>>>>>>> REPLACE') { repIdx = j; break; }
    }
    if (eqIdx < 0 || repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplaceEnd = repIdx;
    i = repIdx + 1;
  }
  return edits;
}
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  const p = path;
  const O = [...oldLines];
  const N = [...newLines];
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (O.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, N.length === 0 ? '' : N.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const f = splitFile(before);
    const found = findOccurrences(f.lines, O, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.pos.length > 1) throw new Fail('ambiguous', p);
    const pos = found.pos[0]!;
    const nToO: (number | null)[] = N.map(() => null);
    const rep = buildReplacement(f.lines, O, N, nToO, pos, found.tier);
    const lines = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + O.length)];
    tree.now.set(p, joinFile({ lines, br: f.br, ends: f.ends }));
  };
}

// ---------- SPEC.md section 8: V4A patches ----------
interface V4aChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}
function chunkON(body: string[]): { O: string[]; N: string[]; nToO: (number | null)[] } {
  const O: string[] = [];
  const N: string[] = [];
  const nToO: (number | null)[] = [];
  for (const l of body) {
    if (l === '' || l.startsWith(' ')) {
      const t = l.slice(1);
      nToO.push(O.length);
      O.push(t);
      N.push(t);
    } else if (l.startsWith('-')) O.push(l.slice(1));
    else if (l.startsWith('+')) { nToO.push(null); N.push(l.slice(1)); }
  }
  return { O, N, nToO };
}
function parseV4a(lines: string[], strict: boolean): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!blank(lines[i]!)) { first = i; break; }
  }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ') || l.trim() === '*** End Patch';
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i++; continue; }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const startIdx = i;
      i++;
      const secLines: string[] = [];
      while (i < last && !isSectionStart(lines[i]!)) { secLines.push(lines[i]!); i++; }
      while (secLines.length > 0 && blank(secLines[secLines.length - 1]!)) secLines.pop();
      const fileLines: string[] = [];
      for (let k = 0; k < secLines.length; k++) {
        const l = secLines[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${startIdx + 2 + k}`);
      }
      edits.push(v4aAddEdit(p, fileLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      edits.push(v4aDeleteEdit(p));
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const updateLineNo = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const secLines: Array<{ text: string; no: number }> = [];
      while (i < last && !isSectionStart(lines[i]!)) { secLines.push({ text: lines[i]!, no: i + 1 }); i++; }
      while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
      const chunks: V4aChunk[] = [];
      let curChunk: V4aChunk | null = null;
      for (const { text: l, no } of secLines) {
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          curChunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          chunks.push(curChunk);
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (curChunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${no}`);
            curChunk = { anchor: null, body: [], eof: false };
            chunks.push(curChunk);
          }
          curChunk.body.push(l);
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${no}`);
          curChunk.eof = true;
          curChunk = null;
          continue;
        }
        throw new Exit2(`error: parse ${no}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}
function v4aAddEdit(path: string, fileLines: string[]): Edit {
  const p = path;
  const text = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, text);
  };
}
function v4aDeleteEdit(path: string): Edit {
  const p = path;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
  };
}
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  const p = path;
  const np = moveTo;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (np !== null && !safe(np)) throw new Fail('unsafe', np);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (np !== null && tree.get(np) !== null) throw new Fail('exists', np);
    let f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      const { O, N, nToO } = chunkON(ch.body);
      if (ch.anchor !== null) {
        const anchor = ch.anchor;
        let foundAt = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          for (let k = cursor; k < f.lines.length; k++) {
            if (lineEq(f.lines[k]!, anchor, tier)) { foundAt = k; break; }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', p);
        cursor = foundAt + 1;
      }
      if (O.length > 0) {
        const tiers = strict ? [0] : [0, 1, 2];
        let foundTier = -1;
        let foundPos = -1;
        for (const tier of tiers) {
          for (let k = cursor; k + O.length <= f.lines.length; k++) {
            let ok = true;
            for (let m = 0; m < O.length; m++) {
              if (!lineEq(f.lines[k + m]!, O[m]!, tier)) { ok = false; break; }
            }
            if (!ok) continue;
            if (ch.eof && k + O.length !== f.lines.length) continue;
            foundTier = tier;
            foundPos = k;
            break;
          }
          if (foundPos >= 0) break;
        }
        if (foundPos < 0) throw new Fail('no-match', p);
        const rep = buildReplacement(f.lines, O, N, nToO, foundPos, foundTier);
        const lines = [...f.lines.slice(0, foundPos), ...rep, ...f.lines.slice(foundPos + O.length)];
        f = { lines, br: f.br, ends: f.ends };
        cursor = foundPos + rep.length;
      } else {
        const ins = ch.eof ? f.lines.length : cursor;
        const lines = [...f.lines.slice(0, ins), ...N, ...f.lines.slice(ins)];
        f = { lines, br: f.br, ends: f.ends };
        cursor = ins + N.length;
      }
    }
    if (np !== null) {
      tree.now.set(np, joinFile(f));
      tree.now.set(p, null);
      tree.moves.push([p, np]);
    } else {
      tree.now.set(p, joinFile(f));
    }
  };
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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? parseUnified(lines, strict) : kind === 'search-replace' ? parseSearchReplace(lines, strict) : kind === 'v4a' ? parseV4a(lines, strict) : [];
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
  const rByNew = new Map<string, string>();
  const suppressed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rByNew.set(newP, oldP);
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  const allRows: Array<{ key: string; text: string }> = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (suppressed.has(p)) continue;
    allRows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [newP, oldP] of rByNew) allRows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
  allRows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = allRows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
