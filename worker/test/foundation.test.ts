import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateLocalApiToken, listAccounts, removeAccount, setSecret, testAccount } from '../src/accounts';
import { openDatabase } from '../src/db/db';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../src/db/migrations';
import { redact, redactString } from '../src/log';
import { nextQuotaReset, pacificDay } from '../src/platforms/youtube/quota';
import { Pseudonymizer, pseudonymizeMentions } from '../src/privacy/pseudonym';
import { dpapiProtect, dpapiUnprotect } from '../src/secrets/dpapi';
import { SecretStore } from '../src/secrets/store';
import { buildControlRouter, startControlServer } from '../src/server/control';
import { DEFAULT_SETTINGS, getSettings, updateSettings } from '../src/settings';
import { fakeFetch, makeContext, tempDir } from './helpers';

describe('database', () => {
  it('creates every table from the brief at the latest version', () => {
    const dir = tempDir();
    const { db, toVersion } = openDatabase(path.join(dir, 'db', 'a.db'), path.join(dir, 'backups'));
    expect(toVersion).toBe(LATEST_SCHEMA_VERSION);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ['sources', 'crawl_runs', 'jobs', 'posts', 'comments', 'media_refs', 'metric_snapshots', 'pseudonyms', 'raw_payloads', 'errors']) {
      expect(tables).toContain(t);
    }
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('backs up an existing database before migrating it, and not on first creation', () => {
    const dir = tempDir();
    const file = path.join(dir, 'db', 'a.db');
    const backups = path.join(dir, 'backups');
    const first = openDatabase(file, backups, MIGRATIONS);
    expect(first.backupPath).toBeNull();
    first.db.prepare("INSERT INTO app_settings VALUES ('marker', '1', 'x')").run();
    first.db.close();

    const next = [...MIGRATIONS, { version: LATEST_SCHEMA_VERSION + 1, name: 'test add', sql: 'CREATE TABLE extra (id INTEGER);' }];
    const second = openDatabase(file, backups, next);
    expect(second.fromVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(second.backupPath).not.toBeNull();
    expect(fs.existsSync(second.backupPath!)).toBe(true);
    second.db.close();

    // The backup holds the pre-migration data and schema.
    const { db: bak } = openDatabase(second.backupPath!, backups, MIGRATIONS);
    expect(bak.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(bak.prepare("SELECT value_json FROM app_settings WHERE key='marker'").get()).toEqual({ value_json: '1' });
    bak.close();
  });

  it('refuses a database from a newer app version', () => {
    const dir = tempDir();
    const file = path.join(dir, 'a.db');
    const { db } = openDatabase(file, dir);
    db.pragma('user_version = 999');
    db.close();
    expect(() => openDatabase(file, dir)).toThrow(/newer/);
  });
});

describe('DPAPI secret store', () => {
  it('round-trips through real DPAPI and never writes plaintext to disk', () => {
    const blob = dpapiProtect(Buffer.from('AIzaTESTKEY'));
    expect(dpapiUnprotect(blob).toString()).toBe('AIzaTESTKEY');

    const dir = tempDir();
    const file = path.join(dir, 'secrets.json');
    const store = new SecretStore(file);
    store.set('youtube.apiKey', 'AIzaSyFAKEFAKEFAKEFAKEFAKE123');
    const onDisk = fs.readFileSync(file, 'utf8');
    expect(onDisk).not.toContain('AIzaSyFAKE');
    expect(new SecretStore(file).get('youtube.apiKey')).toBe('AIzaSyFAKEFAKEFAKEFAKEFAKE123');
  });

  it('never exposes a secret through the accounts listing', () => {
    const ctx = makeContext();
    setSecret(ctx, 'youtube.apiKey', 'AIzaSySECRETSECRETSECRET999', {});
    const json = JSON.stringify(listAccounts(ctx));
    expect(json).not.toContain('SECRETSECRET');
    expect(listAccounts(ctx).find((a) => a.key === 'youtube.apiKey')!.status).toBe('set');
    removeAccount(ctx, 'youtube.apiKey');
    expect(listAccounts(ctx).find((a) => a.key === 'youtube.apiKey')!.status).toBe('not_set');
  });

  it('local API token is returned once and only status afterwards', () => {
    const ctx = makeContext();
    const token = generateLocalApiToken(ctx);
    expect(token).toMatch(/^dcs_/);
    expect(JSON.stringify(listAccounts(ctx))).not.toContain(token);
    expect(listAccounts(ctx).find((a) => a.key === 'localApi.token')!.status).toBe('verified');
  });
});

describe('account tests', () => {
  it('marks a working YouTube key verified and counts 1 quota unit', async () => {
    const f = fakeFetch([['i18nLanguages', () => ({ items: [] })]]);
    const ctx = makeContext({ fetch: f.fn });
    setSecret(ctx, 'youtube.apiKey', 'AIzaSyOKOKOKOKOKOKOKOKOK', {});
    expect((await testAccount(ctx, 'youtube.apiKey')).status).toBe('verified');
    expect(ctx.quota.status().used).toBe(1);
    expect(listAccounts(ctx).find((a) => a.key === 'youtube.apiKey')!.verifiedAt).not.toBeNull();
  });

  it('maps an expired Meta token to "expired"', async () => {
    const f = fakeFetch([['/me', () => new Response(JSON.stringify({ error: { code: 190, error_subcode: 463 } }), { status: 400 })]]);
    const ctx = makeContext({ fetch: f.fn });
    setSecret(ctx, 'meta.pageToken', 'EAAexpiredexpiredexpiredexpired', {});
    expect((await testAccount(ctx, 'meta.pageToken')).status).toBe('expired');
  });

  it('keeps only whitelisted non-secret metadata', () => {
    const ctx = makeContext();
    setSecret(ctx, 'meta.igToken', 'IGQVtokentokentokentokentoken', { igBusinessAccountId: '1784', evil: 'x' });
    const igEntry = listAccounts(ctx).find((a) => a.key === 'meta.igToken')!;
    expect(igEntry.meta).toEqual({ igBusinessAccountId: '1784' });
  });
});

describe('pseudonyms', () => {
  const salt = Buffer.alloc(32, 7);

  it('is stable, namespaced by platform, and not the raw id', () => {
    const p = new Pseudonymizer(salt);
    const a = p.of('youtube', 'UCabc');
    expect(a).toMatch(/^u_[0-9a-f]{16}$/);
    expect(p.of('youtube', 'UCabc')).toBe(a);
    expect(p.of('facebook', 'UCabc')).not.toBe(a);
    expect(new Pseudonymizer(Buffer.alloc(32, 8)).of('youtube', 'UCabc')).not.toBe(a);
  });

  it('records pseudonyms without any raw identifier', () => {
    const ctx = makeContext();
    const p = ctx.pseudonymizer();
    const pseudo = p.of('youtube', 'UC-raw-user-id');
    const rows = ctx.db.prepare('SELECT * FROM pseudonyms').all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('UC-raw-user-id');
    expect(JSON.stringify(rows)).toContain(pseudo);
  });

  it('replaces @mentions of individuals, keeps public entities, links known thread authors', () => {
    const p = new Pseudonymizer(salt);
    const known = new Map([['alice', 'UCalice']]);
    const out = pseudonymizeMentions('@Alice thanks! cc @bob_99. Ask @OfficialChannel, mail a@b.com', {
      platform: 'youtube',
      knownHandles: known,
      publicHandles: new Set(['officialchannel']),
    }, p);
    expect(out).toContain(`@${p.of('youtube', 'UCalice')} thanks`);
    expect(out).toContain(`@${p.of('youtube-handle', 'bob_99')}.`);
    expect(out).toContain('@OfficialChannel');
    expect(out).toContain('a@b.com');
    expect(out).not.toMatch(/alice|bob_99/i);
  });

  it('works with Vietnamese handles', () => {
    const p = new Pseudonymizer(salt);
    expect(pseudonymizeMentions('Cảm ơn @NguyễnVăn.A nhé', { platform: 'facebook' }, p)).not.toContain('NguyễnVăn');
  });
});

describe('settings', () => {
  it('returns defaults, merges partial updates and rejects invalid values', () => {
    const ctx = makeContext();
    expect(getSettings(ctx.db)).toEqual(DEFAULT_SETTINGS);
    const s = updateSettings(ctx.db, { language: 'en', pacing: { facebook: { maxActionsPerHour: 60 } } });
    expect(s.language).toBe('en');
    expect(s.pacing.facebook.maxActionsPerHour).toBe(60);
    expect(s.pacing.facebook.minDelayMs).toBe(DEFAULT_SETTINGS.pacing.facebook.minDelayMs);
    expect(() => updateSettings(ctx.db, { pacing: { facebook: { minDelayMs: 50 } } })).toThrow();
    expect(() => updateSettings(ctx.db, { defaultDepthDays: 0 })).toThrow();
    expect(getSettings(ctx.db).language).toBe('en');
  });
});

describe('log redaction', () => {
  it('removes keys, tokens and cookies', () => {
    expect(redactString('GET https://x/v3/videos?id=1&key=AIzaSyABCDEFGHIJKLMNOPQRSTUV')).not.toContain('AIzaSyABC');
    expect(redactString('cookie c_user=1000123; xs=abc%3Adef')).not.toMatch(/1000123|abc%3Adef/);
    expect(JSON.stringify(redact({ apiKey: 'zzz', nested: { access_token: 'yyy', ok: 'fine' } }))).toBe(
      '{"apiKey":"[redacted]","nested":{"access_token":"[redacted]","ok":"fine"}}',
    );
  });
});

describe('YouTube quota day', () => {
  it('uses the Pacific calendar day and resets just after Pacific midnight', () => {
    // 2026-11-02 07:30 UTC = 2026-11-01 23:30 PST
    const t = new Date('2026-11-02T07:30:00Z');
    expect(pacificDay(t)).toBe('2026-11-01');
    expect(nextQuotaReset(t)).toBe('2026-11-02T08:02:00.000Z');
  });

  it('never lets crawl work dip into the reserve or past the limit', () => {
    const ctx = makeContext();
    updateSettings(ctx.db, { youtube: { dailyQuota: 100, reserveUnits: 10 } });
    ctx.quota.take('x', 90);
    expect(() => ctx.quota.take('x', 1)).toThrow(/quota/);
    ctx.quota.take('test', 10, true);
    expect(() => ctx.quota.take('test', 1, true)).toThrow(/quota/);
    expect(ctx.quota.status().remaining).toBe(0);
  });
});

describe('control server', () => {
  it('requires the token and rejects foreign origins', async () => {
    const ctx = makeContext();
    const server = await startControlServer(buildControlRouter(ctx));
    const base = `http://127.0.0.1:${server.port}`;
    try {
      expect((await fetch(`${base}/health`)).status).toBe(401);
      const ok = await fetch(`${base}/health`, { headers: { 'X-DCS-Token': server.token } });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { schemaVersion: number }).schemaVersion).toBe(LATEST_SCHEMA_VERSION);
      const evil = await fetch(`${base}/health`, { headers: { 'X-DCS-Token': server.token, Origin: 'https://evil.example' } });
      expect(evil.status).toBe(403);
      const tauri = await fetch(`${base}/settings`, { headers: { 'X-DCS-Token': server.token, Origin: 'http://tauri.localhost' } });
      expect(tauri.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost');
      const bad = await fetch(`${base}/settings`, {
        method: 'PUT',
        headers: { 'X-DCS-Token': server.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultDepthDays: 5000 }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});
