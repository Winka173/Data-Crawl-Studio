# Progress

Legend: ✅ tested, with the evidence named · ⏳ not tested yet · ⛔ waiting for the owner.

Evidence comes from commands run on the owner's PC (Windows 11, Node 20.19.2, Rust 1.99.1). The smoke tests drive the **built** `.exe` against a scratch data folder.

## Slice 1: skeleton, SQLite + migrations, Accounts & Keys with DPAPI, VI/EN (2026-11-02)
| Check | Status | Evidence |
|---|---|---|
| Unit tests | ✅ | `npm test`: 18/18 passed (migrations, backup before migration, newer-schema refusal, real DPAPI round-trip, no plaintext on disk, secrets never listed, token shown once, YouTube/Meta key test mapping, pseudonym stability/namespacing, mention replacement incl. Vietnamese, settings validation, log redaction, quota Pacific day, control-server token + origin checks) |
| TypeScript checks | ✅ | `npm run typecheck`: UI + worker, 0 errors |
| Production build | ✅ | `npm run build` (inside `tauri build`): UI 247 kB JS, sidecar 83.9 MB (node.exe + better-sqlite3 + koffi + playwright-core) |
| Windows desktop build | ✅ | `npx tauri build`: `data-crawl-studio.exe` (3.3 MB) + `Data Crawl Studio_0.1.0_x64-setup.exe` (21.9 MB NSIS) |
| Smoke test of built .exe | ✅ | `npm run smoke -- 1`: 20/20 checks. UI renders in ~4.6 s; worker sidecar starts; DB has all tables at schema v1; salt DPAPI-protected; VI↔EN switch; key saved → "Set", never in the page or `secrets.json`; salt Test → "Verified"; local API token shown once only; key removal; unsafe pacing rejected and valid pacing saved; logs without secrets; window close → app and worker exit, lock released |
| Real-data test | n/a | slice 1 has no collection |

Not covered yet, with the slice that covers it:
- Browser profile buttons (Open login window, Log out / reset): slices 3 and 5.
- Changing the storage location: currently fixed at `%LOCALAPPDATA%\DataCrawlStudio`; to be revisited after slice 8.

## Slice 2: YouTube via the API
⏳ in progress

## Slice 3: Facebook public groups via the browser
⏳

## Slice 4: Facebook pages
⏳

## Slice 5: Instagram
⏳

## Slice 6: keyword search
⏳

## Slice 7: scheduler
⏳

## Slice 8: JSONL/CSV export + local HTTP API
⏳
