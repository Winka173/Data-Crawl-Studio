// How a job failure is handled is decided by its class, not by string matching at the call site.

/** Network blips, 5xx, rate-limit responses: retried with backoff up to max_attempts. */
export class TransientError extends Error {
  readonly kind = 'transient';
  constructor(message: string, public readonly code?: string, public readonly retryAfterMs?: number) {
    super(message);
  }
}

/** The target no longer exists or is private: no retry; the post/source is marked unavailable. */
export class NotFoundError extends Error {
  readonly kind = 'permanent';
  constructor(message: string, public readonly code = 'not_found') {
    super(message);
  }
}

/** Bad request / unsupported input: no retry. */
export class PermanentError extends Error {
  readonly kind = 'permanent';
  constructor(message: string, public readonly code?: string) {
    super(message);
  }
}

/** Key missing, invalid, expired or API disabled: the platform waits for the owner (Accounts & Keys). */
export class AuthError extends Error {
  readonly kind = 'auth';
  constructor(message: string, public readonly code: string, public readonly accountKey?: string) {
    super(message);
  }
}

/**
 * Checkpoint, CAPTCHA, login wall, "temporarily blocked", rate-limit warning in the browser.
 * The whole platform stops at once and every active job of it becomes Paused (Needs user).
 */
export class BlockedError extends Error {
  readonly kind = 'block';
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

/** Extraction no longer matches the page layout: source flagged "Parser needs update", nothing stored. */
export class ParserError extends Error {
  readonly kind = 'parser';
  constructor(message: string, public readonly code = 'parser_mismatch', public readonly detail?: unknown) {
    super(message);
  }
}

/** Daily API quota reached: job waits until the reset time; attempts are not consumed. */
export class QuotaWaitError extends Error {
  readonly kind = 'quota';
  constructor(public readonly resumeAt: string) {
    super('API quota reached');
  }
}

/** Pacing cap (per-hour/per-day) reached: job waits; not an error from the platform. */
export class PacingWaitError extends Error {
  readonly kind = 'pacing';
  constructor(public readonly resumeAt: string) {
    super('pacing cap reached');
  }
}
