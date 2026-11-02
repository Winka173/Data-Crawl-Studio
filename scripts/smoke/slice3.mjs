// Slice 3: Facebook groups via the browser. Without the owner's login this verifies everything up to the
// login gate with the REAL driver: notice gate, source add, Chromium download, visible persistent profile,
// "no login" detection → Facebook Paused (Needs user) + dashboard alert, profile reset. No request reaches
// facebook.com: the login cookie is checked on an empty profile before any navigation.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function env() {
  const dir = path.join(os.tmpdir(), 'dcs-smoke-browsers');
  fs.mkdirSync(dir, { recursive: true });
  return { DCS_BROWSERS_DIR: dir };
}

export async function run({ page, dataDir, shotDir, check, waitFor }) {
  const q = (sql) => {
    const d = new Database(path.join(dataDir, 'db', 'datacrawl.db'), { readonly: true, fileMustExist: true });
    try {
      return d.prepare(sql).get();
    } finally {
      d.close();
    }
  };
  const GROUP = 'https://www.facebook.com/groups/dcs.smoke.synthetic.group/';

  // Before the notice: a group link is refused.
  await page.click('[data-page="sources"]');
  await page.fill('[data-testid="links"]', GROUP);
  await page.click('[data-testid="add-sources"]');
  const refused = await waitFor(() => page.textContent('[data-testid="add-result"]'));
  check('Facebook source refused before the browser notice is accepted', refused.includes('Hãy chấp nhận thông báo'), refused.split('\n')[0]);

  // Accounts & Keys shows the notice; accept it.
  await page.click('[data-page="settings"]');
  await page.click('.tab:has-text("Tài khoản")');
  await page.waitForSelector('[data-testid="browser-notice"]');
  await page.screenshot({ path: path.join(shotDir, 's3-notice.png') });
  await page.click('[data-testid="accept-notice"]');
  await waitFor(async () => (await page.locator('[data-testid="browser-notice"]').count()) === 0);
  check('first-run notice accepted', !!q(`SELECT value_json FROM app_settings WHERE key = 'app'`).value_json.match(/"browserTosAcceptedAt":"20/));

  // Add the group: it is accepted and queued.
  await page.click('[data-page="sources"]');
  await page.fill('[data-testid="links"]', GROUP);
  await page.click('[data-testid="add-sources"]');
  const added = await waitFor(async () => {
    const t = await page.textContent('[data-testid="add-result"]');
    return t?.includes('Đã thêm 1') ? t : null;
  });
  check('Facebook group source added after accepting the notice', !!added);

  // The real driver downloads Chromium if needed, opens the persistent profile and finds no login.
  await page.click('[data-page="dashboard"]');
  const alert = await waitFor(() => page.textContent('[data-testid="needs-user-alert"]'), 600_000, 1000);
  check('no login → Facebook paused (needs user), alert on dashboard', alert.includes('facebook') && alert.includes('login_required'), alert.trim().slice(0, 120));
  await page.screenshot({ path: path.join(shotDir, 's3-needs-user.png') });
  const jobs = q(`SELECT COUNT(*) n FROM jobs WHERE platform = 'facebook' AND state = 'needs_user'`);
  const src = q(`SELECT status FROM sources WHERE platform = 'facebook'`);
  check('Facebook jobs are Paused (Needs user) and the source says so', jobs.n === 1 && src.status === 'needs_user', `${jobs.n} job(s), source ${src.status}`);
  const posts = q(`SELECT COUNT(*) n FROM posts WHERE platform = 'facebook'`);
  check('nothing stored without a login', posts.n === 0);

  // Accounts & Keys reflects the state; the profile can be reset.
  await page.click('[data-page="settings"]');
  await page.click('.tab:has-text("Tài khoản")');
  const card = page.locator('#acc-browser\\.facebook');
  const badge = await waitFor(() => card.locator('.badge').first().textContent());
  check('Facebook login entry shows "expired" (login needed)', badge === 'Hết hạn', badge);
  const profile = path.join(dataDir, 'profiles', 'facebook');
  check('persistent browser profile created under the data folder', fs.existsSync(profile));
  await card.locator('button.danger').click();
  await card.locator('.confirm button.danger').click();
  await waitFor(() => !fs.existsSync(profile), 30_000);
  check('Log out / reset deletes the profile', !fs.existsSync(profile));
  await page.screenshot({ path: path.join(shotDir, 's3-accounts.png'), fullPage: true });
}
