import type { Platform } from '../../../shared/contracts';
import type { DB } from '../db/db';
import { redactString } from '../log';
import { nowIso } from '../util/time';

export type JobState = 'queued' | 'running' | 'paused' | 'needs_user' | 'done' | 'failed' | 'cancelled';
export const ACTIVE_STATES: JobState[] = ['queued', 'running', 'paused', 'needs_user'];
const ACTIVE_SQL = `('queued','running','paused','needs_user')`;

export interface JobRow {
  id: number;
  run_id: number | null;
  source_id: number | null;
  platform: Platform;
  type: string;
  target: string | null;
  state: JobState;
  priority: number;
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  cursor_json: string | null;
  checkpoint_json: string | null;
  params_json: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface EnqueueSpec {
  platform: Platform;
  type: string;
  sourceId: number | null;
  runId: number | null;
  target?: string | null;
  params?: Record<string, unknown>;
  priority?: number;
  nextRunAt?: string;
  maxAttempts?: number;
}

/** Returns the new job id, or null when an identical active job already exists. */
export function enqueue(db: DB, s: EnqueueSpec): number | null {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO jobs (run_id, source_id, platform, type, target, state, priority, max_attempts, next_run_at, params_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
    )
    .run(s.runId, s.sourceId, s.platform, s.type, s.target ?? null, s.priority ?? 100, s.maxAttempts ?? 5, s.nextRunAt ?? now, JSON.stringify(s.params ?? {}), now, now);
  return info.changes ? Number(info.lastInsertRowid) : null;
}

export function getJob(db: DB, id: number): JobRow | undefined {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
}

export function setJobState(db: DB, id: number, state: JobState, extra: Partial<Pick<JobRow, 'last_error' | 'next_run_at' | 'attempts' | 'finished_at'>> = {}): void {
  const sets = ['state = ?', 'updated_at = ?'];
  const vals: unknown[] = [state, nowIso()];
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]), id);
}

export function saveCursor(db: DB, id: number, cursor: unknown): void {
  db.prepare('UPDATE jobs SET cursor_json = ?, updated_at = ? WHERE id = ?').run(cursor === null ? null : JSON.stringify(cursor), nowIso(), id);
}

/** Jobs left "running" by a crash or restart go back to the queue; their cursor is kept. */
export function recoverInterrupted(db: DB): number {
  return db.prepare(`UPDATE jobs SET state = 'queued', updated_at = ? WHERE state = 'running'`).run(nowIso()).changes;
}

export function pickNext(db: DB, platform: Platform, now = nowIso()): JobRow | undefined {
  return db
    .prepare(
      `SELECT j.* FROM jobs j LEFT JOIN sources s ON s.id = j.source_id
       WHERE j.state = 'queued' AND j.platform = ? AND j.next_run_at <= ? AND IFNULL(s.paused, 0) = 0
       ORDER BY j.priority, j.next_run_at, j.id LIMIT 1`,
    )
    .get(platform, now) as JobRow | undefined;
}

// ---- platform / global state -------------------------------------------------

export interface PlatformState {
  platform: string;
  paused: number;
  needs_user: number;
  reason: string | null;
  reason_detail: string | null;
  updated_at: string;
}

export function platformState(db: DB, platform: Platform | 'global'): PlatformState {
  return (
    (db.prepare('SELECT * FROM platform_state WHERE platform = ?').get(platform) as PlatformState | undefined) ?? {
      platform,
      paused: 0,
      needs_user: 0,
      reason: null,
      reason_detail: null,
      updated_at: nowIso(),
    }
  );
}

export function setPlatformState(db: DB, platform: Platform | 'global', s: { paused?: boolean; needsUser?: boolean; reason?: string | null; detail?: string | null }): void {
  const cur = platformState(db, platform);
  db.prepare(
    `INSERT INTO platform_state (platform, paused, needs_user, reason, reason_detail, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform) DO UPDATE SET paused = excluded.paused, needs_user = excluded.needs_user,
       reason = excluded.reason, reason_detail = excluded.reason_detail, updated_at = excluded.updated_at`,
  ).run(
    platform,
    s.paused === undefined ? cur.paused : s.paused ? 1 : 0,
    s.needsUser === undefined ? cur.needs_user : s.needsUser ? 1 : 0,
    s.reason === undefined ? cur.reason : s.reason,
    s.detail === undefined ? cur.reason_detail : s.detail,
    nowIso(),
  );
}

/** Stop a platform for the owner: every active job of it becomes Paused (Needs user). */
export function markPlatformNeedsUser(db: DB, platform: Platform, reason: string, detail: string | null): void {
  db.transaction(() => {
    setPlatformState(db, platform, { needsUser: true, reason, detail });
    db.prepare(`UPDATE jobs SET state = 'needs_user', updated_at = ? WHERE platform = ? AND state IN ('queued','running')`).run(nowIso(), platform);
    db.prepare(`UPDATE sources SET status = 'needs_user', status_detail = ?, updated_at = ? WHERE platform = ? AND id IN (SELECT source_id FROM jobs WHERE platform = ? AND state = 'needs_user')`).run(reason, nowIso(), platform, platform);
  })();
}

