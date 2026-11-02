import path from 'node:path';
import { createContext } from './context';
import { openDatabase } from './db/db';
import { acquireLock } from './lock';
import { log } from './log';
import { ensureDirs, resolvePaths } from './paths';
import { Pacer } from './browser/pacing';
import { BrowserManager } from './browser/session';
import { PlaywrightFbDriver } from './platforms/facebook/driver';
import { setFbDriver } from './platforms/facebook/jobs';
import './platforms/youtube/jobs';
import { QueueRunner } from './queue/runner';
import { SecretStore } from './secrets/store';
import { buildControlRouter, startControlServer } from './server/control';
import { installBrowserRoutes } from './server/browserRoutes';
import { installCrawlRoutes } from './server/routes';

declare const __DCS_VERSION__: string | undefined;
const VERSION = typeof __DCS_VERSION__ === 'string' ? __DCS_VERSION__ : 'dev';

async function main(): Promise<void> {
  const paths = resolvePaths();
  ensureDirs(paths);
  log.init(paths.logsDir);
  const releaseLock = acquireLock(paths.lockPath);

  const { db, fromVersion, toVersion, backupPath } = openDatabase(paths.dbPath, paths.backupsDir);
  log.info('worker starting', { version: VERSION, dataDir: paths.dataDir, fromVersion, toVersion, backupPath });

  const secrets = new SecretStore(paths.secretsPath);
  const ctx = createContext({ version: VERSION, paths, db, secrets });
  ctx.pseudonymizer(); // creates the salt on first run so its status is visible in Accounts & Keys

  const runner = new QueueRunner(ctx);
  const browser = new BrowserManager(ctx);
  const pacer = new Pacer(ctx);
  pacer.prune();
  const fbDriver = new PlaywrightFbDriver(browser, pacer, path.join(ctx.paths.logsDir, 'fb-shapes'));
  setFbDriver(() => fbDriver, () => browser.writeStatus('facebook', { lastCrawlOkAt: new Date().toISOString(), loginWall: false }));

  const server = await startControlServer(buildControlRouter(ctx, [(r) => installCrawlRoutes(r, ctx, runner), (r) => installBrowserRoutes(r, ctx, browser)]), {
    port: process.env.DCS_CONTROL_PORT ? Number(process.env.DCS_CONTROL_PORT) : undefined,
    token: process.env.DCS_CONTROL_TOKEN,
  });
  runner.start();

  let stopping = false;
  const shutdown = async (why: string) => {
    if (stopping) return;
    stopping = true;
    log.info('worker stopping', { why });
    // Running jobs are aborted and re-queued with their cursor; they resume on next start.
    await runner.stop().catch((e) => log.error('queue stop failed', e));
    await browser.closeAll().catch((e) => log.error('browser close failed', e));
    await server.close();
    db.close();
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Launched by the desktop shell: when the shell goes away its end of the stdin pipe closes.
  if (process.env.DCS_PARENT_PIPE === '1') {
    process.stdin.on('end', () => void shutdown('parent closed'));
    process.stdin.on('error', () => void shutdown('parent pipe error'));
    process.stdin.resume();
  }

  // The only line ever written to stdout: the shell parses it to find the control server.
  process.stdout.write(JSON.stringify({ type: 'ready', port: server.port, token: server.token }) + '\n');
  log.info('control server listening', { port: server.port });
}

main().catch((e) => {
  log.error('worker failed to start', e);
  process.stdout.write(JSON.stringify({ type: 'fatal', message: e instanceof Error ? e.message : String(e) }) + '\n');
  process.exit(1);
});
