// End-to-end smoke test of the BUILT desktop app.
//   node scripts/smoke.mjs [slice ...]      e.g. node scripts/smoke.mjs 1 2
// Launches src-tauri/target/release/data-crawl-studio.exe with a scratch data folder
// (DCS_DATA_DIR) so the owner's real data is never touched, drives the WebView2 UI through
// the Chrome DevTools Protocol, saves screenshots, and closes the app gracefully.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'src-tauri', 'target', 'release', 'data-crawl-studio.exe');
const CDP_PORT = Number(process.env.DCS_SMOKE_CDP_PORT ?? 9338);
const slices = process.argv.slice(2).length ? process.argv.slice(2) : ['1'];
const dataDir = process.env.DCS_SMOKE_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dcs-smoke-'));
const shotDir = process.env.DCS_SMOKE_SHOTS ?? path.join(dataDir, 'screenshots');
fs.mkdirSync(shotDir, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function waitFor(fn, ms = 20000, step = 250) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error(`timed out${last ? `: ${last.message}` : ''}`);
}

function workerPids() {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -like '*\\sidecar\\node.exe' } | ForEach-Object { $_.ProcessId }`,
    ]).toString();
    return out.split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

export const ctx = { dataDir, shotDir, check, waitFor };

async function main() {
  if (!fs.existsSync(exe)) throw new Error(`build first: ${exe} not found`);
  console.log(`exe: ${exe}\ndata: ${dataDir}\nshots: ${shotDir}`);
  const before = new Set(workerPids());
  const app = spawn(exe, [], {
    env: { ...process.env, DCS_DATA_DIR: dataDir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
    stdio: 'ignore',
  });
  const started = Date.now();
  let browser;
  try {
    browser = await waitFor(() => chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`), 30000, 500);
    const page = await waitFor(() => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('tauri.localhost')), 20000);
    await page.waitForSelector('.sidebar', { timeout: 30000 });
    check('app window shows the UI', true, `${Date.now() - started} ms to first render`);
    ctx.page = page;
    const newWorkers = workerPids().filter((p) => !before.has(p));
    check('worker sidecar process running', newWorkers.length === 1, `pids ${newWorkers.join(',')}`);
    ctx.workerPid = newWorkers[0];

    for (const s of slices) {
      const mod = await import(`./smoke/slice${s}.mjs`);
      console.log(`\n--- slice ${s} ---`);
      await mod.run(ctx);
    }
  } catch (e) {
    check('smoke run completed', false, e.stack ?? String(e));
    if (ctx.page) await ctx.page.screenshot({ path: path.join(shotDir, 'failure.png') }).catch(() => {});
  } finally {
    await browser?.close().catch(() => {});
    // Graceful close (WM_CLOSE), the same as the user clicking X.
    try { execFileSync('taskkill', ['/PID', String(app.pid)]); } catch { /* already closed */ }
    const closed = await waitFor(() => app.exitCode !== null || app.signalCode !== null, 15000).then(() => true, () => false);
    check('app closes on window close', closed);
    if (!closed) try { execFileSync('taskkill', ['/F', '/T', '/PID', String(app.pid)]); } catch {}
    if (ctx.workerPid) {
      const gone = await waitFor(() => !workerPids().includes(ctx.workerPid), 10000).then(() => true, () => false);
      check('worker exits with the app', gone);
      check('worker released its lock', !fs.existsSync(path.join(dataDir, 'worker.lock')));
    }
  }
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(shotDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${shotDir}`);
  process.exit(failed.length ? 1 : 0);
}

main();
