import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Language } from '../../../shared/contracts';
import { en, type MessageKey } from './en';
import { vi } from './vi';

const DICTS: Record<Language, Record<MessageKey, string>> = { en, vi };

export type TFn = (key: MessageKey | string, vars?: Record<string, string | number>) => string;

interface I18n {
  lang: Language;
  setLang(l: Language): void;
  t: TFn;
}

const Ctx = createContext<I18n | null>(null);

export function translate(lang: Language, key: string, vars?: Record<string, string | number>): string {
  const dict = DICTS[lang] as Record<string, string>;
  let s = dict[key] ?? (en as Record<string, string>)[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

export function I18nProvider({ initial, children }: { initial: Language; children: ReactNode }) {
  const [lang, setLang] = useState<Language>(initial);
  const t = useCallback<TFn>((key, vars) => translate(lang, key, vars), [lang]);
  const value = useMemo(() => ({ lang, setLang, t }), [lang, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n outside provider');
  return v;
}

export function formatTime(iso: string | null, lang: Language): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
