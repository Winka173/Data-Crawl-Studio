# Decisions

Decisions taken during implementation that the brief left open. Owner decisions from the brief are not repeated here.

## D1. Process model: Tauri shell + bundled Node worker over a localhost control channel
The Rust shell starts `sidecar/node.exe worker.cjs` (hidden window) and reads one JSON line from its stdout with the port and a per-launch random token. The UI then calls the worker on `http://127.0.0.1:<port>` with the header `X-DCS-Token`.
- **Why:** all collection logic stays in TypeScript, as the brief asks. A plain HTTP channel lets the same worker serve the UI, tests and (later) the public read-only API. The token travels only over a private pipe; the port is OS-assigned, so it never collides with Asset Forge Studio, Autonomous Creative Studio or anything else on this PC.
- The control server accepts only the Tauri origins and the Vite dev origin; any other browser origin gets 403 even with a token.
- The worker exits when the shell's end of its stdin pipe closes, so it cannot outlive the app. The shell restarts a crashed worker up to 5 times in 10 minutes, with backoff.
- A lock file (`worker.lock`) prevents two workers on one data folder. The Tauri single-instance plugin focuses the existing window on a second launch.

## D2. Node runtime is shipped, not required
The build copies the `node.exe` used to build and test (v20.19.2) into the bundle, with only the runtime packages esbuild cannot inline: better-sqlite3 (native), koffi (native) and playwright-core.
- **Why:** the native module ABI must match the runtime. Shipping the tested runtime removes "works on my machine" problems. Cost: about 84 MB on disk.

## D3. DPAPI through koffi (FFI), not PowerShell or a Rust bridge
`CryptProtectData` / `CryptUnprotectData` are called directly from the worker (CurrentUser scope, app-specific entropy, `CRYPTPROTECT_UI_FORBIDDEN`).
- **Why:** this is fast and has no extra process. Secrets are never passed on a command line. It is tested in the unit tests against the real API.

## D4. Secrets and the salt live outside the SQLite database
`secrets.json` in the data folder holds DPAPI blobs plus non-secret status metadata (set/verified time, last test error, whitelisted fields such as the IG business account ID).
- **Why:** the SQLite file is the product delivered to the analytics app. Keeping secrets, even encrypted ones, and the pseudonym salt out of it means the database can be copied without leaking anything that re-identifies people.

## D5. Pseudonyms
`u_` + the first 16 hex characters (64 bits) of HMAC-SHA256(salt, `"<platform>:<platform user id>"`). The salt is 32 random bytes generated at first start.
- The `pseudonyms` table stores only the pseudonym, platform and first/last seen. It never stores the raw ID, so the delivered DB cannot be reversed.
- A salt fingerprint (HMAC of a fixed string, 12 hex characters) is kept as metadata so a lost or replaced salt is detected by the Test button.
- @mentions: when the handle belongs to an author already seen in the same thread, the mention gets that author's pseudonym. Otherwise it is pseudonymised under the namespace `<platform>-handle`. Handles of the public entity being crawled are kept.
- Removing the salt in Accounts & Keys requires typing RESET, because every later pseudonym changes.

## D6. Secrets are never shown again; the local API token is shown once
A saved secret is write-only from the UI. The listing endpoint returns status and dates only, and a unit test asserts the value never appears.
- The local API token must reach the analytics app, so it is shown exactly once at generation, with a Copy button. Losing it means generating a new one.

## D7. Schema versioning with `PRAGMA user_version`, backup by `VACUUM INTO`
Each migration runs in a transaction. Before any migration of an existing DB, a full consistent copy is written to `backups/datacrawl-v<from>-<timestamp>.db`. The app refuses to open a DB from a newer version.

## D8. YouTube quota accounting
Units are counted per US-Pacific calendar day, because that is when Google resets the quota.
- Crawl jobs must leave a configurable reserve (default 300 units) free. Interactive actions (Test, keyword search) may use the reserve but never pass the daily limit.
- A `quotaExceeded` answer from the API marks the day exhausted, whatever our own count says.

