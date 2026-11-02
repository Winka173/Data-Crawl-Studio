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
  return pseudonymizeMentions(out, { platform: 'facebook' }, p);
}

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
