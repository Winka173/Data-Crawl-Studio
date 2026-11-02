import { beforeEach, describe, expect, it } from 'vitest';
import { setSecret } from '../src/accounts';
import { Pacer } from '../src/browser/pacing';
import type { AppContext } from '../src/context';
import { detectBlockInPage, detectBlockInResponse } from '../src/platforms/facebook/detect';
import { isPostMedia } from '../src/platforms/facebook/driver';
import { decodeCommentId, extractFrom, parseJsonDocuments, safeMediaUrl } from '../src/platforms/facebook/extract';
import { orderByParent, setFbDriver, timing } from '../src/platforms/facebook/jobs';
import { mapFbPost, pseudonymizeFbText, validateBatch } from '../src/platforms/facebook/map';
import '../src/platforms/youtube/jobs';
import { ShapeBook } from '../src/browser/shapes';
import { Pseudonymizer } from '../src/privacy/pseudonym';
import { ParserError, PacingWaitError } from '../src/queue/errors';
import { enqueue, platformState, resumePlatform } from '../src/queue/queue';
import { QueueRunner } from '../src/queue/runner';
import { addSources, startCrawl, updateSource } from '../src/sources/service';
import { updateSettings } from '../src/settings';
import { FakeYoutube } from './fixtures/youtube/fakeApi';
import { commentNode, FakeFbDriver, GROUP_ID, GROUP_NAME, GROUP_SLUG, PAGE_ID, storyNode, syntheticGroup, userId, userName, type FakeFbOptions } from './fixtures/facebook/builders';
import { makeContext } from './helpers';

const NOW = Date.now();
const p = new Pseudonymizer(Buffer.alloc(32, 3));

