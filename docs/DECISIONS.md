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
