// Slice 8 (exports part): run after slice 2 in the same session, so the synthetic YouTube crawl is there to export.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export async function run({ page, dataDir, shotDir, check, waitFor }) {
  const d = new Database(path.join(dataDir, 'db', 'datacrawl.db'), { readonly: true, fileMustExist: true });
  const db = d.prepare('SELECT (SELECT COUNT(*) FROM posts) p, (SELECT COUNT(*) FROM comments) c').get();
  d.close();
  await page.click('[data-page="exports"]');
  await page.selectOption('[data-testid="export-format"]', 'csv');
  await page.click('[data-testid="run-export"]');
  const result = await waitFor(() => page.textContent('[data-testid="export-result"]'), 30000);
  check('export from the UI reports every stored post and comment', result.includes(`posts.csv: ${db.p}`) && result.includes(`comments.csv: ${db.c}`), `${result.split('C:')[0]} (DB: ${db.p} posts, ${db.c} comments)`);

  const root = path.join(dataDir, 'exports');
  const dir = path.join(root, fs.readdirSync(root).sort().at(-1));
  const csv = fs.readFileSync(path.join(dir, 'comments.csv'), 'utf8');
  check('CSV has a UTF-8 BOM and the documented header', csv.startsWith('\uFEFFplatform,comment_id,post_id,parent_comment_id,'));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  check('manifest lists the files and row counts', manifest.format_version === 1 && manifest.files.find((f) => f.file === 'comments.csv')?.rows === db.c, JSON.stringify(manifest.files));
  const all = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  check('export holds no raw viewer ids or @handles of people', !/UCviewer|@viewer/.test(all));

  await page.selectOption('[data-testid="export-format"]', 'jsonl');
  await page.click('[data-testid="run-export"]');
  await waitFor(async () => ((await page.textContent('[data-testid="export-result"]')) ?? '').includes(`posts.jsonl: ${db.p}`), 30000);
  await waitFor(async () => (await page.locator('table.table tbody tr').count()) >= 2, 15000);
  check('previous exports are listed', true);
  await page.screenshot({ path: path.join(shotDir, 's8-exports.png'), fullPage: true });

  // Per-source settings: custom depth and the comment switch.
  await page.click('[data-page="sources"]');
  const row = page.locator('[data-testid="sources-table"] tbody tr').first();
  await row.locator('[data-testid="edit-source"]').click();
  await row.locator('[data-testid="edit-depth"]').selectOption('custom');
  await row.locator('[data-testid="edit-depth-days"]').fill('45');
  await row.locator('[data-testid="edit-comments"]').uncheck();
  await row.locator('[data-testid="save-source"]').click();
  await waitFor(async () => (await row.locator('[data-testid="comments-off"]').count()) === 1, 10000);
  const meta = await row.locator('.muted.small').first().textContent();
  check('a source can be set to a custom depth and posts only', /45 ngày/.test(meta) && /chỉ bài viết/.test(meta), meta);
  const sid = Number(await row.getAttribute('data-source-id'));
  const d2 = new Database(path.join(dataDir, 'db', 'datacrawl.db'), { readonly: true, fileMustExist: true });
  const src = d2.prepare('SELECT depth_days, collect_comments FROM sources WHERE id = ?').get(sid);
  d2.close();
  check('the source settings are saved in the DB', src.depth_days === 45 && src.collect_comments === 0, JSON.stringify(src));
  await page.screenshot({ path: path.join(shotDir, 's8-source-settings.png'), fullPage: true });
}
