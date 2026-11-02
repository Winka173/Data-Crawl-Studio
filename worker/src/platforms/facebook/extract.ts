// THE Facebook extraction module: every selector and every assumption about Facebook's data lives here.
// When Facebook changes its layout, this is the only file to update (bump FB_PARSER_VERSION).
//
// Strategy: read the JSON the page itself loads (GraphQL responses + JSON embedded in <script> tags)
// and walk it for Story and Comment nodes wherever they sit, instead of scraping obfuscated DOM classes.

export const FB_PARSER_VERSION = 'fb-net-5';

/** DOM selectors/texts used only to drive the page (scroll, open, expand), never to read data. */
export const SELECTORS = {
  feed: '[role="feed"]',
  article: '[role="article"]',
  dialogs: '[role="dialog"], [role="alert"]',
  embeddedJson: 'script[type="application/json"]',
  /** Buttons that load more comments or replies (English and Vietnamese UI). */
  expandButtonText: /^(view|see) (more|previous|\d+ more) (comments|replies)|^view all \d+ replies|^view \d+ repl(y|ies)|^\d+ repl(y|ies)$|^xem thêm (\d+ )?(bình luận|phản hồi)|^xem (tất cả )?\d+ phản hồi|^\d+ phản hồi$|^xem bình luận trước/i,
  /** The comment-ordering menu: switch from "Most relevant" to "All comments" so nothing is hidden. */
  commentOrderButtonText: /^(most relevant|newest|all comments|phù hợp nhất|mới nhất|tất cả bình luận)$/i,
  allCommentsMenuText: /^(all comments|tất cả bình luận)/i,
  groupNotAvailableText: /this content isn['’]t available|nội dung này hiện không khả dụng|this group is private|nhóm riêng tư|join group to see|tham gia nhóm để xem/i,
} as const;

export function groupUrl(ref: string): string {
  return `https://www.facebook.com/groups/${encodeURIComponent(ref)}/?sorting_setting=CHRONOLOGICAL`;
}

export function postUrl(groupId: string, postId: string): string {
  return `https://www.facebook.com/groups/${groupId}/posts/${postId}/`;
}

// ---- candidates (raw, still containing identifiers; mapped and pseudonymised in map.ts) ----------------

export interface FbActor {
  typename: string;
  id: string;
}

export interface FbRange {
  offset: number;
  length: number;
  entity: FbActor | null;
}

export interface FbMedia {
  type: 'image' | 'video' | 'link';
  url: string;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  altText: string | null;
}

export interface FbPostCandidate {
  postId: string;
  groupId: string | null;
  url: string | null;
  createdTime: number | null;
  text: string | null;
  ranges: FbRange[];
  actor: FbActor | null;
  reactionCount: number | null;
  reactions: Record<string, number> | null;
  commentCount: number | null;
  shareCount: number | null;
  isEdited: boolean;
  media: FbMedia[];
}

export interface FbCommentCandidate {
  commentId: string;
  postId: string | null;
  parentCommentId: string | null;
  depth: number | null;
  createdTime: number | null;
  text: string | null;
  ranges: FbRange[];
  author: FbActor | null;
  reactionCount: number | null;
  replyCount: number | null;
  isEdited: boolean;
  media: FbMedia[];
}

export interface FbGroupInfo {
  id: string;
  name: string | null;
  url: string | null;
}

export interface Extracted {
  posts: Map<string, FbPostCandidate>;
  comments: Map<string, FbCommentCandidate>;
  groups: Map<string, FbGroupInfo>;
}

export function emptyExtracted(): Extracted {
  return { posts: new Map(), comments: new Map(), groups: new Map() };
}

/** The group a page belongs to: matched by id or vanity name, else the group most posts point to. */
export function pickGroup(ex: Extracted, ref: string): FbGroupInfo | null {
  const r = ref.toLowerCase();
  for (const g of ex.groups.values()) {
    if (g.id === ref || (g.url && g.url.toLowerCase().includes(`/groups/${r}/`))) return g;
  }
  const votes = new Map<string, number>();
  for (const p of ex.posts.values()) if (p.groupId) votes.set(p.groupId, (votes.get(p.groupId) ?? 0) + 1);
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best) return null;
  return ex.groups.get(best[0]) ?? { id: best[0], name: null, url: null };
}

