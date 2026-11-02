import type { AppContext } from '../../context';
import { log } from '../../log';
import { abortableSleep } from '../../browser/pacing';
import { BlockedError, NotFoundError, PacingWaitError, ParserError, PermanentError } from '../../queue/errors';
import { registerJob, type JobContext } from '../../queue/runner';
import { computeCutoff, needsCommentSync } from '../../sources/incremental';
import { parseLink } from '../../sources/links';
import { registerSourceKind } from '../../sources/service';
import type { SourceRow } from '../../sources/types';
import type { CommentRecord } from '../../store/records';
import { markPostUnavailable, markUnseenCommentsOfPost, saveRawPayload, upsertComment, upsertPost } from '../../store/upsert';
import { daysAgoIso, nowIso } from '../../util/time';
import { FeedFetchError, type FbDriver } from './driver';
import { emptyExtracted, FB_PARSER_VERSION, groupUrl, pickGroup, postUrl, type FbCommentCandidate, type FbPostCandidate } from './extract';
import { mapFbComment, mapFbPost, validateBatch, type FbContainer } from './map';

export const JOB_FB_GROUP = 'fb.group';
export const JOB_FB_COMMENTS = 'fb.comments';

/** Upper bounds per job; the pacing caps usually stop a job long before these. */
/** Replaced in tests. */
export const timing = { sleep: abortableSleep };

export const LIMITS = { maxScrolls: 20_000, idleScrolls: 8, olderInARow: 3, maxExpandClicks: 600, idleExpandClicks: 5, maxCommentScrolls: 300, idleCommentScrolls: 2, feedFetchFailures: 3 };

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
  /** Deepest feed position reached by this pass (D31): an interrupted pass resumes here, not at the top. */
  feedCursor?: string | null;
}

function getSource(jc: JobContext): SourceRow {
  const s = jc.app.db.prepare('SELECT * FROM sources WHERE id = ?').get(jc.job.source_id) as SourceRow | undefined;
  if (!s) throw new PermanentError('source deleted', 'source_deleted');
  return s;
}

/** On a parser mismatch, save a value-free summary of what the page delivered, so the parser can be fixed. */
async function withDiagnostics(d: FbDriver, job: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (e) {
    if (e instanceof ParserError) {
      const file = await d.diagnose?.(e.code, { job });
      if (file) log.warn('facebook parser diagnostics saved', { file });
    }
    throw e;
  }
}

async function requireLogin(d: FbDriver): Promise<void> {
  if (!(await d.loggedIn())) throw new BlockedError('Facebook login required: open the login window in Accounts & Keys', 'login_required');
}

// ---- fb.group: open the group's chronological feed, scroll until the cutoff, store posts -----------------

registerJob(JOB_FB_GROUP, async (jc) => {
  const d = driver(jc.app);
  await withDiagnostics(d, JOB_FB_GROUP, () => collectGroup(jc, d));
});

