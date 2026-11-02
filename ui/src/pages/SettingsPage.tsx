import { useEffect, useState } from 'react';
import type { AppSettings, DepthDays, Language, PacingSettings, WorkerHealth } from '../../../shared/contracts';
import { DepthInput } from '../depth';
import { get, put } from '../api';
import { Card, ErrorText, Field } from '../components';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/en';
import { AccountsPanel } from './AccountsPanel';

type Tab = 'accounts' | 'pacing' | 'storage' | 'general';
const TABS: { id: Tab; label: MessageKey }[] = [
  { id: 'accounts', label: 'settings.tab.accounts' },
  { id: 'pacing', label: 'settings.tab.pacing' },
  { id: 'storage', label: 'settings.tab.storage' },
  { id: 'general', label: 'settings.tab.general' },
];

export function SettingsPage({ settings, onSettings }: { settings: AppSettings; onSettings(s: AppSettings): void }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('accounts');
  return (
    <section>
      <h1>{t('nav.settings')}</h1>
      <div className="tabs" role="tablist">
        {TABS.map((x) => (
          <button key={x.id} role="tab" aria-selected={tab === x.id} className={tab === x.id ? 'tab active' : 'tab'} onClick={() => setTab(x.id)}>
            {t(x.label)}
          </button>
        ))}
      </div>
      {tab === 'accounts' && <AccountsPanel />}
      {tab === 'pacing' && <PacingPanel settings={settings} onSettings={onSettings} />}
      {tab === 'storage' && <StoragePanel />}
      {tab === 'general' && <GeneralPanel settings={settings} onSettings={onSettings} />}
    </section>
  );
}

function useSaver(onSettings: (s: AppSettings) => void) {
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const save = async (patch: unknown) => {
    setError(null);
    try {
      onSettings(await put<AppSettings>('/settings', patch));
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(e);
    }
  };
  return { error, saved, save };
}

function PacingPanel({ settings, onSettings }: { settings: AppSettings; onSettings(s: AppSettings): void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(settings);
  const { error, saved, save } = useSaver(onSettings);
  const pacingKeys: (keyof PacingSettings)[] = ['minDelayMs', 'maxDelayMs', 'maxActionsPerHour', 'maxActionsPerDay'];

  const setPacing = (p: 'facebook' | 'instagram', k: keyof PacingSettings, v: number) =>
    setDraft({ ...draft, pacing: { ...draft.pacing, [p]: { ...draft.pacing[p], [k]: v } } });

  return (
    <div className="stack">
      <Card title={t('pacing.title')}>
        <p className="muted small">{t('pacing.intro')}</p>
        <div className="grid-2">
          {(['facebook', 'instagram'] as const).map((p) => (
            <div key={p}>
              <h4>{p === 'facebook' ? 'Facebook' : 'Instagram'}</h4>
              {pacingKeys.map((k) => (
                <Field key={k} label={t(`pacing.${k}`)}>
                  <input type="number" value={draft.pacing[p][k]} onChange={(e) => setPacing(p, k, Number(e.target.value))} />
                </Field>
              ))}
            </div>
          ))}
        </div>
      </Card>
      <Card title={t('quota.title')}>
        {(['dailyQuota', 'reserveUnits', 'recheckDays'] as const).map((k) => (
          <Field key={k} label={t(`quota.${k}`)}>
            <input
              type="number"
              value={draft.youtube[k]}
              onChange={(e) => setDraft({ ...draft, youtube: { ...draft.youtube, [k]: Number(e.target.value) } })}
            />
          </Field>
        ))}
      </Card>
      <div className="row-actions">
        <button className="btn primary" onClick={() => void save({ pacing: draft.pacing, youtube: draft.youtube })}>
          {saved ? t('common.saved') : t('common.save')}
        </button>
      </div>
      <ErrorText error={error} />
    </div>
  );
}

function StoragePanel() {
  const { t } = useI18n();
  const [health, setHealth] = useState<WorkerHealth | null>(null);
  useEffect(() => void get<WorkerHealth>('/health').then(setHealth), []);
  return (
    <Card title={t('storage.title')}>
      <dl className="kv">
        <dt>{t('storage.dataDir')}</dt>
        <dd className="path">{health?.dataDir}</dd>
        <dt>{t('storage.db')}</dt>
        <dd className="path">{health?.dbPath}</dd>
      </dl>
      <p className="muted small">{t('storage.note')}</p>
    </Card>
  );
}

function GeneralPanel({ settings, onSettings }: { settings: AppSettings; onSettings(s: AppSettings): void }) {
  const { t, setLang } = useI18n();
  const { error, save } = useSaver(onSettings);
  return (
    <Card>
      <Field label={t('general.language')}>
        <select
          value={settings.language}
          onChange={(e) => {
            const l = e.target.value as Language;
            setLang(l);
            void save({ language: l });
          }}
        >
          <option value="vi">Tiếng Việt</option>
          <option value="en">English</option>
        </select>
      </Field>
      <Field label={t('general.defaultDepth')}>
        <DepthInput value={settings.defaultDepthDays} onChange={(d: DepthDays) => void save({ defaultDepthDays: d })} />
      </Field>
      <ErrorText error={error} />
    </Card>
  );
}
