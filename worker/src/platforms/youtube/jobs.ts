import { log } from '../../log';
import { NotFoundError, PermanentError } from '../../queue/errors';
import { registerJob, type JobContext } from '../../queue/runner';
import { parseLink } from '../../sources/links';
import type { SourceRow } from '../../sources/types';
import { markPostUnavailable, markUnseenComments, saveRawPayload, upsertComment, upsertPost } from '../../store/upsert';
import { daysAgoIso, nowIso } from '../../util/time';
import { ytCall, type YtMethod } from './client';
import { HandleBook, mapComment, mapVideo, scrubComment, scrubThread, scrubVideo, YT_PARSER_VERSION, type Owner, type YtComment, type YtThread, type YtVideo } from './map';

export const JOB_SOURCE = 'yt.source';
export const JOB_COMMENTS = 'yt.comments';

interface ListResponse<T> {
  items?: T[];
  nextPageToken?: string;
  pageInfo?: { totalResults?: number };
}
interface YtChannel {
  id: string;
  snippet?: { title?: string; customUrl?: string };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}
interface YtPlaylist {
  id: string;
  snippet?: { title?: string; channelId?: string; channelTitle?: string };
}
interface YtPlaylistItem {
  contentDetails?: { videoId?: string; videoPublishedAt?: string };
}

interface SourceCursor {
  stage: 'list' | 'verify';
  playlistId: string | null;
  owner: Owner | null;
  pageToken: string | null;
  cutoff: string | null;
  passStartedAt: string;
}

const call = <T>(jc: JobContext, method: YtMethod, params: Record<string, string | number | undefined>) =>
  ytCall<T>(jc.app, method, params, { signal: jc.signal, onUnits: (n) => jc.stats({ apiUnits: n }) });

function getSource(jc: JobContext): SourceRow {
  const s = jc.app.db.prepare('SELECT * FROM sources WHERE id = ?').get(jc.job.source_id) as SourceRow | undefined;
  if (!s) throw new PermanentError('source deleted', 'source_deleted');
  return s;
}

/** Oldest publish date this run must reach. null = everything. */
export function computeCutoff(s: Pick<SourceRow, 'initial_crawl_done' | 'depth_days' | 'last_success_at'>, recheckDays: number, now = new Date()): string | null {
  if (!s.initial_crawl_done) return s.depth_days === null ? null : daysAgoIso(s.depth_days, now);
  const recheck = daysAgoIso(recheckDays, now);
  if (!s.last_success_at) return recheck;
  const sinceLast = new Date(new Date(s.last_success_at).getTime() - 86_400_000).toISOString();
  return sinceLast < recheck ? sinceLast : recheck;
}

// ---- yt.source: resolve, list videos, upsert them, schedule comment syncs ----------------