// ---- JSON sources ----------------------------------------------------------------------------

/** GraphQL responses are often several JSON documents separated by newlines; tolerate the "for (;;);" guard. */
export function parseJsonDocuments(body: string): unknown[] {
  const text = body.replace(/^for \(;;\);/, '').trim();
  if (!text) return [];
  try {
    return [JSON.parse(text)];
  } catch {
    const out: unknown[] = [];
    for (const line of text.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      try {
        out.push(JSON.parse(l));
      } catch {
        /* partial line: ignore */
      }
    }
    return out;
  }
}

// ---- walker ----------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);
/** Durations and sizes arrive as fractions (e.g. length_in_second: 34.567); the schema stores whole numbers. */
const whole = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};

/** Breadth-first search inside a subtree, not descending into keys in `skip` (e.g. shared/attached stories, comments). */
function bfs(root: unknown, pred: (key: string, value: unknown, parent: Obj) => boolean, skip: Set<string>, maxNodes = 20_000): unknown {
  const queue: unknown[] = [root];
  let seen = 0;
  while (queue.length && seen++ < maxNodes) {
    const v = queue.shift();
    if (Array.isArray(v)) {
      queue.push(...v);
      continue;
    }
    if (!isObj(v)) continue;
    for (const [k, child] of Object.entries(v)) {
      if (pred(k, child, v)) return child;
    }
    for (const [k, child] of Object.entries(v)) if (!skip.has(k) && child && typeof child === 'object') queue.push(child);
  }
  return undefined;
}

const STORY_SKIP = new Set(['attached_story', 'attached_story_with_attachments', 'comet_sections_for_attached_story', 'all_subattachments_for_shared', 'comments', 'comment_rendering_instance', 'comment_list_renderer', 'display_comments', 'interesting_top_level_comments', 'top_level_comments', 'replies_connection', 'comment_rendering_instance_for_feed_location']);
const COMMENT_SKIP = new Set(['replies_connection', 'replies', 'comment_parent', 'comment_direct_parent', 'parent_feedback', 'parent_object_ent', 'top_level_comments']);

export function decodeCommentId(id: string): { postId: string | null; commentId: string | null } {
  // Comment node ids look like base64("comment:<postId>_<commentId>").
  try {
    const dec = Buffer.from(id, 'base64').toString('utf8');
    const m = /^comment:(\d+)_(\d+)$/.exec(dec);
    if (m) return { postId: m[1]!, commentId: m[2]! };
  } catch {
    /* not base64 */
  }
  return { postId: null, commentId: /^\d+$/.test(id) ? id : null };
}

function actorOf(v: unknown): FbActor | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  const typename = str(v.__typename) ?? 'User';
  return id ? { typename, id } : null;
}

function rangesOf(textObj: unknown): FbRange[] {
  if (!isObj(textObj) || !Array.isArray(textObj.ranges)) return [];
  return (textObj.ranges as unknown[]).flatMap((r) => {
    if (!isObj(r)) return [];
    const offset = num(r.offset);
    const length = num(r.length);
    if (offset === null || length === null) return [];
    return [{ offset, length, entity: actorOf(r.entity) }];
  });
}

/**
 * Media URLs must not name a person. A video permalink is `facebook.com/<uploader vanity>/videos/<id>`, so it is
 * rewritten to the neutral `watch/?v=<id>`. CDN files (fbcdn.net) carry no names. Any other facebook.com URL is
 * kept only for paths that cannot hold a profile name; otherwise the media item is dropped.
 */
export function safeMediaUrl(url: string, videoId: string | null): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  if (host.endsWith('.fbcdn.net') || host === 'fbcdn.net') return url;
  if (host !== 'facebook.com' && !host.endsWith('.facebook.com')) return url; // e.g. an external link preview image
  const video = /\/videos\/(?:[^/]+\/)?(\d+)/.exec(u.pathname)?.[1] ?? (u.pathname.startsWith('/watch') ? u.searchParams.get('v') : null) ?? videoId;
  if (video && /^\d+$/.test(video) && (/\/videos\//.test(u.pathname) || u.pathname.startsWith('/watch') || u.pathname.startsWith('/reel'))) {
    return `https://www.facebook.com/watch/?v=${video}`;
  }
  const reel = /^\/reel\/(\d+)/.exec(u.pathname)?.[1];
  if (reel) return `https://www.facebook.com/reel/${reel}`;
  const fbid = u.searchParams.get('fbid');
  if (/^\/photo(\.php)?\/?$/.test(u.pathname) && fbid && /^\d+$/.test(fbid)) return `https://www.facebook.com/photo/?fbid=${fbid}`;
  return null;
}

