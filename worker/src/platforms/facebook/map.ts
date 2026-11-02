import type { Pseudonymizer } from '../../privacy/pseudonym';
import { pseudonymizeMentions } from '../../privacy/pseudonym';
import { ParserError } from '../../queue/errors';
import { commentSchema, postSchema, type Author, type CommentRecord, type MediaRecord, type PostRecord } from '../../store/records';
import { toUtcIso } from '../../util/time';
import type { FbActor, FbCommentCandidate, FbMedia, FbPostCandidate, FbRange } from './extract';

/** The crawled group (or page) is a public entity and keeps its real name. */
export interface FbContainer {
  id: string;
  name: string | null;
}

/** Person → pseudonym. Pages (and the crawled group itself) are public entities and keep their id. */
export function fbAuthor(a: FbActor | null, container: FbContainer, p: Pseudonymizer, entityNames: Map<string, string | null> = new Map()): Author {
  if (!a) return { kind: 'unknown' };
  if (a.id === container.id) return { kind: 'entity', id: a.id, name: container.name };
  if (a.typename === 'Page' || a.typename === 'Group') return { kind: 'entity', id: a.id, name: entityNames.get(a.id) ?? null };
  return { kind: 'person', pseudonym: p.of('facebook', a.id) };
}

/**
 * Replace mentioned people (from Facebook's own mention ranges) with their pseudonym, then catch any
 * remaining "@name" style handles. Offsets are in UTF-16 code units, like JavaScript strings.
 */
export function pseudonymizeFbText(text: string | null, ranges: FbRange[], p: Pseudonymizer): string | null {
  if (text === null) return null;
  let out = text;
  const people = ranges.filter((r) => r.entity && r.entity.typename !== 'Page' && r.entity.typename !== 'Group').sort((a, b) => b.offset - a.offset);
  for (const r of people) {
    if (r.offset < 0 || r.offset + r.length > out.length) continue;
    out = `${out.slice(0, r.offset)}@${p.of('facebook', r.entity!.id)}${out.slice(r.offset + r.length)}`;
  }
  return pseudonymizeMentions(pseudonymizeFbLinks(out, p), { platform: 'facebook' }, p);
}

