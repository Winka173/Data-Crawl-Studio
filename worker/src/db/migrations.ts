// Schema migrations. Each entry moves PRAGMA user_version from (version - 1) to version.
// Never edit a released migration: add a new one. Every change must be reflected in docs/SCHEMA.md.

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: /* sql */ `
CREATE TABLE app_settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE sources (
  id                   INTEGER PRIMARY KEY,
  platform             TEXT NOT NULL CHECK (platform IN ('youtube','facebook','instagram')),
  kind                 TEXT NOT NULL,
  input_url            TEXT NOT NULL,
  canonical_url        TEXT,
  platform_id          TEXT,
  name                 TEXT,
  method               TEXT NOT NULL CHECK (method IN ('api','browser')),
  depth_days           INTEGER,
  schedule_minutes     INTEGER,
  status               TEXT NOT NULL DEFAULT 'new',
  status_detail        TEXT,
  paused               INTEGER NOT NULL DEFAULT 0,
  initial_crawl_done   INTEGER NOT NULL DEFAULT 0,
  last_run_started_at  TEXT,
  last_run_finished_at TEXT,
  last_success_at      TEXT,
  next_run_at          TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (platform, input_url)
);
CREATE UNIQUE INDEX sources_platform_id ON sources(platform, kind, platform_id) WHERE platform_id IS NOT NULL;

CREATE TABLE crawl_runs (
  id           INTEGER PRIMARY KEY,
  source_id    INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  platform     TEXT NOT NULL,
  mode         TEXT NOT NULL CHECK (mode IN ('initial','incremental')),
  trigger      TEXT NOT NULL CHECK (trigger IN ('manual','schedule','add')),
  status       TEXT NOT NULL DEFAULT 'running',
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  stats_json   TEXT NOT NULL DEFAULT '{}',
  error        TEXT
);
CREATE INDEX crawl_runs_source ON crawl_runs(source_id, started_at);

CREATE TABLE jobs (
  id              INTEGER PRIMARY KEY,
  run_id          INTEGER REFERENCES crawl_runs(id) ON DELETE CASCADE,
  source_id       INTEGER REFERENCES sources(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL,
  type            TEXT NOT NULL,
  target          TEXT,
  state           TEXT NOT NULL DEFAULT 'queued'
                  CHECK (state IN ('queued','running','paused','needs_user','done','failed','cancelled')),
  priority        INTEGER NOT NULL DEFAULT 100,
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  next_run_at     TEXT NOT NULL,
  cursor_json     TEXT,
  checkpoint_json TEXT,
  params_json     TEXT NOT NULL DEFAULT '{}',
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT
);
CREATE INDEX jobs_pick ON jobs(state, platform, next_run_at, priority);
CREATE INDEX jobs_source ON jobs(source_id, state);
-- One active job per (source, type, target): re-queueing the same work is a no-op.
CREATE UNIQUE INDEX jobs_active_dedupe ON jobs(source_id, type, IFNULL(target, ''))
  WHERE state IN ('queued','running','paused','needs_user');

CREATE TABLE platform_state (
  platform      TEXT PRIMARY KEY,
  paused        INTEGER NOT NULL DEFAULT 0,
  needs_user    INTEGER NOT NULL DEFAULT 0,
  reason        TEXT,
  reason_detail TEXT,
  updated_at    TEXT NOT NULL
);

CREATE TABLE posts (
  id                INTEGER PRIMARY KEY,
  platform          TEXT NOT NULL,
  platform_id       TEXT NOT NULL,
  container_id      TEXT,
  container_name    TEXT,
  post_type         TEXT NOT NULL,
  url               TEXT,
  author_kind       TEXT NOT NULL CHECK (author_kind IN ('entity','person','unknown')),
  author_entity_id  TEXT,
  author_entity_name TEXT,
  author_pseudonym  TEXT REFERENCES pseudonyms(pseudonym),
  title             TEXT,
  text              TEXT,
  published_at      TEXT,
  edited_at         TEXT,
  is_edited         INTEGER NOT NULL DEFAULT 0,
  like_count        INTEGER,
  comment_count     INTEGER,
  view_count        INTEGER,
  share_count       INTEGER,
  reaction_count    INTEGER,
  reactions_json    TEXT,
  duration_seconds  INTEGER,
  tags_json         TEXT,
  extra_json        TEXT,
  content_hash      TEXT,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  comments_synced_at TEXT,
  unavailable_at    TEXT,
  unavailable_reason TEXT,
  UNIQUE (platform, platform_id)
);
CREATE INDEX posts_published ON posts(published_at);
CREATE INDEX posts_updated ON posts(updated_at, id);
CREATE INDEX posts_container ON posts(platform, container_id, published_at);

CREATE TABLE post_sources (
  post_id       INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  source_id     INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (post_id, source_id)
);
CREATE INDEX post_sources_source ON post_sources(source_id);

CREATE TABLE comments (
  id                INTEGER PRIMARY KEY,
  platform          TEXT NOT NULL,
  platform_id       TEXT NOT NULL,
  post_id           INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  parent_id         INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  root_id           INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  depth             INTEGER NOT NULL DEFAULT 0,
  author_kind       TEXT NOT NULL CHECK (author_kind IN ('entity','person','unknown')),
  author_entity_id  TEXT,
  author_entity_name TEXT,
  author_pseudonym  TEXT REFERENCES pseudonyms(pseudonym),
  text              TEXT,
  published_at      TEXT,
  edited_at         TEXT,
  is_edited         INTEGER NOT NULL DEFAULT 0,
  like_count        INTEGER,
  reply_count       INTEGER,
  reactions_json    TEXT,
  extra_json        TEXT,
  content_hash      TEXT,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  unavailable_at    TEXT,
  UNIQUE (platform, platform_id)
);
CREATE INDEX comments_post ON comments(post_id, published_at);
CREATE INDEX comments_parent ON comments(parent_id);
CREATE INDEX comments_updated ON comments(updated_at, id);

CREATE TABLE media_refs (
  id               INTEGER PRIMARY KEY,
  owner_type       TEXT NOT NULL CHECK (owner_type IN ('post','comment')),
  owner_id         INTEGER NOT NULL,
  platform         TEXT NOT NULL,
  position         INTEGER NOT NULL DEFAULT 0,
  media_type       TEXT NOT NULL,
  url              TEXT NOT NULL,
  width            INTEGER,
  height           INTEGER,
  duration_seconds INTEGER,
  alt_text         TEXT,
  caption          TEXT,
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  UNIQUE (owner_type, owner_id, position, media_type)
);
CREATE INDEX media_owner ON media_refs(owner_type, owner_id);

CREATE TABLE metric_snapshots (
  id             INTEGER PRIMARY KEY,
  entity_type    TEXT NOT NULL CHECK (entity_type IN ('post','comment')),
  entity_id      INTEGER NOT NULL,
  observed_at    TEXT NOT NULL,
  like_count     INTEGER,
  comment_count  INTEGER,
  reply_count    INTEGER,
  view_count     INTEGER,
  share_count    INTEGER,
  reaction_count INTEGER,
  reactions_json TEXT
);
CREATE INDEX metric_entity ON metric_snapshots(entity_type, entity_id, observed_at);

CREATE TABLE pseudonyms (
  pseudonym     TEXT PRIMARY KEY,
  platform      TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE TABLE edit_history (
  id          INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('post','comment')),
  entity_id   INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  field       TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT
);
CREATE INDEX edit_entity ON edit_history(entity_type, entity_id);

CREATE TABLE raw_payloads (
  id             INTEGER PRIMARY KEY,
  platform       TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  platform_id    TEXT NOT NULL,
  origin         TEXT NOT NULL CHECK (origin IN ('api','dom','network')),
  parser_version TEXT NOT NULL,
  content_hash   TEXT NOT NULL UNIQUE,
  fetched_at     TEXT NOT NULL,
  payload_json   TEXT NOT NULL
);
CREATE INDEX raw_entity ON raw_payloads(platform, entity_type, platform_id);

CREATE TABLE errors (
  id          INTEGER PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  platform    TEXT,
  source_id   INTEGER,
  job_id      INTEGER,
  run_id      INTEGER,
  kind        TEXT NOT NULL,
  code        TEXT,
  message     TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX errors_time ON errors(occurred_at);

CREATE TABLE quota_usage (
  provider   TEXT NOT NULL,
  day        TEXT NOT NULL,
  units_used INTEGER NOT NULL DEFAULT 0,
  by_method_json TEXT NOT NULL DEFAULT '{}',
  exhausted  INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, day)
);

CREATE TABLE action_counters (
  platform TEXT NOT NULL,
  bucket   TEXT NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (platform, bucket)
);
`,
  },
  {
    version: 2,
    name: 'per-source comment collection switch',
    sql: `
ALTER TABLE sources ADD COLUMN collect_comments INTEGER NOT NULL DEFAULT 1;
`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
