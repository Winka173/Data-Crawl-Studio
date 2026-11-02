import type { JobView, Platform, PostDetail, PostListItem, SourceView, StatusView } from '../../../shared/contracts';
import { PLATFORMS } from '../../../shared/contracts';
import { HttpError } from '../accounts';
import type { AppContext } from '../context';
import { platformState } from '../queue/queue';
import type { QueueRunner } from '../queue/runner';
import { addSources, cancelSource, deleteSource, getSource, pausePlatform, pauseSource, resumePlatformOrGlobal, resumeSource, startCrawl, updateSource } from '../sources/service';
import type { Router } from './router';

const SOURCE_VIEW_SQL = `
  SELECT s.*,
    (SELECT COUNT(*) FROM post_sources ps WHERE ps.source_id = s.id) AS posts,
    (SELECT COUNT(*) FROM comments c JOIN post_sources ps ON ps.post_id = c.post_id WHERE ps.source_id = s.id) AS comments,
    (SELECT COUNT(*) FROM jobs j WHERE j.source_id = s.id AND j.state IN ('queued','running','paused','needs_user')) AS active_jobs,
    (SELECT status FROM crawl_runs r WHERE r.source_id = s.id ORDER BY r.id DESC LIMIT 1) AS last_run_status,
    (SELECT stats_json FROM crawl_runs r WHERE r.source_id = s.id ORDER BY r.id DESC LIMIT 1) AS last_run_stats
  FROM sources s`;

type RawSourceView = Omit<SourceView, 'last_run_stats'> & { last_run_stats: string | null };
const toSourceView = (r: RawSourceView): SourceView => ({ ...r, last_run_stats: r.last_run_stats ? (JSON.parse(r.last_run_stats) as Record<string, number>) : null });

function sourceView(app: AppContext, id: number): SourceView {
  const r = app.db.prepare(`${SOURCE_VIEW_SQL} WHERE s.id = ?`).get(id) as RawSourceView | undefined;
  if (!r) throw new HttpError(404, 'source not found');
  return toSourceView(r);
}

const num = (v: string | null, def: number, max: number) => {
  if (v === null || v.trim() === '') return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(max, Math.floor(n)) : def;
};

function platformParam(v: string | undefined): Platform | 'global' {
  if (v === 'global' || PLATFORMS.includes(v as Platform)) return v as Platform | 'global';
  throw new HttpError(400, 'unknown platform');
}

