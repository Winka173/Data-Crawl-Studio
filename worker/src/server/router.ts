import type http from 'node:http';
import { z } from 'zod';
import { HttpError } from '../accounts';
import { log } from '../log';

export interface Req {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  raw: http.IncomingMessage;
}

export type Handler = (req: Req) => unknown | Promise<unknown>;

/** A handler may return this to stream a non-JSON body (exports, CSV). */
export class RawResponse {
  constructor(
    public readonly body: string | Buffer | NodeJS.ReadableStream,
    public readonly contentType: string,
    public readonly headers: Record<string, string> = {},
  ) {}
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  on(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' +
        path.replace(/\/:([a-zA-Z_]+)/g, (_m, k: string) => {
          keys.push(k);
          return '/([^/]+)';
        }) +
        '$',
    );
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  get(p: string, h: Handler) { return this.on('GET', p, h); }
  post(p: string, h: Handler) { return this.on('POST', p, h); }
  put(p: string, h: Handler) { return this.on('PUT', p, h); }
  patch(p: string, h: Handler) { return this.on('PATCH', p, h); }
  delete(p: string, h: Handler) { return this.on('DELETE', p, h); }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      return { handler: r.handler, params };
    }
    return null;
  }
}

const MAX_BODY = 2 * 1024 * 1024;

export async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(text);
}

export function sendError(res: http.ServerResponse, e: unknown, extra: Record<string, string> = {}): void {
  if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, code: e.code }, extra);
  if (e instanceof z.ZodError) {
    return sendJson(res, 400, { error: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), code: 'err.invalid' }, extra);
  }
  log.error('request failed', e);
  sendJson(res, 500, { error: 'internal error' }, extra);
}

export async function dispatch(
  router: Router,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  extraHeaders: Record<string, string>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const m = router.match(req.method ?? 'GET', url.pathname);
  if (!m) return sendJson(res, 404, { error: 'not found' }, extraHeaders);
  try {
    const body = await readJsonBody(req);
    const out = await m.handler({ method: req.method ?? 'GET', path: url.pathname, params: m.params, query: url.searchParams, body, raw: req });
    if (out instanceof RawResponse) {
      res.writeHead(200, { 'Content-Type': out.contentType, 'Cache-Control': 'no-store', ...extraHeaders, ...out.headers });
      if (typeof out.body === 'string' || Buffer.isBuffer(out.body)) res.end(out.body);
      else out.body.pipe(res);
      return;
    }
    sendJson(res, 200, out ?? { ok: true }, extraHeaders);
  } catch (e) {
    sendError(res, e, extraHeaders);
  }
}
