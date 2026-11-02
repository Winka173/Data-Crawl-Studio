import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext, type AppContext, type FetchFn } from '../src/context';
import { openDatabase } from '../src/db/db';
import { ensureDirs, resolvePaths } from '../src/paths';
import { SecretStore, type Protector } from '../src/secrets/store';

/** Reversible stand-in for DPAPI so most tests do not depend on the Windows user profile. */
export const fakeProtector: Protector = {
  protect: (b) => Buffer.concat([Buffer.from('FAKE:'), Buffer.from(b).reverse()]),
  unprotect: (b) => Buffer.from(b.subarray(5)).reverse(),
};

export function tempDir(prefix = 'dcs-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeContext(opts: { fetch?: FetchFn; dataDir?: string; protector?: Protector } = {}): AppContext {
  const paths = resolvePaths(opts.dataDir ?? tempDir());
  ensureDirs(paths);
  const { db } = openDatabase(paths.dbPath, paths.backupsDir);
  const secrets = new SecretStore(paths.secretsPath, opts.protector ?? fakeProtector);
  return createContext({ version: 'test', paths, db, secrets, fetch: opts.fetch });
}

/** Minimal fetch double: routes by substring of the URL, records calls. */
export function fakeFetch(routes: Array<[string | RegExp, (url: string, init?: RequestInit) => unknown | Response]>) {
  const calls: string[] = [];
  const fn: FetchFn = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    for (const [m, h] of routes) {
      if (typeof m === 'string' ? url.includes(m) : m.test(url)) {
        const out = await h(url, init);
        if (out instanceof Response) return out;
        return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response(JSON.stringify({ error: { message: 'no route', errors: [{ reason: 'notFound' }] } }), { status: 404 });
  };
  return { fn, calls };
}
