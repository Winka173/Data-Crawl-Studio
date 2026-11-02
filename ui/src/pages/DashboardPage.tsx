import type { AccountEntryView, StatusView, WorkerHealth } from '../../../shared/contracts';
import type { PageId } from '../App';
import { Card, StatusBadge } from '../components';
import { fmtNum, usePoll } from '../hooks';
import { formatTime, useI18n } from '../i18n';
import { PlatformControls } from './QueuePage';

export function DashboardPage({ go }: { go(p: PageId): void }) {
  const { t, lang } = useI18n();
  const { data: health } = usePoll<WorkerHealth>('/health', 0);
  const { data: accounts } = usePoll<AccountEntryView[]>('/accounts', 10_000);
  const { data: status, reload } = usePoll<StatusView>('/status', 2000);
  const quota = status?.quota;
  const pct = quota ? Math.min(100, Math.round((quota.used / quota.limit) * 100)) : 0;

  return (
    <section>
      <h1>{t('nav.dashboard')}</h1>

      {status?.platforms.some((p) => p.needsUser) && (
        <div className="alert" role="alert" data-testid="needs-user-alert">
          {status.platforms
            .filter((p) => p.needsUser)
            .map((p) => (
              <div key={p.platform}>
                <b>{p.platform}</b>: {t('dash.needsUser')} — {p.reason}
                {p.detail ? <span className="muted small"> ({p.detail})</span> : null}
              </div>
            ))}
        </div>
      )}

      <PlatformControls status={status} reload={reload} />

      <div className="grid-2">
        <Card title={t('dash.running')}>
          {status?.running.length ? (
            <ul className="plain">
              {status.running.map((j) => (
                <li key={j.id}>
                  <span className={`plat plat-${j.platform}`}>{j.platform}</span> <code>{j.type}</code> {j.source_name ?? ''}{' '}
                  {j.target && <code className="muted">{j.target}</code>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t('dash.none')}</p>
          )}
        </Card>

        <Card title={t('dash.quota')}>
          {quota && (
            <>
              <div className="meter" aria-label={t('dash.quota')}>
                <div className={`meter-fill${quota.exhausted ? ' full' : ''}`} style={{ width: `${pct}%` }} />
              </div>
              <p data-testid="quota-text">{t('dash.quotaUsed', { used: fmtNum(quota.used), limit: fmtNum(quota.limit), remaining: fmtNum(quota.remaining) })}</p>
              <p className="muted small">{t('dash.quotaResets', { time: formatTime(quota.resetsAt, lang) })}</p>
              {quota.exhausted && <p className="error small">{t('dash.quotaExhausted')}</p>}
            </>
          )}
        </Card>

        <Card title={t('dash.totals')}>
          {status && (
            <div className="totals" data-testid="totals">
              <div><b>{fmtNum(status.totals.sources)}</b> {t('dash.sources')}</div>
              <div><b>{fmtNum(status.totals.posts)}</b> {t('dash.posts')}</div>
              <div><b>{fmtNum(status.totals.comments)}</b> {t('dash.comments')}</div>
              <div><b>{fmtNum(status.totals.pseudonyms)}</b> {t('dash.pseudonyms')}</div>
            </div>
          )}
        </Card>

        <Card title={t('dash.accounts')} actions={<button className="btn" onClick={() => go('settings')}>{t('nav.settings')}</button>}>
          <ul className="status-list">
            {accounts?.map((a) => (
              <li key={a.key}>
                <span>{t(`acc.key.${a.key}`)}</span>
                <StatusBadge status={a.status} />
              </li>
            ))}
          </ul>
        </Card>

        <Card title={t('dash.errors')}>
          {status?.recentErrors.length ? (
            <ul className="plain small">
              {status.recentErrors.slice(0, 8).map((e, i) => (
                <li key={i}>
                  <span className="muted">{formatTime(e.occurred_at, lang)}</span> <b>{e.platform}</b> {e.kind}
                  {e.code ? ` (${e.code})` : ''}: {e.message}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">—</p>
          )}
        </Card>

        <Card title={t('dash.worker')}>
          {health && (
            <dl className="kv small">
              <dt>{t('dash.version')}</dt>
              <dd>{health.version}</dd>
              <dt>{t('dash.schema')}</dt>
              <dd data-testid="schema-version">v{health.schemaVersion}</dd>
              <dt>{t('dash.started')}</dt>
              <dd>{formatTime(health.startedAt, lang)}</dd>
              <dt>{t('dash.db')}</dt>
              <dd className="path">{health.dbPath}</dd>
            </dl>
          )}
        </Card>
      </div>
    </section>
  );
}
