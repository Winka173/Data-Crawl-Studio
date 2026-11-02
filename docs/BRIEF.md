# Owner's brief (source of requirements)

This is the brief as given by the owner on 2026-11-02. Decisions made while implementing it are in [DECISIONS.md](DECISIONS.md), and the verified state of each slice is in [PROGRESS.md](PROGRESS.md).

## Goal
Build a local Windows desktop app that collects the full data of public posts and their comments from Facebook public groups, Facebook pages, Instagram and YouTube. It stores the data in SQLite and hands it to a separate analytics app through exports and a local HTTP API.
- No analysis features. Collect, store, deliver.
- Owner: a solo user on one Windows 11 PC.
- Repo: git@github.com:Winka173/Data-Crawl-Studio.git. Commit and push each verified slice to main.

## Decisions already made by the owner (do not re-ask)
- Stack: Tauri 2 desktop shell + TypeScript (UI and a Node worker sidecar) + Playwright Chromium for browser collection + SQLite (better-sqlite3). UI in Vietnamese and English.
- Platforms:
  - Facebook public groups: the most important source.
  - Facebook pages, Instagram, YouTube.
- Collection method: official APIs first, a logged-in browser only where no API exists.
  - YouTube: YouTube Data API v3 (channels, videos, commentThreads + all replies, search).
  - Facebook groups: the Graph API no longer reads group content (removed in 2024), so use the browser.
  - Facebook pages and Instagram:
    - Use the Graph API / Instagram Business Discovery where the owner's keys allow it.
    - Otherwise use the browser.
    - Instagram comments of accounts the owner does not own come from the browser.
- Browser account: ONE secondary Facebook/Instagram account owned by the user.
  - The user logs in manually once, in a visible window, into a persistent Playwright profile stored under %LOCALAPPDATA%\DataCrawlStudio. The app never asks for or stores passwords.
- Sources, chosen three ways:
  - (1) paste links: group, page, Instagram account, YouTube channel/playlist/video;
  - (2) keyword search: YouTube API search, Facebook group/post search via the browser, Instagram hashtag via the browser; results are shown and the user adds the ones they want;
  - (3) scheduled incremental updates per source.
- Depth of the first crawl per source: configurable 7 / 30 / 90 days / all history, default 30 days. Later runs fetch only new posts and new comments, and re-check recent posts for new comments and changed counts.
- Comments: ALL comments including every reply level, with timestamps, reaction/like counts, reply counts and edited flags.
- Scale: 50-500 sources.
- Media: do NOT download images/videos. Store media URLs, type, dimensions/duration when shown, alt text and captions.
- Output to the analytics app:
  - a documented SQLite database;
  - JSONL and CSV export per source and time range;
  - a local read-only HTTP API on 127.0.0.1 with a token, supporting incremental pulls (`since` timestamp / cursor).

## Privacy rule (owner's choice: aggregate data, no personal profiles)
- Keep the full text of posts and comments.
- Replace every individual author with a pseudonym: a salted HMAC of the platform user ID. The salt is stored locally and never exported. The pseudonym is stable within this install, so threads stay connected.
- Never store an individual's name, profile URL, avatar, bio or any profile data.
- Replace @mentions of individuals inside text with their pseudonym.
- Public entities (the page, group, channel or Instagram business account being crawled) keep their real name and URL.

## Account safety and platform limits (mandatory)
- Browser collection runs one tab at a time per platform. Pacing is human-like: randomized delays between actions, scrolls and page loads, with conservative per-hour and per-day caps that the user can edit in Settings.
- When the app sees a checkpoint, CAPTCHA, login wall, "you're temporarily blocked" or rate-limit warning, it must:
  1. stop that platform immediately;
  2. mark the jobs Paused (Needs user);
  3. notify in the UI;
  4. wait for the user to resolve it manually in the visible window and press Resume.
- Do not solve CAPTCHAs, spoof fingerprints, use stealth/evasion plugins, rotate proxies or rotate accounts.
- Track the YouTube API quota (10,000 units/day by default). Show what is left and schedule around it. Never exceed it.
- First-run notice in the UI: browser collection may break the platforms' terms of service and can get the secondary account restricted. The user accepts this before browser sources are enabled.

