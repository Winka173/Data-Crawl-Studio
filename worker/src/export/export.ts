import fs from 'node:fs';
import path from 'node:path';
import type { ExportFormat, ExportView } from '../../../shared/contracts';
import type { AppContext } from '../context';
import { HttpError } from '../accounts';
import { log } from '../log';

// JSONL/CSV export per source and time range. Field names here are a public contract (docs/API.md);
// add fields freely, never rename or remove one without bumping EXPORT_FORMAT_VERSION.

export const EXPORT_FORMAT_VERSION = 1;

export interface ExportRequest {
  /** null = every source */
  sourceIds: number[] | null;
  /** Posts published at or after this UTC ISO time (inclusive). */
  from: string | null;
  /** Posts published before this UTC ISO time (exclusive). */
  to: string | null;
  format: ExportFormat;
}

export type ExportResult = ExportView;

type Row = Record<string, unknown>;

const POST_FIELDS = [
  'platform', 'post_id', 'source_ids', 'container_id', 'container_name', 'post_type', 'url',
  'author_kind', 'author_id', 'author_name', 'title', 'text', 'published_at', 'edited_at', 'is_edited',
  'like_count', 'reaction_count', 'reactions', 'comment_count', 'comments_stored', 'share_count', 'view_count',
  'duration_seconds', 'tags', 'first_seen_at', 'last_seen_at', 'unavailable_at', 'unavailable_reason',
] as const;

const COMMENT_FIELDS = [
  'platform', 'comment_id', 'post_id', 'parent_comment_id', 'root_comment_id', 'depth',
  'author_kind', 'author_id', 'author_name', 'text', 'published_at', 'edited_at', 'is_edited',
  'like_count', 'reply_count', 'reactions', 'first_seen_at', 'last_seen_at', 'unavailable_at',
] as const;

const MEDIA_FIELDS = ['platform', 'owner_type', 'owner_id', 'position', 'media_type', 'url', 'width', 'height', 'duration_seconds', 'alt_text', 'caption'] as const;

const json = (v: unknown): unknown => (typeof v === 'string' && v ? JSON.parse(v) : null);

/** People are only ever a pseudonym; public entities keep their id and name. */
function author(r: Row): { author_kind: unknown; author_id: unknown; author_name: unknown } {
  return r.author_kind === 'person'
    ? { author_kind: 'person', author_id: r.author_pseudonym, author_name: null }
    : { author_kind: r.author_kind, author_id: r.author_entity_id ?? null, author_name: r.author_entity_name ?? null };
}

function postRow(r: Row): Row {
  return {
    platform: r.platform,
    post_id: r.platform_id,
    source_ids: String(r.source_ids ?? '').split(',').filter(Boolean).map(Number),
    container_id: r.container_id,
    container_name: r.container_name,
    post_type: r.post_type,
    url: r.url,
    ...author(r),
    title: r.title,
    text: r.text,
    published_at: r.published_at,
    edited_at: r.edited_at,
    is_edited: r.is_edited === 1,
    like_count: r.like_count,
    reaction_count: r.reaction_count,
    reactions: json(r.reactions_json),
    comment_count: r.comment_count,
    comments_stored: r.comments_stored,
    share_count: r.share_count,
    view_count: r.view_count,
    duration_seconds: r.duration_seconds,
    tags: json(r.tags_json),
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    unavailable_at: r.unavailable_at,
    unavailable_reason: r.unavailable_reason,
  };
}

function commentRow(r: Row): Row {
  return {
    platform: r.platform,
    comment_id: r.platform_id,
    post_id: r.post_platform_id,
    parent_comment_id: r.parent_platform_id ?? null,
    root_comment_id: r.root_platform_id ?? null,
    depth: r.depth,
    ...author(r),
    text: r.text,
    published_at: r.published_at,
    edited_at: r.edited_at,
    is_edited: r.is_edited === 1,
    like_count: r.like_count,
    reply_count: r.reply_count,
    reactions: json(r.reactions_json),
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    unavailable_at: r.unavailable_at,
  };
}

// ---- writers ----------------------------------------------------------------------------------

/** Cells a spreadsheet would run as a formula get a leading apostrophe (CSV only; JSONL keeps the exact text). */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^-\s/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

class Writer {
  private fd: number;
  rows = 0;
  constructor(readonly file: string, private readonly format: ExportFormat, private readonly fields: readonly string[]) {
    this.fd = fs.openSync(file, 'w');
    // A BOM lets Excel read UTF-8 (Vietnamese text) correctly; JSONL stays plain UTF-8.
    if (format === 'csv') fs.writeSync(this.fd, `\uFEFF${fields.join(',')}\r\n`);
  }
  write(row: Row): void {
    const line = this.format === 'jsonl' ? `${JSON.stringify(row)}\n` : `${this.fields.map((f) => csvCell(row[f])).join(',')}\r\n`;
    fs.writeSync(this.fd, line);
    this.rows++;
  }
  close(): void {
    fs.closeSync(this.fd);
  }
}

// ---- export ----------------------------------------------------------------------------------

function validIso(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new HttpError(400, `${field} must be an ISO date`);
  return new Date(v).toISOString();
}

export function parseExportRequest(body: unknown): ExportRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  const format = b.format ?? 'jsonl';
  if (format !== 'jsonl' && format !== 'csv') throw new HttpError(400, 'format must be jsonl or csv');
  let sourceIds: number[] | null = null;
  if (b.sourceIds !== undefined && b.sourceIds !== null) {
    if (!Array.isArray(b.sourceIds) || !b.sourceIds.every((x) => Number.isInteger(x))) throw new HttpError(400, 'sourceIds must be a list of ids');
    sourceIds = b.sourceIds as number[];
  }
  return { sourceIds, from: validIso(b.from, 'from'), to: validIso(b.to, 'to'), format };
}

