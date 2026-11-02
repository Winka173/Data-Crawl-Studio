import fs from 'node:fs';
import path from 'node:path';

export interface AppPaths {
  dataDir: string;
  dbDir: string;
  dbPath: string;
  backupsDir: string;
  logsDir: string;
  profilesDir: string;
  exportsDir: string;
  browsersDir: string;
  secretsPath: string;
  lockPath: string;
}

/**
 * Everything the app writes lives under one folder:
 * %LOCALAPPDATA%\DataCrawlStudio, or DCS_DATA_DIR (tests and smoke runs use a scratch folder).
 */
export function resolvePaths(dataDir = defaultDataDir()): AppPaths {
  const dbDir = path.join(dataDir, 'db');
  return {
    dataDir,
    dbDir,
    dbPath: path.join(dbDir, 'datacrawl.db'),
    backupsDir: path.join(dataDir, 'backups'),
    logsDir: path.join(dataDir, 'logs'),
    profilesDir: path.join(dataDir, 'profiles'),
    exportsDir: path.join(dataDir, 'exports'),
    // Tests may share one browser download between scratch data folders.
    browsersDir: process.env.DCS_BROWSERS_DIR ? path.resolve(process.env.DCS_BROWSERS_DIR) : path.join(dataDir, 'ms-playwright'),
    secretsPath: path.join(dataDir, 'secrets.json'),
    lockPath: path.join(dataDir, 'worker.lock'),
  };
}

export function defaultDataDir(): string {
  if (process.env.DCS_DATA_DIR) return path.resolve(process.env.DCS_DATA_DIR);
  const base = process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '.', 'AppData', 'Local');
  return path.join(base, 'DataCrawlStudio');
}

export function ensureDirs(p: AppPaths): void {
  for (const dir of [p.dataDir, p.dbDir, p.backupsDir, p.logsDir, p.profilesDir, p.exportsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
