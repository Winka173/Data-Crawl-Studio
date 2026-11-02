import type { Platform } from '../../../shared/contracts';
import { PLATFORMS } from '../../../shared/contracts';
import type { AppContext } from '../context';
import { log } from '../log';
import { nowIso } from '../util/time';
import { AuthError, BlockedError, NotFoundError, PacingWaitError, ParserError, PermanentError, QuotaWaitError, TransientError } from './errors';
import {
  addRunStats,
  enqueue,
  finalizeRunIfDone,
  getJob,
  isLaneOpen,
  markPlatformNeedsUser,
  pickNext,
  recordError,
  recoverInterrupted,
  saveCursor,
  setJobState,
  type EnqueueSpec,
  type JobRow,
} from './queue';

export interface JobContext {
  app: AppContext;
  job: JobRow;
  params: Record<string, unknown>;
  signal: AbortSignal;
  cursor<T>(): T | null;
  /** Persist progress now; after a crash the job restarts from here. */
  saveCursor(c: unknown): void;
  /** Child job in the same run and source. Returns null if an identical one is already active. */
  enqueue(spec: Omit<EnqueueSpec, 'sourceId' | 'runId' | 'platform'> & { platform?: Platform }): number | null;
  stats(delta: Record<string, number>): void;
  throwIfAborted(): void;
}

export type JobHandler = (jc: JobContext) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerJob(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

export class AbortedError extends Error {
  constructor() {
    super('aborted');
  }
}

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

export function backoffMs(attempts: number, rand = Math.random()): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (0.8 + 0.4 * rand));
}

interface Lane {
  jobId: number;
  abort: AbortController;
  done: Promise<void>;
}

/**
 * One lane per platform: at most one job of a platform runs at a time (one browser tab per platform),
 * and a failure in one job or source never stops the others.
 */
