import type { Page, Response } from 'playwright-core';
import type { Pacer } from '../../browser/pacing';
import type { BrowserManager } from '../../browser/session';
import { ShapeBook } from '../../browser/shapes';
import { log } from '../../log';
import { BlockedError } from '../../queue/errors';
import { detectBlockInPage, detectBlockInResponse } from './detect';
import { extractFrom, parseJsonDocuments, SELECTORS, type Extracted } from './extract';

export interface Snapshot {
  url: string;
  hasFeed: boolean;
  articleCount: number;
  notAvailable: boolean;
}

/** Everything the Facebook jobs need from a browser tab. Implemented with Playwright; faked in tests. */
export interface FbDriver {
  /** Navigate (one paced action) and return the page state; embedded JSON goes into `into`. */
  open(url: string, into: Extracted, signal: AbortSignal): Promise<Snapshot>;
  /** Scroll down a screen or so (one paced action). */
  scroll(signal: AbortSignal): Promise<void>;
  /** Switch the comment list to "All comments". Returns false if the control was not found. */
  showAllComments(signal: AbortSignal): Promise<boolean>;
  /** Click one "more comments / replies" control (one paced action). Returns false when none is left. */
  expandOne(signal: AbortSignal): Promise<boolean>;
  /** Collect JSON from network responses received since the last call into `into`; throws BlockedError on a block. */
  drain(into: Extracted): Promise<void>;
  /** Throws BlockedError if the current page is a checkpoint/CAPTCHA/login wall/block notice. */
  assertNotBlocked(): Promise<void>;
  loggedIn(): Promise<boolean>;
  /** Write a value-free summary of the JSON seen since the last open() (for parser fixes). Returns the file path. */
  diagnose?(reason: string, extra?: Record<string, unknown>): Promise<string | null>;
}

export class PlaywrightFbDriver implements FbDriver {
  private pending: Promise<void>[] = [];
  private bodies: { status: number; text: string }[] = [];
  private page: Page | null = null;
  private listener = (r: Response) => this.onResponse(r);
  private shapes = new ShapeBook();
  private lastMenu: string[] = [];

  constructor(private readonly browser: BrowserManager, private readonly pacer: Pacer, private readonly diagDir?: string) {}