## D9. Default browser pacing caps
- Facebook: 4–12 s between actions, 120 actions/hour, 800/day.
- Instagram: 5–15 s between actions, 90 actions/hour, 600/day.
- Floors enforced by validation: delay ≥ 1 s, and max delay ≥ min delay.
- **Why:** these are conservative, roughly one page action every 8 s on average, comparable to a person reading. The owner can lower them in Settings.

## D10. Graph API version pinned to v23.0
It is set in one constant (`worker/src/accounts.ts`), to be bumped when Meta deprecates it.

## D11. UI stack
React 19 + Vite, plain CSS with light/dark tokens, no component library. Hash-based page switching; there is no router dependency.
- Translations: `ui/src/i18n/{en,vi}.ts`. The Vietnamese dictionary is typed against the English keys, so a missing translation fails the typecheck.

## D12. Smoke tests drive the real built app
`scripts/smoke.mjs` launches `target/release/data-crawl-studio.exe` with `DCS_DATA_DIR` pointing to a scratch folder and WebView2 remote debugging on port 9338. It then drives the UI with Playwright over CDP, takes screenshots and closes the app with a normal window close. The owner's real data folder is never used by tests.

## D13. Durable queue: one lane per platform
At most one job per platform runs at a time: one tab per platform for browser work, and simple, predictable quota use for YouTube. Different platforms run in parallel.
- **Failure handling** is decided by the error class (`worker/src/queue/errors.ts`):

  | Error | What happens |
  |---|---|
  | transient | retried with backoff from 30 s, doubling, capped at 30 min, ±20 % jitter; at most 5 attempts |
  | quota / pacing | the job waits until the reset; no attempt is used |
  | auth / block | the platform stops and all its active jobs become Paused (Needs user) |
  | parser | the source is flagged "Parser needs update"; nothing is stored |
  | not-found / permanent | the job fails without retry |

- A job saves its cursor after each page. A crash or restart sets `running` jobs back to `queued`, and they continue from the cursor.
- A crawl run ends when none of its jobs is active. Its status is `done`, `partial` (some jobs failed) or `failed`.

## D14. YouTube collection rules
- **Channels:** the uploads playlist (newest first) is listed until a whole page is older than the cutoff. **Playlists** are listed completely, because their order is arbitrary, and filtered by date. A pasted **video** is always re-checked.
- **Cutoff:**
  - First crawl: the chosen depth (or no cutoff for all history).
  - Later runs: the older of (last success − 1 day) and (now − recheck days, default 14). New posts since the last run are always reached, and recent posts are re-checked.
- **Comments are re-synced** when:
  - the post is new; or
  - it is inside the recheck window and its comment count changed or the last full sync is older than 24 h; or
  - it was never fully synced.
- **Every reply is fetched:** the `commentThreads` payload carries at most a few replies, so any thread with more pages through `comments.list`.
- **Deletion detection** runs only after a complete listing:
  - top-level comments of a video, and replies of a thread, that were not seen in that pass get `unavailable_at`;
  - posts of the source inside the window that the listing no longer returns are checked with `videos.list`, and those missing are marked unavailable.
- **Edits:** `is_edited` = the API's `updatedAt` ≠ `publishedAt`. A text change observed between runs is written to `edit_history`.
- **YouTube comments are two levels deep** (the API flattens deeper replies): depth 0 = top-level, depth 1 = reply. Replies to replies appear as depth-1 replies that start with an @mention.

## D15. Mentions in YouTube descriptions
An @handle in a video description might be a person or another public channel, and the API cannot tell which. Every mention except the crawled channel's own handle is pseudonymised. This errs on the side of privacy.

## D16. Raw payloads are scrubbed before storage
Comment payloads drop the author name, avatar and channel URL, the author ID becomes the pseudonym, and the text is the pseudonymised text. Video payloads get the pseudonymised description. A test scans every table for raw viewer IDs and handles.

