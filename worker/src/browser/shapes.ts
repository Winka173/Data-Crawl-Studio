import fs from 'node:fs';
import path from 'node:path';

// Structural summaries of the JSON a page receives, written when a parser cannot read it.
// No value is ever kept: only key names (ids and free-form keys are masked), the kind of each value
// and __typename values, so a summary can be shared and turned into a fixture without personal data.

const TYPENAME = /^[A-Z][A-Za-z0-9_]{0,80}$/;
const PLAIN_KEY = /^[A-Za-z_$][A-Za-z0-9_$:.-]{0,60}$/;
const MAX_REL_DEPTH = 8;
const MAX_PATHS_PER_TYPE = 800;
const KEEP_FILES = 10;

export type ShapeSummary = { docs: number; types: Record<string, { seen: number; paths: Record<string, string[]> }> };

function maskKey(k: string): string {
  if (/^\d+$/.test(k)) return '<n>';
  if (!PLAIN_KEY.test(k) || /\d{5,}/.test(k)) return '<k>';
  return k;
}

function kindOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'arr';
  switch (typeof v) {
    case 'string':
      if (/^\d+$/.test(v)) return 'str:digits';
      if (/^https?:\/\//.test(v)) return 'str:url';
      return 'str';
    case 'number':
      return 'num';
    case 'boolean':
      return 'bool';
    case 'object':
      return 'obj';
    default:
      return typeof v;
  }
}

export class ShapeBook {
  private docs = 0;
  private types = new Map<string, { seen: number; paths: Map<string, Set<string>> }>();

  clear(): void {
    this.docs = 0;
    this.types.clear();
  }

  get size(): number {
    return this.docs;
  }

  /** Record the structure of one JSON document. Paths are relative to the nearest object with a __typename. */
  add(doc: unknown): void {
    this.docs++;
    const stack: { v: unknown; anchor: string; rel: string; depth: number }[] = [{ v: doc, anchor: '(root)', rel: '', depth: 0 }];
    let guard = 0;
    while (stack.length && guard++ < 5_000_000) {
      const { v, anchor, rel, depth } = stack.pop()!;
      if (Array.isArray(v)) {
        for (const x of v.slice(0, 50)) stack.push({ v: x, anchor, rel: `${rel}[]`, depth });
        continue;
      }
      if (!v || typeof v !== 'object') continue;
      const o = v as Record<string, unknown>;
      let a = anchor;
      let r = rel;
      let d = depth;
      if (typeof o.__typename === 'string' && TYPENAME.test(o.__typename)) {
        if (rel) this.note(anchor, rel, `@${o.__typename}`);
        a = o.__typename;
        r = '';
        d = 0;
        this.entry(a).seen++;
      }
      // Below MAX_REL_DEPTH leaf paths are no longer recorded, but the walk goes on so deeper typed nodes
      // (and the path that leads to them) are still found.
      for (const [k, child] of Object.entries(o)) {
        const p = r ? `${r}.${maskKey(k)}` : maskKey(k);
        const kind = kindOf(child);
        if (d < MAX_REL_DEPTH && (kind !== 'obj' || child === null)) this.note(a, p, kind === 'arr' && (child as unknown[]).length === 0 ? 'arr:empty' : kind);
        if (child && typeof child === 'object') stack.push({ v: child, anchor: a, rel: p, depth: d + 1 });
      }
    }
  }

  private entry(t: string) {
    let e = this.types.get(t);
    if (!e) this.types.set(t, (e = { seen: 0, paths: new Map() }));
    return e;
  }

  private note(t: string, p: string, kind: string): void {
    const e = this.entry(t);
    let kinds = e.paths.get(p);
    if (!kinds) {
      // Paths to typed nodes are what a parser fix needs most; they may exceed the cap.
      if (e.paths.size >= MAX_PATHS_PER_TYPE && !kind.startsWith('@')) return;
      e.paths.set(p, (kinds = new Set()));
    }
    kinds.add(kind);
  }

  summary(): ShapeSummary {
    const types: ShapeSummary['types'] = {};
    for (const [t, e] of [...this.types.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
      types[t] = { seen: e.seen, paths: Object.fromEntries([...e.paths.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([p, k]) => [p, [...k].sort()])) };
    }
    return { docs: this.docs, types };
  }

  /** Write the summary to `<dir>/<time>-<reason>.json`, keeping the newest few files. Returns the path. */
  write(dir: string, reason: string, extra: Record<string, unknown> = {}): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${reason.replace(/[^\w-]/g, '_').slice(0, 40)}.json`);
    fs.writeFileSync(file, JSON.stringify({ reason, writtenAt: new Date().toISOString(), ...extra, ...this.summary() }, null, 1));
    const old = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse().slice(KEEP_FILES);
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
    return file;
  }
}
