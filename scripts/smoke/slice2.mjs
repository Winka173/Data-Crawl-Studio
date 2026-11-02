// Slice 2: YouTube via the API, driven through the built app against the synthetic fake API server.
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

let fake;

/** Runs before the app starts: launch the fake YouTube server and point the app at it. */
export async function env() {
  const proc = spawn(process.execPath, ['--import', 'tsx', path.join('scripts', 'fake-youtube-server.ts')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const line = await new Promise((resolve, reject) => {
    readline.createInterface({ input: proc.stdout }).once('line', resolve);
    proc.once('exit', (c) => reject(new Error(`fake server exited ${c}`)));
  });
  const { port, key } = JSON.parse(line);
  fake = { proc, port, key, base: `http://127.0.0.1:${port}` };
  return { DCS_YOUTUBE_API_BASE: fake.base };
}

export function cleanup() {
  fake?.proc.kill();
}

export async function run({ page, dataDir, shotDir, check, waitFor }) {
  const db = () => new Database(path.join(dataDir, 'db', 'datacrawl.db'), { readonly: true, fileMustExist: true });
  const q = (sql) => {
    const d = db();
    try {
      return d.prepare(sql).get();
    } finally {
      d.close();
    }
  };

  // Key entry + Test (against the fake API).
  await page.click('[data-page="settings"]');
  await page.click('.tab:has-text("Tài khoản")');
  const yt = page.locator('#acc-youtube\\.apiKey');
  await yt.locator('input[type="password"]').fill(fake.key);
  await yt.locator('button.primary').click();
  await yt.locator('button:has-text("Kiểm tra")').click();
  await waitFor(async () => (await yt.locator('.badge').textContent()) === 'Đã xác minh');
  check('YouTube key saved and verified via Test', true);

  // Add a channel by link with depth 30 days.
  await page.click('[data-page="sources"]');
  await page.fill('[data-testid="links"]', 'https://www.youtube.com/@fixturechannel\nhttps://example.com/not-supported');
  await page.selectOption('[data-testid="depth"]', '30');
  await page.click('[data-testid="add-sources"]');
  const result = await waitFor(() => page.textContent('[data-testid="add-result"]'));
  check('bulk paste adds the channel and rejects the unsupported link', /Đã thêm 1, 0 đã có sẵn, 1 bị từ chối/.test(result), result.split('\n')[0]);

  const row = page.locator('[data-testid="sources-table"] tbody tr').first();
  await waitFor(async () => (await row.locator('[data-testid="source-status"]').textContent()) === 'Hoạt động' && (await row.locator('.src-name a').textContent()) !== '(đang xác định…)', 60000);
  await waitFor(async () => (await row.locator('[data-testid="source-comments"]').textContent()) === '157' && !(await row.textContent()).includes('tác vụ đang'), 90000, 500);
  const posts = await row.locator('[data-testid="source-posts"]').textContent();
  check('first crawl stores 6 posts (30-day depth) and all 157 comments + replies', posts === '6', `posts ${posts}, comments 157`);
  await page.screenshot({ path: path.join(shotDir, 's2-sources.png'), fullPage: true });

  const counts = q(`SELECT (SELECT COUNT(*) FROM posts) p, (SELECT COUNT(*) FROM comments) c, (SELECT COUNT(*) FROM comments WHERE depth = 1) r,
    (SELECT COUNT(*) FROM pseudonyms) ps, (SELECT units_used FROM quota_usage) u`);
  const calls = await (await fetch(`${fake.base}/__fake/calls`)).json();
  check('DB record counts', counts.p === 6 && counts.c === 157 && counts.r === 50, JSON.stringify(counts));
  check('quota counted exactly one unit per API call', counts.u === calls.calls, `${counts.u} units, ${calls.calls} calls`);
  const leak = q(`SELECT COUNT(*) n FROM comments WHERE text LIKE '%@viewer%'`);
  check('no raw @handles of people in stored comment text', leak.n === 0);

  // Dashboard: quota and totals.
  await page.click('[data-page="dashboard"]');
  const quotaText = await waitFor(() => page.textContent('[data-testid="quota-text"]'));
  check('dashboard shows quota usage', quotaText.includes(`Đã dùng ${counts.u}`), quotaText);
  await page.screenshot({ path: path.join(shotDir, 's2-dashboard.png'), fullPage: true });

  // Data browser: open the video with the most comments, see the comment tree.
  await page.click('[data-page="data"]');
  await waitFor(async () => (await page.textContent('[data-testid="data-total"]'))?.includes('6'));
  await page.locator('.post-item').filter({ hasText: 'Fixture video 1' }).first().click();
  await page.waitForSelector('[data-testid="comment-tree"] .comment');
  const tops = await page.locator('[data-testid="comment-tree"] > .comment').count();
  const nested = await page.locator('.comment-children .comment').count();
  const treeText = await page.textContent('[data-testid="comment-tree"]');
  check('comment tree shows top-level comments with nested replies', tops === 95 && nested === 10, `${tops} top-level, ${nested} replies`);
  check('authors shown as pseudonyms, channel owner by name', /u_[0-9a-f]{16}/.test(treeText) && treeText.includes('Fixture Channel (synthetic)') && !treeText.includes('@viewer'));
  await page.screenshot({ path: path.join(shotDir, 's2-comment-tree.png') });

  // Incremental: a new video appears upstream; "Run now" picks it up without duplicating anything.
  await fetch(`${fake.base}/__fake/add-video`, { method: 'POST' });
  await page.click('[data-page="sources"]');
  await row.locator('button:has-text("Chạy ngay")').click();
  await waitFor(async () => (await row.locator('[data-testid="source-posts"]').textContent()) === '7' && !(await row.textContent()).includes('tác vụ đang'), 60000, 500);
  const after = q(`SELECT (SELECT COUNT(*) FROM posts) p, (SELECT COUNT(*) FROM comments) c, (SELECT COUNT(*) FROM crawl_runs) runs, (SELECT mode FROM crawl_runs ORDER BY id DESC LIMIT 1) mode`);
  check('incremental run adds the new video, no duplicates', after.p === 7 && after.c === 157 && after.runs === 2 && after.mode === 'incremental', JSON.stringify(after));

  // Pause / resume from the Sources page.
  await row.locator('button:has-text("Tạm dừng")').click();
  await waitFor(async () => (await row.locator('[data-testid="source-status"]').textContent()) === 'Tạm dừng');
  await row.locator('button:has-text("Tiếp tục")').click();
  await waitFor(async () => (await row.locator('[data-testid="source-status"]').textContent()) === 'Hoạt động');
  check('pause and resume a source', true);

  // Queue page renders finished jobs.
  await page.click('[data-page="queue"]');
  await page.click('.tab:has-text("Tất cả")');
  await waitFor(async () => (await page.locator('[data-testid="jobs-table"] tbody tr').count()) > 5);
  check('queue page lists jobs', true);
  await page.screenshot({ path: path.join(shotDir, 's2-queue.png'), fullPage: true });
}
