import { useCallback, useEffect, useState } from 'react';
import type { AccountEntryView } from '../../../shared/contracts';
import { del, get, post, put } from '../api';
import { Card, CopyButton, ErrorText, StatusBadge } from '../components';
import { formatTime, useI18n } from '../i18n';
import { BrowserCard, BrowserNotice, useBrowserNotice } from './BrowserCard';

export function AccountsPanel() {
  const { t } = useI18n();
  const [entries, setEntries] = useState<AccountEntryView[]>([]);
  const load = useCallback(() => void get<AccountEntryView[]>('/accounts').then(setEntries), []);
  useEffect(load, [load]);
  const notice = useBrowserNotice();

  return (
    <div>
      <p className="muted">{t('acc.intro')}</p>
      {notice.loaded && !notice.accepted && <BrowserNotice onAccepted={() => (notice.reload(), load())} />}
      <div className="stack">
        {entries.map((e) =>
          e.kind === 'browserProfile' ? <BrowserCard key={e.key} entry={e} reload={load} /> : <AccountCard key={e.key} entry={e} reload={load} />,
        )}
      </div>
    </div>
  );
}

function AccountCard({ entry, reload }: { entry: AccountEntryView; reload(): void }) {
  const { t, lang } = useI18n();
  const name = t(`acc.key.${entry.key}`);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [meta, setMeta] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run('save', async () => {
      await put(`/accounts/${entry.key}`, { value, meta });
      setValue('');
      setEditing(false);
    });

  const test = () =>
    run('test', async () => {
      const r = await post<{ status: string; message?: string }>(`/accounts/${entry.key}/test`);
      setTestMsg(r.message ?? null);
    });

  const remove = () =>
    run('remove', async () => {
      await del(`/accounts/${entry.key}`);
      setConfirming(false);
      setConfirmText('');
      setFreshToken(null);
    });

  const generate = () =>
    run('generate', async () => {
      const r = await post<{ token: string }>('/accounts/localApi.token/generate');
      setFreshToken(r.token);
    });

  const isSecret = entry.kind === 'secret';
  const showInput = isSecret && (entry.status === 'not_set' || editing);
  const isSalt = entry.kind === 'salt';
  const confirmOk = !isSalt || confirmText.trim() === 'RESET';

  return (
    <Card
      id={`acc-${entry.key}`}
      title={
        <>
          {name} <StatusBadge status={entry.status} />
        </>
      }
    >
      <div className="acc-features">
        <span className="muted">{t('acc.usedBy')}:</span>{' '}
        {entry.features.map((f) => (
          <span key={f} className="chip">
            {t(f)}
          </span>
        ))}
      </div>

      {isSalt && <p className="muted small">{t('acc.saltInfo')}</p>}

      {entry.status !== 'not_set' && (
        <dl className="kv small">
          {entry.setAt && (
            <>
              <dt>{t('acc.setAt')}</dt>
              <dd>{formatTime(entry.setAt, lang)}</dd>
            </>
          )}
          <dt>{t('acc.verifiedAt')}</dt>
          <dd>{entry.verifiedAt ? formatTime(entry.verifiedAt, lang) : t('common.never')}</dd>
          {entry.lastError && (
            <>
              <dt>{t('acc.lastError')}</dt>
              <dd className="error">{entry.lastError}</dd>
            </>
          )}
          {Object.entries(entry.meta)
            .filter(([k]) => k !== 'check')
            .map(([k, v]) => (
              <span key={k} style={{ display: 'contents' }}>
                <dt>{t(`acc.meta.${k}`)}</dt>
                <dd>{v}</dd>
              </span>
            ))}
        </dl>
      )}

      {showInput && (
        <div className="acc-input">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('acc.enterValue')}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={name}
          />
          {entry.key === 'meta.igToken' && (
            <input
              type="text"
              placeholder={t('acc.meta.igBusinessAccountId')}
              value={meta.igBusinessAccountId ?? ''}
              onChange={(e) => setMeta({ ...meta, igBusinessAccountId: e.target.value })}
            />
          )}
          <button className="btn primary" disabled={!value.trim() || !!busy} onClick={() => void save()}>
            {t('common.save')}
          </button>
          {editing && (
            <button className="btn" onClick={() => setEditing(false)}>
              {t('common.cancel')}
            </button>
          )}
        </div>
      )}

      {freshToken && (
        <div className="token-once">
          <p>{t('acc.tokenOnce')}</p>
          <code>{freshToken}</code>
          <CopyButton text={freshToken} />
        </div>
      )}

      <div className="row-actions">
        {entry.kind === 'generatedToken' && (
          <button className="btn primary" disabled={!!busy} onClick={() => void generate()}>
            {entry.status === 'not_set' ? t('acc.generate') : t('acc.regenerate')}
          </button>
        )}
        {entry.kind !== 'browserProfile' && (
          <button className="btn" disabled={!entry.canTest || !!busy} onClick={() => void test()}>
            {busy === 'test' ? t('common.testing') : t('common.test')}
          </button>
        )}
        {isSecret && entry.status !== 'not_set' && !editing && (
          <button className="btn" onClick={() => setEditing(true)}>
            {t('acc.replace')}
          </button>
        )}
        {entry.kind !== 'browserProfile' && entry.status !== 'not_set' && !confirming && (
          <button className="btn danger" onClick={() => setConfirming(true)}>
            {t('common.remove')}
          </button>
        )}
      </div>

      {confirming && (
        <div className="confirm">
          <p>{isSalt ? t('acc.saltRemoveConfirm') : t('acc.removeConfirm', { name })}</p>
          {isSalt && <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="RESET" />}
          <button className="btn danger" disabled={!confirmOk || !!busy} onClick={() => void remove()}>
            {t('common.confirm')}
          </button>
          <button className="btn" onClick={() => setConfirming(false)}>
            {t('common.cancel')}
          </button>
        </div>
      )}

      {testMsg && <p className="muted small">{testMsg}</p>}
      <ErrorText error={error} />
    </Card>
  );
}