export function runExport(app: AppContext, req: ExportRequest): ExportResult {
  const db = app.db;
  const createdAt = new Date().toISOString();
  const name = `export-${createdAt.replace(/[:.]/g, '-')}`;
  const dir = path.join(app.paths.exportsDir, name);
  fs.mkdirSync(dir, { recursive: true });

  // Posts of the chosen sources and range, collected into a temp table so comments/media follow them exactly.
  db.exec('DROP TABLE IF EXISTS temp.export_posts; CREATE TEMP TABLE export_posts (id INTEGER PRIMARY KEY)');
  const where: string[] = [];
  const args: unknown[] = [];
  if (req.sourceIds) {
    where.push(`p.id IN (SELECT post_id FROM post_sources WHERE source_id IN (${req.sourceIds.map(() => '?').join(',') || 'NULL'}))`);
    args.push(...req.sourceIds);
  }
  if (req.from) {
    where.push('p.published_at >= ?');
    args.push(req.from);
  }
  if (req.to) {
    where.push('p.published_at < ?');
    args.push(req.to);
  }
  db.prepare(`INSERT INTO temp.export_posts SELECT p.id FROM posts p ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).run(...(args as never[]));

  const ext = req.format;
  const posts = new Writer(path.join(dir, `posts.${ext}`), req.format, POST_FIELDS);
  const comments = new Writer(path.join(dir, `comments.${ext}`), req.format, COMMENT_FIELDS);
  const media = new Writer(path.join(dir, `media.${ext}`), req.format, MEDIA_FIELDS);
  try {
    const postRows = db.prepare(
      `SELECT p.*, (SELECT group_concat(source_id) FROM post_sources ps WHERE ps.post_id = p.id) AS source_ids,
              (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comments_stored
         FROM posts p JOIN temp.export_posts e ON e.id = p.id ORDER BY p.published_at, p.id`,
    );
    for (const r of postRows.iterate() as Iterable<Row>) posts.write(postRow(r));

    const commentRows = db.prepare(
      `SELECT c.*, p.platform_id AS post_platform_id, par.platform_id AS parent_platform_id, root.platform_id AS root_platform_id
         FROM comments c JOIN temp.export_posts e ON e.id = c.post_id JOIN posts p ON p.id = c.post_id
         LEFT JOIN comments par ON par.id = c.parent_id LEFT JOIN comments root ON root.id = c.root_id
        ORDER BY p.published_at, p.id, c.depth, c.published_at, c.id`,
    );
    for (const r of commentRows.iterate() as Iterable<Row>) comments.write(commentRow(r));

    const mediaRows = db.prepare(
      `SELECT m.*, COALESCE(p.platform_id, c.platform_id) AS owner_platform_id FROM media_refs m
         LEFT JOIN posts p ON m.owner_type = 'post' AND p.id = m.owner_id
         LEFT JOIN comments c ON m.owner_type = 'comment' AND c.id = m.owner_id
        WHERE (m.owner_type = 'post' AND m.owner_id IN (SELECT id FROM temp.export_posts))
           OR (m.owner_type = 'comment' AND c.post_id IN (SELECT id FROM temp.export_posts))
        ORDER BY m.owner_type, m.owner_id, m.position`,
    );
    for (const r of mediaRows.iterate() as Iterable<Row>) {
      media.write({
        platform: r.platform, owner_type: r.owner_type, owner_id: r.owner_platform_id, position: r.position, media_type: r.media_type,
        url: r.url, width: r.width, height: r.height, duration_seconds: r.duration_seconds, alt_text: r.alt_text, caption: r.caption,
      });
    }
  } finally {
    posts.close();
    comments.close();
    media.close();
    db.exec('DROP TABLE IF EXISTS temp.export_posts');
  }

  const sources = db
    .prepare(`SELECT id, platform, kind, name, canonical_url, depth_days, last_success_at FROM sources ${req.sourceIds ? `WHERE id IN (${req.sourceIds.map(() => '?').join(',') || 'NULL'})` : ''} ORDER BY id`)
    .all(...((req.sourceIds ?? []) as never[]));
  const files = [posts, comments, media].map((w) => ({ file: path.basename(w.file), rows: w.rows }));
  const manifest = {
    format_version: EXPORT_FORMAT_VERSION,
    app_version: app.version,
    created_at: createdAt,
    filter: { source_ids: req.sourceIds, from: req.from, to: req.to, format: req.format },
    sources,
    files,
    privacy: 'Individuals appear only as pseudonyms (author_id "u_…", @u_… in text). The salt that makes them is never exported.',
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log.info('export written', { name, files });
  return { name, dir, format: req.format, files, createdAt };
}

export function listExports(app: AppContext): ExportResult[] {
  const root = app.paths.exportsDir;
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((n) => fs.existsSync(path.join(root, n, 'manifest.json')))
    .sort()
    .reverse()
    .slice(0, 50)
    .map((n) => {
      const m = JSON.parse(fs.readFileSync(path.join(root, n, 'manifest.json'), 'utf8')) as { created_at: string; files: ExportResult['files']; filter: { format: ExportFormat } };
      return { name: n, dir: path.join(root, n), format: m.filter.format, files: m.files, createdAt: m.created_at };
    });
}
