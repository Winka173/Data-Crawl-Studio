import type { DepthDays, Platform } from '../../../shared/contracts';
import { MAX_DEPTH_DAYS } from '../../../shared/contracts';
import { HttpError } from '../accounts';
import type { AppContext } from '../context';
import { log } from '../log';
import { enqueue, resumePlatform, setPlatformState, startRun } from '../queue/queue';
import type { QueueRunner } from '../queue/runner';
import { nowIso } from '../util/time';
import { LinkError, parseLink, splitBulk, type SourceKind } from './links';
import type { SourceRow } from './types';

/** Which collector starts a crawl for each kind of source. Platforms register here as their slice lands. */
const KINDS: Partial<Record<SourceKind, { method: 'api' | 'browser'; startJob: string }>> = {
  yt_channel: { method: 'api', startJob: 'yt.source' },
  yt_playlist: { method: 'api', startJob: 'yt.source' },
  yt_video: { method: 'api', startJob: 'yt.source' },
};

export function registerSourceKind(kind: SourceKind, def: { method: 'api' | 'browser'; startJob: string }): void {
  KINDS[kind] = def;
}

export interface AddResult {
  added: SourceRow[];
  duplicates: string[];
  errors: { input: string; code: string }[];
}

/** Depth in days: a whole number from 1 to MAX_DEPTH_DAYS, or null for all history. */
export function checkDepth(depth: unknown): DepthDays {
  if (depth === null) return null;
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH_DAYS) {
    throw new HttpError(400, `depthDays must be a whole number of days from 1 to ${MAX_DEPTH_DAYS}, or null`, 'err.depthInvalid');
  }
  return depth;
}

