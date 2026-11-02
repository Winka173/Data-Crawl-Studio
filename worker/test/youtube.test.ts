import { beforeEach, describe, expect, it } from 'vitest';
import { setSecret } from '../src/accounts';
import type { AppContext } from '../src/context';
import '../src/platforms/youtube/jobs';
import { computeCutoff, needsCommentSync } from '../src/platforms/youtube/jobs';
import { mapComment, mapVideo, parseIsoDuration, HandleBook } from '../src/platforms/youtube/map';
import { Pseudonymizer } from '../src/privacy/pseudonym';
import { platformState } from '../src/queue/queue';
import { QueueRunner } from '../src/queue/runner';
import { parseLink } from '../src/sources/links';
import { addSources, cancelSource, pauseSource, resumeSource, startCrawl } from '../src/sources/service';
import { updateSettings } from '../src/settings';
import { CHANNEL_ID, CHANNEL_TITLE, FakeYoutube, PLAYLIST_ID } from './fixtures/youtube/fakeApi';
import { makeContext } from './helpers';

describe('link parsing', () => {
  it.each([
    ['https://www.youtube.com/@FixtureChannel', 'yt_channel', 'handle', 'FixtureChannel'],
    ['youtube.com/channel/UCfixtureChannel00000001', 'yt_channel', 'id', 'UCfixtureChannel00000001'],
    ['https://m.youtube.com/user/oldname', 'yt_channel', 'username', 'oldname'],
    ['https://www.youtube.com/c/CustomName/videos', 'yt_channel', 'custom', 'CustomName'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s', 'yt_video', 'id', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'yt_video', 'id', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'yt_video', 'id', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/playlist?list=PLfixturePlaylist000000001', 'yt_playlist', 'id', 'PLfixturePlaylist000000001'],
    ['@fixturechannel', 'yt_channel', 'handle', 'fixturechannel'],
    ['https://www.facebook.com/groups/123456789/', 'fb_group', 'id', '123456789'],
    ['https://m.facebook.com/groups/some.group.slug?ref=share', 'fb_group', 'slug', 'some.group.slug'],
    ['https://www.facebook.com/profile.php?id=100064', 'fb_page', 'id', '100064'],
    ['https://www.facebook.com/SomePage', 'fb_page', 'slug', 'SomePage'],
    ['https://www.instagram.com/some.brand/', 'ig_account', 'username', 'some.brand'],
  ])('%s', (input, kind, by, value) => {
    const l = parseLink(input);
    expect(l.kind).toBe(kind);
    expect(l.ref).toEqual({ by, value });
  });

  it.each([
    ['https://example.com/x', 'unsupported_site'],
    ['https://www.instagram.com/p/ABC123/', 'instagram_post_link_use_account'],
    ['https://www.facebook.com/watch/?v=1', 'unsupported_facebook_link'],
    ['not a link at all', 'not_a_link'],
  ])('rejects %s', (input, code) => {
    expect(() => parseLink(input)).toThrow(code);
  });
});