async function collectGroup(jc: JobContext, d: FbDriver): Promise<void> {
  const db = jc.app.db;
  const source = getSource(jc);
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
  // Feed paging (D31): after the first scroll the page's own feed request is followed with the next cursor, so the
  // tab does not grow and an interrupted pass resumes at its saved position.
  let resumeFrom = cur.feedCursor ?? null;
  let fetchFailures = 0;
  let fetching = !!d.fetchFeedPage && !!d.feedState;

  for (let i = 0; i <= LIMITS.maxScrolls; i++) {
    jc.throwIfAborted();
    const fresh = [...ex.posts.values()].filter((c) => !seen.has(c.postId) && (!c.groupId || c.groupId === group.id || c.groupId === urlRef));
    fresh.forEach((c) => seen.add(c.postId));
    const inRange = fresh.filter((c) => cutoffMs === null || c.createdTime === null || c.createdTime * 1000 >= cutoffMs);
    storePosts(jc, source, container, inRange, p, recheckFrom);

    const feed = fetching ? d.feedState!(group.id) : null;
    // Save the position only once past a pending resume point, so the deeper saved one is never overwritten.
    if (feed?.cursor && !resumeFrom) jc.saveCursor({ ...cur, feedCursor: feed.cursor });

    // Pinned posts can be old: only a run of several consecutive old posts ends the listing.
    for (const c of fresh) olderInARow = cutoffMs !== null && c.createdTime !== null && c.createdTime * 1000 < cutoffMs ? olderInARow + 1 : 0;
    idle = fresh.length ? 0 : idle + 1;
    if (olderInARow >= LIMITS.olderInARow || idle >= LIMITS.idleScrolls || i === LIMITS.maxScrolls) break;
    if (feed && !resumeFrom && !feed.hasNext) break; // Facebook says the feed has no further page

    const from = feed ? resumeFrom ?? feed.cursor : null;
    if (from) {
      try {
        await fetchKeepingPlace(jc, d, from, ex);
        resumeFrom = null;
        fetchFailures = 0;
        await d.drain(ex);
        continue;
      } catch (e) {
        if (!(e instanceof FeedFetchError)) throw e;
        fetchFailures++;
        log.warn('facebook feed request could not be followed', { job: jc.job.id, failures: fetchFailures, e: e.message });
        if (fetchFailures < LIMITS.feedFetchFailures) {
          // Usually stale tokens: a fresh page view brings a fresh request to follow; the position is kept.
          resumeFrom = from;
          await d.open(groupUrl(group.id), ex, jc.signal);
          await d.drain(ex);
          continue;
        }
        // Give up on paging for this pass and scroll as before, from the top of the reopened page. Posts seen
        // before count as new again (re-storing is idempotent), or re-scrolling them would read as the feed's end.
        await d.diagnose?.('feed_fetch_failed', { job: JOB_FB_GROUP, failures: fetchFailures });
        fetching = false;
        resumeFrom = null;
        seen.clear();
        idle = 0;
      }
    }
    await scrollKeepingPlace(jc, d);
    await d.drain(ex);
  }

  if (!seen.size && snap.articleCount > 0) {
    throw new ParserError('the feed shows posts but none could be extracted', 'no_posts_extracted', { articles: snap.articleCount });
  }
  jc.saveCursor(null);
  onSuccess?.();
}

/**
 * A feed cannot be reopened at a date: a listing re-queued by the hourly/daily cap would start again from the top
 * and, for a deep window, never reach the end. So the listing keeps its tab and place and waits for the cap.
 */
async function scrollKeepingPlace(jc: JobContext, d: FbDriver): Promise<void> {
  for (;;) {
    try {
      await d.scroll(jc.signal);
      return;
    } catch (e) {
      if (!(e instanceof PacingWaitError)) throw e;
      const ms = Math.max(1000, Date.parse(e.resumeAt) - Date.now());
      log.info('facebook listing waits for the pacing cap, keeping its place', { job: jc.job.id, until: e.resumeAt });
      await timing.sleep(ms, jc.signal);
    }
  }
}

/** One feed page through the page's own request, waiting in place for the pacing cap like a scroll does. */
async function fetchKeepingPlace(jc: JobContext, d: FbDriver, cursor: string, ex: ReturnType<typeof emptyExtracted>): Promise<void> {
  for (;;) {
    try {
      await d.fetchFeedPage!(cursor, ex, jc.signal);
      return;
    } catch (e) {
      if (!(e instanceof PacingWaitError)) throw e;
      const ms = Math.max(1000, Date.parse(e.resumeAt) - Date.now());
      log.info('facebook listing waits for the pacing cap, keeping its place', { job: jc.job.id, until: e.resumeAt });
      await timing.sleep(ms, jc.signal);
    }
  }
}

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
      if (source.collect_comments && needsCommentSync(before, rec.commentCount ?? null, rec.publishedAt ?? null, recheckFrom, false)) {
        jc.enqueue({ type: JOB_FB_COMMENTS, target: rec.platformId, priority: 100, params: { groupId: container.id, groupName: container.name } });
      }
    }
  })();
}

// ---- fb.comments: open one post, show all comments, expand every "more comments/replies" -------------

