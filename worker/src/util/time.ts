export function nowIso(): string {
  return new Date().toISOString();
}

/** Normalise any parseable timestamp to UTC ISO-8601 with milliseconds, or null. */
export function toUtcIso(value: string | number | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const d = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

export function daysAgoIso(days: number, from = new Date()): string {
  return new Date(from.getTime() - days * 86_400_000).toISOString();
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