describe('Facebook extraction (synthetic GraphQL shapes)', () => {
  it('parses multi-document and guarded responses', () => {
    expect(parseJsonDocuments('for (;;);{"a":1}')).toEqual([{ a: 1 }]);
    expect(parseJsonDocuments('{"a":1}\n{"b":2}\n{"c":')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('decodes comment ids', () => {
    expect(decodeCommentId(Buffer.from('comment:111_222').toString('base64'))).toEqual({ postId: '111', commentId: '222' });
  });

  it('extracts a story with author, time, text ranges, reactions, shares, media; ignores the shared story', () => {
    const posts = syntheticGroup(NOW);
    const spec = posts.find((x) => x.photos === 3)!;
    const ex = extractFrom({ data: { node: storyNode(spec, NOW) } });
    expect(ex.posts.size).toBe(1);
    const c = ex.posts.get(spec.id)!;
    expect(c.actor).toEqual({ typename: 'User', id: userId(spec.author as number) });
    expect(c.groupId).toBe(GROUP_ID);
    expect(c.createdTime).toBe(Math.floor(NOW / 1000) - spec.ageDays * 86400);
    expect(c.reactionCount).toBe(spec.reactions);
    expect(c.reactions).toEqual({ like: Math.ceil(spec.reactions * 0.8), love: Math.floor(spec.reactions * 0.2) });
    expect(c.shareCount).toBe(spec.shares);
    expect(c.media).toHaveLength(3);
    expect(c.media[0]).toMatchObject({ type: 'image', width: 960, height: 720, altText: 'May be an image of text' });

    const shared = posts.find((x) => x.shared)!;
    const ex2 = extractFrom({ data: { node: storyNode(shared, NOW) } });
    expect([...ex2.posts.keys()]).toEqual([shared.id]);
    expect(ex.groups.get(GROUP_ID)?.name).toBe(GROUP_NAME);
  });

  it('extracts a comment tree from nested replies, three levels deep', () => {
    const post = syntheticGroup(NOW)[1]!;
    const ex = extractFrom({ data: { node: storyNode(post, NOW, { withComments: true }) } });
    const ids = [...ex.comments.values()].map((c) => [c.commentId, c.parentCommentId, c.postId]);
    expect(ids).toEqual(
      expect.arrayContaining([
        ['2000000000000001', null, post.id],
        ['2000000000000002', '2000000000000001', post.id],
        ['2000000000000003', '2000000000000002', post.id],
        ['2000000000000004', '2000000000000001', post.id],
      ]),
    );
    expect(ex.comments.get('2000000000000001')!.replyCount).toBe(2);
    expect(ex.comments.get('2000000000000005')!.isEdited).toBe(true);
    const { ordered, orphans } = orderByParent([...ex.comments.values()].reverse());
    expect(orphans).toBe(0);
    expect(ordered.findIndex((c) => c.commentId === '2000000000000001')).toBeLessThan(ordered.findIndex((c) => c.commentId === '2000000000000003'));
  });

  it('a Comment repeated inside itself is not its own reply (seen on real pages)', () => {
    const top = commentNode({ id: '2000000000000101', author: 1, text: 'top', ageMin: 9, replies: [{ id: '2000000000000102', author: 2, text: 'reply', ageMin: 5 }] }, '1000000000000001', NOW);
    const selfCopy = { ...top, feedback: { ...(top.feedback as object), comment_rendering_instance: { comment: { ...top, feedback: {} } } } };
    const ex = extractFrom({ data: { node: { __typename: 'Story', post_id: '1000000000000001', comments: { edges: [{ node: selfCopy }] } } } });
    expect(ex.comments.get('2000000000000101')?.parentCommentId).toBeNull();
    expect(ex.comments.get('2000000000000102')?.parentCommentId).toBe('2000000000000101');
    const { ordered, orphans } = orderByParent([...ex.comments.values()]);
    expect(orphans).toBe(0);
    expect(ordered.map((c) => c.commentId)).toEqual(['2000000000000101', '2000000000000102']);
  });

  it('a later, fuller sighting refreshes counts', () => {
    const post = syntheticGroup(NOW)[1]!;
    const ex = extractFrom({ data: { node: commentNode({ ...post.comments[0]!, reactions: 1 }, post.id, NOW, 0, false) } });
    extractFrom({ data: { node: commentNode({ ...post.comments[0]!, reactions: 7 }, post.id, NOW) } }, ex);
    expect(ex.comments.get('2000000000000001')!.reactionCount).toBe(7);
    expect(ex.comments.size).toBe(4);
  });
});

describe('media URLs never name a person', () => {
  it('rewrites video permalinks to watch?v=, keeps CDN files, drops anything that could be a profile', () => {
    expect(safeMediaUrl('https://www.facebook.com/some.person/videos/1234567890123456/?idorvanity=364997627165697', '1')).toBe('https://www.facebook.com/watch/?v=1234567890123456');
    expect(safeMediaUrl('https://www.facebook.com/some.person/videos/vb.100/1234567890123456/', null)).toBe('https://www.facebook.com/watch/?v=1234567890123456');
    expect(safeMediaUrl('https://www.facebook.com/watch/?v=42', null)).toBe('https://www.facebook.com/watch/?v=42');
    expect(safeMediaUrl('https://www.facebook.com/reel/987?s=x', null)).toBe('https://www.facebook.com/reel/987');
    expect(safeMediaUrl('https://www.facebook.com/photo/?fbid=55&set=a.some.person', null)).toBe('https://www.facebook.com/photo/?fbid=55');
    expect(safeMediaUrl('https://scontent.fsgn5-13.fna.fbcdn.net/v/t39/1_n.jpg?x=1', null)).toBe('https://scontent.fsgn5-13.fna.fbcdn.net/v/t39/1_n.jpg?x=1');
    expect(safeMediaUrl('https://www.facebook.com/some.person', null)).toBeNull();
    expect(safeMediaUrl('https://www.facebook.com/profile.php?id=100000000000001', null)).toBeNull();
    expect(safeMediaUrl('javascript:alert(1)', null)).toBeNull();
  });
});

describe('browser tab resources', () => {
  it('blocks post photos and videos only; interface images and facebook.com still load', () => {
    expect(isPostMedia('https://scontent.fsgn5-13.fna.fbcdn.net/v/t39/1_n.jpg?x=1', 'image')).toBe(true);
    expect(isPostMedia('https://video.fsgn5-1.fna.fbcdn.net/o1/v/t2/f2/m69/abc.mp4', 'media')).toBe(true);
    expect(isPostMedia('https://static.xx.fbcdn.net/rsrc.php/v3/icon.png', 'image')).toBe(false);
    expect(isPostMedia('https://www.facebook.com/captcha/tfbimage/?x=1', 'image')).toBe(false);
    expect(isPostMedia('https://scontent.fsgn5-13.fna.fbcdn.net/v/t39/1_n.jpg', 'xhr')).toBe(false);
    expect(isPostMedia('not a url', 'image')).toBe(false);
  });
});

describe('parser diagnostics', () => {
  it('summarises structure and typenames without keeping any value', () => {
    const book = new ShapeBook();
    book.add({ data: { node: storyNode({ id: '3000000000000001', author: 4, text: 'Secret words', ageDays: 1, mention: 5, reactions: 1, shares: 0, comments: [{ id: '2000000000000009', author: 6, text: 'hidden reply', ageMin: 3 }] }, NOW, { withComments: true }) } });
    book.add({ '100000000000004': { name: userName(4) }, data: [{ __typename: 'Comment', body: { text: 'hidden' } }] });
    const out = JSON.stringify(book.summary());
    expect(out).toContain('"Story"');
    expect(out).toContain('"Comment"');
    expect(out).toContain('body.text');
    expect(out).not.toMatch(/Secret words|hidden|Synthetic Person|3000000000000001|100000000000004|avatar|profile\.php/);
    expect(out).toContain('<n>'); // an id used as a key is masked
  });

  it('finds typed nodes nested far below the recorded depth', () => {
    const book = new ShapeBook();
    let deep: Record<string, unknown> = { __typename: 'Comment', legacy_fbid: '1', body: { text: 'x' } };
    for (let i = 0; i < 12; i++) deep = { [`level${i}`]: deep };
    book.add({ data: deep });
    const s = book.summary();
    expect(s.types.Comment?.seen).toBe(1);
    expect(Object.entries(s.types['(root)']!.paths).find(([, k]) => k.includes('@Comment'))?.[0]).toBe('data.level11.level10.level9.level8.level7.level6.level5.level4.level3.level2.level1.level0');
  });
});

describe('Facebook mapping and validation', () => {
  it('pseudonymises people (author and mention ranges), keeps pages and the group as entities', () => {
    const spec = syntheticGroup(NOW).find((x) => x.mention !== undefined)!;
    const c = extractFrom({ data: { node: storyNode(spec, NOW) } }).posts.get(spec.id)!;
    const rec = mapFbPost(c, { id: GROUP_ID, name: GROUP_NAME }, p);
    expect(rec.author).toEqual({ kind: 'person', pseudonym: p.of('facebook', userId(spec.author as number)) });
    expect(rec.text).toBe(`@${p.of('facebook', userId(spec.mention!))} ${spec.text}`);
    expect(rec.text).not.toContain('Synthetic Person');
    expect(rec.containerName).toBe(GROUP_NAME);
    const pageSpec = syntheticGroup(NOW).find((x) => x.author === 'page')!;
    const pageRec = mapFbPost(extractFrom({ data: { node: storyNode(pageSpec, NOW) } }).posts.get(pageSpec.id)!, { id: GROUP_ID, name: GROUP_NAME }, p);
    expect(pageRec.author).toEqual({ kind: 'entity', id: PAGE_ID, name: null });
  });

  it('does not re-pseudonymise a pseudonym and handles UTF-16 offsets', () => {
    const text = '😀 Synthetic Person 9 xin chào';
    const out = pseudonymizeFbText(text, [{ offset: 3, length: 'Synthetic Person 9'.length, entity: { typename: 'User', id: userId(9) } }], p)!;
    expect(out).toBe(`😀 @${p.of('facebook', userId(9))} xin chào`);
  });

  it('pseudonymises profile links written in the text, keeps group/event/watch links', () => {

    const text = 'Contact https://www.facebook.com/some.person.77/ or fb.com/profile.php?id=100000000000042, m.facebook.com/100000000000043. '
      + 'Rules: https://www.facebook.com/groups/j2team.community/ event facebook.com/events/123 video https://www.facebook.com/watch/?v=9';
    const out = pseudonymizeFbText(text, [], p)!;
    expect(out).not.toMatch(/some\.person|100000000000042|100000000000043/);
    expect(out).toContain(`https://www.facebook.com/${p.of('facebook-handle', 'some.person.77')}/`);
    expect(out).toContain(`fb.com/${p.of('facebook', '100000000000042')}`);
    expect(out).toContain('https://www.facebook.com/groups/j2team.community/');
    expect(out).toContain('facebook.com/events/123');
    expect(out).toContain('https://www.facebook.com/watch/?v=9');
    expect(pseudonymizeFbText(out, [], p)).toBe(out); // stable when applied twice
  });

  it('removes person ids that sit inside system paths (seen in a real post)', () => {
    const text = 'See https://www.facebook.com/groups/153841081324271/user/100000000000077/?__cft__[0]=AZ and '
      + 'facebook.com/people/Some-Person/100000000000078 and m.facebook.com/messages/t/100000000000079 and fb.com/stories/100000000000080/';
    const out = pseudonymizeFbText(text, [], p)!;
    expect(out).not.toMatch(/10000000000007[7-9]|100000000000080|Some-Person/);
    expect(out).toContain(`https://www.facebook.com/groups/153841081324271/user/${p.of('facebook', '100000000000077')}/`);
    expect(out).toContain(`facebook.com/people/${p.of('facebook', '100000000000078')}`);
    expect(out).toContain(`m.facebook.com/messages/t/${p.of('facebook', '100000000000079')}`);
    expect(out).toContain('https://www.facebook.com/groups/153841081324271/'); // the group itself is public
    expect(pseudonymizeFbText(out, [], p)).toBe(out);
  });

  it('rejects a batch with a record missing its creation time', () => {
    const spec = syntheticGroup(NOW)[2]!;
    const c = extractFrom({ data: { node: storyNode(spec, NOW) } }).posts.get(spec.id)!;
    const rec = mapFbPost({ ...c, createdTime: null }, { id: GROUP_ID, name: GROUP_NAME }, p);
    expect(() => validateBatch([rec], [])).toThrow(ParserError);
  });
});

describe('block detection', () => {
  it.each([
    ['https://www.facebook.com/checkpoint/1501092823525282/', '', 'checkpoint'],
    ['https://www.facebook.com/login/?next=x', '', 'login_required'],
    ['https://www.facebook.com/groups/1/', "You're Temporarily Blocked\nIt looks like you were misusing this feature", 'temporarily_blocked'],
    ['https://www.facebook.com/groups/1/', 'Bạn tạm thời bị chặn', 'temporarily_blocked'],
    ['https://www.facebook.com/groups/1/', 'Chúng tôi nghi ngờ hành vi tự động trên tài khoản của bạn', 'checkpoint'],
    ['https://www.facebook.com/groups/1/', 'Security check: enter the characters you see', 'captcha'],
    ['https://www.facebook.com/groups/1/', 'Tài khoản của bạn đã bị khóa', 'account_locked'],
  ])('%s %s → %s', (url, text, code) => {
    expect(detectBlockInPage(url, text)?.code).toBe(code);
  });

  it('ignores ordinary pages and post text', () => {
    expect(detectBlockInPage('https://www.facebook.com/groups/123/', 'Our weekly meetup. Try again later if the link is broken!')).toBeNull();
  });

  it('recognises API block codes and HTTP 429', () => {
    expect(detectBlockInResponse(200, { errors: [{ code: 1675004, message: 'Rate limit' }] })?.code).toBe('rate_limited');
    expect(detectBlockInResponse(200, { error: 1357001, errorSummary: 'Not logged in' })?.code).toBe('login_required');
    expect(detectBlockInResponse(429, {})?.code).toBe('rate_limited');
    expect(detectBlockInResponse(200, { data: {} })).toBeNull();
  });
});

describe('pacing', () => {
  it('waits a random delay inside the configured range and enforces hourly/daily caps', async () => {
    const app = makeContext();
    updateSettings(app.db, { pacing: { facebook: { minDelayMs: 4000, maxDelayMs: 8000, maxActionsPerHour: 3, maxActionsPerDay: 5 } } });
    const slept: number[] = [];
    let t = new Date('2026-11-02T10:20:00Z');
    const pacer = new Pacer(app, { sleep: async (ms) => void slept.push(ms), now: () => t, random: () => 0.5 });
    for (let i = 0; i < 3; i++) await pacer.beforeAction('facebook');
    expect(slept).toEqual([6000, 6000, 6000]);
    const err = await pacer.beforeAction('facebook').catch((e) => e);
    expect(err).toBeInstanceOf(PacingWaitError);
    expect(err.resumeAt).toBe('2026-11-02T11:05:00.000Z');
    t = new Date('2026-11-02T11:06:00Z');
    await pacer.beforeAction('facebook');
    await pacer.beforeAction('facebook');
    const dayErr = await pacer.beforeAction('facebook').catch((e) => e);
    expect(dayErr.resumeAt).toBe('2026-11-03T00:05:00.000Z');
    expect(pacer.counts('facebook')).toEqual({ hour: 2, day: 5 });
  });

  it('adds an occasional long reading pause', async () => {
    const app = makeContext();
    const slept: number[] = [];
    const pacer = new Pacer(app, { sleep: async (ms) => void slept.push(ms), random: () => 0 });
    for (let i = 0; i < 13; i++) await pacer.beforeAction('facebook');
    const cfg = app.settings().pacing.facebook;
    expect(slept.filter((ms) => ms > cfg.maxDelayMs)).toHaveLength(1);
  });
});

describe('Facebook group collection with a fake browser', () => {
  let app: AppContext;
  let runner: QueueRunner;
  let fake: FakeFbDriver;
  const count = (sql: string, ...a: unknown[]) => (app.db.prepare(sql).get(...(a as never[])) as { n: number }).n;

  const setup = (o: Partial<FakeFbOptions> = {}) => {
    fake = new FakeFbDriver({ posts: syntheticGroup(NOW), now: NOW, ...o });
    setFbDriver(() => fake);
  };
  const runAll = async () => {
    for (let i = 0; i < 10; i++) {
      await runner.drain();
      if (!count(`SELECT COUNT(*) n FROM jobs WHERE state = 'queued'`)) return;
      app.db.prepare(`UPDATE jobs SET next_run_at = ? WHERE state = 'queued'`).run(new Date(0).toISOString());
    }
  };
  const addGroup = (depth: 7 | 30 | 90 | null = 30) => addSources(app, { links: `https://www.facebook.com/groups/${GROUP_SLUG}/`, depthDays: depth });

  beforeEach(() => {
    app = makeContext();
    updateSettings(app.db, { browserTosAcceptedAt: new Date().toISOString() });
    runner = new QueueRunner(app, 10);
    setup();
  });

  it('refuses Facebook sources until the browser notice is accepted', () => {
    const fresh = makeContext();
    const res = addSources(fresh, { links: 'https://www.facebook.com/groups/123/' });
    expect(res.errors).toEqual([{ input: 'https://www.facebook.com/groups/123/', code: 'browser_notice_not_accepted' }]);
  });

  it('first crawl: posts inside the depth (past an old pinned post), all comments and replies, privacy', async () => {
    expect(addGroup(30).added).toHaveLength(1);
    await runAll();
    const src = app.db.prepare('SELECT platform_id, name, status, initial_crawl_done FROM sources').get();
    expect(src).toEqual({ platform_id: GROUP_ID, name: GROUP_NAME, status: 'active', initial_crawl_done: 1 });
    expect(count('SELECT COUNT(*) n FROM posts')).toBe(9); // ages ≤ 28 days; the 200-day pinned post and 35/45-day posts are out
    expect(count('SELECT COUNT(*) n FROM comments')).toBe(13);
    expect(count('SELECT COUNT(*) n FROM comments WHERE depth = 2')).toBe(1);
    expect(count(`SELECT COUNT(*) n FROM comments WHERE author_kind = 'entity' AND author_entity_id = ?`, PAGE_ID)).toBe(1);
    expect(count(`SELECT COUNT(*) n FROM posts WHERE post_type = 'carousel'`)).toBe(1);
    expect(count(`SELECT COUNT(*) n FROM media_refs WHERE media_type = 'video' AND duration_seconds = 42`)).toBe(1);
    expect(count(`SELECT COUNT(*) n FROM posts WHERE reactions_json LIKE '%"love"%'`)).toBe(9);
    const dump = JSON.stringify(['posts', 'comments', 'raw_payloads', 'pseudonyms', 'media_refs', 'jobs', 'errors', 'sources'].map((t) => app.db.prepare(`SELECT * FROM ${t}`).all()));
    expect(dump).not.toMatch(/Synthetic Person|synthetic\.uploader|avatar\d|profile\.php|1000000000000\d\d(?!\d)/);
    for (let n = 1; n <= 9; n++) expect(dump).not.toContain(userId(n));
    const reply = app.db.prepare(`SELECT text FROM comments WHERE platform_id = '2000000000000002'`).get() as { text: string };
    expect(reply.text).toBe(`@${app.pseudonymizer().of('facebook', userId(2))} A reply`);
    expect(app.db.prepare(`SELECT status FROM crawl_runs`).get()).toEqual({ status: 'done' });
  });

  it('is idempotent and detects deleted comments on the next complete pass', async () => {
    addGroup(30);
    await runAll();
    const before = count('SELECT COUNT(*) n FROM comments');
    const posts = syntheticGroup(NOW);
    posts[1]!.comments.pop(); // comment 2000000000000006 deleted upstream
    posts[1]!.comments.push({ id: '2000000000000007', author: 7, text: 'new comment', ageMin: 1 });
    setup({ posts });
    const id = (app.db.prepare('SELECT id FROM sources').get() as { id: number }).id;
    app.db.prepare(`UPDATE posts SET comments_synced_at = '2000-01-01T00:00:00.000Z'`).run(); // force re-sync
    startCrawl(app, id, 'manual');
    await runAll();
    expect(count('SELECT COUNT(*) n FROM posts')).toBe(9);
    expect(count('SELECT COUNT(*) n FROM comments')).toBe(before + 1);
    expect(count(`SELECT COUNT(*) n FROM comments WHERE platform_id = '2000000000000006' AND unavailable_at IS NOT NULL`)).toBe(1);
  });

  it('without the "All comments" control nothing is marked deleted', async () => {
    addGroup(7);
    await runAll();
    const posts = syntheticGroup(NOW);
    posts[1]!.comments.pop();
    setup({ posts, allCommentsControl: false });
    app.db.prepare(`UPDATE posts SET comments_synced_at = '2000-01-01T00:00:00.000Z'`).run();
    startCrawl(app, (app.db.prepare('SELECT id FROM sources').get() as { id: number }).id, 'manual');
    await runAll();
    expect(count(`SELECT COUNT(*) n FROM comments WHERE unavailable_at IS NOT NULL`)).toBe(0);
  });

  it('a control that loads nothing is clicked only a few times, and the pass is not treated as complete', async () => {
    addGroup(7);
    await runAll();
    const posts = syntheticGroup(NOW);
    posts[1]!.comments.pop();
    setup({ posts, deadExpandButton: true });
    app.db.prepare(`UPDATE posts SET comments_synced_at = '2000-01-01T00:00:00.000Z'`).run();
    const jobsBefore = fake.actions;
    startCrawl(app, (app.db.prepare('SELECT id FROM sources').get() as { id: number }).id, 'manual');
    await runAll();
    const commentJobs = count(`SELECT COUNT(*) n FROM jobs WHERE type = 'fb.comments' AND state = 'done' AND run_id = 2`);
    expect(commentJobs).toBeGreaterThan(0);
    // per post: open + "All comments" + 5 idle clicks at most
    expect(fake.actions - jobsBefore).toBeLessThanOrEqual(1 + commentJobs * (2 + 5) + 10);
    expect(count(`SELECT COUNT(*) n FROM comments WHERE unavailable_at IS NOT NULL`)).toBe(0);
  });

  it('comments that load only as the page scrolls are all collected, and complete posts cost no extra scroll', async () => {
    setup({ commentsPerScreen: 1 });
    addGroup(30);
    await runAll();
    expect(count('SELECT COUNT(*) n FROM comments')).toBe(13);
    // Scrolls on post pages: one per extra comment page, plus at most two idle ones per post that still looks short.
    const postsWithComments = syntheticGroup(NOW).filter((p) => p.comments.length > 1).length;
    expect(fake.opened.filter((u) => u.includes('/posts/')).length).toBe(9);
    expect(fake.actions).toBeLessThan(80 + postsWithComments * 2);
  });

  it('posts only: with comments switched off no post is opened and no comment is stored', async () => {
    const res = addSources(app, { links: `https://www.facebook.com/groups/${GROUP_SLUG}/`, depthDays: 45, collectComments: false });
    expect(res.added[0]).toMatchObject({ depth_days: 45, collect_comments: 0 });
    await runAll();
    expect(count('SELECT COUNT(*) n FROM posts')).toBe(10); // the posts younger than 45 days (the 45-day one sits just past the cutoff)
    expect(count(`SELECT COUNT(*) n FROM posts WHERE comment_count > 0`)).toBeGreaterThan(0); // the counts are still there
    expect(count('SELECT COUNT(*) n FROM comments')).toBe(0);
    expect(count(`SELECT COUNT(*) n FROM jobs WHERE type = 'fb.comments'`)).toBe(0);
    expect(fake.opened.some((u) => u.includes('/posts/'))).toBe(false);
    expect(app.db.prepare('SELECT status FROM crawl_runs').get()).toEqual({ status: 'done' });
  });

  it('switching comments off drops waiting comment jobs and keeps stored comments', async () => {
    const id = addGroup(30).added[0]!.id;
    await runAll();
    const stored = count('SELECT COUNT(*) n FROM comments');
    const runId = startCrawl(app, id, 'manual');
    for (const t of ['a', 'b', 'c']) enqueue(app.db, { platform: 'facebook', type: 'fb.comments', sourceId: id, runId, target: t });
    expect(count(`SELECT COUNT(*) n FROM jobs WHERE type = 'fb.comments' AND state = 'queued'`)).toBe(3);
    expect(updateSource(app, id, { collectComments: false }).collect_comments).toBe(0);
    expect(count(`SELECT COUNT(*) n FROM jobs WHERE type = 'fb.comments' AND state = 'queued'`)).toBe(0);
    expect(count('SELECT COUNT(*) n FROM comments')).toBe(stored);
  });

  it('accepts any whole number of days as depth, and rejects the rest', () => {
    expect(addSources(app, { links: 'https://www.facebook.com/groups/111/', depthDays: 730 }).added[0]?.depth_days).toBe(730);
    for (const bad of [0, -1, 3651, 1.5, '30' as never]) {
      expect(() => addSources(app, { links: 'https://www.facebook.com/groups/222/', depthDays: bad })).toThrow(/depthDays/);
    }
  });

  it('a checkpoint stops Facebook at once, marks its jobs Paused (Needs user), leaves YouTube running', async () => {
    const yt = new FakeYoutube(NOW);
    app.fetch = yt.fetch as typeof fetch;
    setSecret(app, 'youtube.apiKey', yt.validKey, {});
    setup({ blockAt: { action: 3, kind: 'page', url: 'https://www.facebook.com/checkpoint/828281030927956/' } });
    addGroup(30);
    addSources(app, { links: '@fixturechannel', depthDays: 7 });
    await runAll();
    expect(platformState(app.db, 'facebook')).toMatchObject({ needs_user: 1, reason: 'checkpoint' });
    expect(count(`SELECT COUNT(*) n FROM jobs WHERE platform = 'facebook' AND state IN ('queued','running')`)).toBe(0);
    expect(count(`SELECT COUNT(*) n FROM jobs WHERE platform = 'facebook' AND state = 'needs_user'`)).toBeGreaterThan(0);
    const actionsAtBlock = fake.actions;
    await runAll();
    expect(fake.actions).toBe(actionsAtBlock); // nothing touches Facebook while it waits for the owner
    expect(count(`SELECT COUNT(*) n FROM posts WHERE platform = 'youtube'`)).toBeGreaterThan(0);
    expect((app.db.prepare(`SELECT status FROM sources WHERE platform = 'facebook'`).get() as { status: string }).status).toBe('needs_user');

    // The owner solves it in the visible window and presses Resume.
    setup();
    resumePlatform(app.db, 'facebook');
    await runAll();
    expect(count(`SELECT COUNT(*) n FROM posts WHERE platform = 'facebook'`)).toBe(9);
    expect((app.db.prepare(`SELECT status FROM sources WHERE platform = 'facebook'`).get() as { status: string }).status).toBe('active');
  });

  it('a rate-limit error inside a GraphQL response also stops the platform', async () => {
    setup({ blockAt: { action: 2, kind: 'response', apiError: 1675004 } });
    addGroup(30);
    await runAll();
    expect(platformState(app.db, 'facebook')).toMatchObject({ needs_user: 1, reason: 'rate_limited' });
  });

  it('no login → Facebook waits for the owner with "login_required"', async () => {
    setup({ loggedIn: false });
    addGroup(30);
    await runAll();
    expect(platformState(app.db, 'facebook')).toMatchObject({ needs_user: 1, reason: 'login_required' });
    expect(fake.actions).toBe(0);
  });

  it('a layout change flags the source "Parser needs update" and stores nothing', async () => {
    setup({ brokenJson: true });
    addGroup(30);
    await runAll();
    const s = app.db.prepare('SELECT status FROM sources').get() as { status: string };
    expect(s.status).toBe('parser_needs_update');
    expect(count('SELECT COUNT(*) n FROM posts')).toBe(0);
    expect(count(`SELECT COUNT(*) n FROM errors WHERE kind = 'parser'`)).toBe(1);
    expect(platformState(app.db, 'facebook').needs_user).toBe(0); // other sources keep going
    expect(fake.diagnosed).toHaveLength(1); // a value-free shape summary is saved for the parser fix

    // After the parser is fixed, a run in which every job succeeds clears the flag.
    setup();
    startCrawl(app, (app.db.prepare('SELECT id FROM sources').get() as { id: number }).id, 'manual');
    await runAll();
    expect(app.db.prepare('SELECT status, initial_crawl_done FROM sources').get()).toEqual({ status: 'active', initial_crawl_done: 1 });
  });

  it('a listing that fails part-way does not count as a successful crawl (the next run is not incremental)', async () => {
    const posts = syntheticGroup(NOW);
    posts[6]!.noTime = true; // on the second screen: the first screen is stored and its comments are fetched
    setup({ posts });
    addGroup(30);
    await runAll();
    expect(count('SELECT COUNT(*) n FROM posts')).toBeGreaterThan(0);
    expect(app.db.prepare('SELECT status FROM crawl_runs').get()).toEqual({ status: 'partial' });
    expect(app.db.prepare('SELECT status, initial_crawl_done, last_success_at FROM sources').get()).toEqual({ status: 'parser_needs_update', initial_crawl_done: 0, last_success_at: null });
  });

  it('a deeper depth after the first crawl lists back to the new depth on the next run', async () => {
    addGroup(7);
    await runAll();
    const first = count('SELECT COUNT(*) n FROM posts');
    expect(first).toBeLessThan(9);
    const id = (app.db.prepare('SELECT id FROM sources').get() as { id: number }).id;
    expect(updateSource(app, id, { depthDays: 365 }).initial_crawl_done).toBe(0);
    startCrawl(app, id, 'manual');
    await runAll();
    expect(count('SELECT COUNT(*) n FROM posts')).toBe(12); // every synthetic post, including the 200-day-old pinned one
    expect(updateSource(app, id, { depthDays: 30 }).initial_crawl_done).toBe(1); // shallower: no re-listing
  });

  it('a listing that reaches the pacing cap waits in place and goes on, without reopening the feed', async () => {
    updateSettings(app.db, { pacing: { facebook: { maxActionsPerHour: 2 } } });
    const pacer = new Pacer(app, { sleep: async () => {} });
    setup({ pacer });
    const waits: number[] = [];
    const real = timing.sleep;
    // Waiting for the cap = the next hour begins: its counter starts empty.
    timing.sleep = async (ms) => {
      waits.push(ms);
      app.db.prepare('DELETE FROM action_counters').run();
    };
    try {
      addGroup(30);
      await runner.drain();
    } finally {
      timing.sleep = real;
    }
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.every((ms) => ms > 0 && ms <= 3600_000 + 600_000)).toBe(true);
    expect(fake.opened.filter((u) => !u.includes('/posts/'))).toHaveLength(1); // the feed was opened once
    expect(count('SELECT COUNT(*) n FROM posts')).toBe(9);
    expect(app.db.prepare(`SELECT state FROM jobs WHERE type = 'fb.group'`).get()).toEqual({ state: 'done' });
  });

  it('a job that reaches the pacing cap before it holds a place in the feed is re-queued for later', async () => {
    addGroup(30);
    await runAll();
    const id = (app.db.prepare('SELECT id FROM sources').get() as { id: number }).id;
    updateSettings(app.db, { pacing: { facebook: { maxActionsPerHour: 1 } } });
    setup({ pacer: new Pacer(app, { sleep: async () => {} }) });
    app.db.prepare(`INSERT INTO action_counters (platform, bucket, count) VALUES ('facebook', ?, 5) ON CONFLICT(platform, bucket) DO UPDATE SET count = 5`).run(`h:${new Date().toISOString().slice(0, 13)}`);
    startCrawl(app, id, 'manual');
    await runner.drain();
    const job = app.db.prepare(`SELECT state, next_run_at, last_error FROM jobs WHERE type = 'fb.group' ORDER BY id DESC LIMIT 1`).get() as { state: string; next_run_at: string; last_error: string };
    expect(job.state).toBe('queued');
    expect(Date.parse(job.next_run_at)).toBeGreaterThan(Date.now());
    expect(job.last_error).toMatch(/pacing/);
    expect(fake.actions).toBe(0);
  });
});
