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

## Slice 2: YouTube via the API (2026-11-02)
| Check | Status | Evidence |
|---|---|---|
| Unit + fixture tests | ✅ | `npm test`: 52/52 passed. The 34 new ones cover: link parsing for all platforms (14 accepted forms, 4 rejected); ISO durations; video/comment mapping; edit flag; cutoff and comment re-sync rules. They also run full crawls through the real queue against a synthetic fake YouTube API. Those crawls check: first crawl with depth, all 157 comments incl. paged replies; no raw viewer ID/handle/avatar in any table; channel owner kept by name; mention → author pseudonym; comments-disabled flagged; exact quota count; idempotent re-run (no new rows or snapshots); incremental new video / edited comment (edit_history + snapshot) / deleted reply (unavailable) / changed views; private video → unavailable; playlist + single-video sources; quota cap → jobs wait until the Pacific reset, never exceed; API quotaExceeded → day exhausted; bad key → YouTube Paused (Needs user), key "blocked", resume after fix; transient 500s retried from the cursor while a missing channel fails alone; restart resumes from checkpoint; pause/resume/cancel; control routes |
| TypeScript checks | ✅ | `npm run typecheck`: 0 errors |
| Production build | ✅ | `npm run build` (inside `tauri build`) |
| Windows desktop build | ✅ | `npx tauri build`: exe + NSIS installer (21.9 MB) |
| Smoke test of built .exe | ✅ | `npm run smoke -- 1 2`: 32/32 checks. With the fake API server: key saved + Test → Verified; bulk paste adds the channel and rejects an unsupported link; first crawl → DB has 6 posts, 157 comments, 50 replies, 32 pseudonyms; 30 quota units = 30 API calls; no `@viewer` handles stored; dashboard quota "30 / 10,000"; Data browser tree shows 95 top-level comments + 10 nested replies with pseudonyms; "Run now" after a new upstream video → 7 posts, 157 comments, 2nd run `incremental`; pause/resume; queue page |
| Real-data test | ⛔ | **Waiting for the owner's YouTube API key.** When it is entered in Settings → Accounts & Keys: add one public channel with depth 7 days, check the record counts in the DB, and add the evidence here. |

Bug found and fixed by the tests in this slice:
- A raw video payload kept an @mention from the description (privacy).
- The quota reset time drifted by seconds between calls.
- A missing query parameter meant `LIMIT 0` on post comments.

## Slice 3: Facebook public groups via the browser (2026-11-02)
| Check | Status | Evidence |
|---|---|---|
| Unit + fixture tests | ✅ (synthetic) | `npm test`: 80/80 passed. The 28 new Facebook tests cover: multi-document/guarded JSON; comment-id decoding; story extraction (author, time, text, mention ranges, reactions by type, shares, photos/video, shared story ignored); comment tree to depth 2; later sightings refresh counts; mapping (people → pseudonyms, Page → entity, UTF-16 mention offsets, no double pseudonymisation); validation failure → ParserError. They also cover block detection (7 EN/VI cases, plain post text is not a block, API codes, HTTP 429) and pacing (delay range, hourly and daily caps → wait until the next hour/day, long reading pause). With a fake browser, through the real queue: notice gate; first crawl past an old pinned post (9 posts, 13 comments, depth-2 reply, Page reply kept as entity, carousel/video media, no names or user IDs in any table); deleted comment marked only on a complete pass, never without "All comments"; checkpoint → Facebook stopped, jobs Paused (Needs user), no further Facebook actions, YouTube keeps running, Resume completes the crawl; GraphQL rate-limit error → stop; no login → stop before any action; layout change → "Parser needs update", nothing stored; pacing cap → re-queued |
| TypeScript checks | ✅ | `npm run typecheck`: 0 errors |
| Production build | ✅ | inside `tauri build` |
| Windows desktop build | ✅ | `npx tauri build`: exe + NSIS |
| Smoke test of built .exe | ✅ | `npm run smoke -- 1 2 3`: 41/41 checks. Slice 3 part, with the **real** Playwright driver: group link refused before the notice; notice accepted; group added; Chromium downloaded and a visible persistent profile opened; empty profile → no login → Facebook Paused (Needs user), dashboard alert "login_required", 1 job needs_user, source needs_user, 0 posts stored; login entry shows "Expired"; Log out / reset deletes the profile. No request was sent to facebook.com |
| Real-data test | ⛔ | **Waiting for the owner's Facebook login** (secondary account, via Settings → Accounts & Keys → "Open login window"). Then: crawl one public group with depth 7 days, check the counts, and save scrubbed real payloads as fixtures. Until that test passes, the extraction is **only proven on synthetic data shaped like Facebook's** (see DECISIONS D19). |

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
