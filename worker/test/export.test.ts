import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context';
import { listExports, parseExportRequest, runExport } from '../src/export/export';
import { setFbDriver } from '../src/platforms/facebook/jobs';
import { QueueRunner } from '../src/queue/runner';
import { addSources } from '../src/sources/service';
import { updateSettings } from '../src/settings';
import { FakeFbDriver, GROUP_ID, GROUP_NAME, GROUP_SLUG, syntheticGroup, userId } from './fixtures/facebook/builders';
import { makeContext } from './helpers';

// The crawl cutoff is computed from the real clock, so the synthetic group is built around it too.
const NOW = Date.now();

/** Minimal RFC 4180 reader for the assertions. */
function readCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const t = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') row.push(cell), (cell = '');
    else if (ch === '\r' && t[i + 1] === '\n') {
      row.push(cell), rows.push(row), (row = []), (cell = ''), i++;
    } else cell += ch;
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i] ?? ''])));
}

describe('JSONL/CSV export', () => {
  let app: AppContext;
  let sourceId: number;

  beforeEach(async () => {
    app = makeContext();
    updateSettings(app.db, { browserTosAcceptedAt: new Date().toISOString() });
    const fake = new FakeFbDriver({ posts: syntheticGroup(NOW), now: NOW });
    setFbDriver(() => fake);
    sourceId = addSources(app, { links: `https://www.facebook.com/groups/${GROUP_SLUG}/`, depthDays: 30 }).added[0]!.id;
    const runner = new QueueRunner(app, 10);
    for (let i = 0; i < 10; i++) {
      await runner.drain();
      app.db.prepare(`UPDATE jobs SET next_run_at = ? WHERE state = 'queued'`).run(new Date(0).toISOString());
    }
  });

  it('writes posts, comments and media as JSONL with the documented fields and pseudonymous authors', () => {
    const res = runExport(app, parseExportRequest({ sourceIds: [sourceId], format: 'jsonl' }));
    expect(res.files).toEqual([
      { file: 'posts.jsonl', rows: 9 },
      { file: 'comments.jsonl', rows: 13 },
      { file: 'media.jsonl', rows: expect.any(Number) },
    ]);
    const posts = fs.readFileSync(path.join(res.dir, 'posts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const comments = fs.readFileSync(path.join(res.dir, 'comments.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(posts[0]).toMatchObject({ platform: 'facebook', container_id: GROUP_ID, container_name: GROUP_NAME, source_ids: [sourceId] });
    expect(posts.every((p) => (p.author_kind === 'person' ? /^u_[0-9a-f]{16}$/.test(p.author_id) && p.author_name === null : true))).toBe(true);
    expect(posts.map((p) => p.published_at)).toEqual([...posts.map((p) => p.published_at)].sort());
    // Every reply points to a parent that is in the same export.
    const ids = new Set(comments.map((c) => c.comment_id));
    for (const c of comments) if (c.parent_comment_id) expect(ids.has(c.parent_comment_id)).toBe(true);
    expect(comments.some((c) => c.depth === 2 && c.root_comment_id)).toBe(true);
    const all = fs.readdirSync(res.dir).map((f) => fs.readFileSync(path.join(res.dir, f), 'utf8')).join('\n');
    for (let n = 1; n <= 9; n++) expect(all).not.toContain(userId(n));
    expect(all).not.toMatch(/Synthetic Person|profile\.php|synthetic\.uploader/);
    const manifest = JSON.parse(fs.readFileSync(path.join(res.dir, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ format_version: 1, filter: { source_ids: [sourceId], format: 'jsonl' } });
    expect(listExports(app)[0]?.name).toBe(res.name);
  });

  it('writes CSV that a spreadsheet opens safely, with the same rows', () => {
    // A comment text that a spreadsheet would run as a formula, plus quotes, commas and a newline.
    app.db.prepare(`UPDATE comments SET text = ? WHERE id = (SELECT MIN(id) FROM comments)`).run('=HYPERLINK("x"),\nline 2');
    const res = runExport(app, { sourceIds: null, from: null, to: null, format: 'csv' });
    const raw = fs.readFileSync(path.join(res.dir, 'comments.csv'), 'utf8');
    expect(raw.startsWith('\uFEFFplatform,comment_id,')).toBe(true);
    const rows = readCsv(raw);
    expect(rows).toHaveLength(13);
    expect(rows.find((r) => r.text?.includes('HYPERLINK'))?.text).toBe(`'=HYPERLINK("x"),\nline 2`);
    const posts = readCsv(fs.readFileSync(path.join(res.dir, 'posts.csv'), 'utf8'));
    expect(posts).toHaveLength(9);
    expect(JSON.parse(posts[0]!.reactions ?? 'null')).toEqual(expect.any(Object));
  });

  it('filters by publication time and rejects bad input', () => {
    const from = new Date(NOW - 7 * 86400_000).toISOString();
    const res = runExport(app, parseExportRequest({ from, format: 'jsonl' }));
    const posts = fs.readFileSync(path.join(res.dir, 'posts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.length).toBeLessThan(9);
    expect(posts.every((p) => p.published_at >= from)).toBe(true);
    const none = runExport(app, parseExportRequest({ to: '2000-01-01T00:00:00Z' }));
    expect(none.files.map((f) => f.rows)).toEqual([0, 0, 0]);
    expect(() => parseExportRequest({ format: 'xml' })).toThrow();
    expect(() => parseExportRequest({ from: 'yesterday' })).toThrow();
    expect(() => parseExportRequest({ sourceIds: ['1'] })).toThrow();
  });
});
