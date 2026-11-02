// A small in-memory imitation of the YouTube Data API v3 (only the parts the collector uses).
// All data is synthetic: no real channels, people or comments. Response shapes follow the API reference.

export interface FakeComment {
  id: string;
  authorId: string | null;
  authorHandle: string;
  text: string;
  likeCount: number;
  publishedAt: string;
  updatedAt: string;
}
export interface FakeThread {
  top: FakeComment;
  replies: FakeComment[];
}
export interface FakeVideo {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  durationIso: string;
  views: number;
  likes: number;
  commentsDisabled?: boolean;
  private?: boolean;
  threads: FakeThread[];
}

export const CHANNEL_ID = 'UCfixtureChannel00000001';
export const UPLOADS_ID = 'UUfixtureChannel00000001';
export const CHANNEL_HANDLE = 'fixturechannel';
export const CHANNEL_TITLE = 'Fixture Channel (synthetic)';
export const PLAYLIST_ID = 'PLfixturePlaylist000000001';

const iso = (base: number, daysAgo: number, minutes = 0) => new Date(base - daysAgo * 86_400_000 + minutes * 60_000).toISOString().replace('.000Z', 'Z');
const viewer = (n: number) => ({ id: `UCviewer${String(n).padStart(16, '0')}`, handle: `@viewer${String(n).padStart(2, '0')}` });

export class FakeYoutube {
  videos: FakeVideo[] = [];
  calls: string[] = [];
  /** 1-based call numbers that fail with HTTP 500 once. */
  failOnce = new Set<number>();
  quotaExceeded = false;
  validKey = 'AIzaFakeValidKeyForTests_000000000000';
  threadPage = 40;
  replyPage = 3;
  private seq = 0;

  constructor(public readonly base = Date.parse('2026-11-01T12:00:00Z')) {
    const comments = (v: number, nThreads: number): FakeThread[] =>
      Array.from({ length: nThreads }, (_, t) => {
        const a = viewer((t % 30) + 1);
        const top: FakeComment = {
          id: `Ug${v}t${t}`.padEnd(26, 'x'),
          authorId: a.id,
          authorHandle: a.handle,
          text: t % 3 === 0 ? `Video hay quá, cảm ơn kênh! #${t}` : `Great video number ${v}, comment ${t}`,
          likeCount: t,
          publishedAt: iso(this.base, v, t),
          updatedAt: iso(this.base, v, t),
        };
        const nReplies = t === 0 ? 8 : t === 1 ? 2 : 0;
        const replies = Array.from({ length: nReplies }, (_, r) => {
          const b = viewer(((t + r + 5) % 30) + 1);
          const owner = r === 1;
          return {
            id: `${top.id}.r${r}`,
            authorId: owner ? CHANNEL_ID : b.id,
            authorHandle: owner ? `@${CHANNEL_HANDLE}` : b.handle,
            text: owner ? `Thanks ${a.handle}!` : `${a.handle} đồng ý, also cc @someoneelse`,
            likeCount: r,
            publishedAt: iso(this.base, v, t + r + 1),
            updatedAt: iso(this.base, v, t + r + 1),
          };
        });
        return { top, replies };
      });
    // Six recent videos (0..5 days old), one at 45 days, one at 120 days.
    const ages = [0, 1, 2, 3, 4, 5, 45, 120];
    this.videos = ages.map((age, i) => ({
      id: `vid${String(i + 1).padStart(8, '0')}`,
      title: `Fixture video ${i + 1}`,
      description: `Description ${i + 1}. Follow @${CHANNEL_HANDLE} and say hi to @viewer03.`,
      publishedAt: iso(this.base, age),
      durationIso: i === 2 ? 'PT1H2M3S' : 'PT4M13S',
      views: 1000 * (i + 1),
      likes: 10 * (i + 1),
      commentsDisabled: i === 4,
      threads: i === 0 ? comments(i, 95) : i === 4 ? [] : comments(i, 3),
    }));
  }

  commentCount(v: FakeVideo): number {
    return v.threads.reduce((n, t) => n + 1 + t.replies.length, 0);
  }

  allComments(): FakeComment[] {
    return this.videos.flatMap((v) => v.threads.flatMap((t) => [t.top, ...t.replies]));
  }

  // ---- mutations used by incremental tests
  addVideo(daysAgo = 0): FakeVideo {
    const n = this.videos.length + 1;
    const v: FakeVideo = { id: `vid${String(n).padStart(8, '0')}`, title: `Fixture video ${n}`, description: 'New one', publishedAt: iso(this.base, daysAgo, 30), durationIso: 'PT59S', views: 5, likes: 1, threads: [] };
    this.videos.unshift(v);
    return v;
  }

