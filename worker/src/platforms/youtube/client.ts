import type { AppContext } from '../../context';
import { AuthError, NotFoundError, PermanentError, QuotaWaitError, TransientError } from '../../queue/errors';
import { AbortedError } from '../../queue/runner';
import { nextQuotaReset, QuotaExceededError } from './quota';

// Quota cost per call (YouTube Data API v3 documentation).
export const YT_COST = {
  'channels.list': 1,
  'playlists.list': 1,
  'playlistItems.list': 1,
  'videos.list': 1,
  'commentThreads.list': 1,
  'comments.list': 1,
  'search.list': 100,
} as const;
export type YtMethod = keyof typeof YT_COST;

/** Overridable only for automated tests (fake API server); never set in normal use. */
export function ytApiBase(): string {
  return process.env.DCS_YOUTUBE_API_BASE ?? 'https://www.googleapis.com/youtube/v3';
}

export interface YtCallOptions {
  interactive?: boolean;
  signal?: AbortSignal;
  onUnits?: (n: number) => void;
}

export async function ytCall<T>(app: AppContext, method: YtMethod, params: Record<string, string | number | undefined>, opts: YtCallOptions = {}): Promise<T> {
  const key = app.secrets.get('youtube.apiKey');
  if (!key) throw new AuthError('YouTube API key is not set (Settings → Accounts & Keys)', 'key_missing', 'youtube.apiKey');
  const cost = YT_COST[method];
  try {
    app.quota.take(method, cost, opts.interactive);
  } catch (e) {
    if (e instanceof QuotaExceededError) throw new QuotaWaitError(e.resetsAt);
    throw e;
  }
  opts.onUnits?.(cost);

  const url = new URL(`${ytApiBase()}/${method.split('.')[0]}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  url.searchParams.set('key', key);

  let res: Response;
  try {
    res = await app.fetch(url.toString(), { signal: opts.signal, headers: { Accept: 'application/json' } });
  } catch (e) {
    if (opts.signal?.aborted) throw new AbortedError();
    throw new TransientError(`network error calling ${method}: ${(e as Error).message}`, 'network');
  }
  if (res.ok) return (await res.json()) as T;

  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; errors?: { reason?: string; message?: string }[] } };
  const reason = body.error?.errors?.[0]?.reason ?? '';
  const message = body.error?.message ?? `HTTP ${res.status}`;
  const msg = `${method}: ${reason || res.status} ${message}`.slice(0, 300);

  switch (reason) {
    case 'quotaExceeded':
    case 'dailyLimitExceeded':
      app.quota.markExhausted();
      throw new QuotaWaitError(nextQuotaReset());
    case 'rateLimitExceeded':
    case 'userRateLimitExceeded':
      throw new TransientError(msg, reason, 60_000);
    case 'keyInvalid':
      throw new AuthError(msg, 'key_invalid', 'youtube.apiKey');
    case 'keyExpired':
      throw new AuthError(msg, 'key_expired', 'youtube.apiKey');
    case 'accessNotConfigured':
      throw new AuthError(msg, 'api_disabled', 'youtube.apiKey');
    case 'ipRefererBlocked':
      throw new AuthError(msg, 'key_restricted', 'youtube.apiKey');
    case 'commentsDisabled':
      throw new PermanentError(msg, 'comments_disabled');
    case 'videoNotFound':
    case 'playlistNotFound':
    case 'channelNotFound':
    case 'commentThreadNotFound':
    case 'commentNotFound':
    case 'notFound':
      throw new NotFoundError(msg, reason);
  }
  if (res.status === 400 && /api key/i.test(message)) throw new AuthError(msg, 'key_invalid', 'youtube.apiKey');
  if (res.status === 404) throw new NotFoundError(msg);
  if (res.status === 429 || res.status >= 500) throw new TransientError(msg, `http_${res.status}`);
  if (res.status === 403) throw new PermanentError(msg, reason || 'forbidden');
  throw new PermanentError(msg, reason || `http_${res.status}`);
}
