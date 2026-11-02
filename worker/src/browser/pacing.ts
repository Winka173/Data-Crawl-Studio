import type { AppContext } from '../context';
import { PacingWaitError } from '../queue/errors';
import { AbortedError } from '../queue/runner';
import type { BrowserPlatform } from './session';

// Human-like pacing for browser work: a random pause before every action (page load, scroll, click),
// an occasional longer "reading" pause, and hard per-hour / per-day caps the owner sets in Settings.

const hourBucket = (d: Date) => `h:${d.toISOString().slice(0, 13)}`;
const dayBucket = (d: Date) => `d:${d.toISOString().slice(0, 10)}`;

export interface PacerOptions {
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => Date;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class Pacer {
  private sinceLongPause = 0;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly app: AppContext, opts: PacerOptions = {}) {
    this.random = opts.random ?? Math.random;
    this.sleep = opts.sleep ?? abortableSleep;
    this.now = opts.now ?? (() => new Date());
  }

  counts(platform: BrowserPlatform, at = this.now()): { hour: number; day: number } {
    const get = (b: string) =>
      (this.app.db.prepare('SELECT count FROM action_counters WHERE platform = ? AND bucket = ?').get(platform, b) as { count: number } | undefined)?.count ?? 0;
    return { hour: get(hourBucket(at)), day: get(dayBucket(at)) };
  }

  /**
   * Call before every browser action. Throws PacingWaitError when a cap is reached
   * (the job is re-queued for the next hour/day), otherwise counts the action and waits a random delay.
   */
  async beforeAction(platform: BrowserPlatform, signal?: AbortSignal): Promise<void> {
    const cfg = this.app.settings().pacing[platform];
    const now = this.now();
    const c = this.counts(platform, now);
    if (c.day >= cfg.maxActionsPerDay) {
      const next = new Date(now);
      next.setUTCHours(24, 5, 0, 0);
      throw new PacingWaitError(next.toISOString());
    }
    if (c.hour >= cfg.maxActionsPerHour) {
      const next = new Date(now);
      next.setUTCMinutes(60 + Math.floor(this.random() * 10), 0, 0);
      throw new PacingWaitError(next.toISOString());
    }
    const db = this.app.db;
    const inc = db.prepare(
      `INSERT INTO action_counters (platform, bucket, count) VALUES (?, ?, 1)
       ON CONFLICT(platform, bucket) DO UPDATE SET count = count + 1`,
    );
    db.transaction(() => {
      inc.run(platform, hourBucket(now));
      inc.run(platform, dayBucket(now));
    })();

    let delay = cfg.minDelayMs + this.random() * (cfg.maxDelayMs - cfg.minDelayMs);
    // Every 12-25 actions, pause like a person reading for a while (3-6x the maximum delay).
    this.sinceLongPause++;
    if (this.sinceLongPause >= 12 + Math.floor(this.random() * 14)) {
      delay += cfg.maxDelayMs * (3 + this.random() * 3);
      this.sinceLongPause = 0;
    }
    await this.sleep(Math.round(delay), signal);
  }

  /** Remove counters older than two days so the table stays tiny. */
  prune(): void {
    const old = new Date(this.now().getTime() - 2 * 86_400_000);
    this.app.db.prepare(`DELETE FROM action_counters WHERE (bucket LIKE 'h:%' AND bucket < ?) OR (bucket LIKE 'd:%' AND bucket < ?)`).run(hourBucket(old), dayBucket(old));
  }
}
