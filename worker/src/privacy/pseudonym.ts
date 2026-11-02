import crypto from 'node:crypto';
import type { Platform } from '../../../shared/contracts';
import type { DB } from '../db/db';
import type { SecretStore } from '../secrets/store';
import { nowIso } from '../util/time';

export const SALT_KEY = 'privacy.salt';
const CHECK_INPUT = 'dcs-salt-check';

/**
 * Pseudonym = "u_" + first 16 hex chars of HMAC-SHA256(salt, "<platform>:<platform user id>").
 * The salt is random, DPAPI-protected, stored only in secrets.json and never exported,
 * so a pseudonym cannot be reversed or matched against another install.
 */
export class Pseudonymizer {
  private salt: Buffer;
  private seen = new Set<string>();

  constructor(salt: Buffer, private readonly db?: DB) {
    if (salt.length < 32) throw new Error('salt too short');
    this.salt = salt;
  }

  static fromStore(store: SecretStore, db?: DB): Pseudonymizer {
    let salt = store.getBuffer(SALT_KEY);
    if (!salt) {
      salt = crypto.randomBytes(32);
      store.set(SALT_KEY, salt);
      store.setMeta(SALT_KEY, { check: checkValue(salt) });
    }
    return new Pseudonymizer(salt, db);
  }

  of(platform: Platform | string, userId: string): string {
    const h = crypto.createHmac('sha256', this.salt).update(`${platform}:${userId}`).digest('hex');
    const p = `u_${h.slice(0, 16)}`;
    this.register(p, platform);
    return p;
  }

  private register(pseudonym: string, platform: string): void {
    if (!this.db || this.seen.has(pseudonym)) return;
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO pseudonyms (pseudonym, platform, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(pseudonym) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .run(pseudonym, platform, now, now);
    this.seen.add(pseudonym);
  }
}

/** Short fingerprint of the salt, stored as non-secret metadata so a changed/lost salt is detectable. */
export function checkValue(salt: Buffer): string {
  return crypto.createHmac('sha256', salt).update(CHECK_INPUT).digest('hex').slice(0, 12);
}

export interface MentionContext {
  platform: Platform;
  /** handle (without @, lower-case) -> platform user id, for authors seen in the same thread */
  knownHandles?: Map<string, string>;
  /** lower-case handles of public entities, which keep their name */
  publicHandles?: Set<string>;
}

const PSEUDONYM = /^u_[0-9a-f]{16}$/;

// @handle: letters, digits, dot, underscore, hyphen (YouTube/Instagram handle alphabet), at a word start.
const MENTION = /(^|[^\w@.])@([\p{L}\p{N}_][\p{L}\p{N}._-]{0,99})/gu;

/**
 * Replace @mentions of individuals with their pseudonym.
 * When the handle belongs to an author seen in the thread, the pseudonym matches that author's
 * pseudonym; otherwise it is derived from the handle itself (namespace "<platform>-handle").
 */
export function pseudonymizeMentions(text: string, ctx: MentionContext, p: Pseudonymizer): string {
  return text.replace(MENTION, (_m, lead: string, handle: string) => {
    const trimmed = handle.replace(/[._-]+$/, '');
    const trail = handle.slice(trimmed.length);
    const key = trimmed.toLowerCase();
    if (ctx.publicHandles?.has(key) || PSEUDONYM.test(trimmed)) return `${lead}@${trimmed}${trail}`;
    const userId = ctx.knownHandles?.get(key);
    const pseudo = userId ? p.of(ctx.platform, userId) : p.of(`${ctx.platform}-handle`, key);
    return `${lead}@${pseudo}${trail}`;
  });
}
