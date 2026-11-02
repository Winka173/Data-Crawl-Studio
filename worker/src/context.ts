import type { AppSettings } from '../../shared/contracts';
import type { DB } from './db/db';
import type { AppPaths } from './paths';
import { YoutubeQuota } from './platforms/youtube/quota';
import { Pseudonymizer, SALT_KEY } from './privacy/pseudonym';
import type { SecretStore } from './secrets/store';
import { getSettings } from './settings';

export type FetchFn = typeof fetch;

export interface AppContext {
  version: string;
  startedAt: string;
  paths: AppPaths;
  db: DB;
  secrets: SecretStore;
  settings(): AppSettings;
  quota: YoutubeQuota;
  pseudonymizer(): Pseudonymizer;
  fetch: FetchFn;
}

export function createContext(opts: {
  version: string;
  paths: AppPaths;
  db: DB;
  secrets: SecretStore;
  fetch?: FetchFn;
}): AppContext {
  let pseudo: Pseudonymizer | null = null;
  const ctx: AppContext = {
    version: opts.version,
    startedAt: new Date().toISOString(),
    paths: opts.paths,
    db: opts.db,
    secrets: opts.secrets,
    settings: () => getSettings(opts.db),
    quota: new YoutubeQuota(opts.db, () => {
      const s = getSettings(opts.db).youtube;
      return { daily: s.dailyQuota, reserve: s.reserveUnits };
    }),
    // Rebuilt if the salt was removed in Accounts & Keys (a new salt is generated on next use).
    pseudonymizer: () => {
      if (!pseudo || !opts.secrets.has(SALT_KEY)) pseudo = Pseudonymizer.fromStore(opts.secrets, opts.db);
      return pseudo;
    },
    fetch: opts.fetch ?? fetch,
  };
  return ctx;
}