describe('YouTube mapping', () => {
  const p = new Pseudonymizer(Buffer.alloc(32, 1));
  it('parses ISO durations', () => {
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723);
    expect(parseIsoDuration('PT59S')).toBe(59);
    expect(parseIsoDuration('P1DT1S')).toBe(86401);
    expect(parseIsoDuration('bogus')).toBeNull();
  });

  it('maps a video with public-entity author and media refs, keeping only the channel handle', () => {
    const rec = mapVideo(
      {
        id: 'vid00000001',
        snippet: { publishedAt: '2026-11-01T12:00:00Z', channelId: CHANNEL_ID, channelTitle: CHANNEL_TITLE, title: 'T', description: 'Hi @fixturechannel and @someone', thumbnails: { high: { url: 'https://i.ytimg.com/x.jpg', width: 480, height: 360 } } },
        contentDetails: { duration: 'PT4M13S' },
        statistics: { viewCount: '10', likeCount: '2', commentCount: '3' },
      },
      { channelId: CHANNEL_ID, name: CHANNEL_TITLE, handle: 'fixturechannel' },
      p,
    );
    expect(rec.author).toEqual({ kind: 'entity', id: CHANNEL_ID, name: CHANNEL_TITLE });
    expect(rec.text).toContain('@fixturechannel');
    expect(rec.text).not.toContain('@someone');
    expect(rec.publishedAt).toBe('2026-11-01T12:00:00.000Z');
    expect(rec.media).toHaveLength(2);
    expect(rec.durationSeconds).toBe(253);
  });

  it('flags edited comments and pseudonymises authors', () => {
    const rec = mapComment(
      { id: 'c1', snippet: { authorDisplayName: '@alice', authorChannelId: { value: 'UCalice' }, textOriginal: 'hello', likeCount: 3, publishedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' } },
      { videoId: 'v', parentId: null, replyCount: 0, owner: { channelId: 'UCowner', name: 'Owner', handle: null }, handles: new HandleBook(), p },
    );
    expect(rec.isEdited).toBe(true);
    expect(rec.editedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(rec.author).toEqual({ kind: 'person', pseudonym: p.of('youtube', 'UCalice') });
  });
});

describe('incremental rules', () => {
  const now = new Date('2026-11-02T00:00:00Z');
  it('first crawl uses the depth; later runs reach back to the older of last success and the recheck window', () => {
    expect(computeCutoff({ initial_crawl_done: 0, depth_days: 30, last_success_at: null }, 14, now)).toBe('2026-10-03T00:00:00.000Z');
    expect(computeCutoff({ initial_crawl_done: 0, depth_days: null, last_success_at: null }, 14, now)).toBeNull();
    expect(computeCutoff({ initial_crawl_done: 1, depth_days: 30, last_success_at: '2026-11-01T00:00:00Z' }, 14, now)).toBe('2026-10-19T00:00:00.000Z');
    expect(computeCutoff({ initial_crawl_done: 1, depth_days: 30, last_success_at: '2026-09-01T00:00:00Z' }, 14, now)).toBe('2026-08-31T00:00:00.000Z');
  });

  it('decides when a post needs its comments re-synced', () => {
    const recheckFrom = '2026-10-19T00:00:00.000Z';
    const fresh = { comment_count: 5, comments_synced_at: new Date(now.getTime() - 3600_000).toISOString() };
    expect(needsCommentSync(undefined, 5, '2026-11-01T00:00:00Z', recheckFrom, false, now.getTime())).toBe(true);
    expect(needsCommentSync(fresh, 5, '2026-11-01T00:00:00Z', recheckFrom, false, now.getTime())).toBe(false);
    expect(needsCommentSync(fresh, 6, '2026-11-01T00:00:00Z', recheckFrom, false, now.getTime())).toBe(true);
    expect(needsCommentSync(fresh, 6, '2026-01-01T00:00:00Z', recheckFrom, false, now.getTime())).toBe(false);
    expect(needsCommentSync({ comment_count: 5, comments_synced_at: '2026-10-30T00:00:00Z' }, 5, '2026-11-01T00:00:00Z', recheckFrom, false, now.getTime())).toBe(true);
  });
});

describe('YouTube collection against the fake API', () => {
  let yt: FakeYoutube;
  let app: AppContext;
  let runner: QueueRunner;

  beforeEach(() => {
    yt = new FakeYoutube(Date.now());
    app = makeContext({ fetch: yt.fetch as typeof fetch });
    setSecret(app, 'youtube.apiKey', yt.validKey, {});
    runner = new QueueRunner(app, 10);
  });

  const count = (sql: string, ...args: unknown[]) => (app.db.prepare(sql).get(...(args as never[])) as { n: number }).n;
  /** Run until idle, fast-forwarding retry backoffs. */
  const runAll = async () => {
    for (let i = 0; i < 20; i++) {
      await runner.drain();
      const waiting = count(`SELECT COUNT(*) n FROM jobs WHERE state = 'queued'`);
      if (!waiting) return;
      app.db.prepare(`UPDATE jobs SET next_run_at = ? WHERE state = 'queued'`).run(new Date(0).toISOString());
    }
  };
  const expectedComments = (maxAgeDays: number) =>
    yt.videos.filter((v) => Date.now() - Date.parse(v.publishedAt) <= maxAgeDays * 86_400_000).reduce((n, v) => n + yt.commentCount(v), 0);

  it('posts only: with comments switched off no comment call is made', async () => {
    addSources(app, { links: '@fixturechannel', depthDays: 30, collectComments: false });
    await runAll();
    expect((app.db.prepare('SELECT COUNT(*) n FROM posts').get() as { n: number }).n).toBe(6);
    expect((app.db.prepare('SELECT COUNT(*) n FROM comments').get() as { n: number }).n).toBe(0);
    expect(app.quota.status().byMethod['commentThreads.list'] ?? 0).toBe(0);
  });

  it('first crawl: posts within depth, every comment and reply, privacy, quota accounting', async () => {
    const res = addSources(app, { links: 'https://www.youtube.com/@fixturechannel', depthDays: 30 });
    expect(res.added).toHaveLength(1);
    await runAll();

    const src = app.db.prepare('SELECT * FROM sources').get() as { platform_id: string; name: string; status: string; initial_crawl_done: number };
    expect(src).toMatchObject({ platform_id: CHANNEL_ID, name: CHANNEL_TITLE, status: 'active', initial_crawl_done: 1 });
    expect(count('SELECT COUNT(*) n FROM posts')).toBe(6); // 0..5 days old; 45 and 120 days are outside the depth
    expect(count('SELECT COUNT(*) n FROM comments')).toBe(expectedComments(30));
    expect(count('SELECT COUNT(*) n FROM comments')).toBe(157);

    // Thread with 8 replies needed comments.list paging; replies hang under the top comment.
    const top = app.db.prepare(`SELECT id, reply_count FROM comments WHERE platform_id = ?`).get(yt.videos[0]!.threads[0]!.top.id) as { id: number; reply_count: number };
    expect(top.reply_count).toBe(8);
    expect(count('SELECT COUNT(*) n FROM comments WHERE parent_id = ? AND root_id = ? AND depth = 1', top.id, top.id)).toBe(8);

    // Channel owner's reply keeps the public name; people are pseudonyms; mention matches the author's pseudonym.
    expect(count(`SELECT COUNT(*) n FROM comments WHERE author_kind = 'entity' AND author_entity_name = ?`, CHANNEL_TITLE)).toBeGreaterThan(0);
    const reply = app.db.prepare(`SELECT text FROM comments WHERE platform_id = ?`).get(yt.videos[0]!.threads[0]!.replies[0]!.id) as { text: string };
    const topAuthor = app.db.prepare(`SELECT author_pseudonym FROM comments WHERE id = ?`).get(top.id) as { author_pseudonym: string };
    expect(reply.text.startsWith(`@${topAuthor.author_pseudonym} đồng ý`)).toBe(true);

    // No raw author id, handle, avatar or profile URL anywhere in the database.
    const dump = JSON.stringify(
      ['posts', 'comments', 'raw_payloads', 'pseudonyms', 'media_refs', 'errors', 'jobs'].map((t) => app.db.prepare(`SELECT * FROM ${t}`).all()),
    );
    expect(dump).not.toMatch(/UCviewer|@viewer|fake-avatar|@someoneelse/);
    expect(dump).toContain('@fixturechannel'); // the public entity's own handle stays

    // Comments disabled is recorded, not an error.
    const disabled = app.db.prepare(`SELECT extra_json FROM posts WHERE platform_id = ?`).get(yt.videos[4]!.id) as { extra_json: string };
    expect(JSON.parse(disabled.extra_json).commentsDisabled).toBe(true);

    // Quota: every API call counted once.
    expect(app.quota.status().used).toBe(yt.calls.length);
    const run = app.db.prepare('SELECT status, stats_json FROM crawl_runs').get() as { status: string; stats_json: string };
    expect(run.status).toBe('done');
    expect(JSON.parse(run.stats_json)).toMatchObject({ postsNew: 6, commentsNew: 157, apiUnits: yt.calls.length });
    expect(count('SELECT COUNT(*) n FROM metric_snapshots')).toBe(6 + 157);
    expect(count('SELECT COUNT(*) n FROM raw_payloads')).toBeGreaterThan(157);
  });

  it('re-running is idempotent and an incremental run picks up new, edited, deleted and re-counted content', async () => {
    addSources(app, { links: '@fixturechannel', depthDays: 30 });
    await runAll();
    const posts = count('SELECT COUNT(*) n FROM posts');
    const comments = count('SELECT COUNT(*) n FROM comments');

    // Nothing changed upstream: no new rows, no new snapshots, nothing marked unavailable.
    const snaps = count('SELECT COUNT(*) n FROM metric_snapshots');
    const sourceId = (app.db.prepare('SELECT id FROM sources').get() as { id: number }).id;
    startCrawl(app, sourceId, 'manual');
    await runAll();
    expect(count('SELECT COUNT(*) n FROM posts')).toBe(posts);
    expect(count('SELECT COUNT(*) n FROM comments')).toBe(comments);
    expect(count('SELECT COUNT(*) n FROM metric_snapshots')).toBe(snaps);
    expect(count('SELECT COUNT(*) n FROM comments WHERE unavailable_at IS NOT NULL')).toBe(0);
    const runs = app.db.prepare('SELECT mode FROM crawl_runs ORDER BY id').all() as { mode: string }[];
    expect(runs.map((r) => r.mode)).toEqual(['initial', 'incremental']);

    // Upstream changes.
    const v1 = yt.videos[1]!;
    const fresh = yt.addVideo(0);
    fresh.threads.push({ top: { id: 'UgNewTopComment0000000000', authorId: 'UCviewer0000000000000099', authorHandle: '@viewer99', text: 'first!', likeCount: 0, publishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, replies: [] });
    const edited = v1.threads[2]!.top;
    edited.text = 'Edited text';
    edited.updatedAt = new Date().toISOString();
    edited.likeCount = 77;
    const removed = v1.threads[1]!.replies.pop()!; // a reply disappears
    v1.views += 500;

    startCrawl(app, sourceId, 'manual');
    await runAll();

    expect(count('SELECT COUNT(*) n FROM posts')).toBe(posts + 1);
    expect(count(`SELECT COUNT(*) n FROM comments WHERE platform_id = 'UgNewTopComment0000000000'`)).toBe(1);
    const e = app.db.prepare(`SELECT id, text, is_edited, like_count FROM comments WHERE platform_id = ?`).get(edited.id) as { id: number; text: string; is_edited: number; like_count: number };
    expect(e).toMatchObject({ text: 'Edited text', is_edited: 1, like_count: 77 });
    expect(count(`SELECT COUNT(*) n FROM edit_history WHERE entity_type = 'comment' AND entity_id = ? AND new_value = 'Edited text'`, e.id)).toBe(1);
    expect(count(`SELECT COUNT(*) n FROM metric_snapshots WHERE entity_type = 'comment' AND entity_id = ?`, e.id)).toBe(2);
    expect(count(`SELECT COUNT(*) n FROM comments WHERE platform_id = ? AND unavailable_at IS NOT NULL`, removed.id)).toBe(1);
    const p1 = app.db.prepare(`SELECT id, view_count FROM posts WHERE platform_id = ?`).get(v1.id) as { id: number; view_count: number };
    expect(p1.view_count).toBe(v1.views);
    expect(count(`SELECT COUNT(*) n FROM metric_snapshots WHERE entity_type = 'post' AND entity_id = ?`, p1.id)).toBe(2);
  });

  it('a video that goes private is marked unavailable on the next run', async () => {
    addSources(app, { links: '@fixturechannel', depthDays: 7 });
    await runAll();
    yt.videos[2]!.private = true;
    const sourceId = (app.db.prepare('SELECT id FROM sources').get() as { id: number }).id;
    startCrawl(app, sourceId, 'manual');
    await runAll();
    const p = app.db.prepare('SELECT unavailable_at, unavailable_reason FROM posts WHERE platform_id = ?').get(yt.videos[2]!.id) as { unavailable_at: string | null };
    expect(p.unavailable_at).not.toBeNull();
  });

  it('playlist and single-video sources', async () => {
    addSources(app, { links: `https://www.youtube.com/playlist?list=${PLAYLIST_ID}\nhttps://youtu.be/${yt.videos[3]!.id}`, depthDays: null });
    await runAll();
    const s = app.db.prepare('SELECT kind, name, status FROM sources ORDER BY id').all();
    expect(s).toEqual([
      { kind: 'yt_playlist', name: 'Fixture playlist', status: 'active' },
      { kind: 'yt_video', name: yt.videos[3]!.title, status: 'active' },
    ]);
    expect(count('SELECT COUNT(*) n FROM posts')).toBe(4); // playlist = videos 1..3, plus the single video 4
    expect(count('SELECT COUNT(*) n FROM post_sources')).toBe(4);
  });

  it('never exceeds the daily quota: work waits for the Pacific-midnight reset instead of failing', async () => {
    updateSettings(app.db, { youtube: { dailyQuota: 120, reserveUnits: 100 } });
    addSources(app, { links: '@fixturechannel', depthDays: 30 });
    await runner.drain();
    const st = app.quota.status();
    expect(st.used).toBeLessThanOrEqual(20);
    const waiting = app.db.prepare(`SELECT next_run_at, last_error FROM jobs WHERE state = 'queued'`).all() as { next_run_at: string; last_error: string }[];
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.every((j) => j.next_run_at === st.resetsAt && /quota/.test(j.last_error))).toBe(true);
    expect(count(`SELECT COUNT(*) n FROM jobs WHERE state = 'failed'`)).toBe(0);
  });

  it('an API quotaExceeded answer stops the day even if our own count is lower', async () => {
    yt.quotaExceeded = true;
    addSources(app, { links: '@fixturechannel' });
    await runner.drain();
    expect(app.quota.status().exhausted).toBe(true);
    expect(count(`SELECT COUNT(*) n FROM jobs WHERE state = 'queued'`)).toBe(1);
  });

  it('a bad key pauses YouTube for the owner; fixing it and resuming completes the crawl', async () => {
    setSecret(app, 'youtube.apiKey', 'AIzaWrongKey', {});
    addSources(app, { links: '@fixturechannel', depthDays: 7 });
    await runner.drain();
    expect(platformState(app.db, 'youtube')).toMatchObject({ needs_user: 1, reason: 'key_invalid' });
    expect(count(`SELECT COUNT(*) n FROM jobs WHERE state = 'needs_user'`)).toBe(1);
    expect((app.db.prepare('SELECT status FROM sources').get() as { status: string }).status).toBe('needs_user');
    expect(app.secrets.record('youtube.apiKey')!.status).toBe('blocked');

    setSecret(app, 'youtube.apiKey', yt.validKey, {});
    const { resumePlatform } = await import('../src/queue/queue');
    resumePlatform(app.db, 'youtube');
    await runAll();
    expect(count('SELECT COUNT(*) n FROM posts')).toBeGreaterThan(0);
    expect((app.db.prepare('SELECT status FROM sources').get() as { status: string }).status).toBe('active');
  });

  it('transient errors are retried from the saved cursor, and a broken source never blocks the others', async () => {
    yt.failOnce = new Set([4, 9, 15]);
    addSources(app, { links: 'https://www.youtube.com/channel/UCdoesNotExist0000000000\n@fixturechannel', depthDays: 30 });
    await runAll();
    const s = app.db.prepare('SELECT platform_id, status FROM sources ORDER BY id').all() as { platform_id: string; status: string }[];
    expect(s[0]!.status).toBe('unavailable');
    expect(s[1]!.status).toBe('active');
    expect(count('SELECT COUNT(*) n FROM comments')).toBe(157);
    expect(count(`SELECT COUNT(*) n FROM errors WHERE kind = 'transient'`)).toBe(3);
    expect(count(`SELECT SUM(attempts) n FROM jobs WHERE state = 'done'`)).toBe(3);
  });

  it('resumes after a restart from the last checkpoint without refetching finished pages', async () => {
    addSources(app, { links: '@fixturechannel', depthDays: 30 });
    // Let the listing run, then pretend the app was killed while comments were running.
    await runner.tick();
    await new Promise((r) => setTimeout(r, 50));
    await runner.drain(1);
    app.db.prepare(`UPDATE jobs SET state = 'running' WHERE state = 'queued' AND type = 'yt.comments'`).run();
    const fresh = new QueueRunner(app, 10);
    fresh.start(); // recovers 'running' → 'queued'
    await fresh.stop();
    runner = fresh;
    await runAll();
    expect(count('SELECT COUNT(*) n FROM comments')).toBe(157);
    expect(count(`SELECT COUNT(*) n FROM jobs WHERE state != 'done'`)).toBe(0);
  });

  it('pause, resume and cancel a source', async () => {
    const { added } = addSources(app, { links: '@fixturechannel', depthDays: 30 });
    const id = added[0]!.id;
    pauseSource(app, runner, id);
    await runner.drain();
    expect(count('SELECT COUNT(*) n FROM posts')).toBe(0);
    expect(count(`SELECT COUNT(*) n FROM jobs WHERE state = 'paused'`)).toBe(1);
    resumeSource(app, id);
    await runner.drain(1);
    cancelSource(app, runner, id);
    await runAll();
    expect(count(`SELECT COUNT(*) n FROM jobs WHERE state IN ('queued','running','paused')`)).toBe(0);
    expect((app.db.prepare('SELECT status FROM crawl_runs').get() as { status: string }).status).toBe('cancelled');
  });
});

describe('control routes', () => {
  it('serve sources, status, posts and a post with its comment tree (default limits)', async () => {
    const { buildControlRouter, startControlServer } = await import('../src/server/control');
    const { installCrawlRoutes } = await import('../src/server/routes');
    const yt = new FakeYoutube(Date.now());
    const app = makeContext({ fetch: yt.fetch as typeof fetch });
    setSecret(app, 'youtube.apiKey', yt.validKey, {});
    const runner = new QueueRunner(app, 10);
    const server = await startControlServer(buildControlRouter(app, [(r) => installCrawlRoutes(r, app, runner)]));
    const get = async (p: string) => (await fetch(`http://127.0.0.1:${server.port}${p}`, { headers: { 'X-DCS-Token': server.token } })).json() as Promise<any>;
    try {
      addSources(app, { links: '@fixturechannel', depthDays: 7 });
      await runner.drain();
      const sources = await get('/sources');
      expect(sources[0]).toMatchObject({ name: CHANNEL_TITLE, posts: 6, comments: 157, active_jobs: 0, last_run_status: 'done' });
      const status = await get('/status');
      expect(status.totals).toMatchObject({ sources: 1, posts: 6, comments: 157 });
      const list = await get('/posts');
      expect(list.total).toBe(6);
      expect(list.items).toHaveLength(6);
      const top = list.items.find((p: { title: string }) => p.title === 'Fixture video 1');
      const detail = await get(`/posts/${top.id}`);
      expect(detail.comments).toHaveLength(105);
      expect(detail.commentsTotal).toBe(105);
      expect(detail.media.map((m: { media_type: string }) => m.media_type).sort()).toEqual(['thumbnail', 'video']);
      expect((await get('/posts?q=hay%20qu%C3%A1')).total).toBe(0); // the search is over post text, not comments
      expect((await get('/jobs?state=active'))).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
