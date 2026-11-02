import type { DB } from '../../db/db';
import { nowIso } from '../../util/time';

const PROVIDER = 'youtube';

/** YouTube Data API quota resets at midnight US Pacific time. */
export function pacificDay(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Next Pacific midnight as UTC ISO (plus a 2-minute margin). */
export function nextQuotaReset(d = new Date()): string {
  const today = pacificDay(d);
  let t = d.getTime();
  // Step forward in 15-minute increments until the Pacific date changes; DST-safe without tz math.
  while (pacificDay(new Date(t)) === today) t += 15 * 60_000;
  // Walk back to the exact boundary minute.
  while (pacificDay(new Date(t - 60_000)) !== today) t -= 60_000;
  return new Date(t + 2 * 60_000).toISOString();
}

export interface QuotaStatus {
  day: string;
  limit: number;
  reserve: number;
  used: number;
  remaining: number;
  exhausted: boolean;
  resetsAt: string;
  byMethod: Record<string, number>;
}

export class QuotaExceededError extends Error {
  constructor(public readonly resetsAt: string) {
    super('YouTube API daily quota reached');
  }
}

export class YoutubeQuota {
  constructor(private readonly db: DB, private readonly limit: () => { daily: number; reserve: number }) {}

  status(now = new Date()): QuotaStatus {
    const day = pacificDay(now);
    const row = this.db
      .prepare('SELECT units_used, by_method_json, exhausted FROM quota_usage WHERE provider = ? AND day = ?')
      .get(PROVIDER, day) as { units_used: number; by_method_json: string; exhausted: number } | undefined;
    const { daily, reserve } = this.limit();
    const used = row?.units_used ?? 0;
    const exhausted = !!row?.exhausted || used >= daily;
    return {
      day,
      limit: daily,
      reserve,
      used,
      remaining: exhausted ? 0 : Math.max(0, daily - used),
      exhausted,
      resetsAt: nextQuotaReset(now),
      byMethod: row ? (JSON.parse(row.by_method_json) as Record<string, number>) : {},
    };
  }

  /**
   * Reserve units before a call. Crawl work must leave `reserve` units free;
   * interactive calls (Test, Search) may dig into the reserve but never past the limit.
   */
  take(method: string, units: number, interactive = false, now = new Date()): void {
    const st = this.status(now);
    const floor = interactive ? 0 : st.reserve;
    if (st.exhausted || st.remaining - units < floor) throw new QuotaExceededError(st.resetsAt);
    const byMethod = { ...st.byMethod, [method]: (st.byMethod[method] ?? 0) + units };
    this.db
      .prepare(
        `INSERT INTO quota_usage (provider, day, units_used, by_method_json, exhausted, updated_at)
         VALUES (?, ?, ?, ?, 0, ?)
         ON CONFLICT(provider, day) DO UPDATE SET units_used = excluded.units_used,
           by_method_json = excluded.by_method_json, updated_at = excluded.updated_at`,
      )
      .run(PROVIDER, st.day, st.used + units, JSON.stringify(byMethod), nowIso());
  }

  /** The API said quotaExceeded: trust it over our count for the rest of the Pacific day. */
  markExhausted(now = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO quota_usage (provider, day, units_used, exhausted, updated_at) VALUES (?, ?, 0, 1, ?)
         ON CONFLICT(provider, day) DO UPDATE SET exhausted = 1, updated_at = excluded.updated_at`,
      )
      .run(PROVIDER, pacificDay(now), nowIso());
  }
}
