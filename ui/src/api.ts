import type { ApiError } from '../../shared/contracts';

interface Endpoint {
  port: number;
  token: string;
}

let endpoint: Endpoint | null = null;
let pending: Promise<Endpoint> | null = null;

const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function discover(): Promise<Endpoint> {
  if (!isTauri()) {
    // Browser dev mode: `npm run dev:worker` with DCS_CONTROL_PORT/DCS_CONTROL_TOKEN set to the same values.
    const port = Number(import.meta.env.VITE_DCS_PORT ?? 47820);
    const token = String(import.meta.env.VITE_DCS_TOKEN ?? 'dev-token');
    return { port, token };
  }
  const { invoke } = await import('@tauri-apps/api/core');
  // The shell starts the worker; poll until it has reported its port (or failed).
  for (let i = 0; i < 300; i++) {
    const ep = await invoke<Endpoint | null>('worker_endpoint');
    if (ep) return ep;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('worker did not start');
}

export function getEndpoint(): Promise<Endpoint> {
  if (endpoint) return Promise.resolve(endpoint);
  pending ??= discover().then((e) => (endpoint = e));
  return pending;
}

export class WorkerError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
  }
}

async function send(method: string, path: string, body: unknown): Promise<Response> {
  const ep = await getEndpoint();
  return fetch(`http://127.0.0.1:${ep.port}${path}`, {
    method,
    headers: { 'X-DCS-Token': ep.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await send(method, path, body);
  } catch {
    // The shell restarts a crashed worker on a new port with a new token: rediscover once.
    endpoint = null;
    pending = null;
    res = await send(method, path, body);
  }
  if (res.status === 401 && isTauri()) {
    endpoint = null;
    pending = null;
    res = await send(method, path, body);
  }
  const data = (await res.json().catch(() => ({}))) as T | ApiError;
  if (!res.ok) {
    const err = data as ApiError;
    throw new WorkerError(res.status, err.error ?? `HTTP ${res.status}`, err.code);
  }
  return data as T;
}

export const get = <T>(p: string) => api<T>('GET', p);
export const post = <T>(p: string, b?: unknown) => api<T>('POST', p, b ?? {});
export const put = <T>(p: string, b: unknown) => api<T>('PUT', p, b);
export const patch = <T>(p: string, b: unknown) => api<T>('PATCH', p, b);
export const del = <T>(p: string) => api<T>('DELETE', p);

/** Calls into the Rust shell; no-ops when running in a plain browser. */
export async function shell<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}