/** First path segments of facebook.com that are never a person's vanity name. */
const FB_SYSTEM_PATHS = new Set(
  'groups watch photo photos photo.php reel reels share sharer sharer.php hashtag events permalink.php story.php pages l.php marketplace gaming help policies business ads login settings notes media video videos stories fundraisers messages search home.php plugins dialog privacy terms legal people'.split(' '),
);
const FB_LINK = /\b((?:https?:\/\/)?(?:(?:www|m|web|mbasic)\.)?(?:facebook\.com|fb\.com))\/(?:profile\.php\?id=(\d+)|([A-Za-z0-9.]{5,}))(?=[/?#\s)\]"'<>,]|$)/gi;
/**
 * System paths that still carry a person's id (or name and id): a group member's page, a public "people" page,
 * a chat with someone, someone's story. Seen in real posts: `facebook.com/groups/<group>/user/<user id>/`.
 */
const FB_PERSON_IN_PATH =
  /\b((?:https?:\/\/)?(?:(?:www|m|web|mbasic)\.)?(?:facebook\.com|fb\.com)\/)(groups\/[^/\s?#]+\/user\/|people\/[^/\s?#]+\/|messages\/t\/|stories\/)(\d{5,})/gi;

/**
 * A link written into a post, such as `facebook.com/some.name` or `profile.php?id=…`, is a profile URL when it
 * points to a person, and the app cannot tell a person from a page. Like @mentions (D15), every such link
 * gets a pseudonym; system paths (groups, events, watch, …) are kept, minus any person id inside them.
 */
export function pseudonymizeFbLinks(text: string, p: Pseudonymizer): string {
  const inPath = text.replace(FB_PERSON_IN_PATH, (_m, host: string, kind: string, id: string) =>
    // A "people" path also holds the person's name: keep only the kind of link.
    `${host}${kind.toLowerCase().startsWith('people/') ? 'people/' : kind}${p.of('facebook', id)}`,
  );
  return inPath.replace(FB_LINK, (m, host: string, profileId: string | undefined, vanity: string | undefined) => {
    if (profileId) return `${host}/${p.of('facebook', profileId)}`;
    const v = vanity!.replace(/\.+$/, '');
    const trail = vanity!.slice(v.length);
    if (FB_SYSTEM_PATHS.has(v.toLowerCase()) || PSEUDONYM_RE.test(v)) return m;
    const pseudo = /^\d+$/.test(v) ? p.of('facebook', v) : p.of('facebook-handle', v.toLowerCase());
    return `${host}/${pseudo}${trail}`;
  });
}
const PSEUDONYM_RE = /^u_[0-9a-f]{16}$/;

function media(m: FbMedia[]): MediaRecord[] {
  return m.map((x, i) => ({
    mediaType: x.type,
    url: x.url,
    position: i,
    width: x.width,
    height: x.height,
    durationSeconds: x.durationSeconds,
    altText: x.altText,
    caption: null,
  }));
}

export function mapFbPost(c: FbPostCandidate, container: FbContainer, p: Pseudonymizer): PostRecord {
  return {
    platform: 'facebook',
    platformId: c.postId,
    containerId: container.id,
    containerName: container.name,
    postType: c.media.length > 1 ? 'carousel' : c.media[0]?.type === 'video' ? 'video' : c.media.length === 1 ? 'photo' : 'post',
    url: c.url ?? `https://www.facebook.com/groups/${container.id}/posts/${c.postId}/`,
    author: fbAuthor(c.actor, container, p),
    title: null,
    text: pseudonymizeFbText(c.text, c.ranges, p),
    publishedAt: c.createdTime ? toUtcIso(c.createdTime) : null,
    isEdited: c.isEdited,
    likeCount: c.reactionCount,
    reactionCount: c.reactionCount,
    reactions: c.reactions,
    commentCount: c.commentCount,
    shareCount: c.shareCount,
    media: media(c.media),
  };
}

export function mapFbComment(c: FbCommentCandidate, postId: string, container: FbContainer, p: Pseudonymizer): CommentRecord {
  return {
    platform: 'facebook',
    platformId: c.commentId,
    postPlatformId: postId,
    parentPlatformId: c.parentCommentId,
    author: fbAuthor(c.author, container, p),
    text: pseudonymizeFbText(c.text, c.ranges, p),
    publishedAt: c.createdTime ? toUtcIso(c.createdTime) : null,
    isEdited: c.isEdited,
    likeCount: c.reactionCount,
    replyCount: c.replyCount,
    media: media(c.media),
  };
}

/**
 * Every record must validate AND carry the fields a real post/comment always has. If a batch fails,
 * the extraction no longer matches Facebook's data: nothing from the batch is stored.
 */
export function validateBatch(posts: PostRecord[], comments: CommentRecord[]): void {
  const problems: string[] = [];
  for (const r of posts) {
    const res = postSchema.safeParse(r);
    if (!res.success) problems.push(`post ${r.platformId}: ${res.error.issues.map((i) => i.path.join('.')).join(',')}`);
    else if (!r.publishedAt) problems.push(`post ${r.platformId}: no creation time`);
    else if (r.author.kind === 'unknown') problems.push(`post ${r.platformId}: no author`);
  }
  for (const r of comments) {
    const res = commentSchema.safeParse(r);
    if (!res.success) problems.push(`comment ${r.platformId}: ${res.error.issues.map((i) => i.path.join('.')).join(',')}`);
    else if (!r.publishedAt) problems.push(`comment ${r.platformId}: no creation time`);
  }
  if (problems.length) throw new ParserError(`${problems.length} extracted records failed validation`, 'validation_failed', problems.slice(0, 20));
}