export function addSources(app: AppContext, opts: { links: string; depthDays?: DepthDays; scheduleMinutes?: number | null; collectComments?: boolean }): AddResult {
  const db = app.db;
  const depth = checkDepth(opts.depthDays === undefined ? app.settings().defaultDepthDays : opts.depthDays);
  const collectComments = opts.collectComments ?? true;
  const schedule = opts.scheduleMinutes ?? null;
  if (schedule !== null && (!Number.isInteger(schedule) || schedule < 15)) throw new HttpError(400, 'scheduleMinutes must be >= 15');
  const out: AddResult = { added: [], duplicates: [], errors: [] };

  for (const input of splitBulk(opts.links)) {
    let link;
    try {
      link = parseLink(input);
    } catch (e) {
      out.errors.push({ input, code: e instanceof LinkError ? e.code : 'invalid' });
      continue;
    }
    const kind = KINDS[link.kind];
    if (!kind) {
      out.errors.push({ input, code: 'platform_not_available_yet' });
      continue;
    }
    if (link.platform !== 'youtube' && !app.settings().browserTosAcceptedAt && kind.method === 'browser') {
      out.errors.push({ input, code: 'browser_notice_not_accepted' });
      continue;
    }
    const dup = db
      .prepare(`SELECT id FROM sources WHERE platform = ? AND (input_url = ? OR (platform_id IS NOT NULL AND kind = ? AND platform_id = ?))`)
      .get(link.platform, link.normalized, link.kind, link.ref.by === 'id' ? link.ref.value : null);
    if (dup) {
      out.duplicates.push(input);
      continue;
    }
    const now = nowIso();
    const info = db
      .prepare(
        `INSERT INTO sources (platform, kind, input_url, platform_id, method, depth_days, schedule_minutes, collect_comments, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
      )
      .run(link.platform, link.kind, link.normalized, link.ref.by === 'id' ? link.ref.value : null, kind.method, depth, schedule, collectComments ? 1 : 0, now, now);
    const id = Number(info.lastInsertRowid);
    startCrawl(app, id, 'add');
    out.added.push(getSource(app, id));
  }
  log.info('sources added', { added: out.added.length, duplicates: out.duplicates.length, errors: out.errors.length });
  return out;
}

export function getSource(app: AppContext, id: number): SourceRow {
  const s = app.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined;
  if (!s) throw new HttpError(404, 'source not found');
  return s;
}

/** Start a crawl run unless one is already active. Returns the run id. */
export function startCrawl(app: AppContext, sourceId: number, trigger: 'add' | 'manual' | 'schedule'): number {
  const db = app.db;
  const s = getSource(app, sourceId);
  const active = db.prepare(`SELECT id FROM crawl_runs WHERE source_id = ? AND status = 'running'`).get(sourceId) as { id: number } | undefined;
  if (active) return active.id;
  const kind = KINDS[s.kind];
  if (!kind) throw new HttpError(400, `no collector for ${s.kind}`);
  return db.transaction(() => {
    const runId = startRun(db, s.id, s.platform, s.initial_crawl_done ? 'incremental' : 'initial', trigger);
    enqueue(db, { platform: s.platform, type: kind.startJob, sourceId: s.id, runId, priority: 50 });
    db.prepare(`UPDATE sources SET status = CASE WHEN paused = 1 THEN 'paused' WHEN status IN ('new','error','active') THEN 'active' ELSE status END, updated_at = ? WHERE id = ?`).run(nowIso(), s.id);
    return runId;
  })();
}

export function updateSource(app: AppContext, id: number, patch: { depthDays?: DepthDays; scheduleMinutes?: number | null; collectComments?: boolean }): SourceRow {
  getSource(app, id);
  if (patch.collectComments !== undefined) {
    if (typeof patch.collectComments !== 'boolean') throw new HttpError(400, 'collectComments must be true or false');
    app.db.transaction(() => {
      app.db.prepare('UPDATE sources SET collect_comments = ?, updated_at = ? WHERE id = ?').run(patch.collectComments ? 1 : 0, nowIso(), id);
      // Switching comments off drops the comment work still waiting; what was already stored is kept.
      if (!patch.collectComments) {
        app.db
          .prepare(`UPDATE jobs SET state = 'cancelled', finished_at = ?, updated_at = ? WHERE source_id = ? AND type IN ('fb.comments','yt.comments') AND state IN ('queued','paused','needs_user')`)
          .run(nowIso(), nowIso(), id);
      }
    })();
  }
  if (patch.depthDays !== undefined) {
    checkDepth(patch.depthDays);
    // A deeper window than before needs a full listing back to the new depth, not an incremental run.
    const before = getSource(app, id).depth_days;
    const deeper = before !== null && (patch.depthDays === null || patch.depthDays > before);
    app.db
      .prepare(`UPDATE sources SET depth_days = ?, initial_crawl_done = CASE WHEN ? THEN 0 ELSE initial_crawl_done END, updated_at = ? WHERE id = ?`)
      .run(patch.depthDays, deeper ? 1 : 0, nowIso(), id);
  }
  if (patch.scheduleMinutes !== undefined) {
    const m = patch.scheduleMinutes;
    if (m !== null && (!Number.isInteger(m) || m < 15)) throw new HttpError(400, 'scheduleMinutes must be >= 15');
    app.db.prepare('UPDATE sources SET schedule_minutes = ?, updated_at = ? WHERE id = ?').run(m, nowIso(), id);
  }
  return getSource(app, id);
}

export function pauseSource(app: AppContext, runner: QueueRunner, id: number): void {
  getSource(app, id);
  app.db.transaction(() => {
    app.db.prepare(`UPDATE sources SET paused = 1, status = CASE WHEN status IN ('needs_user','parser_needs_update','unavailable') THEN status ELSE 'paused' END, updated_at = ? WHERE id = ?`).run(nowIso(), id);
    app.db.prepare(`UPDATE jobs SET state = 'paused', updated_at = ? WHERE source_id = ? AND state IN ('queued','running')`).run(nowIso(), id);
  })();
  runner.abortWhere((j) => j.source_id === id);
}

export function resumeSource(app: AppContext, id: number): void {
  getSource(app, id);
  app.db.transaction(() => {
    app.db.prepare(`UPDATE sources SET paused = 0, status = CASE WHEN status = 'paused' THEN 'active' ELSE status END, updated_at = ? WHERE id = ?`).run(nowIso(), id);
    app.db.prepare(`UPDATE jobs SET state = 'queued', next_run_at = ?, updated_at = ? WHERE source_id = ? AND state = 'paused'`).run(nowIso(), nowIso(), id);
  })();
}

export function cancelSource(app: AppContext, runner: QueueRunner, id: number): void {
  getSource(app, id);
  const now = nowIso();
  app.db.transaction(() => {
    app.db.prepare(`UPDATE jobs SET state = 'cancelled', finished_at = ?, updated_at = ? WHERE source_id = ? AND state IN ('queued','running','paused','needs_user')`).run(now, now, id);
    app.db.prepare(`UPDATE crawl_runs SET status = 'cancelled', finished_at = ? WHERE source_id = ? AND status = 'running'`).run(now, id);
    app.db.prepare(`UPDATE sources SET status = CASE WHEN paused = 1 THEN 'paused' WHEN status IN ('active','new') THEN 'active' ELSE status END, updated_at = ? WHERE id = ?`).run(now, id);
  })();
  runner.abortWhere((j) => j.source_id === id);
}

/** Removes the source. With deleteData, posts found only through this source (and their comments) go too. */
export function deleteSource(app: AppContext, runner: QueueRunner, id: number, deleteData: boolean): { postsDeleted: number } {
  cancelSource(app, runner, id);
  const db = app.db;
  let postsDeleted = 0;
  db.transaction(() => {
    if (deleteData) {
      const only = db
        .prepare(`SELECT post_id FROM post_sources WHERE source_id = ? AND post_id NOT IN (SELECT post_id FROM post_sources WHERE source_id != ?)`)
        .all(id, id) as { post_id: number }[];
      const delMedia = db.prepare(`DELETE FROM media_refs WHERE (owner_type = 'post' AND owner_id = ?) OR (owner_type = 'comment' AND owner_id IN (SELECT id FROM comments WHERE post_id = ?))`);
      const delSnap = db.prepare(`DELETE FROM metric_snapshots WHERE (entity_type = 'post' AND entity_id = ?) OR (entity_type = 'comment' AND entity_id IN (SELECT id FROM comments WHERE post_id = ?))`);
      const delEdits = db.prepare(`DELETE FROM edit_history WHERE (entity_type = 'post' AND entity_id = ?) OR (entity_type = 'comment' AND entity_id IN (SELECT id FROM comments WHERE post_id = ?))`);
      const delPost = db.prepare('DELETE FROM posts WHERE id = ?');
      for (const { post_id } of only) {
        delMedia.run(post_id, post_id);
        delSnap.run(post_id, post_id);
        delEdits.run(post_id, post_id);
        delPost.run(post_id);
      }
      postsDeleted = only.length;
    }
    db.prepare('DELETE FROM sources WHERE id = ?').run(id);
  })();
  log.info('source deleted', { id, deleteData, postsDeleted });
  return { postsDeleted };
}

export function pausePlatform(app: AppContext, runner: QueueRunner, platform: Platform | 'global'): void {
  setPlatformState(app.db, platform, { paused: true });
  runner.abortWhere((j) => platform === 'global' || j.platform === platform);
}

export function resumePlatformOrGlobal(app: AppContext, platform: Platform | 'global'): void {
  if (platform === 'global') setPlatformState(app.db, 'global', { paused: false });
  else resumePlatform(app.db, platform);
}