## D17. Test-only API base override
`DCS_YOUTUBE_API_BASE` points the collector at a local fake server (`scripts/fake-youtube-server.ts`, synthetic data only). The smoke test uses it to drive a full crawl through the built `.exe`. Normal use never sets it.

## D18. Browser: one visible, persistent Playwright Chromium profile per platform
- **Profiles** live at `profiles\facebook` and `profiles\instagram`.
- **Chromium** is Playwright's own build. It is downloaded once, on first use, into `ms-playwright\`. playwright-core is loaded lazily, so the worker starts light.
- **The window is always visible:** collection and login use the same visible window. The owner can watch it, and it is already on screen when a checkpoint needs solving. There is no headless mode, stealth plugin, fingerprint change, proxy or second account.
- **Login check:** only the *presence* of the login cookie is checked (`c_user` on Facebook, `sessionid` on Instagram). Cookie values never leave the browser.
- **Log out / reset** deletes the profile folder.

## D19. Facebook extraction reads the page's own JSON, not obfuscated DOM classes
Facebook's CSS class names are generated and change constantly. The collector reads the JSON the page itself receives: GraphQL responses and the data embedded in `<script type="application/json">`. A tree walker collects `Story`, `Comment` and `Group` nodes wherever they are nested.
- The DOM is used only to *drive* the page: open, scroll, switch to "All comments", click "more comments/replies". Matching is by role plus English/Vietnamese text.
- All selectors and data assumptions live in `worker/src/platforms/facebook/extract.ts`, versioned as `FB_PARSER_VERSION`.
- Every record is validated: zod schema, creation time present, author present for posts. If a batch fails, nothing from it is stored and the source is flagged **Parser needs update**. The same happens when the page shows posts but none can be extracted.
- **Limitation, stated plainly:** until the owner logs in, the extraction has only been tested on synthetic JSON shaped like Facebook's. The first real crawl will show whether the shapes match. Real payloads will then be saved as scrubbed fixtures, with names and IDs replaced, and the parser adjusted.