registerJob(JOB_SOURCE, async (jc) => {
  const db = jc.app.db;
  const source = getSource(jc);
  let cur = jc.cursor<SourceCursor>();

  if (!cur) {
    const resolved = await resolveSource(jc, source);
    cur = {
      stage: 'list',
      playlistId: resolved.playlistId,
      owner: resolved.owner,
      pageToken: null,
      cutoff: source.kind === 'yt_video' ? null : computeCutoff(source, jc.app.settings().youtube.recheckDays),
      passStartedAt: nowIso(),
    };
    jc.saveCursor(cur);
  }

  if (source.kind === 'yt_video') {
    await syncVideos(jc, source, [source.platform_id!], cur.owner, true);
    jc.saveCursor(null);
    return;
  }

  // Page through the uploads playlist (newest first) or the playlist.
  const uploads = source.kind === 'yt_channel';
  while (cur.stage === 'list') {
    jc.throwIfAborted();
    const page: ListResponse<YtPlaylistItem> = await call<ListResponse<YtPlaylistItem>>(jc, 'playlistItems.list', {
      part: 'contentDetails',
      playlistId: cur.playlistId!,
      maxResults: 50,
      pageToken: cur.pageToken ?? undefined,
    });
    const items = (page.items ?? []).filter((i) => i.contentDetails?.videoId);
    const cutoff = cur.cutoff;
    const inRange = items.filter((i) => !cutoff || !i.contentDetails?.videoPublishedAt || i.contentDetails.videoPublishedAt >= cutoff);
    if (inRange.length) await syncVideos(jc, source, inRange.map((i) => i.contentDetails!.videoId!), cur.owner, false);
    const allOlder = items.length > 0 && inRange.length === 0;
    cur = { ...cur, pageToken: page.nextPageToken ?? null };
    // The uploads playlist is newest-first: a page entirely older than the cutoff ends the listing.
    if (!page.nextPageToken || (uploads && allOlder)) cur.stage = 'verify';
    jc.saveCursor(cur);
  }

  // Videos of this source inside the window that the listing no longer returned: check them directly.
  const missing = db
    .prepare(
      `SELECT p.platform_id FROM posts p JOIN post_sources ps ON ps.post_id = p.id
       WHERE ps.source_id = ? AND p.platform = 'youtube' AND p.unavailable_at IS NULL AND p.last_seen_at < ?
         AND (? IS NULL OR p.published_at >= ?)`,
    )
    .all(source.id, cur.passStartedAt, cur.cutoff, cur.cutoff) as { platform_id: string }[];
  for (let i = 0; i < missing.length; i += 50) {
    jc.throwIfAborted();
    await syncVideos(jc, source, missing.slice(i, i + 50).map((m) => m.platform_id), cur.owner, false);
  }
  jc.saveCursor(null);
});

async function resolveSource(jc: JobContext, s: SourceRow): Promise<{ playlistId: string | null; owner: Owner | null }> {
  const db = jc.app.db;
  const link = parseLink(s.input_url);
  const setResolved = (platformId: string, name: string | null, canonical: string) =>
    db.prepare('UPDATE sources SET platform_id = ?, name = ?, canonical_url = ?, updated_at = ? WHERE id = ?').run(platformId, name, canonical, nowIso(), s.id);

  if (s.kind === 'yt_channel') {
    const by = link.ref.by;
    const params: Record<string, string> = { part: 'snippet,contentDetails' };
    if (s.platform_id) params.id = s.platform_id;
    else if (by === 'id') params.id = link.ref.value;
    else if (by === 'username') params.forUsername = link.ref.value;
    else params.forHandle = link.ref.value; // handles, and legacy /c/ names that usually equal the handle
    let res = await call<ListResponse<YtChannel>>(jc, 'channels.list', params);
    if (!res.items?.length && by === 'custom' && !s.platform_id) {
      const found = await call<ListResponse<{ id?: { channelId?: string } }>>(jc, 'search.list', { part: 'snippet', type: 'channel', q: link.ref.value, maxResults: 1 });
      const id = found.items?.[0]?.id?.channelId;
      if (id) res = await call<ListResponse<YtChannel>>(jc, 'channels.list', { part: 'snippet,contentDetails', id });
    }
    const ch = res.items?.[0];
    if (!ch) {
      db.prepare(`UPDATE sources SET status = 'unavailable', status_detail = 'channel not found', updated_at = ? WHERE id = ?`).run(nowIso(), s.id);
      throw new NotFoundError(`channel not found: ${s.input_url}`);
    }
    const handle = ch.snippet?.customUrl?.replace(/^@/, '').toLowerCase() ?? null;
    setResolved(ch.id, ch.snippet?.title ?? null, `https://www.youtube.com/channel/${ch.id}`);
    return { playlistId: ch.contentDetails?.relatedPlaylists?.uploads ?? null, owner: { channelId: ch.id, name: ch.snippet?.title ?? null, handle } };
  }

  if (s.kind === 'yt_playlist') {
    const res = await call<ListResponse<YtPlaylist>>(jc, 'playlists.list', { part: 'snippet', id: link.ref.value });
    const pl = res.items?.[0];
    if (!pl) {
      db.prepare(`UPDATE sources SET status = 'unavailable', status_detail = 'playlist not found or private', updated_at = ? WHERE id = ?`).run(nowIso(), s.id);
      throw new NotFoundError(`playlist not found: ${s.input_url}`);
    }
    setResolved(pl.id, pl.snippet?.title ?? null, `https://www.youtube.com/playlist?list=${pl.id}`);
    // Videos in a playlist can belong to other channels; their owner is taken per video.
    return { playlistId: pl.id, owner: null };
  }

  // Single video: the owner is learned from the video itself.
  if (!s.platform_id) setResolved(link.ref.value, null, link.normalized);
  return { playlistId: null, owner: null };
}

