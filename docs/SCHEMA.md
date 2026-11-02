# Database schema (SQLite)

File: `%LOCALAPPDATA%\DataCrawlStudio\db\datacrawl.db` (WAL mode). Schema version: `PRAGMA user_version` (currently **1**).

## Conventions for the analytics app
- **Timestamps** are UTC ISO-8601 strings with milliseconds and a `Z` suffix (`2026-11-02T07:30:00.000Z`). They compare correctly as text.
- **Identity:** every post and comment is unique on `(platform, platform_id)`. Re-crawls update rows in place (upsert), so reading the same row twice is safe.
- **Change tracking:** `updated_at` changes whenever any stored field of a row changes. Incremental readers should page on `(updated_at, id)`.
- **Counts over time** are in `metric_snapshots`. The `*_count` columns on `posts`/`comments` hold the latest observed value.
- **Deletions:** rows are never deleted when content disappears on the platform. `unavailable_at` is set instead, and cleared if the content comes back.
- **Privacy:**
  - Individual authors appear only as `author_pseudonym`. Names, profile URLs, avatars and bios are never stored.
  - `@mentions` of individuals inside `text` are replaced with pseudonyms.
  - Public entities (the crawled page, group, channel or IG business account) keep their real name and ID in `author_entity_*` / `container_*`.
- **Tables for the analytics app:** `posts`, `comments`, `media_refs`, `metric_snapshots`, `post_sources`, `sources`, `pseudonyms`, `edit_history`.
- **Internal tables:** `jobs`, `crawl_runs`, `platform_state`, `quota_usage`, `action_counters` and `app_settings` exist for the app itself. They are read-only for consumers and may change between versions.

## Enumerations
| Column | Values |
|---|---|
| `platform` | `youtube`, `facebook`, `instagram` |
| `sources.kind` | `yt_channel`, `yt_playlist`, `yt_video`, `fb_group`, `fb_page`, `ig_account` |
| `sources.method` | `api`, `browser` |
| `sources.status` | `new`, `active`, `paused`, `needs_user`, `parser_needs_update`, `error`, `unavailable` |
| `posts.post_type` | `video`, `short`, `live`, `post`, `photo`, `reel`, `carousel` |
| `author_kind` | `entity` (public entity, named), `person` (pseudonymised), `unknown` |
| `jobs.state` | `queued`, `running`, `paused`, `needs_user`, `done`, `failed`, `cancelled` |
| `media_refs.media_type` | `image`, `video`, `thumbnail`, `link` |

## Tables

### sources
Every crawled source: a channel, playlist, video, group, page or IG account.
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| platform | TEXT | |
| kind | TEXT | see enumerations |
| input_url | TEXT | link as pasted; UNIQUE with platform |
| canonical_url | TEXT | normalised URL once resolved |
| platform_id | TEXT | channel id / playlist id / video id / group id / page id / IG user id |
| name | TEXT | public entity name |
| method | TEXT | `api` or `browser` |
| depth_days | INTEGER | first-crawl depth; NULL = all history |
| schedule_minutes | INTEGER | incremental update interval; NULL = manual only |
| status, status_detail | TEXT | current state and a human-readable reason |
| paused | INTEGER 0/1 | paused by the user |
| initial_crawl_done | INTEGER 0/1 | first crawl finished; later runs are incremental |
| last_run_started_at, last_run_finished_at, last_success_at, next_run_at | TEXT | |
| created_at, updated_at | TEXT | |

### crawl_runs
One row per crawl of a source.
- `mode` = `initial`|`incremental`.
- `trigger` = `add`|`manual`|`schedule`.
- `status` = `running`|`done`|`partial` (some jobs failed)|`failed`|`cancelled`.
- `stats_json` holds counters: `postsNew`, `postsUpdated`, `postsUnavailable`, `commentsNew`, `commentsUpdated`, `commentsUnavailable`, `apiUnits`.

### jobs
The durable work queue. Each job carries its own `cursor_json`/`checkpoint_json` (e.g. a page token), so it resumes where it stopped after a crash or restart. `attempts`/`max_attempts`/`next_run_at` implement bounded retries with backoff. Only one active job may exist per `(source_id, type, target)`.

