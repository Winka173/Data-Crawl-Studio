// Synthetic Facebook data in the shape of the JSON the web app receives (GraphQL / embedded Relay data).
// No real people, groups or posts. Names exist ONLY to prove they never reach the database.

import type { Pacer } from '../../../src/browser/pacing';
import { FeedFetchError, type FbDriver, type Snapshot } from '../../../src/platforms/facebook/driver';
import { detectBlockInPage, detectBlockInResponse } from '../../../src/platforms/facebook/detect';
import { extractFrom, type Extracted, type FeedPage } from '../../../src/platforms/facebook/extract';
import { BlockedError, TransientError } from '../../../src/queue/errors';

export const GROUP_ID = '900000000000001';
export const GROUP_SLUG = 'synthetic.test.group';
export const GROUP_NAME = 'Synthetic Test Group';
export const PAGE_ID = '700000000000001';
export const userId = (n: number) => String(100000000000000 + n);
export const userName = (n: number) => `Synthetic Person ${n}`;

const b64 = (s: string) => Buffer.from(s).toString('base64');

export interface CommentSpec {
  id: string;
  author: number | 'page';
  text: string;
  ageMin: number;
  reactions?: number;
  mention?: number;
  edited?: boolean;
  replies?: CommentSpec[];
}

export interface PostSpec {
  id: string;
  author: number | 'page';
  ageDays: number;
  text: string;
  mention?: number;
  reactions: number;
  shares: number;
  photos?: number;
  video?: boolean;
  shared?: boolean;
  /** Simulate a node in an unexpected shape: no creation time anywhere. */
  noTime?: boolean;
  comments: CommentSpec[];
}

function actor(a: number | 'page') {
  return a === 'page'
    ? { __typename: 'Page', id: PAGE_ID, name: 'Synthetic Brand Page', url: 'https://www.facebook.com/syntheticbrand' }
    : { __typename: 'User', id: userId(a), name: userName(a), url: `https://www.facebook.com/profile.php?id=${userId(a)}`, profile_picture: { uri: `https://scontent.example/avatar${a}.jpg` } };
}

function textWithMention(text: string, mention?: number) {
  if (mention === undefined) return { text, ranges: [] };
  const name = userName(mention);
  const full = `${name} ${text}`;
  return { text: full, ranges: [{ offset: 0, length: name.length, entity: { __typename: 'User', id: userId(mention), url: `https://www.facebook.com/${userId(mention)}` } }] };
}

export function commentNode(c: CommentSpec, postId: string, now: number, depth = 0, withReplies = true, parentId?: string): Record<string, unknown> {
  return {
    __typename: 'Comment',
    id: b64(`comment:${postId}_${c.id}`),
    legacy_fbid: c.id,
    depth,
    // 2026 shape: a reply names its parent (with the parent's author, a person) instead of being nested only.
    ...(parentId ? { comment_direct_parent: { id: b64(`comment:${postId}_${parentId}`), author: actor(1) } } : {}),
    created_time: Math.floor(now / 1000) - c.ageMin * 60,
    body: textWithMention(c.text, c.mention),
    author: actor(c.author),
    is_edited: c.edited ?? false,
    feedback: {
      id: b64(`feedback:${postId}_${c.id}`),
      reactors: { count: c.reactions ?? 0 },
      replies_fields: { count: c.replies?.length ?? 0, total_count: c.replies?.length ?? 0 },
      replies_connection: { edges: withReplies ? (c.replies ?? []).map((r) => ({ node: commentNode(r, postId, now, depth + 1, true, c.id) })) : [], page_info: { has_next_page: !withReplies && !!c.replies?.length } },
    },
  };
}