  async diagnose(reason: string, extra: Record<string, unknown> = {}): Promise<string | null> {
    if (!this.diagDir || !this.shapes.size) return null;
    try {
      const controls = await this.controlTexts().catch(() => []);
      return this.shapes.write(this.diagDir, reason, { ...extra, controls, sortMenu: this.lastMenu.map((t) => t.replace(/(\p{Lu}[\p{Ll}\p{M}]+)(\s+\p{Lu}[\p{Ll}\p{M}]+)+/gu, '<name>')) });
    } catch (e) {
      log.warn('could not write parser diagnostics', { e: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  private async tab(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    this.page = await this.browser.page('facebook');
    this.page.on('response', this.listener);
    return this.page;
  }

  detach(): void {
    this.page?.off('response', this.listener);
    this.page = null;
  }

  private onResponse(r: Response): void {
    const url = r.url();
    if (!url.includes('/api/graphql') && !url.includes('/ajax/')) return;
    this.pending.push(
      r.text().then(
        (text) => void this.bodies.push({ status: r.status(), text }),
        () => undefined,
      ),
    );
  }

  /**
   * Texts of the page's comment controls, for fixing SELECTORS. Only short texts made of comment-UI words are kept,
   * and runs of two or more capitalised words (usually a person's name) are masked.
   */
  private async controlTexts(): Promise<{ role: string; text: string }[]> {
    const page = await this.tab();
    const raw = await page.$$eval('[role="button"], [role="menuitem"], [role="menuitemradio"], [role="radio"]', (els) =>
      els.slice(0, 3000).map((e) => ({ role: e.getAttribute('role') ?? '', text: ((e as HTMLElement).innerText ?? '').trim().slice(0, 80) })),
    );
    const vocab = /comment|repl|relevant|newest|all |more|previous|view|see|bình luận|phản hồi|trả lời|phù hợp|mới nhất|tất cả|xem|thêm|trước/i;
    const seen = new Set<string>();
    const out: { role: string; text: string }[] = [];
    for (const r of raw) {
      if (!r.text || r.text.length > 60 || !vocab.test(r.text)) continue;
      const text = r.text.replace(/\s+/g, ' ').replace(/(\p{Lu}[\p{Ll}\p{M}]+)(\s+\p{Lu}[\p{Ll}\p{M}]+)+/gu, '<name>');
      const key = `${r.role}|${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ role: r.role, text });
      if (out.length >= 80) break;
    }
    return out;
  }

  async loggedIn(): Promise<boolean> {
    const page = await this.tab();
    return this.browser.hasLoginCookie(page.context(), 'facebook');
  }

  async open(url: string, into: Extracted, signal: AbortSignal): Promise<Snapshot> {
    const page = await this.tab();
    await this.pacer.beforeAction('facebook', signal);
    this.shapes.clear();
    this.lastMenu = [];
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector(`${SELECTORS.feed}, ${SELECTORS.article}`, { timeout: 15_000 }).catch(() => undefined);
    await this.assertNotBlocked();
    const scripts = await page.$$eval(SELECTORS.embeddedJson, (els) => els.map((e) => e.textContent ?? ''));
    for (const s of scripts) {
      for (const doc of parseJsonDocuments(s)) {
        this.shapes.add(doc);
        extractFrom(doc, into);
      }
    }
    return this.snapshot();
  }

  private async snapshot(): Promise<Snapshot> {
    const page = await this.tab();
    return page.evaluate(
      ({ feed, article, notAvail }) => {
        const re = new RegExp(notAvail.source, notAvail.flags);
        const hasFeed = !!document.querySelector(feed);
        return {
          url: location.href,
          hasFeed,
          articleCount: document.querySelectorAll(article).length,
          notAvailable: !hasFeed && re.test(document.body.innerText.slice(0, 5000)),
        };
      },
      { feed: SELECTORS.feed, article: SELECTORS.article, notAvail: { source: SELECTORS.groupNotAvailableText.source, flags: SELECTORS.groupNotAvailableText.flags } },
    );
  }

  async assertNotBlocked(): Promise<void> {
    const page = await this.tab();
    const info = await page.evaluate(
      ({ dialogs, feed, article }) => {
        const dialogText = [...document.querySelectorAll(dialogs)].map((d) => (d as HTMLElement).innerText).join('\n');
        const content = document.querySelector(feed) || document.querySelector(article);
        return { dialogText, title: document.title, body: content ? '' : document.body.innerText.slice(0, 20000) };
      },
      { dialogs: SELECTORS.dialogs, feed: SELECTORS.feed, article: SELECTORS.article },
    );
    const hit = detectBlockInPage(page.url(), `${info.title}\n${info.dialogText}\n${info.body}`);
    if (hit) throw new BlockedError(`Facebook: ${hit.code} (${hit.evidence})`, hit.code);
  }

  async scroll(signal: AbortSignal): Promise<void> {
    const page = await this.tab();
    await this.pacer.beforeAction('facebook', signal);
    // The wheel scrolls whatever is under the pointer: put it over the main column first (at (0,0) it sits on the
    // left navigation, which has its own scroll area, and the page would not move).
    const vp = page.viewportSize() ?? (await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })));
    await page.mouse.move(vp.width * (0.42 + Math.random() * 0.16), vp.height * (0.45 + Math.random() * 0.25), { steps: 4 });
    // A flick of several wheel steps of uneven size, like a person skimming. Group posts are long: fewer steps
    // passed only ~1.6 posts per action on a real feed.
    const steps = 5 + Math.floor(Math.random() * 4);
    for (let i = 0; i < steps; i++) {
      await page.mouse.wheel(0, 300 + Math.random() * 400);
      await page.waitForTimeout(150 + Math.random() * 350);
    }
    await this.assertNotBlocked();
  }

  async showAllComments(signal: AbortSignal): Promise<boolean> {
    const page = await this.tab();
    // Facebook keeps hidden copies of controls in the DOM: only visible ones count.
    const order = page.locator('[role="button"]:visible').filter({ hasText: SELECTORS.commentOrderButtonText }).first();
    if (!(await order.isVisible().catch(() => false))) return false;
    if (SELECTORS.allCommentsMenuText.test((await order.innerText().catch(() => '')).trim())) return true;
    await this.pacer.beforeAction('facebook', signal);
    await order.click();
    const item = page.locator('[role="menuitem"]:visible, [role="menuitemradio"]:visible, [role="option"]:visible').filter({ hasText: SELECTORS.allCommentsMenuText }).first();
    if (!(await item.isVisible({ timeout: 5000 }).catch(() => false))) {
      // Remember what the menu offered (UI words only) for the diagnostics, then close it.
      this.lastMenu = await page
        .locator('[role="menuitem"]:visible, [role="menuitemradio"]:visible, [role="option"]:visible, [role="radio"]:visible, [role="menu"]:visible, [role="dialog"]:visible [role="button"]')
        .evaluateAll((els) => els.slice(0, 20).map((e) => `${e.getAttribute('role')}: ${((e as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)}`))
        .catch(() => []);
      await page.keyboard.press('Escape').catch(() => undefined);
      return false;
    }
    await this.pacer.beforeAction('facebook', signal);
    await item.click();
    await page.waitForTimeout(1500);
    await this.assertNotBlocked();
    return true;
  }

  async expandOne(signal: AbortSignal): Promise<boolean> {
    const page = await this.tab();
    const btn = page.locator('[role="button"]:visible').filter({ hasText: SELECTORS.expandButtonText }).first();
    if (!(await btn.isVisible().catch(() => false))) return false;
    await this.pacer.beforeAction('facebook', signal);
    await btn.scrollIntoViewIfNeeded().catch(() => undefined);
    await btn.click({ timeout: 10_000 }).catch((e: Error) => log.debug('expand click failed', { e: e.message }));
    await page.waitForTimeout(800 + Math.random() * 700);
    await this.assertNotBlocked();
    return true;
  }

  async drain(into: Extracted): Promise<void> {
    const pending = this.pending;
    this.pending = [];
    await Promise.all(pending);
    const bodies = this.bodies;
    this.bodies = [];
    for (const b of bodies) {
      const docs = parseJsonDocuments(b.text);
      for (const doc of docs) {
        const hit = detectBlockInResponse(b.status, doc);
        if (hit) throw new BlockedError(`Facebook: ${hit.code} (${hit.evidence})`, hit.code);
        this.shapes.add(doc);
        extractFrom(doc, into);
      }
      if (!docs.length && b.status === 429) throw new BlockedError('Facebook: rate_limited (HTTP 429)', 'rate_limited');
    }
  }
}
