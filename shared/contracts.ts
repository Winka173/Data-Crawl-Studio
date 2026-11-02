// Types shared by the UI and the worker's internal control API.
// The public read-only HTTP API (docs/API.md) has its own, separately versioned contract.

export type Platform = 'youtube' | 'facebook' | 'instagram';
export const PLATFORMS: Platform[] = ['youtube', 'facebook', 'instagram'];

export type Language = 'vi' | 'en';

/** null = all history */
export type DepthDays = 7 | 30 | 90 | 365 | null;
export const DEPTH_OPTIONS: DepthDays[] = [7, 30, 90, 365, null];

export interface PacingSettings {
  minDelayMs: number;
  maxDelayMs: number;
  maxActionsPerHour: number;
  maxActionsPerDay: number;
}

export interface AppSettings {
  language: Language;
  defaultDepthDays: DepthDays;
  youtube: {
    dailyQuota: number;
    /** Units kept free so a Test click or a search still works late in the day. */
    reserveUnits: number;
    /** Posts published within this many days are re-checked for new comments and counts. */
    recheckDays: number;
  };
  pacing: Record<'facebook' | 'instagram', PacingSettings>;
  browserTosAcceptedAt: string | null;
  localApi: { enabled: boolean; port: number };
}

export type AccountStatus = 'not_set' | 'set' | 'verified' | 'expired' | 'blocked';

export type AccountKey =
  | 'youtube.apiKey'
  | 'meta.appId'
  | 'meta.appSecret'
  | 'meta.pageToken'
  | 'meta.igToken'
  | 'browser.facebook'
  | 'browser.instagram'
  | 'localApi.token'
  | 'privacy.salt';

export type AccountKind = 'secret' | 'browserProfile' | 'generatedToken' | 'salt';

export interface AccountEntryView {
  key: AccountKey;
  kind: AccountKind;
  status: AccountStatus;
  /** i18n keys of the features that use this entry */
  features: string[];
  setAt: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  /** Non-secret metadata safe to display (e.g. IG business account id). */
  meta: Record<string, string>;
  canTest: boolean;
}

export interface WorkerHealth {
  ok: true;
  version: string;
  dataDir: string;
  dbPath: string;
  schemaVersion: number;
  startedAt: string;
}

export interface ApiError {
  error: string;
  /** i18n key when the message is user-facing */
  code?: string;
}

// ---- Sources, jobs, status, data browser (slice 2+) ---------------------------------

export interface SourceView {
  id: number;
  platform: Platform;
  kind: string;
  input_url: string;
  canonical_url: string | null;
  platform_id: string | null;
  name: string | null;
  method: 'api' | 'browser';
  depth_days: number | null;
  schedule_minutes: number | null;
  status: string;
  status_detail: string | null;
  paused: number;
  initial_crawl_done: number;
  last_run_started_at: string | null;
  last_run_finished_at: string | null;
  last_success_at: string | null;
  next_run_at: string | null;
  created_at: string;
  posts: number;
  comments: number;
  active_jobs: number;
  last_run_status: string | null;
  last_run_stats: Record<string, number> | null;
}

export interface AddSourcesResult {
  added: SourceView[];
  duplicates: string[];
  errors: { input: string; code: string }[];
}

export interface JobView {
  id: number;
  run_id: number | null;
  source_id: number | null;
  source_name: string | null;
  platform: Platform;
  type: string;
  target: string | null;
  state: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  last_error: string | null;
  updated_at: string;
  started_at: string | null;
}

export interface PlatformStateView {
  platform: Platform | 'global';
  paused: boolean;
  needsUser: boolean;
  reason: string | null;
  detail: string | null;
}

export interface QuotaView {
  day: string;
  limit: number;
  reserve: number;
  used: number;
  remaining: number;
  exhausted: boolean;
  resetsAt: string;
  byMethod: Record<string, number>;
}

export interface StatusView {
  platforms: PlatformStateView[];
  running: JobView[];
  queueCounts: { platform: Platform; state: string; n: number }[];
  quota: QuotaView;
  totals: { sources: number; posts: number; comments: number; pseudonyms: number };
  recentErrors: { occurred_at: string; platform: string | null; kind: string; code: string | null; message: string; source_id: number | null }[];
}

export interface PostListItem {
  id: number;
  platform: Platform;
  platform_id: string;
  post_type: string;
  url: string | null;
  container_name: string | null;
  author_kind: string;
  author_entity_name: string | null;
  author_pseudonym: string | null;
  title: string | null;
  text: string | null;
  published_at: string | null;
  like_count: number | null;
  comment_count: number | null;
  view_count: number | null;
  share_count: number | null;
  stored_comments: number;
  unavailable_at: string | null;
}

export interface CommentView {
  id: number;
  parent_id: number | null;
  depth: number;
  author_kind: string;
  author_entity_name: string | null;
  author_pseudonym: string | null;
  text: string | null;
  published_at: string | null;
  is_edited: number;
  like_count: number | null;
  reply_count: number | null;
  unavailable_at: string | null;
}

export interface PostDetail {
  post: PostListItem & { extra_json: string | null; tags_json: string | null; duration_seconds: number | null; first_seen_at: string; last_seen_at: string; is_edited: number };
  media: { media_type: string; url: string; width: number | null; height: number | null; duration_seconds: number | null; alt_text: string | null }[];
  snapshots: { observed_at: string; like_count: number | null; comment_count: number | null; view_count: number | null }[];
  comments: CommentView[];
  commentsTotal: number;
}

// ---- Exports (slice 8) ------------------------------------------------------------------------

export type ExportFormat = 'jsonl' | 'csv';

export interface ExportView {
  name: string;
  dir: string;
  format: ExportFormat;
  files: { file: string; rows: number }[];
  createdAt: string;
}
