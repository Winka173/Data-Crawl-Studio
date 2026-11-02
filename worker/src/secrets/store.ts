import fs from 'node:fs';
import type { AccountStatus } from '../../../shared/contracts';
import { nowIso } from '../util/time';
import { dpapiProtect, dpapiUnprotect } from './dpapi';

// Secrets live in <dataDir>\secrets.json, outside the SQLite file that is handed to the analytics app.
// Each value is a DPAPI (CurrentUser) blob; the plaintext never touches disk and is never returned to the UI.

export interface SecretRecord {
  blob: string; // base64 DPAPI blob
  setAt: string;
  status: AccountStatus;
  verifiedAt: string | null;
  lastError: string | null;
  meta: Record<string, string>;
}

interface FileShape {
  version: 1;
  entries: Record<string, SecretRecord>;
}

export interface Protector {
  protect(plain: Buffer): Buffer;
  unprotect(blob: Buffer): Buffer;
}

export const dpapi: Protector = { protect: dpapiProtect, unprotect: dpapiUnprotect };

export class SecretStore {
  private data: FileShape;
  private cache = new Map<string, string>();

  constructor(private readonly file: string, private readonly protector: Protector = dpapi) {
    this.data = fs.existsSync(file)
      ? (JSON.parse(fs.readFileSync(file, 'utf8')) as FileShape)
      : { version: 1, entries: {} };
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  has(key: string): boolean {
    return key in this.data.entries;
  }

  record(key: string): Omit<SecretRecord, 'blob'> | null {
    const r = this.data.entries[key];
    if (!r) return null;
    const { blob: _blob, ...rest } = r;
    return rest;
  }

  set(key: string, value: string | Buffer, meta: Record<string, string> = {}): void {
    const plain = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    const blob = this.protector.protect(plain).toString('base64');
    this.data.entries[key] = { blob, setAt: nowIso(), status: 'set', verifiedAt: null, lastError: null, meta };
    this.cache.delete(key);
    this.persist();
  }

  /** Plaintext for internal use only (API calls). Never send it to the UI or a log. */
  get(key: string): string | null {
    const buf = this.getBuffer(key);
    return buf ? buf.toString('utf8') : null;
  }

  getBuffer(key: string): Buffer | null {
    const r = this.data.entries[key];
    if (!r) return null;
    const cached = this.cache.get(key);
    if (cached !== undefined) return Buffer.from(cached, 'base64');
    const plain = this.protector.unprotect(Buffer.from(r.blob, 'base64'));
    this.cache.set(key, plain.toString('base64'));
    return plain;
  }

  setStatus(key: string, status: AccountStatus, lastError: string | null = null): void {
    const r = this.data.entries[key];
    if (!r) return;
    r.status = status;
    r.lastError = lastError;
    if (status === 'verified') r.verifiedAt = nowIso();
    this.persist();
  }

  setMeta(key: string, meta: Record<string, string>): void {
    const r = this.data.entries[key];
    if (!r) return;
    r.meta = { ...r.meta, ...meta };
    this.persist();
  }

  remove(key: string): void {
    delete this.data.entries[key];
    this.cache.delete(key);
    this.persist();
  }
}