export function storyNode(p: PostSpec, now: number, opts: { withComments?: boolean; withReplies?: boolean } = {}): Record<string, unknown> {
  const created = Math.floor(now / 1000) - p.ageDays * 86400;
  const url = `https://www.facebook.com/groups/${GROUP_ID}/posts/${p.id}/`;
  const media = [
    ...Array.from({ length: p.photos ?? 0 }, (_, i) => ({ __typename: 'Photo', id: `55${p.id}${i}`, image: { uri: `https://scontent.example/p${p.id}_${i}.jpg`, width: 960, height: 720 }, accessibility_caption: 'May be an image of text' })),
    ...(p.video ? [{ __typename: 'Video', id: `66${p.id}`, permalink_url: `https://www.facebook.com/synthetic.uploader${typeof p.author === 'number' ? p.author : 0}/videos/66${p.id}/?idorvanity=${GROUP_ID}`, length_in_second: 42.317 }] : []),
  ];
  const countTotal = (cs: CommentSpec[]): number => cs.reduce((n, c) => n + 1 + countTotal(c.replies ?? []), 0);
  return {
    __typename: 'Story',
    id: b64(`S:_I${GROUP_ID}:${p.id}`),
    post_id: p.id,
    to: { __typename: 'Group', id: GROUP_ID, name: GROUP_NAME, url: `https://www.facebook.com/groups/${GROUP_SLUG}/` },
    comet_sections: {
      content: {
        story: {
          message: textWithMention(p.text, p.mention),
          attachments: media.length > 1
            ? [{ styles: { attachment: { all_subattachments: { nodes: media.map((m) => ({ media: m })) } } } }]
            : media.map((m) => ({ styles: { attachment: { media: m } } })),
          ...(p.shared
            ? { attached_story: { __typename: 'Story', post_id: '123456789', message: { text: 'Shared from elsewhere' }, actors: [actor(99)], comet_sections: { metadata: [{ story: { creation_time: 1 } }] } } }
            : {}),
        },
      },
      context_layout: {
        story: {
          comet_sections: {
            actor_photo: { story: { actors: [actor(p.author)] } },
            metadata: [{ __typename: 'CometFeedStoryMinimizedTimestampStrategy', story: { ...(p.noTime ? {} : { creation_time: created }), url } }],
          },
        },
      },
      feedback: {
        story: {
          story_ufi_container: {
            story: {
              feedback_context: {
                feedback_target_with_context: {
                  comet_ufi_summary_and_actions_renderer: {
                    feedback: {
                      id: b64(`feedback:${p.id}`),
                      reaction_count: { count: p.reactions },
                      top_reactions: { edges: [{ reaction_count: Math.ceil(p.reactions * 0.8), node: { reaction_type: 'LIKE', localized_name: 'Like' } }, { reaction_count: Math.floor(p.reactions * 0.2), node: { reaction_type: 'LOVE', localized_name: 'Love' } }] },
                      share_count: { count: p.shares },
                      comment_rendering_instance: { comments: { total_count: countTotal(p.comments) } },
                      ...(opts.withComments
                        ? { display_comments: { edges: p.comments.map((c) => ({ node: commentNode(c, p.id, now, 0, opts.withReplies ?? true) })) } }
                        : {}),
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

export function syntheticGroup(now: number): PostSpec[] {
  const posts: PostSpec[] = [
    { id: '1000000000000999', author: 3, ageDays: 200, text: 'Pinned rules of the group (old).', reactions: 50, shares: 0, comments: [] },
  ];
  const ages = [0.2, 1, 2, 3, 5, 8, 12, 20, 28, 35, 45];
  ages.forEach((age, i) => {
    const id = String(1000000000000001 + i);
    posts.push({
      id,
      author: i === 4 ? 'page' : (i % 7) + 1,
      ageDays: age,
      text: i % 2 ? `Bài viết thử nghiệm số ${i} – có ai biết không?` : `Synthetic post ${i}, asking a question`,
      mention: i === 1 ? 5 : undefined,
      reactions: 3 * (i + 1),
      shares: i % 3,
      photos: i === 2 ? 3 : i === 6 ? 1 : 0,
      video: i === 3,
      shared: i === 5,
      comments:
        i === 0
          ? [
              { id: '2000000000000001', author: 2, text: 'First top-level comment', ageMin: 50, reactions: 4, replies: [
                { id: '2000000000000002', author: 3, text: 'A reply', ageMin: 40, mention: 2, replies: [
                  { id: '2000000000000003', author: 2, text: 'Reply to the reply', ageMin: 30 },
                ] },
                { id: '2000000000000004', author: 'page', text: 'Official answer from the page', ageMin: 35, reactions: 9 },
              ] },
              { id: '2000000000000005', author: 4, text: 'Bình luận tiếng Việt @someone hay quá', ageMin: 20, edited: true },
              { id: '2000000000000006', author: 5, text: 'Another one', ageMin: 10 },
            ]
          : i < 8
            ? [{ id: `30000000000000${String(i).padStart(2, '0')}`, author: 6, text: `Comment on post ${i}`, ageMin: 15 }]
            : [],
    });
  });
  void now;
  return posts;
}

// ---- fake driver -------------------------------------------------------------------------------

export interface FakeFbOptions {
  posts: PostSpec[];
  now: number;
  perScreen?: number;
  loggedIn?: boolean;
  /** Return a block page/response at the n-th action (1-based). */
  blockAt?: { action: number; kind: 'page' | 'response'; url?: string; text?: string; apiError?: number };
  /** Simulate a Facebook layout change: the page renders articles but the JSON has no Story nodes. */
  brokenJson?: boolean;
  allCommentsControl?: boolean;
  /** A "more replies" control that stays on screen and loads nothing when clicked. */
  deadExpandButton?: boolean;
  /** Like the 2026 permalink page: only this many top-level comments at first, the rest load as the page scrolls. */
  commentsPerScreen?: number;
  /** Feed paging (D31): after the first scroll the feed can be followed page by page with cursors "c<index>". */
  feedApi?: boolean;
  /** Feed page requests (1-based count over the driver's life) that fail as a stale/unknown request would. */
  failFetch?: 'always' | number[];
  /** Feed page request (1-based) that fails like a network error: the job is retried later. */
  transientAtFetch?: number;
  pacer?: Pacer;
}

export class FakeFbDriver implements FbDriver {
  actions = 0;
  opened: string[] = [];
  diagnosed: string[] = [];
  scrolls = 0;
  /** Cursor of every feed page request, in order. */
  fetched: string[] = [];
  /** Feed position reached through the page's own scrolling; null until the first scroll after open(). */
  private uiFeed: FeedPage | null = null;
  private screen = 0;
  private queue: unknown[] = [];
  private expandQueue: unknown[] = [];
  private blockedResponse: { status: number; body: unknown } | null = null;

  constructor(public o: FakeFbOptions) {}

  private async act(signal: AbortSignal, url: string): Promise<void> {
    await this.o.pacer?.beforeAction('facebook', signal);
    this.actions++;
    const b = this.o.blockAt;
    if (b && this.actions === b.action) {
      if (b.kind === 'page') {
        const hit = detectBlockInPage(b.url ?? url, b.text ?? '');
        if (hit) throw new BlockedError(`Facebook: ${hit.code}`, hit.code);
      } else {
        this.blockedResponse = { status: 200, body: { errors: [{ code: b.apiError ?? 1675004, message: 'blocked' }] } };
      }
    }
  }

  async loggedIn() {
    return this.o.loggedIn ?? true;
  }

  async diagnose(reason: string) {
    this.diagnosed.push(reason);
    return null;
  }

  async open(url: string, into: Extracted, signal: AbortSignal): Promise<Snapshot> {
    await this.act(signal, url);
    this.opened.push(url);
    const per = this.o.perScreen ?? 4;
    const post = /\/posts\/(\d+)\//.exec(url)?.[1];
    if (post) {
      const spec = this.o.posts.find((p) => p.id === post);
      if (!spec) return { url, hasFeed: false, articleCount: 0, notAvailable: true };
      // Like Facebook: the first screen shows top-level comments only; replies arrive when expanded.
      const k = this.o.commentsPerScreen;
      this.commentPages = [];
      if (this.o.brokenJson) {
        /* nothing readable */
      } else if (k) {
        const page = (cs: CommentSpec[]) => ({ data: { node: { __typename: 'Feedback', id: b64(`feedback:${spec.id}`), display_comments: { edges: cs.map((c) => ({ node: commentNode(c, spec.id, this.o.now, 0, false) })) } } } });
        extractFrom({ data: { node: storyNode(spec, this.o.now) } }, into);
        extractFrom(page(spec.comments.slice(0, k)), into);
        for (let i = k; i < spec.comments.length; i += k) this.commentPages.push(page(spec.comments.slice(i, i + k)));
      } else extractFrom({ data: { node: storyNode(spec, this.o.now, { withComments: true, withReplies: false }) } }, into);
      // "View N replies" loads the replies as a page of the parent's Feedback (2026 shape), which points back to its owner.
      this.expandQueue = spec.comments
        .filter((c) => c.replies?.length)
        .map((c) => ({
          data: {
            node: {
              __typename: 'Feedback',
              id: b64(`feedback:${spec.id}_${c.id}`),
              parent_object_ent: { __typename: 'Comment', id: b64(`comment:${spec.id}_${c.id}`), legacy_fbid: c.id, created_time: 1 },
              replies_connection: { edges: (c.replies ?? []).map((r) => ({ node: commentNode(r, spec.id, this.o.now, 1, true, c.id) })) },
            },
          },
        }));
      return { url, hasFeed: false, articleCount: 1, notAvailable: false };
    }
    this.screen = 0;
    this.uiFeed = null;
    const docs = this.o.brokenJson ? [] : this.o.posts.map((p) => ({ data: { node: { group_feed: { edges: [{ node: storyNode(p, this.o.now) }] } } } }));
    this.queue = docs.slice(per);
    for (const d of docs.slice(0, per)) extractFrom(d, into);
    extractFrom({ data: { group: { __typename: 'Group', id: GROUP_ID, name: GROUP_NAME, url: `https://www.facebook.com/groups/${GROUP_SLUG}/` } } }, into);
    return { url: `https://www.facebook.com/groups/${GROUP_SLUG}/?sorting_setting=CHRONOLOGICAL`, hasFeed: true, articleCount: this.o.posts.length ? per : 0, notAvailable: false };
  }

  private pending: unknown[] = [];

  private commentPages: unknown[] = [];

  async scroll(signal: AbortSignal) {
    await this.act(signal, 'https://www.facebook.com/groups/x/');
    this.scrolls++;
    if (this.opened.at(-1)?.includes('/posts/')) {
      const next = this.commentPages.shift();
      if (next) this.pending.push(next);
      return;
    }
    const per = this.o.perScreen ?? 4;
    this.pending.push(...this.queue.splice(0, per));
    this.screen++;
    const shown = Math.min(this.o.posts.length, per * (this.screen + 1));
    this.uiFeed = { cursor: `c${shown}`, hasNext: shown < this.o.posts.length };
  }

  feedState(groupId: string): FeedPage | null {
    return this.o.feedApi && groupId === GROUP_ID ? this.uiFeed : null;
  }

  async fetchFeedPage(cursor: string, into: Extracted, signal: AbortSignal): Promise<FeedPage> {
    await this.act(signal, 'https://www.facebook.com/api/graphql/');
    this.fetched.push(cursor);
    const n = this.fetched.length;
    if (this.o.transientAtFetch === n) throw new TransientError('network error');
    const f = this.o.failFetch;
    if (f === 'always' || f?.includes(n)) throw new FeedFetchError('stale request');
    const per = this.o.perScreen ?? 4;
    const from = Number(cursor.slice(1));
    for (const p of this.o.posts.slice(from, from + per)) extractFrom({ data: { node: { group_feed: { edges: [{ node: storyNode(p, this.o.now) }] } } } }, into);
    const next = Math.min(this.o.posts.length, from + per);
    this.uiFeed = { cursor: `c${next}`, hasNext: next < this.o.posts.length };
    return this.uiFeed;
  }

  async showAllComments(signal: AbortSignal) {
    if (this.o.allCommentsControl === false) return false;
    await this.act(signal, 'https://www.facebook.com/groups/x/posts/y/');
    return true;
  }

  async expandOne(signal: AbortSignal) {
    if (this.o.deadExpandButton) {
      await this.act(signal, 'https://www.facebook.com/groups/x/posts/y/');
      return true;
    }
    if (!this.expandQueue.length) return false;
    await this.act(signal, 'https://www.facebook.com/groups/x/posts/y/');
    this.pending.push(this.expandQueue.shift());
    return true;
  }

  async drain(into: Extracted) {
    if (this.blockedResponse) {
      const hit = detectBlockInResponse(this.blockedResponse.status, this.blockedResponse.body);
      this.blockedResponse = null;
      if (hit) throw new BlockedError(`Facebook: ${hit.code}`, hit.code);
    }
    for (const d of this.pending.splice(0)) extractFrom(d, into);
  }

  async assertNotBlocked() {}
}
