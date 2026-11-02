import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import type { AccountEntryView, AccountKey } from '../../../shared/contracts';
import { setBrowserStatusProvider } from '../accounts';
import type { AppContext } from '../context';
import { log } from '../log';
import { platformState } from '../queue/queue';
import { nowIso } from '../util/time';

// One persistent Chromium profile per platform under <dataDir>\profiles\<platform>.
// The owner logs in by hand in a visible window; the app never sees or stores the password,
// and only checks that the login cookie EXISTS (its value is never read into the app or a log).

export type BrowserPlatform = 'facebook' | 'instagram';

const HOME: Record<BrowserPlatform, string> = { facebook: 'https://www.facebook.com/', instagram: 'https://www.instagram.com/' };
const LOGIN_COOKIE: Record<BrowserPlatform, string> = { facebook: 'c_user', instagram: 'sessionid' };

interface ProfileStatus {
  loggedIn: boolean;
  checkedAt: string | null;
  loggedInSince: string | null;
  lastCrawlOkAt: string | null;
  loginWall: boolean;
}

type InstallState = { state: 'idle' | 'installing' | 'done' | 'failed'; message?: string };

let pw: typeof import('playwright-core') | null = null;

export class BrowserManager {
  private contexts = new Map<BrowserPlatform, BrowserContext>();
  private opening = new Map<BrowserPlatform, Promise<BrowserContext>>();
  install: InstallState = { state: 'idle' };

