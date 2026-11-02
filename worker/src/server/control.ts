import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WorkerHealth } from '../../../shared/contracts';
import { generateLocalApiToken, listAccounts, removeAccount, setSecret, testAccount } from '../accounts';
import type { AppContext } from '../context';
import { log } from '../log';
import { getSettings, updateSettings } from '../settings';
import { dispatch, Router, sendJson } from './router';

// Internal API between the desktop UI and this worker. Bound to 127.0.0.1 on an OS-chosen port,
// protected by a per-launch random token that only the Tauri shell receives (via stdout pipe).

const ALLOWED_ORIGINS = new Set([
  'http://tauri.localhost',
  'https://tauri.localhost',
  'tauri://localhost',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

export type RouteInstaller = (router: Router, ctx: AppContext) => void;

export function buildControlRouter(ctx: AppContext, installers: RouteInstaller[] = []): Router {
  const r = new Router();

  r.get('/health', (): WorkerHealth => ({
    ok: true,
    version: ctx.version,
    dataDir: ctx.paths.dataDir,
    dbPath: ctx.paths.dbPath,
    schemaVersion: ctx.db.pragma('user_version', { simple: true }) as number,
    startedAt: ctx.startedAt,
  }));

  r.get('/settings', () => getSettings(ctx.db));
  r.put('/settings', (req) => updateSettings(ctx.db, req.body));

  r.get('/accounts', () => listAccounts(ctx));
  r.put('/accounts/:key', (req) => {
    const b = (req.body ?? {}) as { value?: unknown; meta?: unknown };
    setSecret(ctx, req.params.key!, b.value, b.meta);
    return listAccounts(ctx).find((a) => a.key === req.params.key);
  });
  r.post('/accounts/:key/test', async (req) => testAccount(ctx, req.params.key!));
  r.delete('/accounts/:key', (req) => {
    removeAccount(ctx, req.params.key!);
    return { ok: true };
  });
  r.post('/accounts/localApi.token/generate', () => ({ token: generateLocalApiToken(ctx) }));

  r.get('/logs', (req) => ({ lines: log.tail(Math.min(2000, Number(req.query.get('lines') ?? 500) || 500)) }));

  for (const install of installers) install(r, ctx);
  return r;
}

export interface ControlServer {
  port: number;
  token: string;
  close(): Promise<void>;
}

export function startControlServer(router: Router, opts: { port?: number; token?: string } = {}): Promise<ControlServer> {
  const token = opts.token ?? crypto.randomBytes(32).toString('base64url');
  const tokenBuf = Buffer.from(token);

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    const cors: Record<string, string> = {};
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      cors['Access-Control-Allow-Origin'] = origin;
      cors['Vary'] = 'Origin';
      cors['Access-Control-Allow-Headers'] = 'Content-Type, X-DCS-Token';
      cors['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
      cors['Access-Control-Max-Age'] = '600';
    } else if (origin) {
      return sendJson(res, 403, { error: 'origin not allowed' });
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    const given = Buffer.from(String(req.headers['x-dcs-token'] ?? ''));
    if (given.length !== tokenBuf.length || !crypto.timingSafeEqual(given, tokenBuf)) {
      return sendJson(res, 401, { error: 'unauthorized' }, cors);
    }
    void dispatch(router, req, res, cors);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        token,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