function mediaIn(root: unknown, skip: Set<string>): FbMedia[] {
  const out: FbMedia[] = [];
  const seen = new Set<string>();
  const queue: unknown[] = [root];
  let n = 0;
  while (queue.length && n++ < 20_000) {
    const v = queue.shift();
    if (Array.isArray(v)) {
      queue.push(...v);
      continue;
    }
    if (!isObj(v)) continue;
    const t = v.__typename;
    if (t === 'Photo' || t === 'Video' || t === 'GenericAttachmentMedia') {
      const img = (isObj(v.image) ? v.image : isObj(v.photo_image) ? v.photo_image : isObj(v.viewer_image) ? v.viewer_image : null) as Obj | null;
      const raw = t === 'Video' ? str(v.permalink_url) ?? str(v.playable_url) ?? str(img?.uri) : str(img?.uri);
      const url = raw ? safeMediaUrl(raw, t === 'Video' ? str(v.id) : null) : null;
      if (url && !seen.has(url)) {
        seen.add(url);
        out.push({
          type: t === 'Video' ? 'video' : 'image',
          url,
          width: whole(img?.width) ?? whole(v.width),
          height: whole(img?.height) ?? whole(v.height),
          durationSeconds: whole(v.length_in_second) ?? (num(v.playable_duration_in_ms) !== null ? Math.round(num(v.playable_duration_in_ms)! / 1000) : null),
          altText: str(v.accessibility_caption),
        });
      }
      continue;
    }
    for (const [k, child] of Object.entries(v)) if (!skip.has(k) && child && typeof child === 'object') queue.push(child);
  }
  return out;
}

function countIn(root: unknown, keys: string[], skip: Set<string>): number | null {
  const found = bfs(root, (k, v) => keys.includes(k) && (num(v) !== null || (isObj(v) && num(v.count ?? v.total_count) !== null)), skip);
  if (found === undefined) return null;
  return num(found) ?? (isObj(found) ? num(found.count ?? found.total_count) : null);
}

function reactionsIn(root: unknown, skip: Set<string>): Record<string, number> | null {
  const top = bfs(root, (k, v) => k === 'top_reactions' && isObj(v) && Array.isArray(v.edges), skip) as Obj | undefined;
  if (!top) return null;
  const out: Record<string, number> = {};
  for (const e of top.edges as unknown[]) {
    if (!isObj(e)) continue;
    const node = isObj(e.node) ? e.node : {};
    const name = (str(node.reaction_type) ?? str(node.localized_name) ?? str(node.id) ?? 'unknown').toLowerCase();
    const c = num(e.reaction_count) ?? num(isObj(e.reaction_count) ? (e.reaction_count as Obj).count : undefined);
    if (c !== null) out[name] = c;
  }
  return Object.keys(out).length ? out : null;
}

function editedIn(root: unknown, skip: Set<string>): boolean {
  const e = bfs(root, (k, v) => (k === 'is_edited' && v === true) || (k === 'edit_history' && isObj(v) && (num(v.count) ?? 0) > 0), skip);
  return e !== undefined;
}