  // ---- HTTP surface
  fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    this.seq++;
    this.calls.push(url.pathname.split('/').pop()!);
    if (this.failOnce.delete(this.seq)) return json({ error: { code: 500, message: 'Backend Error', errors: [{ reason: 'backendError' }] } }, 500);
    if (url.searchParams.get('key') !== this.validKey) {
      return json({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', errors: [{ reason: 'badRequest' }] } }, 400);
    }
    if (this.quotaExceeded) return json({ error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } }, 403);
    const endpoint = url.pathname.split('/').pop();
    const q = url.searchParams;
    switch (endpoint) {
      case 'i18nLanguages':
        return json({ items: [{ id: 'en' }] });
      case 'channels': {
        const match = q.get('id') === CHANNEL_ID || q.get('forHandle')?.toLowerCase() === CHANNEL_HANDLE;
        return json({ kind: 'youtube#channelListResponse', items: match ? [this.channel()] : [] });
      }
      case 'playlists':
        return json({ items: q.get('id') === PLAYLIST_ID ? [{ id: PLAYLIST_ID, snippet: { title: 'Fixture playlist', channelId: CHANNEL_ID, channelTitle: CHANNEL_TITLE } }] : [] });
      case 'playlistItems':
        return this.playlistItems(q);
      case 'videos':
        return json({ items: (q.get('id') ?? '').split(',').map((id) => this.videos.find((v) => v.id === id && !v.private)).filter(Boolean).map((v) => this.video(v!)) });
      case 'commentThreads':
        return this.threads(q);
      case 'comments':
        return this.replies(q);
    }
    return json({ error: { code: 404, message: 'not found', errors: [{ reason: 'notFound' }] } }, 404);
  };

  private channel() {
    return {
      kind: 'youtube#channel',
      id: CHANNEL_ID,
      snippet: { title: CHANNEL_TITLE, customUrl: `@${CHANNEL_HANDLE}`, publishedAt: '2015-01-01T00:00:00Z' },
      contentDetails: { relatedPlaylists: { likes: '', uploads: UPLOADS_ID } },
    };
  }

  private playlistItems(q: URLSearchParams) {
    const id = q.get('playlistId');
    if (id !== UPLOADS_ID && id !== PLAYLIST_ID) return json({ error: { code: 404, errors: [{ reason: 'playlistNotFound' }] } }, 404);
    const list = id === UPLOADS_ID ? [...this.videos].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)) : this.videos.slice(0, 3).reverse();
    return json(page(list, q, 3, (v) => ({ kind: 'youtube#playlistItem', contentDetails: { videoId: v.id, videoPublishedAt: v.publishedAt } })));
  }

  private video(v: FakeVideo) {
    return {
      kind: 'youtube#video',
      id: v.id,
      snippet: {
        publishedAt: v.publishedAt,
        channelId: CHANNEL_ID,
        channelTitle: CHANNEL_TITLE,
        title: v.title,
        description: v.description,
        tags: ['fixture', 'test'],
        categoryId: '22',
        liveBroadcastContent: 'none',
        thumbnails: { high: { url: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`, width: 480, height: 360 } },
      },
      contentDetails: { duration: v.durationIso, caption: 'false', definition: 'hd' },
      statistics: { viewCount: String(v.views), likeCount: String(v.likes), favoriteCount: '0', ...(v.commentsDisabled ? {} : { commentCount: String(this.commentCount(v)) }) },
    };
  }

  private comment(c: FakeComment, videoId: string, parentId?: string) {
    return {
      kind: 'youtube#comment',
      id: c.id,
      snippet: {
        channelId: CHANNEL_ID,
        videoId,
        textDisplay: c.text,
        textOriginal: c.text,
        ...(parentId ? { parentId } : {}),
        authorDisplayName: c.authorHandle,
        authorProfileImageUrl: `https://yt3.ggpht.com/fake-avatar-${c.authorHandle.slice(1)}`,
        authorChannelUrl: `http://www.youtube.com/${c.authorHandle}`,
        ...(c.authorId ? { authorChannelId: { value: c.authorId } } : {}),
        canRate: true,
        viewerRating: 'none',
        likeCount: c.likeCount,
        publishedAt: c.publishedAt,
        updatedAt: c.updatedAt,
      },
    };
  }

  private threads(q: URLSearchParams) {
    const v = this.videos.find((x) => x.id === q.get('videoId'));
    if (!v || v.private) return json({ error: { code: 404, errors: [{ reason: 'videoNotFound' }] } }, 404);
    if (v.commentsDisabled) return json({ error: { code: 403, message: 'disabled comments', errors: [{ reason: 'commentsDisabled' }] } }, 403);
    return json(
      page(v.threads, q, this.threadPage, (t) => ({
        kind: 'youtube#commentThread',
        id: t.top.id,
        snippet: { channelId: CHANNEL_ID, videoId: v.id, topLevelComment: this.comment(t.top, v.id), canReply: true, totalReplyCount: t.replies.length, isPublic: true },
        // Like the real API: the thread carries only a few replies.
        ...(t.replies.length ? { replies: { comments: t.replies.slice(0, 5).map((r) => this.comment(r, v.id, t.top.id)) } } : {}),
      })),
    );
  }

  private replies(q: URLSearchParams) {
    const parent = q.get('parentId');
    for (const v of this.videos) {
      const t = v.threads.find((x) => x.top.id === parent);
      if (t) return json(page(t.replies, q, this.replyPage, (r) => this.comment(r, v.id, t.top.id)));
    }
    return json({ items: [] });
  }
}

function page<T, U>(list: T[], q: URLSearchParams, cap: number, map: (t: T) => U) {
  const size = Math.min(Number(q.get('maxResults') ?? 20), cap);
  const start = Number(q.get('pageToken')?.replace('p', '') ?? 0);
  const slice = list.slice(start, start + size);
  const next = start + size < list.length ? `p${start + size}` : undefined;
  return { items: slice.map(map), ...(next ? { nextPageToken: next } : {}), pageInfo: { totalResults: list.length, resultsPerPage: size } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