/** videos.list for up to 50 ids: upsert, mark missing ones unavailable, queue comment syncs where needed. */
async function syncVideos(jc: JobContext, source: SourceRow, ids: string[], owner: Owner | null, always: boolean): Promise<void> {
  const db = jc.app.db;
  const res = await call<ListResponse<YtVideo>>(jc, 'videos.list', { part: 'snippet,contentDetails,statistics,liveStreamingDetails', id: ids.join(','), maxResults: 50 });
  const p = jc.app.pseudonymizer();
  const recheckFrom = daysAgoIso(jc.app.settings().youtube.recheckDays);
  const returned = new Set<string>();
  for (const v of res.items ?? []) {
    returned.add(v.id);
    const vOwner: Owner = owner && owner.channelId === v.snippet?.channelId ? owner : { channelId: v.snippet?.channelId ?? '', name: v.snippet?.channelTitle ?? null, handle: null };
    const before = db.prepare('SELECT comment_count, comments_synced_at FROM posts WHERE platform = ? AND platform_id = ?').get('youtube', v.id) as
      | { comment_count: number | null; comments_synced_at: string | null }
      | undefined;
    const record = mapVideo(v, vOwner, p);
    const r = db.transaction(() => {
      const out = upsertPost(db, record, source.id);
      saveRawPayload(db, { platform: 'youtube', entityType: 'video', platformId: v.id, origin: 'api', parserVersion: YT_PARSER_VERSION, payload: scrubVideo(v, record) });
      return out;
    })();
    jc.stats(r.created ? { postsNew: 1 } : r.changed ? { postsUpdated: 1 } : {});
    if (source.kind === 'yt_video' && !source.name) {
      db.prepare('UPDATE sources SET name = ?, updated_at = ? WHERE id = ?').run(v.snippet?.title ?? null, nowIso(), source.id);
    }
    if (needsCommentSync(before, record.commentCount ?? null, record.publishedAt ?? null, recheckFrom, always)) {
      jc.enqueue({ type: JOB_COMMENTS, target: v.id, priority: 100, params: { owner: vOwner } });
    }
  }
  for (const id of ids) {
    if (!returned.has(id) && markPostUnavailable(db, 'youtube', id, 'not returned by videos.list (deleted or private)')) {
      jc.stats({ postsUnavailable: 1 });
    }
  }
}

/**
 * New posts always get a full comment sync. Recent posts (inside the recheck window, or the pasted video itself)
 * are re-synced when their comment count changed or the last sync is older than a day. Older posts are only
 * synced if they never were (e.g. an interrupted first crawl).
 */
export function needsCommentSync(
  before: { comment_count: number | null; comments_synced_at: string | null } | undefined,
  commentCount: number | null,
  publishedAt: string | null,
  recheckFrom: string,
  always: boolean,
  now = Date.now(),
): boolean {
  if (commentCount === 0 && before?.comments_synced_at) return false;
  if (!before || !before.comments_synced_at) return true;
  const recent = always || (publishedAt !== null && publishedAt >= recheckFrom);
  if (!recent) return false;
  if (before.comment_count !== commentCount) return true;
  return now - new Date(before.comments_synced_at).getTime() > 86_400_000;
}

// ---- yt.comments: every thread and every reply of one video ------------------------------

interface CommentsCursor {
  pageToken: string | null;
  passStartedAt: string;
}