registerJob(JOB_FB_COMMENTS, async (jc) => {
  const d = driver(jc.app);
  await withDiagnostics(d, JOB_FB_COMMENTS, () => collectComments(jc, d));
});

async function collectComments(jc: JobContext, d: FbDriver): Promise<void> {
  const db = jc.app.db;
  const postId = jc.job.target!;
  const container: FbContainer = { id: String(jc.params.groupId), name: (jc.params.groupName as string | null) ?? null };
  const post = db.prepare(`SELECT id, comment_count FROM posts WHERE platform = 'facebook' AND platform_id = ?`).get(postId) as
    | { id: number; comment_count: number | null }
    | undefined;
  if (!post) throw new PermanentError(`post ${postId} not stored`, 'post_missing');
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
  // Click every "more comments / replies" control. When none is left but the post reports more comments than were
  // captured, scroll: the permalink page also loads comments as it scrolls. Posts that are already complete cost nothing.
  const captured = () => [...ex.comments.values()].filter((c) => c.postId === postId || c.postId === null).length;
  const reported = () => ex.posts.get(postId)?.commentCount ?? post.comment_count ?? 0;
  let clicks = 0;
  let idleClicks = 0;
  let scrolls = 0;
  let idleScrolls = 0;
  for (;;) {
    const before = ex.comments.size;
    let clicked = false;
    if (await d.expandOne(jc.signal)) {
      clicked = true;
      clicks++;
    } else if (captured() < reported() && idleScrolls < LIMITS.idleCommentScrolls && scrolls < LIMITS.maxCommentScrolls) {
      await d.scroll(jc.signal);
      scrolls++;
    } else break;
    await d.drain(ex);
    jc.throwIfAborted();
    const grew = ex.comments.size > before;
    // A control that loads nothing (click swallowed, or a button that is not what it seems) must not be clicked forever.
    if (clicked) idleClicks = grew ? 0 : idleClicks + 1;
    else idleScrolls = grew ? 0 : idleScrolls + 1;
    if (grew) idleScrolls = 0;
    if (clicks >= LIMITS.maxExpandClicks || idleClicks >= LIMITS.idleExpandClicks || scrolls >= LIMITS.maxCommentScrolls) {
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
  if (!complete) log.info('facebook comments stored without a complete pass', { postId, clicks, scrolls, orphans });
  // Comments that report replies of which none was captured: the reply controls were not found or not read.
  const parents = new Set(ordered.map((c) => c.parentCommentId).filter(Boolean));
  const missingReplies = ordered.filter((c) => (c.replyCount ?? 0) > 0 && !parents.has(c.commentId)).length;
  if (missingReplies) {
    const file = await d.diagnose?.('missing_replies', { job: JOB_FB_COMMENTS, expected, stored: records.length, missingReplies, clicks, complete });
    log.warn('facebook comments: replies reported but not captured', { postId, missingReplies, clicks, file });
  }
  // Far fewer comments than the post reports usually means part of the thread was in a shape we do not read.
  if (expected >= 4 && records.length < expected / 2) {
    const all = [...ex.comments.values()];
    const ids = new Set(all.map((c) => c.commentId));
    const file = await d.diagnose?.('few_comments', {
      job: JOB_FB_COMMENTS,
      expected,
      stored: records.length,
      orphans,
      complete,
      candidates: {
        total: all.length,
        forThisPost: cands.length,
        otherPost: all.filter((c) => c.postId !== null && c.postId !== postId).length,
        withParent: all.filter((c) => c.parentCommentId).length,
        parentCaptured: all.filter((c) => c.parentCommentId && ids.has(c.parentCommentId)).length,
        parentIsPost: all.filter((c) => c.parentCommentId === postId).length,
        withTime: all.filter((c) => c.createdTime !== null).length,
        withAuthor: all.filter((c) => c.author !== null).length,
      },
    });
    log.warn('facebook comments: far fewer than the post reports', { postId, expected, stored: records.length, file });
  }
  onSuccess?.();
}

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
