import { z } from 'zod';

// Normalised records every collector (API or browser) produces before anything is written.
// Validation happens here so a broken parser can never store a half-empty row.

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/, 'UTC ISO timestamp');
const count = z.number().int().min(0).nullable();

export const authorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('entity'), id: z.string().min(1), name: z.string().nullable() }),
  z.object({ kind: z.literal('person'), pseudonym: z.string().regex(/^u_[0-9a-f]{16}$/) }),
  z.object({ kind: z.literal('unknown') }),
]);
export type Author = z.infer<typeof authorSchema>;

export const mediaSchema = z.object({
  mediaType: z.enum(['image', 'video', 'thumbnail', 'link']),
  url: z.string().url(),
  position: z.number().int().min(0),
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  durationSeconds: z.number().int().min(0).nullable().default(null),
  altText: z.string().nullable().default(null),
  caption: z.string().nullable().default(null),
});
export type MediaRecord = z.input<typeof mediaSchema>;

export const postSchema = z.object({
  platform: z.enum(['youtube', 'facebook', 'instagram']),
  platformId: z.string().min(1),
  containerId: z.string().nullable(),
  containerName: z.string().nullable(),
  postType: z.enum(['video', 'short', 'live', 'post', 'photo', 'reel', 'carousel']),
  url: z.string().url().nullable(),
  author: authorSchema,
  title: z.string().nullable(),
  text: z.string().nullable(),
  publishedAt: iso.nullable(),
  editedAt: iso.nullable().default(null),
  isEdited: z.boolean().default(false),
  likeCount: count.default(null),
  commentCount: count.default(null),
  viewCount: count.default(null),
  shareCount: count.default(null),
  reactionCount: count.default(null),
  reactions: z.record(z.string(), z.number().int().min(0)).nullable().default(null),
  durationSeconds: z.number().int().min(0).nullable().default(null),
  tags: z.array(z.string()).nullable().default(null),
  extra: z.record(z.string(), z.unknown()).nullable().default(null),
  media: z.array(mediaSchema).default([]),
});
export type PostRecord = z.input<typeof postSchema>;
export type ValidPost = z.output<typeof postSchema>;

export const commentSchema = z.object({
  platform: z.enum(['youtube', 'facebook', 'instagram']),
  platformId: z.string().min(1),
  postPlatformId: z.string().min(1),
  parentPlatformId: z.string().min(1).nullable(),
  author: authorSchema,
  text: z.string().nullable(),
  publishedAt: iso.nullable(),
  editedAt: iso.nullable().default(null),
  isEdited: z.boolean().default(false),
  likeCount: count.default(null),
  replyCount: count.default(null),
  reactions: z.record(z.string(), z.number().int().min(0)).nullable().default(null),
  extra: z.record(z.string(), z.unknown()).nullable().default(null),
  media: z.array(mediaSchema).default([]),
});
export type CommentRecord = z.input<typeof commentSchema>;
export type ValidComment = z.output<typeof commentSchema>;