function storyCandidate(s: Obj): FbPostCandidate | null {
  const postId = str(s.post_id) ?? null;
  if (!postId || !/^\d+$/.test(postId)) return null;
  const msg = bfs(s, (k, v) => k === 'message' && isObj(v) && typeof v.text === 'string', STORY_SKIP) as Obj | undefined;
  const actors = bfs(s, (k, v) => k === 'actors' && Array.isArray(v) && v.length > 0, STORY_SKIP) as unknown[] | undefined;
  const created = bfs(s, (k, v) => (k === 'creation_time' || k === 'created_time') && num(v) !== null, STORY_SKIP);
  const url = bfs(s, (k, v) => (k === 'url' || k === 'permalink_url' || k === 'wwwURL') && typeof v === 'string' && /facebook\.com\/groups\/[^/]+\/(posts|permalink)\//.test(v), STORY_SKIP) as string | undefined;
  const target = bfs(s, (k, v) => (k === 'to' || k === 'target_group' || k === 'group') && isObj(v) && v.__typename === 'Group', STORY_SKIP) as Obj | undefined;
  const groupFromUrl = url ? /groups\/([^/]+)\//.exec(url)?.[1] ?? null : null;
  return {
    postId,
    groupId: str(target?.id) ?? groupFromUrl,
    url: url ?? null,
    createdTime: num(created),
    text: msg ? (msg.text as string) : null,
    ranges: rangesOf(msg),
    actor: actors ? actorOf(actors[0]) : null,
    reactionCount: countIn(s, ['reaction_count', 'reactors', 'i18n_reaction_count_number'], STORY_SKIP),
    reactions: reactionsIn(s, STORY_SKIP),
    commentCount: countIn(s, ['total_comment_count', 'comment_count'], new Set([...STORY_SKIP].filter((k) => k !== 'comments' && k !== 'comment_rendering_instance'))) ?? countIn(s, ['comments'], new Set(['replies_connection'])),
    shareCount: countIn(s, ['share_count', 'reshares'], STORY_SKIP),
    isEdited: editedIn(s, STORY_SKIP),
    media: mediaIn(s, STORY_SKIP),
  };
}

function commentCandidate(c: Obj, parent: string | null, postHint: string | null): FbCommentCandidate | null {
  const rawId = str(c.id) ?? '';
  const decoded = decodeCommentId(rawId);
  const commentId = str(c.legacy_fbid) ?? decoded.commentId;
  if (!commentId) return null;
  const body = isObj(c.body) ? c.body : isObj(c.preferred_body) ? c.preferred_body : null;
  // Replies name their parent in comment_direct_parent (2026 shape) or comment_parent (older shape).
  const parentObj = isObj(c.comment_direct_parent) ? c.comment_direct_parent : isObj(c.comment_parent) ? c.comment_parent : null;
  const explicitParent = parentObj ? (str(parentObj.legacy_fbid) ?? decodeCommentId(str(parentObj.id) ?? '').commentId) : null;
  // Facebook repeats a Comment node inside itself (e.g. under its own feedback); that copy is not its own reply.
  const parentId = [explicitParent, parent].find((x) => x && x !== commentId) ?? null;
  const feedback = isObj(c.feedback) ? c.feedback : {};
  return {
    commentId,
    postId: decoded.postId ?? postHint,
    parentCommentId: parentId,
    depth: num(c.depth),
    createdTime: num(c.created_time) ?? num(bfs(c, (k, v) => k === 'created_time' && num(v) !== null, COMMENT_SKIP)),
    text: body && typeof body.text === 'string' ? body.text : null,
    ranges: rangesOf(body),
    author: actorOf(c.author),
    reactionCount: countIn(feedback, ['reactors', 'reaction_count', 'i18n_reaction_count_number'], COMMENT_SKIP) ?? countIn(c, ['reactors', 'reaction_count'], COMMENT_SKIP),
    replyCount: countIn(feedback, ['replies_fields', 'total_reply_count', 'replies_count'], new Set()) ?? (isObj(feedback.replies_connection) ? num((feedback.replies_connection as Obj).count ?? (feedback.replies_connection as Obj).total_count) : null),
    isEdited: c.is_edited === true || (isObj(c.edit_history) && (num(c.edit_history.count) ?? 0) > 0),
    media: mediaIn(c.attachments ?? c.attachment ?? null, COMMENT_SKIP),
  };
}

/**
 * Walk any JSON document and collect every Story and Comment node into `into`.
 * Later sightings of the same id fill in fields that were missing earlier (feeds often carry partial nodes).
 */
/** Keys that point back up the tree (a reply's parent, a Feedback's owner); following them would re-nest nodes. */
const BACK_POINTERS = new Set(['comment_parent', 'comment_direct_parent', 'parent_feedback', 'parent_object_ent']);

export function extractFrom(doc: unknown, into: Extracted = emptyExtracted()): Extracted {
  const stack: { v: unknown; parentComment: string | null; post: string | null; depth: number }[] = [{ v: doc, parentComment: null, post: null, depth: 0 }];
  let guard = 0;
  while (stack.length && guard++ < 500_000) {
    const { v, parentComment, post, depth } = stack.pop()!;
    if (depth > 200) continue;
    if (Array.isArray(v)) {
      for (const x of v) stack.push({ v: x, parentComment, post, depth: depth + 1 });
      continue;
    }
    if (!isObj(v)) continue;
    let nextParent = parentComment;
    let nextPost = post;
    if (v.__typename === 'Group' && str(v.id) && /^\d+$/.test(str(v.id)!)) {
      merge(into.groups, str(v.id)!, { id: str(v.id)!, name: str(v.name), url: str(v.url) });
    }
    if (v.__typename === 'Story') {
      const cand = storyCandidate(v);
      if (cand) {
        merge(into.posts, cand.postId, cand);
        nextPost = cand.postId;
      }
    } else if (v.__typename === 'Comment') {
      const cand = commentCandidate(v, parentComment, post);
      if (cand) {
        merge(into.comments, cand.commentId, cand);
        nextParent = cand.commentId;
        nextPost = cand.postId ?? post;
      }
    }
    for (const [k, child] of Object.entries(v)) {
      if (!child || typeof child !== 'object') continue;
      // Pointers back to a parent or owner are not children; a shared (attached) story is never a post of this group.
      if (BACK_POINTERS.has(k) || k.startsWith('attached_story')) continue;
      // Replies belong to the comment we are inside; a story's comments start a new top level.
      const p = v.__typename === 'Story' ? null : nextParent;
      stack.push({ v: child, parentComment: p, post: nextPost, depth: depth + 1 });
    }
  }
  return into;
}

// ---- feed pagination (D31) -------------------------------------------------------------------

export interface FeedPage {
  cursor: string | null;
  hasNext: boolean;
}

/**
 * The feed connection's paging info in one GraphQL document: the `page_info` that sits beside `edges` holding Story
 * nodes, or a deferred chunk (`{label, path, data: {page_info}}`) whose label or path names the feed. The last match
 * wins (a streamed response sends the page info after the stories).
 */
export function feedPageInfo(doc: unknown): FeedPage | null {
  let found: FeedPage | null = null;
  const take = (pi: Obj) => {
    const cursor = str(pi.end_cursor);
    if (cursor || pi.has_next_page === false) found = { cursor, hasNext: pi.has_next_page === true && !!cursor };
  };
  if (isObj(doc) && isObj(doc.data) && isObj(doc.data.page_info)) {
    const where = `${str(doc.label) ?? ''} ${Array.isArray(doc.path) ? doc.path.join('.') : ''}`;
    if (/feed/i.test(where)) take(doc.data.page_info);
  }
  const stack: unknown[] = [doc];
  let guard = 0;
  while (stack.length && guard++ < 500_000) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
      continue;
    }
    if (!isObj(v)) continue;
    if (Array.isArray(v.edges) && isObj(v.page_info) && v.edges.some((e) => isObj(e) && isObj(e.node) && e.node.__typename === 'Story')) {
      take(v.page_info);
    }
    for (const [k, child] of Object.entries(v)) if (child && typeof child === 'object' && !BACK_POINTERS.has(k)) stack.push(child);
  }
  return found;
}

/** A feed page request worth replaying: a GraphQL POST whose variables hold a cursor and name the group. */
export function feedRequestVariables(postData: string | null): Record<string, unknown> | null {
  if (!postData) return null;
  try {
    const vars = JSON.parse(new URLSearchParams(postData).get('variables') ?? 'null') as unknown;
    return isObj(vars) && 'cursor' in vars ? vars : null;
  } catch {
    return null;
  }
}

function merge<T extends object>(map: Map<string, T>, id: string, cand: T): void {
  const prev = map.get(id);
  if (!prev) {
    map.set(id, cand);
    return;
  }
  // Feeds deliver partial nodes: fill gaps, refresh counts with the latest value, keep the longest lists.
  const out = { ...prev } as Record<string, unknown>;
  for (const [k, v] of Object.entries(cand)) {
    if (v === null || v === undefined) continue;
    const cur = out[k];
    if (cur === null || cur === undefined) out[k] = v;
    else if (typeof v === 'number') out[k] = v;
    else if (typeof v === 'boolean') out[k] = cur === true || v;
    else if (Array.isArray(v) && Array.isArray(cur) && v.length > cur.length) out[k] = v;
  }
  map.set(id, out as T);
}
