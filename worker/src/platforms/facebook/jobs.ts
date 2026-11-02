import type { AppContext } from '../../context';
import { log } from '../../log';
import { BlockedError, NotFoundError, ParserError, PermanentError } from '../../queue/errors';
import { registerJob, type JobContext } from '../../queue/runner';
import { computeCutoff, needsCommentSync } from '../../sources/incremental';
import { parseLink } from '../../sources/links';
import { registerSourceKind } from '../../sources/service';
import type { SourceRow } from '../../sources/types';
import type { CommentRecord } from '../../store/records';
import { markPostUnavailable, markUnseenCommentsOfPost, saveRawPayload, upsertComment, upsertPost } from '../../store/upsert';
import { daysAgoIso, nowIso } from '../../util/time';
import type { FbDriver } from './driver';
import { emptyExtracted, FB_PARSER_VERSION, groupUrl, pickGroup, postUrl, type FbCommentCandidate, type FbPostCandidate } from './extract';
import { mapFbComment, mapFbPost, validateBatch, type FbContainer } from './map';

export const JOB_FB_GROUP = 'fb.group';
export const JOB_FB_COMMENTS = 'fb.comments';

/** Upper bounds per job; the pacing caps usually stop a job long before these. */
export const LIMITS = { maxScrolls: 400, idleScrolls: 4, olderInARow: 3, maxExpandClicks: 600 };

// Wired in main.ts (Playwright) and in tests (fake driver).
let driverFactory: ((app: AppContext) => FbDriver) | null = null;
let onSuccess: (() => void) | null = null;
export function setFbDriver(factory: (app: AppContext) => FbDriver, success?: () => void): void {
  driverFactory = factory;
  onSuccess = success ?? null;
}
function driver(app: AppContext): FbDriver {
  if (!driverFactory) throw new PermanentError('browser collection is not available', 'no_browser');
  return driverFactory(app);
}

registerSourceKind('fb_group', { method: 'browser', startJob: JOB_FB_GROUP });

interface GroupCursor {
  cutoff: string | null;
  passStartedAt: string;
}

function getSource(jc: JobContext): SourceRow {
  const s = jc.app.db.prepare('SELECT * FROM sources WHERE id = ?').get(jc.job.source_id) as SourceRow | undefined;
  if (!s) throw new PermanentError('source deleted', 'source_deleted');
  return s;
}

async function requireLogin(d: FbDriver): Promise<void> {
  if (!(await d.loggedIn())) throw new BlockedError('Facebook login required: open the login window in Accounts & Keys', 'login_required');
}

// ---- fb.group: open the group's chronological feed, scroll until the cutoff, store posts -----------------