export class QueueRunner {
  private lanes = new Map<Platform, Lane>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly app: AppContext, private readonly tickMs = 1000) {}

  start(): void {
    const n = recoverInterrupted(this.app.db);
    if (n) log.info('resumed interrupted jobs from their checkpoints', { count: n });
    this.timer = setInterval(() => void this.tick(), this.tickMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const running = [...this.lanes.values()];
    for (const l of running) l.abort.abort();
    await Promise.all(running.map((l) => l.done));
  }

  runningJobIds(): number[] {
    return [...this.lanes.values()].map((l) => l.jobId);
  }

  /** Abort running jobs that match; the caller has already set their new state (paused / cancelled / queued). */
  abortWhere(pred: (job: JobRow) => boolean): void {
    for (const lane of this.lanes.values()) {
      const job = getJob(this.app.db, lane.jobId);
      if (job && pred(job)) lane.abort.abort();
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const p of PLATFORMS) {
        if (this.lanes.has(p) || !isLaneOpen(this.app.db, p)) continue;
        const job = pickNext(this.app.db, p);
        if (!job) continue;
        if (!handlers.has(job.type)) {
          setJobState(this.app.db, job.id, 'failed', { last_error: `no handler for ${job.type}`, finished_at: nowIso() });
          continue;
        }
        this.launch(p, job);
      }
    } catch (e) {
      log.error('queue tick failed', e);
    } finally {
      this.ticking = false;
    }
  }

  /** Run every runnable job to completion (tests and smoke helpers). */
  async drain(maxJobs = 10_000): Promise<number> {
    let n = 0;
    for (;;) {
      await this.tick();
      if (!this.lanes.size) return n;
      await Promise.all([...this.lanes.values()].map((l) => l.done));
      n++;
      if (n >= maxJobs) return n;
    }
  }

  private launch(platform: Platform, job: JobRow): void {
    const abort = new AbortController();
    const db = this.app.db;
    db.prepare(`UPDATE jobs SET state = 'running', started_at = ?, updated_at = ? WHERE id = ?`).run(nowIso(), nowIso(), job.id);
    const jc: JobContext = {
      app: this.app,
      job,
      params: JSON.parse(job.params_json) as Record<string, unknown>,
      signal: abort.signal,
      cursor: <T>() => {
        const row = getJob(db, job.id);
        return row?.cursor_json ? (JSON.parse(row.cursor_json) as T) : null;
      },
      saveCursor: (c) => saveCursor(db, job.id, c),
      enqueue: (spec) => enqueue(db, { ...spec, platform: spec.platform ?? job.platform, sourceId: job.source_id, runId: job.run_id }),
      stats: (d) => addRunStats(db, job.run_id, d),
      throwIfAborted: () => {
        if (abort.signal.aborted) throw new AbortedError();
      },
    };
    const done = (async () => {
      try {
        await handlers.get(job.type)!(jc);
        if (abort.signal.aborted) throw new AbortedError();
        this.finish(job, 'done');
      } catch (e) {
        this.fail(job, e, abort.signal.aborted);
      } finally {
        this.lanes.delete(platform);
        if (job.run_id) finalizeRunIfDone(db, job.run_id);
      }
    })();
    this.lanes.set(platform, { jobId: job.id, abort, done });
  }

  private stillMine(job: JobRow): boolean {
    return getJob(this.app.db, job.id)?.state === 'running';
  }

  private finish(job: JobRow, state: 'done'): void {
    if (!this.stillMine(job)) return;
    setJobState(this.app.db, job.id, state, { finished_at: nowIso(), last_error: null });
  }

  private fail(job: JobRow, e: unknown, aborted: boolean): void {
    const db = this.app.db;
    const msg = e instanceof Error ? e.message : String(e);
    if (aborted || e instanceof AbortedError) {
      // A pause/cancel set the new state already; a plain abort (shutdown) re-queues with the cursor intact.
      if (this.stillMine(job)) setJobState(db, job.id, 'queued');
      return;
    }
    if (!this.stillMine(job)) return;
    const base = { platform: job.platform, sourceId: job.source_id, jobId: job.id, runId: job.run_id, message: msg };

    if (e instanceof QuotaWaitError || e instanceof PacingWaitError) {
      setJobState(db, job.id, 'queued', { next_run_at: e.resumeAt, last_error: msg });
      log.info('job waiting', { job: job.id, type: job.type, until: e.resumeAt, why: e.kind });
      return;
    }
    if (e instanceof BlockedError) {
      recordError(db, { ...base, kind: 'block', code: e.code });
      setJobState(db, job.id, 'needs_user', { last_error: msg });
      markPlatformNeedsUser(db, job.platform, e.code, msg);
      log.warn('platform stopped: needs user', { platform: job.platform, code: e.code });
      return;
    }
    if (e instanceof AuthError) {
      recordError(db, { ...base, kind: 'auth', code: e.code });
      setJobState(db, job.id, 'needs_user', { last_error: msg });
      markPlatformNeedsUser(db, job.platform, e.code, msg);
      if (e.accountKey && this.app.secrets.has(e.accountKey)) {
        this.app.secrets.setStatus(e.accountKey, e.code === 'key_expired' ? 'expired' : 'blocked', msg);
      }
      log.warn('platform stopped: credentials', { platform: job.platform, code: e.code });
      return;
    }
    if (e instanceof ParserError) {
      recordError(db, { ...base, kind: 'parser', code: e.code, detail: e.detail });
      setJobState(db, job.id, 'failed', { last_error: msg, finished_at: nowIso() });
      if (job.source_id) {
        db.prepare(`UPDATE sources SET status = 'parser_needs_update', status_detail = ?, updated_at = ? WHERE id = ?`).run(msg.slice(0, 300), nowIso(), job.source_id);
      }
      log.warn('parser mismatch', { job: job.id, code: e.code });
      return;
    }
    if (e instanceof NotFoundError || e instanceof PermanentError) {
      recordError(db, { ...base, kind: 'permanent', code: e.code });
      setJobState(db, job.id, 'failed', { last_error: msg, finished_at: nowIso() });
      return;
    }
    // Transient (explicit or unknown): bounded retries with exponential backoff.
    const attempts = job.attempts + 1;
    const code = e instanceof TransientError ? e.code : 'unexpected';
    recordError(db, { ...base, kind: 'transient', code, detail: e instanceof TransientError ? undefined : { stack: (e as Error)?.stack?.split('\n').slice(0, 5) } });
    if (attempts >= job.max_attempts) {
      setJobState(db, job.id, 'failed', { attempts, last_error: msg, finished_at: nowIso() });
      log.warn('job failed after retries', { job: job.id, type: job.type, attempts });
      return;
    }
    const delay = e instanceof TransientError && e.retryAfterMs ? e.retryAfterMs : backoffMs(attempts);
    setJobState(db, job.id, 'queued', { attempts, last_error: msg, next_run_at: new Date(Date.now() + delay).toISOString() });
    log.info('job will retry', { job: job.id, type: job.type, attempts, inMs: delay });
  }
}
