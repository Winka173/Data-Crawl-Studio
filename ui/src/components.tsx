import { useState, type ReactNode } from 'react';
import type { AccountStatus } from '../../shared/contracts';
import { useI18n } from './i18n';

export function StatusBadge({ status }: { status: AccountStatus | string }) {
  const { t } = useI18n();
  return <span className={`badge badge-${status}`}>{t(`status.${status}`)}</span>;
}

export function Card({ title, actions, children, id }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <div className="card" id={id}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h3>{title}</h3>}
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

export function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn"
      onClick={() => {
        void copyText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? t('common.copied') : t('common.copy')}
    </button>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  const { t } = useI18n();
  if (!error) return null;
  const e = error as { code?: string; message?: string };
  return <p className="error">{e.code ? t(e.code) : (e.message ?? String(error))}</p>;
}