export function installCrawlRoutes(r: Router, app: AppContext, runner: QueueRunner): void {
  const db = app.db;

  // ---- sources
  r.get('/sources', () => (db.prepare(`${SOURCE_VIEW_SQL} ORDER BY s.created_at DESC, s.id DESC`).all() as RawSourceView[]).map(toSourceView));
  r.post('/sources', (req) => {
    const b = (req.body ?? {}) as { links?: unknown; depthDays?: unknown; scheduleMinutes?: unknown };
    if (typeof b.links !== 'string') throw new HttpError(400, 'links is required');
    const res = addSources(app, { links: b.links, depthDays: b.depthDays as never, scheduleMinutes: (b.scheduleMinutes ?? null) as number | null });
    return { ...res, added: res.added.map((s) => sourceView(app, s.id)) };
  });
  r.patch('/sources/:id', (req) => {
    const b = (req.body ?? {}) as { depthDays?: unknown; scheduleMinutes?: unknown };
    updateSource(app, Number(req.params.id), { depthDays: b.depthDays as never, scheduleMinutes: b.scheduleMinutes as never });
    return sourceView(app, Number(req.params.id));
  });
  r.delete('/sources/:id', (req) => deleteSource(app, runner, Number(req.params.id), req.query.get('deleteData') === '1'));
  r.post('/sources/:id/run', (req) => ({ runId: startCrawl(app, Number(req.params.id), 'manual') }));
  r.post('/sources/:id/pause', (req) => {
    pauseSource(app, runner, Number(req.params.id));
    return sourceView(app, Number(req.params.id));
  });
  r.post('/sources/:id/resume', (req) => {
    resumeSource(app, Number(req.params.id));
    return sourceView(app, Number(req.params.id));
  });
  r.post('/sources/:id/cancel', (req) => {
    cancelSource(app, runner, Number(req.params.id));
    return sourceView(app, Number(req.params.id));
  });
  r.get('/sources/:id/runs', (req) => {
    getSource(app, Number(req.params.id));
    return db.prepare('SELECT * FROM crawl_runs WHERE source_id = ? ORDER BY id DESC LIMIT 50').all(Number(req.params.id));
  });

  // ---- queue control: global and per platform
  r.post('/control/:platform/pause', (req) => {
    pausePlatform(app, runner, platformParam(req.params.platform));
    return { ok: true };
  });
  r.post('/control/:platform/resume', (req) => {
    resumePlatformOrGlobal(app, platformParam(req.params.platform));
    return { ok: true };
  });

  // ---- jobs
  r.get('/jobs', (req): JobView[] => {
    const where: string[] = [];
    const args: unknown[] = [];
    const state = req.query.get('state');
    if (state === 'active') where.push(`j.state IN ('queued','running','paused','needs_user')`);
    else if (state) (where.push('j.state = ?'), args.push(state));
    const platform = req.query.get('platform');
    if (platform) (where.push('j.platform = ?'), args.push(platform));
    const sourceId = req.query.get('sourceId');
    if (sourceId) (where.push('j.source_id = ?'), args.push(Number(sourceId)));
    const limit = num(req.query.get('limit'), 200, 1000);
    return db
      .prepare(
        `SELECT j.id, j.run_id, j.source_id, s.name AS source_name, j.platform, j.type, j.target, j.state, j.priority, j.attempts, j.max_attempts,
                j.next_run_at, j.last_error, j.updated_at, j.started_at
         FROM jobs j LEFT JOIN sources s ON s.id = j.source_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY CASE j.state WHEN 'running' THEN 0 WHEN 'needs_user' THEN 1 WHEN 'queued' THEN 2 WHEN 'paused' THEN 3 ELSE 4 END, j.updated_at DESC
         LIMIT ?`,
      )
      .all(...(args as never[]), limit) as JobView[];
  });

  // ---- dashboard
  r.get('/status', (): StatusView => {
    const running = db
      .prepare(
        `SELECT j.id, j.run_id, j.source_id, s.name AS source_name, j.platform, j.type, j.target, j.state, j.priority, j.attempts, j.max_attempts,
                j.next_run_at, j.last_error, j.updated_at, j.started_at
         FROM jobs j LEFT JOIN sources s ON s.id = j.source_id WHERE j.state = 'running'`,
      )
      .all() as JobView[];
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return {
      platforms: (['global', ...PLATFORMS] as const).map((p) => {
        const st = platformState(db, p);
        return { platform: p, paused: !!st.paused, needsUser: !!st.needs_user, reason: st.reason, detail: st.reason_detail };
      }),
      running,
      queueCounts: db.prepare(`SELECT platform, state, COUNT(*) n FROM jobs WHERE state IN ('queued','running','paused','needs_user','failed') GROUP BY platform, state`).all() as StatusView['queueCounts'],
      quota: app.quota.status(),
      totals: {
        sources: count('SELECT COUNT(*) n FROM sources'),
        posts: count('SELECT COUNT(*) n FROM posts'),
        comments: count('SELECT COUNT(*) n FROM comments'),
        pseudonyms: count('SELECT COUNT(*) n FROM pseudonyms'),
      },
      recentErrors: db.prepare('SELECT occurred_at, platform, kind, code, message, source_id FROM errors ORDER BY id DESC LIMIT 20').all() as StatusView['recentErrors'],
    };
  });

  // ---- data browser
  r.get('/posts', (req) => {
    const where: string[] = [];
    const args: unknown[] = [];
    const platform = req.query.get('platform');
    if (platform) (where.push('p.platform = ?'), args.push(platform));
    const sourceId = req.query.get('sourceId');
    if (sourceId) (where.push('p.id IN (SELECT post_id FROM post_sources WHERE source_id = ?)'), args.push(Number(sourceId)));
    const q = req.query.get('q');
    if (q) (where.push(`(p.title LIKE ? ESCAPE '\\' OR p.text LIKE ? ESCAPE '\\')`), args.push(`%${likeEscape(q)}%`, `%${likeEscape(q)}%`));
    const from = req.query.get('from');
    if (from) (where.push('p.published_at >= ?'), args.push(from));
    const to = req.query.get('to');
    if (to) (where.push('p.published_at < ?'), args.push(to));
    const limit = num(req.query.get('limit'), 50, 500);
    const offset = num(req.query.get('offset'), 0, 1e9);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) n FROM posts p ${w}`).get(...(args as never[])) as { n: number }).n;
    const items = db
      .prepare(
        `SELECT p.id, p.platform, p.platform_id, p.post_type, p.url, p.container_name, p.author_kind, p.author_entity_name, p.author_pseudonym,
                p.title, substr(p.text, 1, 400) AS text, p.published_at, p.like_count, p.comment_count, p.view_count, p.share_count, p.unavailable_at,
                (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS stored_comments
         FROM posts p ${w} ORDER BY p.published_at DESC, p.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...(args as never[]), limit, offset) as PostListItem[];
    return { total, items };
  });

  r.get('/posts/:id', (req): PostDetail => {
    const id = Number(req.params.id);
    const post = db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS stored_comments FROM posts p WHERE p.id = ?`,
      )
      .get(id) as PostDetail['post'] | undefined;
    if (!post) throw new HttpError(404, 'post not found');
    const limit = num(req.query.get('commentLimit'), 2000, 20000);
    return {
      post,
      media: db.prepare(`SELECT media_type, url, width, height, duration_seconds, alt_text FROM media_refs WHERE owner_type = 'post' AND owner_id = ? ORDER BY position, media_type`).all(id) as PostDetail['media'],
      snapshots: db.prepare(`SELECT observed_at, like_count, comment_count, view_count FROM metric_snapshots WHERE entity_type = 'post' AND entity_id = ? ORDER BY observed_at`).all(id) as PostDetail['snapshots'],
      comments: db
        .prepare(
          `SELECT id, parent_id, depth, author_kind, author_entity_name, author_pseudonym, text, published_at, is_edited, like_count, reply_count, unavailable_at
           FROM comments WHERE post_id = ? ORDER BY IFNULL(root_id, id), depth, published_at, id LIMIT ?`,
        )
        .all(id, limit) as PostDetail['comments'],
      commentsTotal: post.stored_comments,
    };
  });
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}
