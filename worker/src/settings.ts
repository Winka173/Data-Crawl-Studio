import { z } from 'zod';
import type { AppSettings } from '../../shared/contracts';
import { MAX_DEPTH_DAYS } from '../../shared/contracts';
import type { DB } from './db/db';
import { nowIso } from './util/time';

const pacing = z.object({
  minDelayMs: z.number().int().min(1000).max(600_000),
  maxDelayMs: z.number().int().min(1000).max(600_000),
  maxActionsPerHour: z.number().int().min(1).max(2000),
  maxActionsPerDay: z.number().int().min(1).max(20_000),
}).refine((p) => p.maxDelayMs >= p.minDelayMs, { message: 'maxDelayMs must be >= minDelayMs' });

export const settingsSchema = z.object({
  language: z.enum(['vi', 'en']),
  defaultDepthDays: z.number().int().min(1).max(MAX_DEPTH_DAYS).nullable(),
  youtube: z.object({
    dailyQuota: z.number().int().min(100).max(10_000_000),
    reserveUnits: z.number().int().min(0).max(100_000),
    recheckDays: z.number().int().min(0).max(365),
  }),
  pacing: z.object({ facebook: pacing, instagram: pacing }),
  browserTosAcceptedAt: z.string().nullable(),
  localApi: z.object({ enabled: z.boolean(), port: z.number().int().min(1024).max(65535) }),
});

// Conservative defaults: a person reading a group does not open more than a few pages a minute.
export const DEFAULT_SETTINGS: AppSettings = {
  language: 'vi',
  defaultDepthDays: 30,
  youtube: { dailyQuota: 10_000, reserveUnits: 300, recheckDays: 14 },
  pacing: {
    facebook: { minDelayMs: 4_000, maxDelayMs: 12_000, maxActionsPerHour: 120, maxActionsPerDay: 800 },
    instagram: { minDelayMs: 5_000, maxDelayMs: 15_000, maxActionsPerHour: 90, maxActionsPerDay: 600 },
  },
  browserTosAcceptedAt: null,
  localApi: { enabled: false, port: 47821 },
};

const KEY = 'app';

export function getSettings(db: DB): AppSettings {
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(KEY) as
    | { value_json: string }
    | undefined;
  if (!row) return structuredClone(DEFAULT_SETTINGS);
  const merged = deepMerge(structuredClone(DEFAULT_SETTINGS), JSON.parse(row.value_json));
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? (parsed.data as AppSettings) : structuredClone(DEFAULT_SETTINGS);
}

/** Merge a partial update into the stored settings, validate, persist. Throws on invalid input. */
export function updateSettings(db: DB, patch: unknown): AppSettings {
  const next = deepMerge(getSettings(db), patch);
  const parsed = settingsSchema.parse(next) as AppSettings;
  db.prepare(
    `INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(KEY, JSON.stringify(parsed), nowIso());
  return parsed;
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object'
        ? deepMerge(cur, v)
        : v;
  }
  return out as T;
}
