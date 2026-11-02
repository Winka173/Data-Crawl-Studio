// Types shared by the UI and the worker's internal control API.
// The public read-only HTTP API (docs/API.md) has its own, separately versioned contract.

export type Platform = 'youtube' | 'facebook' | 'instagram';
export const PLATFORMS: Platform[] = ['youtube', 'facebook', 'instagram'];

export type Language = 'vi' | 'en';

/** null = all history */
export type DepthDays = 7 | 30 | 90 | null;
export const DEPTH_OPTIONS: DepthDays[] = [7, 30, 90, null];

export interface PacingSettings {
  minDelayMs: number;
  maxDelayMs: number;
  maxActionsPerHour: number;
  maxActionsPerDay: number;
}

export interface AppSettings {
  language: Language;
  defaultDepthDays: DepthDays;
  youtube: {
    dailyQuota: number;
    /** Units kept free so a Test click or a search still works late in the day. */
    reserveUnits: number;
    /** Posts published within this many days are re-checked for new comments and counts. */
    recheckDays: number;
  };
  pacing: Record<'facebook' | 'instagram', PacingSettings>;
  browserTosAcceptedAt: string | null;
  localApi: { enabled: boolean; port: number };
}

export type AccountStatus = 'not_set' | 'set' | 'verified' | 'expired' | 'blocked';

export type AccountKey =
  | 'youtube.apiKey'
  | 'meta.appId'
  | 'meta.appSecret'
  | 'meta.pageToken'
  | 'meta.igToken'
  | 'browser.facebook'
  | 'browser.instagram'
  | 'localApi.token'
  | 'privacy.salt';

export type AccountKind = 'secret' | 'browserProfile' | 'generatedToken' | 'salt';

export interface AccountEntryView {
  key: AccountKey;
  kind: AccountKind;
  status: AccountStatus;
  /** i18n keys of the features that use this entry */
  features: string[];
  setAt: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  /** Non-secret metadata safe to display (e.g. IG business account id). */
  meta: Record<string, string>;
  canTest: boolean;
}

export interface WorkerHealth {
  ok: true;
  version: string;
  dataDir: string;
  dbPath: string;
  schemaVersion: number;
  startedAt: string;
}

export interface ApiError {
  error: string;
  /** i18n key when the message is user-facing */
  code?: string;
}
