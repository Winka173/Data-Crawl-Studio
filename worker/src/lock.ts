import fs from 'node:fs';

/** One worker per data folder: two workers on the same queue would double-crawl and fight over the DB. */
export function acquireLock(lockPath: string): () => void {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const pid = Number(fs.readFileSync(lockPath, 'utf8').trim());
    if (pid && pid !== process.pid && isAlive(pid)) {
      throw new Error(`another worker (pid ${pid}) is already using this data folder`);
    }
    fs.writeFileSync(lockPath, String(process.pid));
  }
  return () => {
    try {
      if (fs.readFileSync(lockPath, 'utf8').trim() === String(process.pid)) fs.rmSync(lockPath);
    } catch {
      /* already gone */
    }
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
