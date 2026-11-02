import crypto from 'node:crypto';
import type { DB } from '../db/db';
import { nowIso } from '../util/time';
import { commentSchema, postSchema, type CommentRecord, type MediaRecord, type PostRecord, type ValidComment, type ValidPost } from './records';

export interface UpsertResult {
  id: number;
  created: boolean;
  changed: boolean;
}

const hash = (v: unknown) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);
const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

interface PostRow {
  id: number;
  title: string | null;
  text: string | null;
  content_hash: string | null;
  [k: string]: unknown;
}

function postColumns(p: ValidPost): Record<string, unknown> {
  return {
    container_id: p.containerId,
    container_name: p.containerName,
    post_type: p.postType,
    url: p.url,
    author_kind: p.author.kind,
    author_entity_id: p.author.kind === 'entity' ? p.author.id : null,
    author_entity_name: p.author.kind === 'entity' ? p.author.name : null,
    author_pseudonym: p.author.kind === 'person' ? p.author.pseudonym : null,
    title: p.title,
    text: p.text,
    published_at: p.publishedAt,
    edited_at: p.editedAt,
    is_edited: p.isEdited ? 1 : 0,
    like_count: p.likeCount,
    comment_count: p.commentCount,
    view_count: p.viewCount,
    share_count: p.shareCount,
    reaction_count: p.reactionCount,
    reactions_json: json(p.reactions),
    duration_seconds: p.durationSeconds,
    tags_json: json(p.tags),
    extra_json: json(p.extra),
    content_hash: hash([p.title, p.text]),
  };
}

const POST_METRICS = ['like_count', 'comment_count', 'view_count', 'share_count', 'reaction_count', 'reactions_json'] as const;
const COMMENT_METRICS = ['like_count', 'reply_count', 'reactions_json'] as const;

/**
 * Idempotent upsert by (platform, platform_id).
 * - updated_at moves only when a stored field actually changed;
 * - text/title changes are written to edit_history;
 * - a metric snapshot is written on first sight and whenever a count changes;
 * - seeing a row again clears unavailable_at.
 */
