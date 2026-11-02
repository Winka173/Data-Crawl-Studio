import type { MentionContext, Pseudonymizer } from '../../privacy/pseudonym';
import { pseudonymizeMentions } from '../../privacy/pseudonym';
import type { Author, CommentRecord, MediaRecord, PostRecord } from '../../store/records';
import { toUtcIso } from '../../util/time';

// Mapping from YouTube Data API v3 resources to normalised records. Pure functions: fixture-tested.

export const YT_PARSER_VERSION = 'yt-api-1';

export interface YtThumb { url: string; width?: number; height?: number }
export interface YtVideo {
  id: string;
  snippet?: {
    publishedAt?: string;
    channelId?: string;
    channelTitle?: string;
    title?: string;
    description?: string;
    tags?: string[];
    categoryId?: string;
    liveBroadcastContent?: string;
    defaultLanguage?: string;
    defaultAudioLanguage?: string;
    thumbnails?: Record<string, YtThumb>;
  };
  contentDetails?: { duration?: string; caption?: string; definition?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string; favoriteCount?: string };
  liveStreamingDetails?: { actualStartTime?: string; scheduledStartTime?: string };
}

export interface YtComment {
  id: string;
  snippet: {
    channelId?: string;
    videoId?: string;
    authorDisplayName?: string;
    authorProfileImageUrl?: string;
    authorChannelUrl?: string;
    authorChannelId?: { value?: string };
    textDisplay?: string;
    textOriginal?: string;
    parentId?: string;
    likeCount?: number;
    publishedAt?: string;
    updatedAt?: string;
  };
}

export interface YtThread {
  id: string;
  snippet: { videoId?: string; channelId?: string; topLevelComment: YtComment; totalReplyCount?: number; canReply?: boolean; isPublic?: boolean };
  replies?: { comments?: YtComment[] };
}

export interface Owner {
  channelId: string;
  name: string | null;
  /** lower-case handle without "@", kept un-pseudonymised in text */
  handle: string | null;
}

const int = (s: string | number | undefined | null): number | null => {
  if (s === undefined || s === null || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
};

/** ISO-8601 duration (PT#H#M#S, P#DT…) to seconds. */
export function parseIsoDuration(d: string | undefined): number | null {
  if (!d) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d);
  if (!m) return null;
  const [, days, h, min, s] = m;
  return (Number(days ?? 0) * 86400) + (Number(h ?? 0) * 3600) + (Number(min ?? 0) * 60) + Number(s ?? 0);
}

function bestThumb(thumbs: Record<string, YtThumb> | undefined): YtThumb | null {
  if (!thumbs) return null;
  for (const k of ['maxres', 'standard', 'high', 'medium', 'default']) if (thumbs[k]?.url) return thumbs[k]!;
  return null;
}

export function mapVideo(v: YtVideo, owner: Owner, p: Pseudonymizer): PostRecord {
  const s = v.snippet ?? {};
  const mention: MentionContext = { platform: 'youtube', publicHandles: new Set(owner.handle ? [owner.handle] : []) };
  const duration = parseIsoDuration(v.contentDetails?.duration);
  const thumb = bestThumb(s.thumbnails);
  const watch = `https://www.youtube.com/watch?v=${v.id}`;
  const media: MediaRecord[] = [{ mediaType: 'video', url: watch, position: 0, durationSeconds: duration, width: null, height: null, altText: null, caption: null }];
  if (thumb) media.push({ mediaType: 'thumbnail', url: thumb.url, position: 0, width: thumb.width ?? null, height: thumb.height ?? null, durationSeconds: null, altText: null, caption: null });
  const channelId = s.channelId ?? owner.channelId;
  return {
    platform: 'youtube',
    platformId: v.id,
    containerId: channelId,
    containerName: s.channelTitle ?? owner.name,
    postType: v.liveStreamingDetails ? 'live' : 'video',
    url: watch,
    author: { kind: 'entity', id: channelId, name: s.channelTitle ?? owner.name },
    title: s.title ?? null,
    text: s.description ? pseudonymizeMentions(s.description, mention, p) : null,
    publishedAt: toUtcIso(s.publishedAt),
    likeCount: int(v.statistics?.likeCount),
    commentCount: int(v.statistics?.commentCount),
    viewCount: int(v.statistics?.viewCount),
    durationSeconds: duration,
    tags: s.tags ?? null,
    extra: compact({
      categoryId: s.categoryId,
      liveBroadcastContent: s.liveBroadcastContent,
      defaultLanguage: s.defaultLanguage,
      defaultAudioLanguage: s.defaultAudioLanguage,
      caption: v.contentDetails?.caption,
      definition: v.contentDetails?.definition,
      liveActualStart: toUtcIso(v.liveStreamingDetails?.actualStartTime),
    }),
    media,
  };
}