registerJob(JOB_COMMENTS, async (jc) => {
  const db = jc.app.db;
  const videoId = jc.job.target!;
  const owner = (jc.params.owner as Owner | undefined) ?? { channelId: '', name: null, handle: null };
  const post = db.prepare(`SELECT id FROM posts WHERE platform = 'youtube' AND platform_id = ?`).get(videoId) as { id: number } | undefined;
  if (!post) throw new PermanentError(`video ${videoId} not stored`, 'post_missing');
  const p = jc.app.pseudonymizer();
  const handles = new HandleBook();
  let cur = jc.cursor<CommentsCursor>() ?? { pageToken: null, passStartedAt: nowIso() };

  for (;;) {
    jc.throwIfAborted();
    let page: ListResponse<YtThread>;
    try {
      page = await call<ListResponse<YtThread>>(jc, 'commentThreads.list', {
        part: 'snippet,replies',
        videoId,
        maxResults: 100,
        textFormat: 'plainText',
        pageToken: cur.pageToken ?? undefined,
      });
    } catch (e) {
      if (e instanceof PermanentError && e.code === 'comments_disabled') {
        db.prepare(`UPDATE posts SET extra_json = json_set(IFNULL(extra_json, '{}'), '$.commentsDisabled', json('true')), comments_synced_at = ?, updated_at = ? WHERE id = ?`).run(nowIso(), nowIso(), post.id);
        jc.saveCursor(null);
        return;
      }
      throw e;
    }
    const threads = page.items ?? [];
    // Learn every author handle on the page first so mentions resolve to the right pseudonym.
    for (const t of threads) {
      handles.learn(t.snippet.topLevelComment);
      for (const r of t.replies?.comments ?? []) handles.learn(r);
    }
    for (const t of threads) {
      await syncThread(jc, t, videoId, owner, handles, p);
    }
    cur = { ...cur, pageToken: page.nextPageToken ?? null };
    jc.saveCursor(cur);
    if (!page.nextPageToken) break;
  }

  // The listing was complete: top-level comments not seen in this pass are gone.
  const gone = markUnseenComments(db, post.id, null, cur.passStartedAt);
  if (gone) jc.stats({ commentsUnavailable: gone });
  db.prepare('UPDATE posts SET comments_synced_at = ? WHERE id = ?').run(nowIso(), post.id);
  jc.saveCursor(null);
  log.debug('comments synced', { videoId });
});

async function syncThread(jc: JobContext, t: YtThread, videoId: string, owner: Owner, handles: HandleBook, p: ReturnType<JobContext['app']['pseudonymizer']>) {
  const db = jc.app.db;
  const startedAt = nowIso();
  const total = t.snippet.totalReplyCount ?? 0;
  const top = t.snippet.topLevelComment;
  const save = (c: YtComment, parentId: string | null, replyCount: number | null) => {
    const rec = mapComment(c, { videoId, parentId, replyCount, owner, handles, p });
    const r = upsertComment(db, rec);
    saveRawPayload(db, { platform: 'youtube', entityType: 'comment', platformId: c.id, origin: 'api', parserVersion: YT_PARSER_VERSION, payload: scrubComment(c, rec) });
    jc.stats(r.created ? { commentsNew: 1 } : r.changed ? { commentsUpdated: 1 } : {});
    return r;
  };

  const topRes = db.transaction(() => {
    const r = save(top, null, total);
    saveRawPayload(db, { platform: 'youtube', entityType: 'thread', platformId: t.id, origin: 'api', parserVersion: YT_PARSER_VERSION, payload: scrubThread(t) });
    return r;
  })();

  const inline = t.replies?.comments ?? [];
  if (total > 0 && inline.length >= total) {
    db.transaction(() => inline.forEach((r) => save(r, top.id, null)))();
  } else if (total > 0) {
    // The thread resource carries at most a few replies: page through all of them.
    let token: string | undefined;
    do {
      jc.throwIfAborted();
      const page = await call<ListResponse<YtComment>>(jc, 'comments.list', { part: 'snippet', parentId: top.id, maxResults: 100, textFormat: 'plainText', pageToken: token });
      const replies = page.items ?? [];
      replies.forEach((r) => handles.learn(r));
      db.transaction(() => replies.forEach((r) => save(r, top.id, null)))();
      token = page.nextPageToken;
    } while (token);
  }
  // Every reply of this thread was listed: replies not seen now are gone.
  const gone = markUnseenComments(db, topRes.postId, topRes.id, startedAt);
  if (gone) jc.stats({ commentsUnavailable: gone });
}
