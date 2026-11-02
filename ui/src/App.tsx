import { useEffect, useState } from 'react';
import type { AppSettings, Language } from '../../shared/contracts';
import { get, put } from './api';
import { I18nProvider, useI18n } from './i18n';
import type { MessageKey } from './i18n/en';
import { DashboardPage } from './pages/DashboardPage';
import { DataPage } from './pages/DataPage';
import { LogsPage } from './pages/LogsPage';
import { ExportsPage } from './pages/ExportsPage';
import { Placeholder } from './pages/Placeholder';
import { QueuePage } from './pages/QueuePage';
import { SettingsPage } from './pages/SettingsPage';
import { SourcesPage } from './pages/SourcesPage';

export type PageId = 'dashboard' | 'sources' | 'search' | 'queue' | 'data' | 'exports' | 'localApi' | 'settings' | 'logs';

const NAV: { id: PageId; label: MessageKey }[] = [
  { id: 'dashboard', label: 'nav.dashboard' },
  { id: 'sources', label: 'nav.sources' },
  { id: 'search', label: 'nav.search' },
  { id: 'queue', label: 'nav.queue' },
  { id: 'data', label: 'nav.data' },
  { id: 'exports', label: 'nav.exports' },
  { id: 'localApi', label: 'nav.localApi' },
  { id: 'settings', label: 'nav.settings' },
  { id: 'logs', label: 'nav.logs' },
];

export function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    get<AppSettings>('/settings').then(setSettings, (e: Error) => setFailed(e.message));
  }, []);

  if (failed) {
    return (
      <div className="boot">
        <h1>Data Crawl Studio</h1>
        <p className="error">Không khởi động được tiến trình thu thập. / The collector process could not start.</p>
        <code>{failed}</code>
      </div>
    );
  }
  if (!settings) {
    return (
      <div className="boot">
        <div className="spinner" />
        <p>Đang khởi động… / Starting…</p>
      </div>
    );
  }
  return (
    <I18nProvider initial={settings.language}>
      <Shell settings={settings} onSettings={setSettings} />
    </I18nProvider>
  );
}

function Shell({ settings, onSettings }: { settings: AppSettings; onSettings(s: AppSettings): void }) {
  const { t, lang, setLang } = useI18n();
  const [page, setPage] = useState<PageId>(() => (location.hash.slice(1) as PageId) || 'dashboard');

  useEffect(() => {
    location.hash = page;
  }, [page]);

  const switchLang = async (l: Language) => {
    setLang(l);
    onSettings(await put<AppSettings>('/settings', { language: l }));
  };

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="main">
        <div className="brand">
          <span className="brand-mark" aria-hidden>◆</span>
          <span>{t('app.name')}</span>
        </div>
        <ul>
          {NAV.map((n) => (
            <li key={n.id}>
              <button className={page === n.id ? 'nav-item active' : 'nav-item'} onClick={() => setPage(n.id)} data-page={n.id}>
                {t(n.label)}
              </button>
            </li>
          ))}
        </ul>
        <div className="lang-switch" role="group" aria-label={t('general.language')}>
          {(['vi', 'en'] as Language[]).map((l) => (
            <button key={l} className={lang === l ? 'active' : ''} onClick={() => void switchLang(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </nav>
      <main className="content">
        {page === 'dashboard' && <DashboardPage go={setPage} />}
        {page === 'sources' && <SourcesPage settings={settings} />}
        {page === 'search' && <Placeholder title="nav.search" slice={6} />}
        {page === 'queue' && <QueuePage />}
        {page === 'data' && <DataPage />}
        {page === 'exports' && <ExportsPage />}
        {page === 'localApi' && <Placeholder title="nav.localApi" slice={8} />}
        {page === 'settings' && <SettingsPage settings={settings} onSettings={onSettings} />}
        {page === 'logs' && <LogsPage />}
      </main>
    </div>
  );
}