export function resumePlatform(db: DB, platform: Platform): void {
  db.transaction(() => {
    setPlatformState(db, platform, { paused: false, needsUser: false, reason: null, detail: null });
    db.prepare(`UPDATE jobs SET state = 'queued', next_run_at = ?, updated_at = ? WHERE platform = ? AND state = 'needs_user'`).run(nowIso(), nowIso(), platform);
    db.prepare(`UPDATE sources SET status = CASE WHEN paused = 1 THEN 'paused' ELSE 'active' END, status_detail = NULL, updated_at = ? WHERE platform = ? AND status = 'needs_user'`).run(nowIso(), platform);
  })();
}

export function isLaneOpen(db: DB, platform: Platform): boolean {
  const g = platformState(db, 'global');
  const p = platformState(db, platform);
  return !g.paused && !p.paused && !p.needs_user;
}

// ---- runs ------------------------------------------------------------------------

export function startRun(db: DB, sourceId: number, platform: Platform, mode: 'initial' | 'incremental', trigger: 'add' | 'manual' | 'schedule'): number {
  const now = nowIso();
  const info = db
    .prepare(`INSERT INTO crawl_runs (source_id, platform, mode, trigger, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)`)
    .run(sourceId, platform, mode, trigger, now);
  db.prepare('UPDATE sources SET last_run_started_at = ?, updated_at = ? WHERE id = ?').run(now, now, sourceId);
  return Number(info.lastInsertRowid);
}

export function addRunStats(db: DB, runId: number | null, delta: Record<string, number>): void {
  if (!runId) return;
  const row = db.prepare('SELECT stats_json FROM crawl_runs WHERE id = ?').get(runId) as { stats_json: string } | undefined;
  if (!row) return;
  const stats = JSON.parse(row.stats_json) as Record<string, number>;
  for (const [k, v] of Object.entries(delta)) stats[k] = (stats[k] ?? 0) + v;
  db.prepare('UPDATE crawl_runs SET stats_json = ? WHERE id = ?').run(JSON.stringify(stats), runId);
}

/** Close a run once none of its jobs is active. Returns the final status, or null if still running. */
export function finalizeRunIfDone(db: DB, runId: number): string | null {
  const active = db.prepare(`SELECT COUNT(*) n FROM jobs WHERE run_id = ? AND state IN ${ACTIVE_SQL}`).get(runId) as { n: number };
  if (active.n) return null;
  const run = db.prepare('SELECT * FROM crawl_runs WHERE id = ?').get(runId) as { status: string; source_id: number; mode: string } | undefined;
  if (!run || run.status !== 'running') return run?.status ?? null;
  const counts = db.prepare(`SELECT state, COUNT(*) n FROM jobs WHERE run_id = ? GROUP BY state`).all(runId) as { state: JobState; n: number }[];
  const failed = counts.find((c) => c.state === 'failed')?.n ?? 0;
  const done = counts.find((c) => c.state === 'done')?.n ?? 0;
  const status = failed === 0 ? 'done' : done > 0 ? 'partial' : 'failed';
  const now = nowIso();
  db.transaction(() => {
    db.prepare('UPDATE crawl_runs SET status = ?, finished_at = ? WHERE id = ?').run(status, now, runId);
    const ok = status !== 'failed';
    db.prepare(
      `UPDATE sources SET last_run_finished_at = ?, updated_at = ?,
         last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END,
         initial_crawl_done = CASE WHEN ? THEN 1 ELSE initial_crawl_done END,
         status = CASE WHEN status IN ('parser_needs_update','unavailable','needs_user') THEN status
                       WHEN paused = 1 THEN 'paused' WHEN ? THEN 'active' ELSE 'error' END
       WHERE id = ?`,
    ).run(now, now, ok ? 1 : 0, now, ok ? 1 : 0, ok ? 1 : 0, run.source_id);
  })();
  return status;
}

export function recordError(
  db: DB,
  e: { platform?: string | null; sourceId?: number | null; jobId?: number | null; runId?: number | null; kind: string; code?: string | null; message: string; detail?: unknown },
): void {
  db.prepare(
    `INSERT INTO errors (occurred_at, platform, source_id, job_id, run_id, kind, code, message, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    nowIso(),
    e.platform ?? null,
    e.sourceId ?? null,
    e.jobId ?? null,
    e.runId ?? null,
    e.kind,
    e.code ?? null,
    redactString(e.message).slice(0, 2000),
    e.detail === undefined ? null : redactString(JSON.stringify(e.detail)).slice(0, 8000),
  );
}
