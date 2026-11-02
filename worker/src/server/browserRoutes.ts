import { HttpError } from '../accounts';
import type { BrowserManager, BrowserPlatform } from '../browser/session';
import type { AppContext } from '../context';
import { log } from '../log';
import { updateSettings } from '../settings';
import { nowIso } from '../util/time';
import type { Router } from './router';

const platformOf = (v: string | undefined): BrowserPlatform => {
  if (v === 'facebook' || v === 'instagram') return v;
  throw new HttpError(400, 'unknown browser platform');
};

export function installBrowserRoutes(r: Router, app: AppContext, browser: BrowserManager): void {
  r.get('/browser/status', async () => ({
    noticeAcceptedAt: app.settings().browserTosAcceptedAt,
    chromiumInstalled: await browser.chromiumInstalled().catch(() => false),
    install: browser.install,
    platforms: (['facebook', 'instagram'] as const).map((p) => ({ platform: p, open: browser.isOpen(p), ...browser.readStatus(p) })),
  }));

  // The owner accepts the first-run notice once; browser sources and login windows are refused before that.
  r.post('/browser/notice/accept', () => {
    const s = updateSettings(app.db, { browserTosAcceptedAt: nowIso() });
    log.info('browser collection notice accepted');
    return { acceptedAt: s.browserTosAcceptedAt };
  });

  const requireNotice = () => {
    if (!app.settings().browserTosAcceptedAt) throw new HttpError(409, 'accept the browser-collection notice first', 'link.browser_notice_not_accepted');
  };

  r.post('/browser/install', async () => {
    requireNotice();
    void browser.ensureChromium().catch(() => undefined); // progress via /browser/status
    return { install: browser.install };
  });

  r.post('/browser/:platform/login', async (req) => {
    requireNotice();
    const p = platformOf(req.params.platform);
    if (!(await browser.chromiumInstalled())) {
      void browser.ensureChromium().then(() => browser.openLoginWindow(p)).catch((e) => log.error('login window failed', e));
      return { started: true, installing: true };
    }
    await browser.openLoginWindow(p);
    return { started: true, installing: false };
  });

  r.post('/browser/:platform/check', async (req) => {
    requireNotice();
    const p = platformOf(req.params.platform);
    return { loggedIn: await browser.checkLogin(p) };
  });

  r.post('/browser/:platform/close', async (req) => {
    await browser.close(platformOf(req.params.platform));
    return { ok: true };
  });

  r.post('/browser/:platform/reset', async (req) => {
    await browser.resetProfile(platformOf(req.params.platform));
    return { ok: true };
  });
}