export function upsertPost(db: DB, input: PostRecord, sourceId: number | null, now = nowIso()): UpsertResult {
  const p = postSchema.parse(input);
  const cols = postColumns(p);
  const existing = db.prepare('SELECT * FROM posts WHERE platform = ? AND platform_id = ?').get(p.platform, p.platformId) as
    | PostRow
    | undefined;

  let id: number;
  let created = false;
  let changed = false;
  if (!existing) {
    const keys = Object.keys(cols);
    const info = db
      .prepare(
        `INSERT INTO posts (platform, platform_id, ${keys.join(', ')}, first_seen_at, last_seen_at, updated_at)
         VALUES (?, ?, ${keys.map(() => '?').join(', ')}, ?, ?, ?)`,
      )
      .run(p.platform, p.platformId, ...keys.map((k) => cols[k] as never), now, now, now);
    id = Number(info.lastInsertRowid);
    created = changed = true;
    snapshot(db, 'post', id, now, cols, POST_METRICS);
  } else {
    id = existing.id;
    const diff = Object.keys(cols).filter((k) => !same(existing[k], cols[k]));
    if (diff.length) {
      changed = true;
      for (const field of ['title', 'text'] as const) {
        if (existing.content_hash && existing[field] !== cols[field]) {
          db.prepare('INSERT INTO edit_history (entity_type, entity_id, observed_at, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)').run(
            'post', id, now, field, existing[field] as string | null, cols[field] as string | null,
          );
        }
      }
      db.prepare(`UPDATE posts SET ${diff.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
        ...diff.map((k) => cols[k] as never), now, id,
      );
      if (POST_METRICS.some((k) => diff.includes(k))) snapshot(db, 'post', id, now, cols, POST_METRICS);
    }
    const unavailable = db.prepare('SELECT unavailable_at FROM posts WHERE id = ?').get(id) as { unavailable_at: string | null };
    if (unavailable.unavailable_at) {
      db.prepare('UPDATE posts SET unavailable_at = NULL, unavailable_reason = NULL, updated_at = ? WHERE id = ?').run(now, id);
      changed = true;
    }
    db.prepare('UPDATE posts SET last_seen_at = ? WHERE id = ?').run(now, id);
  }
  if (sourceId !== null) {
    db.prepare('INSERT OR IGNORE INTO post_sources (post_id, source_id, first_seen_at) VALUES (?, ?, ?)').run(id, sourceId, now);
  }
  syncMedia(db, 'post', id, p.platform, p.media, now);
  return { id, created, changed };
}

export function upsertComment(db: DB, input: CommentRecord, now = nowIso()): UpsertResult & { postId: number } {
  const c = commentSchema.parse(input);
  const post = db.prepare('SELECT id FROM posts WHERE platform = ? AND platform_id = ?').get(c.platform, c.postPlatformId) as
    | { id: number }
    | undefined;
  if (!post) throw new Error(`comment ${c.platformId}: post ${c.postPlatformId} not stored`);

  let parentId: number | null = null;
  let rootId: number | null = null;
  let depth = 0;
  if (c.parentPlatformId) {
    const parent = db
      .prepare('SELECT id, root_id, depth FROM comments WHERE platform = ? AND platform_id = ?')
      .get(c.platform, c.parentPlatformId) as { id: number; root_id: number | null; depth: number } | undefined;
    if (!parent) throw new Error(`comment ${c.platformId}: parent ${c.parentPlatformId} not stored`);
    parentId = parent.id;
    rootId = parent.root_id ?? parent.id;
    depth = parent.depth + 1;
  }

  const cols = commentColumns(c, post.id, parentId, rootId, depth);
  const existing = db.prepare('SELECT * FROM comments WHERE platform = ? AND platform_id = ?').get(c.platform, c.platformId) as
    | PostRow
    | undefined;
  let id: number;
  let created = false;
  let changed = false;
  if (!existing) {
    const keys = Object.keys(cols);
    const info = db
      .prepare(
        `INSERT INTO comments (platform, platform_id, ${keys.join(', ')}, first_seen_at, last_seen_at, updated_at)
         VALUES (?, ?, ${keys.map(() => '?').join(', ')}, ?, ?, ?)`,
      )
      .run(c.platform, c.platformId, ...keys.map((k) => cols[k] as never), now, now, now);
    id = Number(info.lastInsertRowid);
    created = changed = true;
    snapshot(db, 'comment', id, now, cols, COMMENT_METRICS);
  } else {
    id = existing.id;
    const diff = Object.keys(cols).filter((k) => !same(existing[k], cols[k]));
    if (diff.length) {
      changed = true;
      if (existing.text !== cols.text) {
        db.prepare('INSERT INTO edit_history (entity_type, entity_id, observed_at, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)').run(
          'comment', id, now, 'text', existing.text, cols.text as string | null,
        );
      }
      db.prepare(`UPDATE comments SET ${diff.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
        ...diff.map((k) => cols[k] as never), now, id,
      );
      if (COMMENT_METRICS.some((k) => diff.includes(k))) snapshot(db, 'comment', id, now, cols, COMMENT_METRICS);
    }
    const r = db.prepare('SELECT unavailable_at FROM comments WHERE id = ?').get(id) as { unavailable_at: string | null };
    if (r.unavailable_at) {
      db.prepare('UPDATE comments SET unavailable_at = NULL, updated_at = ? WHERE id = ?').run(now, id);
      changed = true;
    }
    db.prepare('UPDATE comments SET last_seen_at = ? WHERE id = ?').run(now, id);
  }
  syncMedia(db, 'comment', id, c.platform, c.media, now);
  return { id, created, changed, postId: post.id };
}

function commentColumns(c: ValidComment, postId: number, parentId: number | null, rootId: number | null, depth: number) {
  return {
    post_id: postId,
    parent_id: parentId,
    root_id: rootId,
    depth,
    author_kind: c.author.kind,
    author_entity_id: c.author.kind === 'entity' ? c.author.id : null,
    author_entity_name: c.author.kind === 'entity' ? c.author.name : null,
    author_pseudonym: c.author.kind === 'person' ? c.author.pseudonym : null,
    text: c.text,
    published_at: c.publishedAt,
    edited_at: c.editedAt,
    is_edited: c.isEdited ? 1 : 0,
    like_count: c.likeCount,
    reply_count: c.replyCount,
    reactions_json: json(c.reactions),
    extra_json: json(c.extra),
    content_hash: hash([c.text]),
  } as Record<string, unknown>;
}

function same(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

function snapshot(db: DB, type: 'post' | 'comment', id: number, now: string, cols: Record<string, unknown>, keys: readonly string[]) {
  const v = (k: string) => (keys.includes(k) ? (cols[k] ?? null) : null) as never;
  db.prepare(
    `INSERT INTO metric_snapshots (entity_type, entity_id, observed_at, like_count, comment_count, reply_count, view_count, share_count, reaction_count, reactions_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(type, id, now, v('like_count'), v('comment_count'), v('reply_count'), v('view_count'), v('share_count'), v('reaction_count'), v('reactions_json'));
}

function syncMedia(db: DB, ownerType: 'post' | 'comment', ownerId: number, platform: string, media: MediaRecord[], now: string) {
  const up = db.prepare(
    `INSERT INTO media_refs (owner_type, owner_id, platform, position, media_type, url, width, height, duration_seconds, alt_text, caption, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_type, owner_id, position, media_type) DO UPDATE SET
       url = excluded.url, width = excluded.width, height = excluded.height, duration_seconds = excluded.duration_seconds,
       alt_text = excluded.alt_text, caption = excluded.caption, last_seen_at = excluded.last_seen_at`,
  );
  for (const m of media) {
    up.run(ownerType, ownerId, platform, m.position, m.mediaType, m.url, m.width ?? null, m.height ?? null, m.durationSeconds ?? null, m.altText ?? null, m.caption ?? null, now, now);
  }
}

/**
 * After a COMPLETE listing, mark comments under `parentId` (NULL = top-level) of a post that were not seen
 * since `passStartedAt` as unavailable. Never call this after a partial or interrupted listing.
 */
export function markUnseenComments(db: DB, postId: number, parentId: number | null, passStartedAt: string, now = nowIso()): number {
  const info = db
    .prepare(
      `UPDATE comments SET unavailable_at = ?, updated_at = ?
       WHERE post_id = ? AND ${parentId === null ? 'parent_id IS NULL' : 'parent_id = ?'} AND last_seen_at < ? AND unavailable_at IS NULL`,
    )
    .run(...([now, now, postId, ...(parentId === null ? [] : [parentId]), passStartedAt] as never[]));
  return info.changes;
}

export function markPostUnavailable(db: DB, platform: string, platformId: string, reason: string, now = nowIso()): boolean {
  const info = db
    .prepare('UPDATE posts SET unavailable_at = ?, unavailable_reason = ?, updated_at = ? WHERE platform = ? AND platform_id = ? AND unavailable_at IS NULL')
    .run(now, reason, now, platform, platformId);
  return info.changes > 0;
}

export function saveRawPayload(
  db: DB,
  r: { platform: string; entityType: string; platformId: string; origin: 'api' | 'dom' | 'network'; parserVersion: string; payload: unknown },
  now = nowIso(),
): void {
  const text = JSON.stringify(r.payload);
  const h = crypto.createHash('sha256').update(`${r.platform}|${r.entityType}|${r.platformId}|${text}`).digest('hex');
  db.prepare(
    `INSERT OR IGNORE INTO raw_payloads (platform, entity_type, platform_id, origin, parser_version, content_hash, fetched_at, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(r.platform, r.entityType, r.platformId, r.origin, r.parserVersion, h, now, text);
}
