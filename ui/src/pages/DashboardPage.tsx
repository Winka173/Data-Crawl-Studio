import { useEffect, useState } from 'react';
import type { AccountEntryView, WorkerHealth } from '../../../shared/contracts';
import { get } from '../api';
import type { PageId } from '../App';
import { Card, StatusBadge } from '../components';
import { formatTime, useI18n } from '../i18n';

export function DashboardPage({ go }: { go(p: PageId): void }) {
  const { t, lang } = useI18n();
  const [health, setHealth] = useState<WorkerHealth | null>(null);
  const [accounts, setAccounts] = useState<AccountEntryView[]>([]);

  useEffect(() => {
    void get<WorkerHealth>('/health').then(setHealth);
    void get<AccountEntryView[]>('/accounts').then(setAccounts);
  }, []);

  return (
    <section>
      <h1>{t('nav.dashboard')}</h1>
      <div className="grid-2">
        <Card title={t('dash.worker')}>
          {health ? (
            <dl className="kv">
              <dt>{t('dash.version')}</dt>
              <dd>{health.version}</dd>
              <dt>{t('dash.schema')}</dt>
              <dd data-testid="schema-version">v{health.schemaVersion}</dd>
              <dt>{t('dash.started')}</dt>
              <dd>{formatTime(health.startedAt, lang)}</dd>
              <dt>{t('dash.db')}</dt>
              <dd className="path">{health.dbPath}</dd>
            </dl>
          ) : (
            <p className="muted">{t('common.loading')}</p>
          )}
        </Card>
        <Card title={t('dash.accounts')} actions={<button className="btn" onClick={() => go('settings')}>{t('nav.settings')}</button>}>
          <ul className="status-list">
            {accounts.map((a) => (
              <li key={a.key}>
                <span>{t(`acc.key.${a.key}`)}</span>
                <StatusBadge status={a.status} />
              </li>
            ))}
          </ul>
          <p className="muted small">{t('dash.accountsHint')}</p>
        </Card>
      </div>
    </section>
  );
}