## Settings: one page for all accounts and keys
A single "Tài khoản & Khóa / Accounts & Keys" page holds everything:
- YouTube API key;
- Meta app ID/secret and page/IG tokens;
- the browser login profile per platform, with a status, an "Open login window" button and a "Log out / reset profile" button;
- the local API token;
- the pseudonym salt status.

Requirements for the page:
- Each entry shows its status (not set / set / verified / expired / blocked), the features that use it, a Test button and a Remove button.
- Store secrets with Windows DPAPI. Never display a secret again after saving.
- No other page may ask for credentials.

## Data model (SQLite, documented in docs/SCHEMA.md)
- Tables: sources, crawl_runs, jobs (durable queue with checkpoints/cursors), posts, comments (with a parent_id tree), media_refs, metric_snapshots (counts over time for posts and comments), pseudonyms, raw_payloads (raw API JSON / extracted DOM JSON, kept for re-parsing), errors.
- Upsert by (platform, platform_id), so re-runs are idempotent.
- Record first_seen, last_seen, deleted/unavailable detection and edit history.
- Store timestamps in UTC ISO.
- Back up the database before any schema migration.

## Robustness
- Durable queue in SQLite:
  - Pause, Resume and Cancel per source, per platform and globally.
  - After a crash or restart, continue from the last checkpoint and cursor.
  - Bounded retries with backoff for transient errors.
  - A failure in one source never stops the others.
- Browser parsers:
  - Keep all selectors and extraction in one module per platform.
  - Validate every extracted record against a schema. If a layout change breaks extraction, flag the source "Parser needs update" and store nothing broken.
  - Write tests from saved HTML fixtures, with no personal data in the fixtures.
- Logs are rotated and contain no secrets or cookies.

## UI pages
Dashboard (running jobs, quotas, blocked states), Sources (add by link or bulk paste, depth, schedule, status per source), Search (keyword → candidates → add), Queue/Jobs, Data browser (posts with comment trees, filters), Exports, Local API (URL, token, docs), Settings (Accounts & Keys, pacing caps, storage location), Logs.

## Delivery: vertical slices, each one fully verified before the next
1. Skeleton: Tauri app, worker sidecar, SQLite + migrations, Accounts & Keys page with DPAPI, VI/EN.
2. YouTube via the API: channel/video/playlist sources, all comments + replies, incremental updates, quota tracking.
3. Facebook public groups via the browser: login profile, posts, all comments and replies, pacing, block detection → pause.
4. Facebook pages (API where available, browser otherwise).
5. Instagram (Business Discovery where available, browser for the rest, comments via the browser).
6. Keyword search for every platform.
7. Scheduler for periodic incremental updates.
8. JSONL/CSV export and the local HTTP API, documented in docs/API.md, with an example client.

Each slice must pass all of the following:
- unit and fixture tests;
- TypeScript checks;
- the production build;
- a Windows desktop build (Tauri 2);
- launching the built .exe and smoke-testing the new feature.

A real-data test is required for each slice:
- Small crawls only: one public YouTube channel, one Facebook public group, a few posts.
- Run it only after the owner has entered the key or logged in. Until then, say "waiting for the owner's key/login" and test with fixtures.

Keep docs/PROGRESS.md up to date with a tested/untested checklist per slice. Never claim something works without evidence: a command output, the record count in the DB, or a screenshot.

## Hard rules
- Local only. No cloud services, no paid scraping APIs, no telemetry.
- Never commit secrets, cookies, browser profiles, databases, exports or real crawled data. Add them to .gitignore from the first commit.
- This PC also runs other heavy apps: Asset Forge Studio and Autonomous Creative Studio. Do not touch their folders, data, ports or processes. Keep CPU and RAM use modest; no GPU is needed.
- Ask the owner only for things you cannot decide: keys, the manual login, and approval of anything outside this brief. Decide everything else yourself and record the reason in docs/DECISIONS.md.
