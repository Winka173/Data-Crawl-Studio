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