### posts
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | stable local id |
| platform, platform_id | TEXT | UNIQUE pair (YouTube video id, FB post id, IG media id) |
| container_id, container_name | TEXT | channel / group / page / IG account the post belongs to (public entity) |
| post_type | TEXT | |
| url | TEXT | permalink |
| author_kind | TEXT | `entity` for page/channel posts, `person` for group members |
| author_entity_id, author_entity_name | TEXT | only when `author_kind = 'entity'` |
| author_pseudonym | TEXT | only when `author_kind = 'person'` → `pseudonyms.pseudonym` |
| title | TEXT | YouTube title; NULL elsewhere |
| text | TEXT | full text / description / caption, mentions pseudonymised |
| published_at | TEXT | |
| edited_at, is_edited | TEXT, 0/1 | when the platform exposes it |
| like_count, comment_count, view_count, share_count, reaction_count | INTEGER | latest observed; NULL = not shown by the platform |
| reactions_json | TEXT | per-reaction counts, e.g. `{"like":10,"love":2,"haha":1}` |
| duration_seconds | INTEGER | videos |
| tags_json | TEXT | JSON array (YouTube tags, hashtags) |
| extra_json | TEXT | platform-specific fields (e.g. YouTube `categoryId`, `defaultLanguage`, `liveBroadcastContent`) |
| content_hash | TEXT | hash of the stored content fields; used for edit detection |
| first_seen_at, last_seen_at | TEXT | first and latest time a crawl saw the post |
| updated_at | TEXT | last time any stored field changed |
| comments_synced_at | TEXT | last complete comment sync |
| unavailable_at, unavailable_reason | TEXT | set when the post can no longer be retrieved |

### post_sources
Which sources a post was found through: `(post_id, source_id)`. A video can belong to a channel source and a playlist source. Per-source exports use this table.

### comments
Same identity, timestamp and privacy rules as `posts`, plus:
| Column | Notes |
|---|---|
| post_id | the post the comment belongs to |
| parent_id | direct parent comment; NULL for top-level comments |
| root_id | top-level comment of the thread; NULL for top-level comments |
| depth | 0 = top-level, 1 = reply, 2 = reply to a reply, … |
| like_count | likes / total reactions |
| reply_count | replies as reported by the platform |
| reactions_json | per-reaction counts where available |

### YouTube specifics
- Comment depth is 0 (top-level) or 1 (reply). The platform has no deeper nesting.
- `post_type` is `video` or `live`; the API does not mark Shorts.
- `posts.extra_json` may contain:
  - `categoryId`, `liveBroadcastContent`, `defaultLanguage`, `defaultAudioLanguage`, `caption`, `definition`, `liveActualStart`;
  - `commentsDisabled: true` when the video has comments turned off.
- `comments.reply_count` on a top-level comment is the platform's `totalReplyCount`.
- Media refs per video:
  - one `video` row: the watch URL plus the duration;
  - one `thumbnail` row: the best available thumbnail URL plus its size.

### media_refs
URLs and metadata of images, videos and thumbnails. Files are **never downloaded**.
`owner_type` (`post`|`comment`) + `owner_id`, `position` (order inside a carousel or album), `media_type`, `url`, `width`, `height`, `duration_seconds`, `alt_text`, `caption`.

### metric_snapshots
One row each time a crawl observed a post or comment whose counts changed, or which had no snapshot yet.
`entity_type` (`post`|`comment`), `entity_id`, `observed_at` and the count columns.

### pseudonyms
| Column | Notes |
|---|---|
| pseudonym | `u_` + 16 hex characters. Stable within this installation |
| platform | `youtube`, `facebook`, `instagram`, or `<platform>-handle` for mentions of handles never seen as authors |
| first_seen_at, last_seen_at | |
No raw platform user ID is stored anywhere, and the HMAC salt is not in the database.

### edit_history
A row each time a crawl observed a change in a stored text field: `entity_type`, `entity_id`, `observed_at`, `field` (`text`|`title`), `old_value`, `new_value`.

### raw_payloads
Raw API JSON or extracted DOM/network JSON, kept for re-parsing after a parser fix.
- Personal fields (names, profile URLs, avatars, raw user IDs) are replaced with pseudonyms or removed before storage.
- Rows are deduplicated by `content_hash`.
- `origin` is `api`, `dom` or `network`. `parser_version` identifies the parser that stored the row.

### errors
Errors per platform/source/job: `kind` (`transient`, `permanent`, `parser`, `block`, `quota`, `auth`), `code`, `message`, `detail_json`. Messages are redacted of secrets.

### Internal tables
- `platform_state`: per-platform pause / needs-user flag and reason (checkpoint, CAPTCHA, rate limit).
- `quota_usage`: YouTube API units per Pacific day and per method.
- `action_counters`: browser actions per platform per hour/day bucket, used by the pacing caps.
- `app_settings`: non-secret settings as JSON.