registerJob(JOB_FB_GROUP, async (jc) => {
  const db = jc.app.db;
  const source = getSource(jc);
  const d = driver(jc.app);
  const cur = jc.cursor<GroupCursor>() ?? { cutoff: computeCutoff(source, jc.app.settings().youtube.recheckDays), passStartedAt: nowIso() };
  jc.saveCursor(cur);
  await requireLogin(d);

  const link = parseLink(source.input_url);
  const ref = source.platform_id ?? link.ref.value;
  const ex = emptyExtracted();
  const snap = await d.open(link.ref.by === 'share' && !source.platform_id ? link.ref.value : groupUrl(ref), ex, jc.signal);
  await d.drain(ex);
  if (!snap.hasFeed) {
    if (snap.notAvailable) {
      db.prepare(`UPDATE sources SET status = 'unavailable', status_detail = 'group not available (private, removed or not public)', updated_at = ? WHERE id = ?`).run(nowIso(), source.id);
      throw new NotFoundError(`group not available: ${source.input_url}`);
    }
    throw new ParserError('group page loaded but no feed was found', 'feed_missing', { url: snap.url });
  }

  const urlRef = /facebook\.com\/groups\/([^/?#]+)/.exec(snap.url)?.[1] ?? ref;
  const group = pickGroup(ex, source.platform_id ?? urlRef) ?? pickGroup(ex, ref);
  if (!group) throw new ParserError('could not identify the group on its own page', 'group_unknown');
  const container: FbContainer = { id: group.id, name: group.name ?? source.name };
  db.prepare('UPDATE sources SET platform_id = ?, name = COALESCE(?, name), canonical_url = ?, updated_at = ? WHERE id = ?').run(
    group.id, group.name, `https://www.facebook.com/groups/${group.id}/`, nowIso(), source.id,
  );

  const p = jc.app.pseudonymizer();
  const recheckFrom = daysAgoIso(jc.app.settings().youtube.recheckDays);
  const cutoffMs = cur.cutoff ? Date.parse(cur.cutoff) : null;
  const seen = new Set<string>();
  let idle = 0;
  let olderInARow = 0;

  for (let i = 0; i <= LIMITS.maxScrolls; i++) {
    jc.throwIfAborted();
    const fresh = [...ex.posts.values()].filter((c) => !seen.has(c.postId) && (!c.groupId || c.groupId === group.id || c.groupId === urlRef));
    fresh.forEach((c) => seen.add(c.postId));
    const inRange = fresh.filter((c) => cutoffMs === null || c.createdTime === null || c.createdTime * 1000 >= cutoffMs);
    storePosts(jc, source, container, inRange, p, recheckFrom);

    // Pinned posts can be old: only a run of several consecutive old posts ends the listing.
    for (const c of fresh) olderInARow = cutoffMs !== null && c.createdTime !== null && c.createdTime * 1000 < cutoffMs ? olderInARow + 1 : 0;
    idle = fresh.length ? 0 : idle + 1;
    if (olderInARow >= LIMITS.olderInARow || idle >= LIMITS.idleScrolls || i === LIMITS.maxScrolls) break;
    await d.scroll(jc.signal);
    await d.drain(ex);
  }

  if (!seen.size && snap.articleCount > 0) {
    throw new ParserError('the feed shows posts but none could be extracted', 'no_posts_extracted', { articles: snap.articleCount });
  }
  jc.saveCursor(null);
  onSuccess?.();
});

function storePosts(jc: JobContext, source: SourceRow, container: FbContainer, cands: FbPostCandidate[], p: ReturnType<AppContext['pseudonymizer']>, recheckFrom: string): void {
  if (!cands.length) return;
  const db = jc.app.db;
  const records = cands.map((c) => mapFbPost(c, container, p));
  validateBatch(records, []); // throws ParserError: nothing from this batch is stored
  db.transaction(() => {
    for (const rec of records) {
      const before = db.prepare(`SELECT comment_count, comments_synced_at FROM posts WHERE platform = 'facebook' AND platform_id = ?`).get(rec.platformId) as
        | { comment_count: number | null; comments_synced_at: string | null }
        | undefined;
      const r = upsertPost(db, rec, source.id);
      saveRawPayload(db, { platform: 'facebook', entityType: 'post', platformId: rec.platformId, origin: 'network', parserVersion: FB_PARSER_VERSION, payload: rec });
      jc.stats(r.created ? { postsNew: 1 } : r.changed ? { postsUpdated: 1 } : {});
      if (needsCommentSync(before, rec.commentCount ?? null, rec.publishedAt ?? null, recheckFrom, false)) {
        jc.enqueue({ type: JOB_FB_COMMENTS, target: rec.platformId, priority: 100, params: { groupId: container.id, groupName: container.name } });
      }
    }
  })();
}

// ---- fb.comments: open one post, show all comments, expand every "more comments/replies" -------------

registerJob(JOB_FB_COMMENTS, async (jc) => {
  const db = jc.app.db;
  const postId = jc.job.target!;
  const container: FbContainer = { id: String(jc.params.groupId), name: (jc.params.groupName as string | null) ?? null };
  const post = db.prepare(`SELECT id, comment_count FROM posts WHERE platform = 'facebook' AND platform_id = ?`).get(postId) as
    | { id: number; comment_count: number | null }
    | undefined;
  if (!post) throw new PermanentError(`post ${postId} not stored`, 'post_missing');
  const d = driver(jc.app);
  await requireLogin(d);
  const passStartedAt = nowIso();
  const ex = emptyExtracted();

  const snap = await d.open(postUrl(container.id, postId), ex, jc.signal);
  await d.drain(ex);
  if (!snap.articleCount && !ex.posts.has(postId)) {
    if (snap.notAvailable) {
      markPostUnavailable(db, 'facebook', postId, 'post not available');
      return;
    }
    throw new ParserError('post page loaded but no post was found', 'post_missing_on_page', { url: snap.url });
  }

  let complete = await d.showAllComments(jc.signal);
  await d.drain(ex);
  let clicks = 0;
  while (await d.expandOne(jc.signal)) {
    await d.drain(ex);
    jc.throwIfAborted();
    if (++clicks >= LIMITS.maxExpandClicks) {
      complete = false;
      break;
    }
  }

  const p = jc.app.pseudonymizer();
  // Refresh the post's own counts from the permalink page.
  const fresh = ex.posts.get(postId);
  if (fresh) {
    const rec = mapFbPost(fresh, container, p);
    validateBatch([rec], []);
    upsertPost(db, rec, jc.job.source_id);
  }

  const cands = [...ex.comments.values()].filter((c) => c.postId === postId || c.postId === null);
  const { ordered, orphans } = orderByParent(cands);
  if (orphans) complete = false;
  const records: CommentRecord[] = ordered.map((c) => mapFbComment(c, postId, container, p));
  const expected = fresh?.commentCount ?? post.comment_count ?? 0;
  if (!records.length && expected > 0 && complete) {
    throw new ParserError(`post shows ${expected} comments but none could be extracted`, 'no_comments_extracted');
  }
  validateBatch([], records);

  db.transaction(() => {
    for (const rec of records) {
      const r = upsertComment(db, rec);
      saveRawPayload(db, { platform: 'facebook', entityType: 'comment', platformId: rec.platformId, origin: 'network', parserVersion: FB_PARSER_VERSION, payload: rec });
      jc.stats(r.created ? { commentsNew: 1 } : r.changed ? { commentsUpdated: 1 } : {});
    }
    if (complete) {
      const gone = markUnseenCommentsOfPost(db, post.id, passStartedAt);
      if (gone) jc.stats({ commentsUnavailable: gone });
    }
    db.prepare('UPDATE posts SET comments_synced_at = ? WHERE id = ?').run(nowIso(), post.id);
  })();
  if (!complete) log.info('facebook comments stored without a complete pass', { postId, clicks, orphans });
  onSuccess?.();
});

/** Parents before children; comments whose parent was not captured are left out (never stored detached). */
export function orderByParent(cands: FbCommentCandidate[]): { ordered: FbCommentCandidate[]; orphans: number } {
  const byId = new Map(cands.map((c) => [c.commentId, c]));
  const depthOf = (c: FbCommentCandidate, guard = 0): number | null => {
    if (!c.parentCommentId) return 0;
    if (guard > 20) return null;
    const parent = byId.get(c.parentCommentId);
    if (!parent) return null;
    const d = depthOf(parent, guard + 1);
    return d === null ? null : d + 1;
  };
  const withDepth = cands.map((c) => ({ c, d: depthOf(c) }));
  const ordered = withDepth.filter((x) => x.d !== null).sort((a, b) => a.d! - b.d! || (a.c.createdTime ?? 0) - (b.c.createdTime ?? 0)).map((x) => x.c);
  return { ordered, orphans: withDepth.length - ordered.length };
}
