import crypto from 'node:crypto';
import type { AccountEntryView, AccountKey, AccountKind, AccountStatus } from '../../shared/contracts';
import type { AppContext } from './context';
import { log } from './log';
import { QuotaExceededError } from './platforms/youtube/quota';
import { checkValue, SALT_KEY } from './privacy/pseudonym';

// The single registry behind the "Accounts & Keys" page. No other part of the app asks for credentials.

export const GRAPH_VERSION = 'v23.0';

interface AccountDef {
  key: AccountKey;
  kind: AccountKind;
  features: string[];
  /** Non-secret fields the user may enter alongside the secret (shown back as-is). */
  metaFields?: string[];
  test?: (ctx: AppContext) => Promise<TestResult>;
}

export interface TestResult {
  status: AccountStatus;
  message?: string;
}

const DEFS: AccountDef[] = [
  {
    key: 'youtube.apiKey',
    kind: 'secret',
    features: ['feature.youtubeCrawl', 'feature.youtubeSearch'],
    test: testYoutubeKey,
  },
  { key: 'meta.appId', kind: 'secret', features: ['feature.fbPageApi', 'feature.igBusinessDiscovery'], test: testMetaApp },
  { key: 'meta.appSecret', kind: 'secret', features: ['feature.fbPageApi', 'feature.igBusinessDiscovery'], test: testMetaApp },
  {
    key: 'meta.pageToken',
    kind: 'secret',
    features: ['feature.fbPageApi'],
    test: (ctx) => testGraphToken(ctx, 'meta.pageToken'),
  },
  {
    key: 'meta.igToken',
    kind: 'secret',
    features: ['feature.igBusinessDiscovery'],
    metaFields: ['igBusinessAccountId'],
    test: (ctx) => testGraphToken(ctx, 'meta.igToken'),
  },
  { key: 'browser.facebook', kind: 'browserProfile', features: ['feature.fbGroupBrowser', 'feature.fbPageBrowser', 'feature.fbSearch'] },
  { key: 'browser.instagram', kind: 'browserProfile', features: ['feature.igBrowser', 'feature.igComments', 'feature.igHashtag'] },
  { key: 'localApi.token', kind: 'generatedToken', features: ['feature.localApi'], test: testDecrypts('localApi.token') },
  { key: 'privacy.salt', kind: 'salt', features: ['feature.pseudonyms'], test: testSalt },
];

export function accountDefs(): readonly AccountDef[] {
  return DEFS;
}

function def(key: string): AccountDef {
  const d = DEFS.find((x) => x.key === key);
  if (!d) throw new HttpError(404, `unknown account key: ${key}`);
  return d;
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
  }
}

/** Browser-profile status is provided by the browser module (slice 3); until then it reports "not set". */
export type BrowserStatusFn = (key: AccountKey) => Pick<AccountEntryView, 'status' | 'setAt' | 'verifiedAt' | 'lastError'>;
let browserStatus: BrowserStatusFn = () => ({ status: 'not_set', setAt: null, verifiedAt: null, lastError: null });
export function setBrowserStatusProvider(fn: BrowserStatusFn): void {
  browserStatus = fn;
}

export function listAccounts(ctx: AppContext): AccountEntryView[] {
  return DEFS.map((d) => {
    if (d.kind === 'browserProfile') {
      return { key: d.key, kind: d.kind, features: d.features, meta: {}, canTest: true, ...browserStatus(d.key) };
    }
    const r = ctx.secrets.record(d.key);
    const meta = r?.meta ?? {};
    return {
      key: d.key,
      kind: d.kind,
      features: d.features,
      status: r?.status ?? 'not_set',
      setAt: r?.setAt ?? null,
      verifiedAt: r?.verifiedAt ?? null,
      lastError: r?.lastError ?? null,
      // Only whitelisted, non-secret metadata goes to the UI.
      meta: Object.fromEntries(Object.entries(meta).filter(([k]) => (d.metaFields ?? []).includes(k) || k === 'check')),
      canTest: !!d.test && !!r,
    };
  });
}

export function setSecret(ctx: AppContext, key: string, value: unknown, meta: unknown): void {
  const d = def(key);
  if (d.kind !== 'secret') throw new HttpError(400, `${key} cannot be set by hand`);
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'value is required', 'err.valueRequired');
  if (value.length > 4096) throw new HttpError(400, 'value too long');
  const cleanMeta: Record<string, string> = {};
  if (meta && typeof meta === 'object') {
    for (const f of d.metaFields ?? []) {
      const v = (meta as Record<string, unknown>)[f];
      if (typeof v === 'string' && v.trim()) cleanMeta[f] = v.trim().slice(0, 200);
    }
  }
  ctx.secrets.set(key, value.trim(), cleanMeta);
  log.info('account entry saved', { key });
}

