import { useState } from 'react';
import type { AccountEntryView } from '../../../shared/contracts';
import { post } from '../api';
import { Card, ErrorText, StatusBadge } from '../components';
import { usePoll } from '../hooks';
import { formatTime, useI18n } from '../i18n';

interface BrowserStatus {
  noticeAcceptedAt: string | null;
  chromiumInstalled: boolean;
  install: { state: 'idle' | 'installing' | 'done' | 'failed'; message?: string };
  platforms: { platform: 'facebook' | 'instagram'; open: boolean; loggedIn: boolean; checkedAt: string | null; lastCrawlOkAt: string | null }[];
}

/** First-run notice: browser collection stays disabled until the owner accepts it. */
export function BrowserNotice({ onAccepted }: { onAccepted(): void }) {
  const { t } = useI18n();
  return (
    <div className="notice" role="alert" data-testid="browser-notice">
      <h3>{t('browser.noticeTitle')}</h3>
      <p>{t('browser.noticeBody1')}</p>
      <p>{t('browser.noticeBody2')}</p>
      <button className="btn primary" onClick={() => void post('/browser/notice/accept').then(onAccepted)} data-testid="accept-notice">
        {t('browser.noticeAccept')}
      </button>
    </div>
  );
}

export function BrowserCard({ entry, reload }: { entry: AccountEntryView; reload(): void }) {
  const { t, lang } = useI18n();
  const platform = entry.key === 'browser.instagram' ? 'instagram' : 'facebook';
  const { data: st, reload: reloadStatus } = usePoll<BrowserStatus>('/browser/status', 2000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const plat = st?.platforms.find((p) => p.platform === platform);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
      reload();
      reloadStatus();
    }
  };

  return (
    <Card id={`acc-${entry.key}`} title={<>{t(`acc.key.${entry.key}`)} <StatusBadge status={entry.status} /></>}>
      <div className="acc-features">
        <span className="muted">{t('acc.usedBy')}:</span>{' '}
        {entry.features.map((f) => <span key={f} className="chip">{t(f)}</span>)}
      </div>
      {st && !st.noticeAcceptedAt ? (
        <p className="muted small">{t('browser.acceptFirst')}</p>
      ) : (
        <>
          <p className="muted small">{t('browser.loginHelp')}</p>
          <dl className="kv small">
            <dt>{t('browser.window')}</dt>
            <dd>{plat?.open ? t('browser.open') : t('browser.closed')}</dd>
            <dt>{t('browser.checked')}</dt>
            <dd>{formatTime(plat?.checkedAt ?? null, lang)}</dd>
            <dt>{t('acc.verifiedAt')}</dt>
            <dd>{entry.verifiedAt ? formatTime(entry.verifiedAt, lang) : t('common.never')}</dd>
            {entry.lastError && (
              <>
                <dt>{t('acc.lastError')}</dt>
                <dd className="error">{entry.lastError}</dd>
              </>
            )}
          </dl>
          {st?.install.state === 'installing' && <p className="small" data-testid="chromium-installing">{t('browser.installing')}</p>}
          {st?.install.state === 'failed' && <p className="error small">{t('browser.installFailed')}: {st.install.message}</p>}
          <div className="row-actions">
            <button className="btn primary" disabled={!!busy || st?.install.state === 'installing'} onClick={() => void run('login', () => post(`/browser/${platform}/login`))}>
              {t('acc.openLogin')}
            </button>
            <button className="btn" disabled={!!busy} onClick={() => void run('check', async () => {
              const r = await post<{ loggedIn: boolean }>(`/browser/${platform}/check`);
              setMsg(r.loggedIn ? t('browser.loggedIn') : t('browser.notLoggedIn'));
            })}>
              {busy === 'check' ? t('common.testing') : t('common.test')}
            </button>
            {plat?.open && (
              <button className="btn" disabled={!!busy} onClick={() => void run('close', () => post(`/browser/${platform}/close`))}>
                {t('browser.closeWindow')}
              </button>
            )}
            {!confirming && (
              <button className="btn danger" onClick={() => setConfirming(true)}>{t('acc.resetProfile')}</button>
            )}
          </div>
          {confirming && (
            <div className="confirm">
              <p>{t('browser.resetConfirm')}</p>
              <button className="btn danger" onClick={() => void run('reset', () => post(`/browser/${platform}/reset`)).then(() => setConfirming(false))}>{t('common.confirm')}</button>
              <button className="btn" onClick={() => setConfirming(false)}>{t('common.cancel')}</button>
            </div>
          )}
        </>
      )}
      {msg && <p className="small">{msg}</p>}
      <ErrorText error={error} />
    </Card>
  );
}

export function useBrowserNotice() {
  const { data, reload } = usePoll<BrowserStatus>('/browser/status', 0);
  return { accepted: !!data?.noticeAcceptedAt, loaded: !!data, reload };
}
