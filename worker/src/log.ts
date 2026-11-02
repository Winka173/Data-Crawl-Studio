import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_FILES = 5;

// Keys whose values never reach a log line, whatever their content.
const SECRET_KEY = /(token|secret|password|passwd|cookie|authorization|api[-_]?key|access[-_]?key|salt|session)/i;
// Value shapes that look like credentials even under an innocent key.
const SECRET_VALUE: RegExp[] = [
  /AIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /EAA[0-9A-Za-z]{20,}/g, // Meta access tokens
  /IG[A-Z]{2}[0-9A-Za-z]{20,}/g, // Instagram tokens
  /([?&](?:key|access_token|client_secret|token)=)[^&\s"]+/gi,
  /(c_user|xs|sessionid|datr|fr|ds_user_id|csrftoken)=[^;\s"]+/gi,
];

export function redactString(s: string): string {
  let out = s;
  for (const re of SECRET_VALUE) {
    out = out.replace(re, (m, prefix?: string) =>
      typeof prefix === 'string' && m.startsWith(prefix) ? `${prefix}[redacted]` : '[redacted]',
    );
  }
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return redactString(value);
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

class Logger {
  private file: string | null = null;
  private size = 0;
  minLevel: LogLevel = process.env.VITEST ? 'warn' : 'info';

  init(logsDir: string): void {
    fs.mkdirSync(logsDir, { recursive: true });
    this.file = path.join(logsDir, 'worker.log');
    this.size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
  }

  get filePath(): string | null {
    return this.file;
  }

  private rotate(): void {
    if (!this.file) return;
    for (let i = KEEP_FILES - 1; i >= 1; i--) {
      const from = `${this.file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${i + 1}`);
    }
    const oldest = `${this.file}.${KEEP_FILES}`;
    if (fs.existsSync(oldest)) fs.rmSync(oldest);
    fs.renameSync(this.file, `${this.file}.1`);
    this.size = 0;
  }

  write(level: LogLevel, msg: string, data?: unknown): void {
    const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    if (order.indexOf(level) < order.indexOf(this.minLevel)) return;
    const line =
      JSON.stringify({
        t: new Date().toISOString(),
        level,
        msg: redactString(msg),
        ...(data === undefined ? {} : { data: redact(data) }),
      }) + '\n';
    if (!this.file) {
      process.stderr.write(line);
      return;
    }
    if (this.size + line.length > MAX_BYTES) this.rotate();
    fs.appendFileSync(this.file, line);
    this.size += Buffer.byteLength(line);
  }

  debug(msg: string, data?: unknown) { this.write('debug', msg, data); }
  info(msg: string, data?: unknown) { this.write('info', msg, data); }
  warn(msg: string, data?: unknown) { this.write('warn', msg, data); }
  error(msg: string, data?: unknown) { this.write('error', msg, data); }

  /** Last N lines for the Logs page (already redacted when written). */
  tail(lines: number): string[] {
    if (!this.file || !fs.existsSync(this.file)) return [];
    const text = fs.readFileSync(this.file, 'utf8');
    const all = text.split('\n').filter(Boolean);
    return all.slice(-lines);
  }
}

export const log = new Logger();