/** Creates (or replaces) the local API token. The plaintext is returned exactly once. */
export function generateLocalApiToken(ctx: AppContext): string {
  const token = `dcs_${crypto.randomBytes(24).toString('base64url')}`;
  ctx.secrets.set('localApi.token', token);
  ctx.secrets.setStatus('localApi.token', 'verified');
  log.info('local API token generated');
  return token;
}

export function removeAccount(ctx: AppContext, key: string): void {
  const d = def(key);
  if (d.kind === 'browserProfile') throw new HttpError(400, 'use the browser profile reset action');
  ctx.secrets.remove(key);
  log.info('account entry removed', { key });
}

export async function testAccount(ctx: AppContext, key: string): Promise<TestResult> {
  const d = def(key);
  if (!d.test) throw new HttpError(400, `${key} has no test`);
  if (d.kind !== 'browserProfile' && !ctx.secrets.has(key)) throw new HttpError(400, 'not set', 'err.notSet');
  let result: TestResult;
  try {
    result = await d.test(ctx);
  } catch (e) {
    result = { status: 'set', message: e instanceof Error ? e.message : String(e) };
  }
  if (d.kind !== 'browserProfile') {
    ctx.secrets.setStatus(key, result.status, result.status === 'verified' ? null : (result.message ?? null));
    // App id and secret are verified together.
    if (key === 'meta.appId' && ctx.secrets.has('meta.appSecret')) ctx.secrets.setStatus('meta.appSecret', result.status, result.status === 'verified' ? null : (result.message ?? null));
    if (key === 'meta.appSecret' && ctx.secrets.has('meta.appId')) ctx.secrets.setStatus('meta.appId', result.status, result.status === 'verified' ? null : (result.message ?? null));
  }
  log.info('account entry tested', { key, status: result.status });
  return result;
}

// ---- testers ---------------------------------------------------------------

async function testYoutubeKey(ctx: AppContext): Promise<TestResult> {
  const key = ctx.secrets.get('youtube.apiKey')!;
  try {
    ctx.quota.take('i18nLanguages.list(test)', 1, true);
  } catch (e) {
    if (e instanceof QuotaExceededError) return { status: 'set', message: 'quota exhausted; test again after reset' };
    throw e;
  }
  const url = `https://www.googleapis.com/youtube/v3/i18nLanguages?part=snippet&hl=en&key=${encodeURIComponent(key)}`;
  const res = await ctx.fetch(url);
  if (res.ok) return { status: 'verified' };
  const body = (await res.json().catch(() => ({}))) as { error?: { errors?: { reason?: string }[]; message?: string } };
  const reason = body.error?.errors?.[0]?.reason ?? `http_${res.status}`;
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
    ctx.quota.markExhausted();
    return { status: 'set', message: 'quota exhausted; test again after reset' };
  }
  if (reason === 'keyExpired') return { status: 'expired', message: reason };
  if (reason === 'accessNotConfigured') return { status: 'blocked', message: 'YouTube Data API v3 is not enabled for this key' };
  return { status: 'blocked', message: reason };
}

async function testMetaApp(ctx: AppContext): Promise<TestResult> {
  const id = ctx.secrets.get('meta.appId');
  const secret = ctx.secrets.get('meta.appSecret');
  if (!id || !secret) return { status: 'set', message: 'enter both the app ID and the app secret' };
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}&grant_type=client_credentials`;
  const res = await ctx.fetch(url);
  if (res.ok) return { status: 'verified' };
  return graphFailure(res);
}

async function testGraphToken(ctx: AppContext, key: AccountKey): Promise<TestResult> {
  const token = ctx.secrets.get(key)!;
  const res = await ctx.fetch(`https://graph.facebook.com/${GRAPH_VERSION}/me?fields=id`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.ok) return { status: 'verified' };
  return graphFailure(res);
}

async function graphFailure(res: Response): Promise<TestResult> {
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: number; error_subcode?: number; type?: string } };
  const code = body.error?.code;
  // 190 = invalid/expired OAuth token; 463/467 subcodes = expired session.
  if (code === 190) return { status: 'expired', message: `graph error 190/${body.error?.error_subcode ?? ''}` };
  if (code === 4 || code === 17 || code === 32 || code === 613) return { status: 'set', message: `rate limited (graph ${code})` };
  return { status: 'blocked', message: `graph error ${code ?? res.status}` };
}

function testDecrypts(key: AccountKey) {
  return async (ctx: AppContext): Promise<TestResult> => {
    const v = ctx.secrets.getBuffer(key);
    return v && v.length > 0 ? { status: 'verified' } : { status: 'blocked', message: 'cannot decrypt' };
  };
}

async function testSalt(ctx: AppContext): Promise<TestResult> {
  const salt = ctx.secrets.getBuffer(SALT_KEY);
  if (!salt) return { status: 'not_set' };
  const expected = ctx.secrets.record(SALT_KEY)?.meta.check;
  if (expected && expected !== checkValue(salt)) {
    return { status: 'blocked', message: 'salt fingerprint mismatch: pseudonyms would change' };
  }
  return { status: 'verified' };
}
