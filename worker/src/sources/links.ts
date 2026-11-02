import type { Platform } from '../../../shared/contracts';

export type SourceKind = 'yt_channel' | 'yt_playlist' | 'yt_video' | 'fb_group' | 'fb_page' | 'ig_account';

export interface ParsedLink {
  platform: Platform;
  kind: SourceKind;
  /** How the source is identified before it is resolved to a stable platform id. */
  ref: { by: 'id' | 'handle' | 'username' | 'custom' | 'slug' | 'share'; value: string };
  /** A normalised form of the input, used to detect duplicates. */
  normalized: string;
}

export class LinkError extends Error {
  constructor(public readonly input: string, public readonly code: string) {
    super(`${code}: ${input}`);
  }
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const YT_PLAYLIST_ID = /^(PL|UU|LL|FL|OL|RD)[A-Za-z0-9_-]{10,}$/;
const FB_RESERVED = new Set(['watch', 'events', 'marketplace', 'gaming', 'hashtag', 'stories', 'reel', 'reels', 'photo', 'photo.php', 'story.php', 'permalink.php', 'login', 'home.php', 'search', 'friends', 'messages', 'notifications', 'settings', 'help', 'privacy', 'policies', 'pages', 'bookmarks', 'live', 'fundraisers', 'saved', 'memories']);
const IG_RESERVED = new Set(['p', 'reel', 'reels', 'tv', 'explore', 'stories', 'accounts', 'direct', 'about', 'developer', 'legal', 'web', 'emails', 'challenge']);

export function parseLink(raw: string): ParsedLink {
  const input = raw.trim();
  if (!input) throw new LinkError(raw, 'empty');

  // Bare YouTube identifiers.
  if (/^@[\p{L}\p{N}._-]{3,100}$/u.test(input)) return yt('yt_channel', 'handle', input.slice(1));
  if (YT_CHANNEL_ID.test(input)) return yt('yt_channel', 'id', input);
  if (YT_PLAYLIST_ID.test(input) && input.length >= 18) return yt('yt_playlist', 'id', input);

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new LinkError(raw, 'not_a_link');
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|mobile|web|music)\./, '');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  if (host === 'youtu.be') {
    if (parts[0] && YT_ID.test(parts[0])) return yt('yt_video', 'id', parts[0]);
    throw new LinkError(raw, 'unsupported_youtube_link');
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') return parseYoutube(raw, url, parts);
  if (host === 'facebook.com' || host === 'fb.com') return parseFacebook(raw, url, parts);
  if (host === 'instagram.com' || host === 'instagr.am') return parseInstagram(raw, parts);
  throw new LinkError(raw, 'unsupported_site');
}

function yt(kind: SourceKind, by: ParsedLink['ref']['by'], value: string): ParsedLink {
  const normalized =
    kind === 'yt_video'
      ? `https://www.youtube.com/watch?v=${value}`
      : kind === 'yt_playlist'
        ? `https://www.youtube.com/playlist?list=${value}`
        : by === 'handle'
          ? `https://www.youtube.com/@${value.toLowerCase()}`
          : by === 'id'
            ? `https://www.youtube.com/channel/${value}`
            : `https://www.youtube.com/${by === 'username' ? 'user' : 'c'}/${value.toLowerCase()}`;
  return { platform: 'youtube', kind, ref: { by, value }, normalized };
}

function parseYoutube(raw: string, url: URL, parts: string[]): ParsedLink {
  const [a, b] = parts;
  const v = url.searchParams.get('v');
  const list = url.searchParams.get('list');
  if (a === 'watch' && v && YT_ID.test(v)) return yt('yt_video', 'id', v);
  if (a === 'playlist' && list) return yt('yt_playlist', 'id', list);
  if ((a === 'shorts' || a === 'live' || a === 'embed' || a === 'v') && b && YT_ID.test(b)) return yt('yt_video', 'id', b);
  if (a === 'channel' && b && YT_CHANNEL_ID.test(b)) return yt('yt_channel', 'id', b);
  if (a?.startsWith('@') && a.length > 1) return yt('yt_channel', 'handle', a.slice(1));
  if (a === 'user' && b) return yt('yt_channel', 'username', b);
  if (a === 'c' && b) return yt('yt_channel', 'custom', b);
  throw new LinkError(raw, 'unsupported_youtube_link');
}

function parseFacebook(raw: string, url: URL, parts: string[]): ParsedLink {
  const [a, b, c] = parts;
  const fb = (kind: SourceKind, by: ParsedLink['ref']['by'], value: string, normalized: string): ParsedLink => ({
    platform: 'facebook',
    kind,
    ref: { by, value },
    normalized,
  });
  if (a === 'groups' && b) {
    const by = /^\d+$/.test(b) ? 'id' : 'slug';
    return fb('fb_group', by, b, `https://www.facebook.com/groups/${b.toLowerCase()}`);
  }
  if (a === 'share' && (b === 'g' || b === 'p') && c) {
    // Share links resolve to a group (or post inside one) only after opening them in the browser.
    return fb('fb_group', 'share', url.toString(), `https://www.facebook.com/share/${b}/${c}`);
  }
  if (a === 'profile.php') {
    const id = url.searchParams.get('id');
    if (id && /^\d+$/.test(id)) return fb('fb_page', 'id', id, `https://www.facebook.com/profile.php?id=${id}`);
  }
  if (a === 'pages' && b && c && /^\d+$/.test(c)) return fb('fb_page', 'id', c, `https://www.facebook.com/${c}`);
  if (a && !FB_RESERVED.has(a.toLowerCase()) && /^[\p{L}\p{N}.\-_]{2,100}$/u.test(a)) {
    return fb('fb_page', /^\d+$/.test(a) ? 'id' : 'slug', a, `https://www.facebook.com/${a.toLowerCase()}`);
  }
  throw new LinkError(raw, 'unsupported_facebook_link');
}

function parseInstagram(raw: string, parts: string[]): ParsedLink {
  const [a] = parts;
  if (a && !IG_RESERVED.has(a.toLowerCase()) && /^[A-Za-z0-9._]{1,30}$/.test(a)) {
    const u = a.toLowerCase();
    return { platform: 'instagram', kind: 'ig_account', ref: { by: 'username', value: u }, normalized: `https://www.instagram.com/${u}/` };
  }
  if (a === 'p' || a === 'reel' || a === 'reels') throw new LinkError(raw, 'instagram_post_link_use_account');
  if (a === 'explore') throw new LinkError(raw, 'instagram_hashtag_use_search');
  throw new LinkError(raw, 'unsupported_instagram_link');
}

/** Split a bulk paste into candidate links (newline, comma, whitespace separated). */
export function splitBulk(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
}