function compact(o: Record<string, unknown>): Record<string, unknown> | null {
  const out = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  return Object.keys(out).length ? out : null;
}

/** Thread-local memory of "@handle → channel id" so a mention of a commenter gets that commenter's pseudonym. */
export class HandleBook {
  private map = new Map<string, string>();
  learn(c: YtComment): void {
    const name = c.snippet.authorDisplayName;
    const id = c.snippet.authorChannelId?.value;
    if (name?.startsWith('@') && id) this.map.set(name.slice(1).toLowerCase(), id);
  }
  get known(): Map<string, string> {
    return this.map;
  }
}

export function commentAuthor(c: YtComment, owner: Owner, p: Pseudonymizer): Author {
  const id = c.snippet.authorChannelId?.value;
  if (!id) return { kind: 'unknown' };
  if (id === owner.channelId) return { kind: 'entity', id, name: owner.name };
  return { kind: 'person', pseudonym: p.of('youtube', id) };
}

export function mapComment(c: YtComment, opts: { videoId: string; parentId: string | null; replyCount: number | null; owner: Owner; handles: HandleBook; p: Pseudonymizer }): CommentRecord {
  const s = c.snippet;
  const raw = s.textOriginal ?? s.textDisplay ?? null;
  const text = raw === null ? null : pseudonymizeMentions(raw, { platform: 'youtube', knownHandles: opts.handles.known, publicHandles: new Set(opts.owner.handle ? [opts.owner.handle] : []) }, opts.p);
  const published = toUtcIso(s.publishedAt);
  const updated = toUtcIso(s.updatedAt);
  const edited = !!(updated && published && updated !== published);
  return {
    platform: 'youtube',
    platformId: c.id,
    postPlatformId: opts.videoId,
    parentPlatformId: opts.parentId,
    author: commentAuthor(c, opts.owner, opts.p),
    text,
    publishedAt: published,
    editedAt: edited ? updated : null,
    isEdited: edited,
    likeCount: int(s.likeCount),
    replyCount: opts.replyCount,
  };
}

/**
 * Raw payload with every personal field replaced: author name/avatar/channel URL removed,
 * author channel id replaced by the pseudonym, text replaced by the pseudonymised text.
 */
export function scrubComment(c: YtComment, mapped: CommentRecord): unknown {
  const { authorDisplayName: _n, authorProfileImageUrl: _a, authorChannelUrl: _u, authorChannelId: _i, textDisplay: _d, textOriginal: _o, ...rest } = c.snippet;
  const author = mapped.author;
  return {
    id: c.id,
    snippet: {
      ...rest,
      author: author.kind === 'person' ? { pseudonym: author.pseudonym } : author,
      text: mapped.text,
    },
  };
}

/** Raw video payload with the description replaced by its pseudonymised form (it can @mention people). */
export function scrubVideo(v: YtVideo, mapped: PostRecord): unknown {
  return v.snippet ? { ...v, snippet: { ...v.snippet, description: mapped.text ?? undefined } } : v;
}

export function scrubThread(t: YtThread): unknown {
  // Replies and top-level comment are stored as their own scrubbed payloads.
  const { topLevelComment: _t, ...snippet } = t.snippet;
  return { id: t.id, snippet: { ...snippet, topLevelCommentId: t.snippet.topLevelComment.id } };
}
