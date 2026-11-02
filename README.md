# Data Crawl Studio

A local Windows desktop app that collects public posts and **all** their comments from Facebook public groups, Facebook pages, Instagram and YouTube. It stores them in SQLite and hands them to a separate analytics app through exports and a local read-only HTTP API. It does not analyse anything.

- Official APIs first (YouTube Data API v3, Meta Graph API / IG Business Discovery). A logged-in browser (Playwright Chromium, one secondary account, human pacing) is used only where no API exists.
- Authors are pseudonymised: a salted HMAC of the platform user ID. Names, profile URLs and avatars are never stored.
- Secrets are protected with Windows DPAPI and managed on one page: **Settings → Accounts & Keys**.

Docs: [SCHEMA](docs/SCHEMA.md) · [API](docs/API.md) · [DECISIONS](docs/DECISIONS.md) · [PROGRESS](docs/PROGRESS.md)

## Layout
| Path | What |
|---|---|
| `src-tauri/` | Tauri 2 shell (Rust): window, single instance, worker supervisor |
| `worker/src/` | Node worker: SQLite, queue, platform collectors, control API |
| `worker/test/` | unit and fixture tests (Vitest) |
| `ui/src/` | React UI (Vietnamese / English) |
| `shared/` | types shared by the UI and the worker |
| `scripts/` | sidecar packaging, end-to-end smoke tests of the built app |

## Build
Requirements: Node 20.19+, Rust (stable, MSVC), Visual Studio C++ Build Tools, WebView2 (included with Windows 11).

```
npm install
npm test                 # unit + fixture tests
npm run typecheck
npx tauri build          # runs the production build, then bundles the Windows app + NSIS installer
npm run smoke -- 1 2     # launches the built .exe against a scratch data folder and drives the UI
```

The built app is `src-tauri/target/release/data-crawl-studio.exe`, and the installer is in `src-tauri/target/release/bundle/nsis/`.

## Data location
Everything is stored in `%LOCALAPPDATA%\DataCrawlStudio`:
- `db\datacrawl.db`
- `backups\`
- `logs\`
- `profiles\` (browser logins)
- `exports\`
- `secrets.json` (DPAPI)

None of it is committed to git.
