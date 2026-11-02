import type { SourceRow } from './types';
import { daysAgoIso } from '../util/time';

// Shared incremental rules for every collector (see docs/DECISIONS.md D14).

/** Oldest publish date this run must reach. null = everything. */
export function computeCutoff(s: Pick<SourceRow, 'initial_crawl_done' | 'depth_days' | 'last_success_at'>, recheckDays: number, now = new Date()): string | null {
  if (!s.initial_crawl_done) return s.depth_days === null ? null : daysAgoIso(s.depth_days, now);
  const recheck = daysAgoIso(recheckDays, now);
  if (!s.last_success_at) return recheck;
  const sinceLast = new Date(new Date(s.last_success_at).getTime() - 86_400_000).toISOString();
  return sinceLast < recheck ? sinceLast : recheck;
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