  constructor(private readonly app: AppContext) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = app.paths.browsersDir;
    setBrowserStatusProvider((key) => this.accountStatus(key));
  }

  private async playwright() {
    pw ??= await import('playwright-core');
    return pw;
  }

  profileDir(p: BrowserPlatform): string {
    return path.join(this.app.paths.profilesDir, p);
  }

  private statusFile(p: BrowserPlatform): string {
    return path.join(this.app.paths.profilesDir, `${p}.status.json`);
  }

  readStatus(p: BrowserPlatform): ProfileStatus {
    try {
      return JSON.parse(fs.readFileSync(this.statusFile(p), 'utf8')) as ProfileStatus;
    } catch {
      return { loggedIn: false, checkedAt: null, loggedInSince: null, lastCrawlOkAt: null, loginWall: false };
    }
  }

  writeStatus(p: BrowserPlatform, patch: Partial<ProfileStatus>): void {
    fs.mkdirSync(this.app.paths.profilesDir, { recursive: true });
    fs.writeFileSync(this.statusFile(p), JSON.stringify({ ...this.readStatus(p), ...patch }, null, 2));
  }

  accountStatus(key: AccountKey): Pick<AccountEntryView, 'status' | 'setAt' | 'verifiedAt' | 'lastError'> {
    const p: BrowserPlatform = key === 'browser.instagram' ? 'instagram' : 'facebook';
    const st = this.readStatus(p);
    const plat = platformState(this.app.db, p);
    const blocked = !!plat.needs_user && plat.reason !== 'login_required';
    const status = blocked ? 'blocked' : st.loginWall || plat.reason === 'login_required' ? 'expired' : st.loggedIn ? (st.lastCrawlOkAt ? 'verified' : 'set') : 'not_set';
    return { status, setAt: st.loggedInSince, verifiedAt: st.lastCrawlOkAt, lastError: blocked ? `${plat.reason}: ${plat.reason_detail ?? ''}`.slice(0, 300) : null };
  }

  // ---- Chromium ---------------------------------------------------------------

  async chromiumInstalled(): Promise<boolean> {
    const { chromium } = await this.playwright();
    return fs.existsSync(chromium.executablePath());
  }

  /** Downloads Playwright's Chromium into <dataDir>\ms-playwright (once, ~150 MB). */
  async ensureChromium(): Promise<void> {
    if (await this.chromiumInstalled()) return;
    if (this.install.state === 'installing') throw new Error('browser download in progress');
    this.install = { state: 'installing' };
    log.info('downloading Playwright Chromium', { dir: this.app.paths.browsersDir });
    // cli.js is not in the package's "exports"; locate it next to package.json (sidecar or repo node_modules).
    const pkg = createRequire(path.join(process.cwd(), 'noop.js')).resolve('playwright-core/package.json');
    const cli = path.join(path.dirname(pkg), 'cli.js');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: this.app.paths.browsersDir },
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let err = '';
      child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`chromium install failed (${code}): ${err}`))));
      child.on('error', reject);
    }).then(
      () => {
        this.install = { state: 'done' };
        log.info('Chromium installed');
      },
      (e: Error) => {
        this.install = { state: 'failed', message: e.message.slice(0, 500) };
        log.error('Chromium install failed', e);
        throw e;
      },
    );
  }

  // ---- contexts -----------------------------------------------------------------

  isOpen(p: BrowserPlatform): boolean {
    return this.contexts.has(p);
  }

  /** The single persistent context of a platform (visible window; no stealth or fingerprint changes). */
  async context(p: BrowserPlatform): Promise<BrowserContext> {
    const existing = this.contexts.get(p);
    if (existing) return existing;
    const pending = this.opening.get(p);
    if (pending) return pending;
    const open = (async () => {
      await this.ensureChromium();
      const { chromium } = await this.playwright();
      fs.mkdirSync(this.profileDir(p), { recursive: true });
      const ctx = await chromium.launchPersistentContext(this.profileDir(p), {
        headless: false,
        viewport: null,
        args: ['--window-size=1280,900'],
      });
      ctx.on('close', () => {
        this.contexts.delete(p);
        void this.recordLoginFromProfile(p, null);
      });
      this.contexts.set(p, ctx);
      return ctx;
    })();
    this.opening.set(p, open);
    try {
      return await open;
    } finally {
      this.opening.delete(p);
    }
  }

  /** The one tab used for collection on this platform. */
  async page(p: BrowserPlatform): Promise<Page> {
    const ctx = await this.context(p);
    return ctx.pages()[0] ?? (await ctx.newPage());
  }

  /** Opens the visible window on the platform's home page so the owner can log in or solve a checkpoint. */
  async openLoginWindow(p: BrowserPlatform): Promise<void> {
    const page = await this.page(p);
    await page.bringToFront();
    if (!page.url().startsWith(HOME[p])) await page.goto(HOME[p], { waitUntil: 'domcontentloaded' }).catch(() => {});
    await this.recordLoginFromProfile(p, await page.context());
  }

  /** Login cookie present? Only the cookie NAME is checked; the value never leaves the browser. */
  async hasLoginCookie(ctx: BrowserContext, p: BrowserPlatform): Promise<boolean> {
    const cookies = await ctx.cookies(HOME[p]);
    return cookies.some((c) => c.name === LOGIN_COOKIE[p] && !!c.value);
  }

  async recordLoginFromProfile(p: BrowserPlatform, ctx: BrowserContext | null): Promise<boolean | null> {
    if (!ctx) return null;
    try {
      const loggedIn = await this.hasLoginCookie(ctx, p);
      const prev = this.readStatus(p);
      this.writeStatus(p, {
        loggedIn,
        checkedAt: nowIso(),
        loggedInSince: loggedIn ? (prev.loggedIn ? prev.loggedInSince : nowIso()) : null,
        loginWall: loggedIn ? false : prev.loginWall,
      });
      return loggedIn;
    } catch {
      return null;
    }
  }

  /** Re-check the login state (opens the profile if needed). */
  async checkLogin(p: BrowserPlatform): Promise<boolean> {
    const ctx = await this.context(p);
    return (await this.recordLoginFromProfile(p, ctx)) ?? false;
  }

  async close(p: BrowserPlatform): Promise<void> {
    const ctx = this.contexts.get(p);
    if (!ctx) return;
    await this.recordLoginFromProfile(p, ctx);
    await ctx.close().catch(() => {});
    this.contexts.delete(p);
  }

  /** Log out locally: close the window and delete the whole profile folder (cookies, cache, storage). */
  async resetProfile(p: BrowserPlatform): Promise<void> {
    await this.close(p);
    fs.rmSync(this.profileDir(p), { recursive: true, force: true });
    fs.rmSync(this.statusFile(p), { force: true });
    log.info('browser profile reset', { platform: p });
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.contexts.keys()].map((p) => this.close(p)));
  }
}
