// Slice 1: skeleton, SQLite + migrations, Accounts & Keys with DPAPI, VI/EN.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const FAKE_KEY = 'AIzaSmokeTestNotARealKey_0123456789ab';

export async function run({ page, dataDir, shotDir, check, waitFor }) {
  // Dashboard: schema version from the live worker.
  await page.click('[data-page="dashboard"]');
  const schema = await page.textContent('[data-testid="schema-version"]', { timeout: 15000 });
  check('dashboard shows schema version from worker', /^v\d+$/.test(schema ?? ''), schema);
  await page.screenshot({ path: path.join(shotDir, 's1-dashboard-vi.png') });

  // Database created with every table; secrets file has a DPAPI-protected salt.
  const db = new Database(path.join(dataDir, 'db', 'datacrawl.db'), { readonly: true, fileMustExist: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  db.close();
  const want = ['sources', 'crawl_runs', 'jobs', 'posts', 'comments', 'media_refs', 'metric_snapshots', 'pseudonyms', 'raw_payloads', 'errors'];
  check('database has all brief tables', want.every((t) => tables.includes(t)), `${tables.length} tables`);
  const secrets = JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8'));
  check('pseudonym salt created and DPAPI-protected', !!secrets.entries['privacy.salt']?.blob);

  // Language switch VI -> EN -> VI.
  await page.click('.lang-switch button:has-text("EN")');
  await waitFor(async () => (await page.textContent('[data-page="settings"]')) === 'Settings');
  check('switches UI to English', true);
  await page.click('.lang-switch button:has-text("VI")');
  await waitFor(async () => (await page.textContent('[data-page="settings"]')) === 'Cài đặt');
  check('switches UI back to Vietnamese', true);

  // Accounts & Keys: save a key, it is never shown again, file has no plaintext.
  await page.click('[data-page="settings"]');
  const yt = page.locator('#acc-youtube\\.apiKey');
  await yt.locator('input[type="password"]').fill(FAKE_KEY);
  await yt.locator('button.primary').click();
  await waitFor(async () => (await yt.locator('.badge').textContent()) === 'Đã đặt');
  check('saves YouTube key, status "set"', true);
  const html = await page.content();
  check('saved key is not present anywhere in the page', !html.includes(FAKE_KEY));
  const onDisk = fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8');
  check('secrets.json holds no plaintext key', !onDisk.includes(FAKE_KEY) && onDisk.includes('youtube.apiKey'));
  await page.screenshot({ path: path.join(shotDir, 's1-accounts-saved.png'), fullPage: true });

  // Salt test -> verified.
  const salt = page.locator('#acc-privacy\\.salt');
  await salt.locator('button:has-text("Kiểm tra")').click();
  await waitFor(async () => (await salt.locator('.badge').textContent()) === 'Đã xác minh');
  check('salt Test reports verified', true);

  // Local API token is shown once, then gone after re-render.
  const tok = page.locator('#acc-localApi\\.token');
  await tok.locator('button.primary').click();
  const token = await waitFor(async () => (await tok.locator('.token-once code').textContent())?.trim());
  check('local API token displayed once on generation', /^dcs_/.test(token));
  await page.click('[data-page="dashboard"]');
  await page.click('[data-page="settings"]');
  const html2 = await page.content();
  check('token not shown again after leaving the page', !html2.includes(token));

  // Remove the key.
  await yt.locator('button.danger').click();
  await yt.locator('.confirm button.danger').click();
  await waitFor(async () => (await yt.locator('.badge').textContent()) === 'Chưa đặt');
  check('removes YouTube key', !fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8').includes('youtube.apiKey'));

  // Pacing settings validation round-trip.
  await page.click('.tab:has-text("Nhịp độ")');
  const first = page.locator('.card').first().locator('input[type="number"]').first();
  await first.fill('100');
  await page.click('.row-actions button.primary');
  await waitFor(async () => (await page.locator('.error').count()) > 0);
  check('rejects an unsafe pacing value (100 ms)', true, await page.locator('.error').first().textContent());
  await first.fill('5000');
  await page.click('.row-actions button.primary');
  await waitFor(async () => (await page.locator('.row-actions button.primary').textContent()) === 'Đã lưu');
  check('saves a valid pacing value', true);
  await page.screenshot({ path: path.join(shotDir, 's1-pacing.png'), fullPage: true });

  // Logs page renders and contains no secrets.
  await page.click('[data-page="logs"]');
  await page.waitForSelector('.log-line');
  const logs = await page.textContent('.log-view');
  check('logs page shows worker log without secrets', logs.includes('account entry saved') && !logs.includes(FAKE_KEY) && !logs.includes(token));
}