## D20. Facebook group collection rules
- The feed is opened sorted chronologically (`?sorting_setting=CHRONOLOGICAL`) and scrolled.
- **Where the listing stops:** after **3 consecutive posts** older than the cutoff (pinned old posts at the top do not end it), after 4 scrolls with nothing new, or at 400 scrolls.
- **Comments:** each post's permalink is opened, the list is switched to **All comments** (Facebook defaults to "Most relevant", which hides some), and every "more comments / replies" control is clicked, one paced action each, up to 600 clicks.
- **Deletions** are marked only after a *complete* pass. A pass is complete when "All comments" was set, nothing was left to expand, and no comment was missing its parent. Otherwise comments are stored but nothing is marked deleted.
- Facebook comments nest up to depth 2 (reply to a reply). The parent chain is kept. A comment whose parent was not captured is not stored detached.
- People are pseudonymised: post and comment authors, plus people tagged in the text (using Facebook's mention ranges, UTF-16 offsets). Pages and the group itself are public entities.
- The raw payload stored for Facebook is the normalised record only. Facebook's JSON contains names, avatars and profile URLs.

## D21. Stop rules (block detection) and pacing details
- **What stops collection:**
  - Checkpoint, two-factor, challenge, CAPTCHA or login URLs.
  - "Temporarily blocked", "suspected automated behavior", "account locked", "security check", "log in to continue", "please wait a few minutes" in English or Vietnamese. Only dialog/alert text and the page title are checked, plus the body when no feed is present, so words inside ordinary posts never trigger a stop.
  - GraphQL error codes 1357001/1357004 (login), 1675004/1390008 (rate limit) and 368 (policy block), and HTTP 429.
- **What a stop does:** the whole platform stops, every active job of it becomes Paused (Needs user), and the source and the dashboard show the reason. Nothing touches that platform again until the owner presses Resume.
- **Pacing:** a random delay between the min and max before *every* action. After every 12–25 actions comes a longer "reading" pause of 3–6× the max delay. Hitting the hourly or daily cap re-queues the job for the next hour (+0–10 min) or the next UTC day.

## D22. Parser diagnostics are value-free shape summaries
When a Facebook job hits a parser mismatch, or stores far fewer comments than the post reports (fewer than half, when it reports 4 or more), the driver writes a summary of the JSON the page delivered to `logs\fb-shapes\` (the newest 10 are kept).
- The summary holds only structure: key paths relative to the nearest `__typename`, the kind of each value (string, digits, URL, number, …) and the typenames. It never holds a value. Keys that look like IDs are masked (`<n>`, `<k>`).
- **Why:** real Facebook payloads are full of names, avatars and profile links, so they cannot be saved as-is. The structure alone is enough to fix the parser and to build synthetic fixtures of the same shape. A unit test checks that no value from a synthetic payload reaches the summary.

## D23. Media URLs never name a person
A Facebook video permalink is `facebook.com/<uploader's vanity name>/videos/<id>`. Found in the first real crawl, this would have stored a person's profile name.
- Video links are rewritten to `https://www.facebook.com/watch/?v=<id>`, and photo links to `photo/?fbid=<id>`. Reel links keep only the ID.
- CDN files (`*.fbcdn.net`) and external preview images are kept.
- Any other `facebook.com` media URL is dropped, because its path could be a profile.

## D24. A run counts as a success only if its listing job succeeded
The first job of a run lists the source. If it fails, posts may have been missed. The run then stays `partial`, but it does not move `last_success_at` (the next incremental cutoff) and does not finish the initial crawl. The next run repeats the full depth. Found in the first real crawl.

## D25. A 1-year depth, and deepening a source re-lists it
The owner asked for one year of a group (2026-11-02), so the depth options are now 7 / 30 / 90 / 365 days / all history.
- If a source's depth is raised after its first crawl, `initial_crawl_done` is reset. The next run then lists back to the new depth instead of running incrementally.
- Lowering the depth changes nothing that was already stored.

## D26. A group listing waits for the pacing cap in place
A Facebook feed cannot be reopened at a given date. A listing that was re-queued by the hourly or daily cap would scroll again from the top and, for a deep window (one year is about 1,000 scrolls, more than the 800-action daily cap), would never reach the end.
- The listing job therefore keeps its tab and scroll position and sleeps until the cap allows the next action. The platform lane is busy meanwhile, but the cap would block the other Facebook jobs anyway.
- Every other job is still re-queued for later as before. So is a listing that hits the cap before it has opened the feed.
- If the app is closed during a listing, the next start lists again from the top. Posts already stored are not lost; they are only scrolled past again.

## D27. Loading every comment (learned from the first real crawl)
- Only **visible** controls are used. Facebook keeps hidden copies of buttons in the page, and `.first()` used to pick a hidden one and stop.
- A reply names its parent in `comment_direct_parent` (2026 shape). Replies arrive as pages of the parent's `Feedback`, which points back to its owner through `parent_object_ent`. Back-pointers are never walked, so a comment cannot become its own parent.
- The permalink page also loads comments as it scrolls. When no "more comments/replies" control is left but fewer comments were captured than the post reports, the job scrolls. It stops after 2 scrolls that add nothing. Posts that are already complete cost no extra action.
- Five clicks in a row that load nothing end the expansion, and the pass is then not counted as complete.
- When a post reports replies that were not captured, or far fewer comments than it shows, a diagnostics summary (D22) is written. It includes the texts of the visible comment controls and of the sort menu. Only UI words are kept, and runs of capitalised words are masked.

## D28. Export format
An export is a folder `exports\export-<time>\` containing `posts`, `comments` and `media` (as `.jsonl` or `.csv`) plus `manifest.json`.
- **Rows:** comments carry `parent_comment_id` / `root_comment_id` / `depth`, so the reply tree can be rebuilt. People appear only as `author_id = u_…`, and pages and groups as their id and name.
- **Filter:** posts are chosen by source and publication time. Comments and media follow their posts.
- **CSV:** RFC 4180 with a UTF-8 BOM (Excel reads Vietnamese correctly). A cell that a spreadsheet would run as a formula gets a leading apostrophe. JSONL keeps the exact text.
- Field names are a contract (`EXPORT_FORMAT_VERSION = 1`): fields may be added, but never renamed or removed without a version bump.

## D29. Posts-only sources, and any depth in days
The owner asked (2026-11-02) for a run without comments and for more control per source.
- **Comment switch:** every source has `collect_comments`. When it is off, the listing stores posts with their counts (reactions, comments, shares) but never enqueues comment jobs. For Facebook, each post is then not opened, which cuts a year of a busy group from about 65,000 actions to about 1,000. Switching it off cancels comment jobs still waiting; comments already stored are kept.
- **Depth:** any whole number of days from 1 to 3,650, or all history. 7 / 30 / 90 / 365 stay as presets, and "Custom…" takes a number.
- **Editing:** depth, schedule and the comment switch can be edited on each source ("Settings" in the Sources table). Raising the depth re-lists the source (D25).

## D30. Person ids inside system paths; faster pacing on the owner's request
- **Person ids in paths:** a real post linked `facebook.com/groups/<group>/user/<user id>/`, a group member's page. The `groups/` path was treated as public and kept, so the user id reached the stored text. Ids after `groups/<g>/user/`, `people/<name>/`, `messages/t/` and `stories/` are now pseudonymised. A `people` link also drops the name. Stored rows were cleaned with this install's salt (posts, raw payloads, edit history), and the export made before the fix was deleted.
- **Pacing:** on 2026-11-02 the owner asked for much faster collection. Facebook pacing was set to 2–5 s between actions, 600 actions/hour and 6,000/day, through the same validated settings as the Settings page.
- **Scrolling:** each feed scroll is now a flick of 5–8 wheel steps instead of 2–4. Group posts are long, and short scrolls passed only about 1.6 posts per action; the longer flick measured about 3.6 posts per action.

## D31. A long group listing follows the feed's own requests instead of scrolling
On a real group, a feed tab that kept scrolling grew by 200–400 MB a minute (6.5 GB after about 500 posts) and slowed from about 30 to about 6 posts a minute. Blocking post photos and videos (`isPostMedia`) halved the growth but did not stop it. The rest is the page's own DOM and data store, which a React page keeps even if elements are removed, so pruning the DOM would not free memory.
- **How it works:** after the first scroll, the page itself has asked for a page of the group's feed. That GraphQL request (body, `x-fb-*` headers) is kept, and the next page is asked for from inside the page (`fetch`, same session and tokens) with the cursor from the last answer. `__req` keeps counting. Each request is one paced action. Nothing is drawn, so the tab stays at about 1 GB; measured about 36 posts a minute at 2–5 s pacing.
- **Which request:** only a request whose variables hold a `cursor` and the group's id, and whose answer has a `page_info` beside Story edges (or a deferred chunk whose label or path names the feed).
- **Resume:** the deepest cursor is saved in the job after every page. A pause, crash, cap or restart resumes there (one scroll to get a fresh request, then the saved cursor), not at the top. A finished pass clears it.
- **Failures:** if a request cannot be followed (stale tokens, an unexpected answer, a page crash), the group page is opened again and paging goes on from the same cursor. After 3 failures in a row, the pass falls back to scrolling and a diagnostics summary is written. Blocks (error codes, HTTP 429, a login page) stop Facebook as before, and the tab is reloaded so the owner sees the notice.
- **End:** when Facebook's page info says there is no next page, at the depth cutoff, or after 8 pages with nothing new.
