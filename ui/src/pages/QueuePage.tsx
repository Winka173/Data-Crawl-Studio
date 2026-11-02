import { useState } from 'react';
import type { JobView, StatusView } from '../../../shared/contracts';
import { post } from '../api';
import { usePoll } from '../hooks';
import { formatTime, useI18n } from '../i18n';

type Filter = 'active' | 'failed' | 'all';

export function PlatformControls({ status, reload }: { status: StatusView | null; reload(): void }) {
  const { t } = useI18n();
  if (!status) return null;
  return (
    <div className="platform-row">
      {status.platforms.map((p) => {
        const label = p.platform === 'global' ? t('queue.global') : p.platform;
        const stopped = p.paused || p.needsUser;
        return (
          <div key={p.platform} className={`platform-chip ${p.needsUser ? 'needs' : p.paused ? 'paused' : 'ok'}`} data-platform={p.platform}>
            <div>
              <b>{label}</b>
              <div className="small">{p.needsUser ? t('dash.needsUser') : p.paused ? t('dash.paused') : t('dash.ok')}</div>
              {p.reason && <div className="small muted">{t('dash.reason')}: {p.reason}</div>}
            </div>
            <button
              className="btn small"
              onClick={() => void post(`/control/${p.platform}/${stopped ? 'resume' : 'pause'}`).then(reload)}
            >
              {stopped ? t('queue.resume') : t('queue.pause')}
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function QueuePage() {
  const { t, lang } = useI18n();
  const [filter, setFilter] = useState<Filter>('active');
  const q = filter === 'active' ? '?state=active' : filter === 'failed' ? '?state=failed' : '?limit=300';
  const { data: jobs, reload } = usePoll<JobView[]>(`/jobs${q}`, 2000);
  const { data: status, reload: reloadStatus } = usePoll<StatusView>('/status', 2000);

  return (
    <section>
      <h1>{t('nav.queue')}</h1>
      <PlatformControls status={status} reload={() => (reload(), reloadStatus())} />
      <div className="tabs" role="tablist">
        {(['active', 'failed', 'all'] as Filter[]).map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'tab active' : 'tab'} onClick={() => setFilter(f)}>
            {t(`queue.filter.${f}`)}
          </button>
        ))}
      </div>
      <div className="table-wrap">
        <table className="table" data-testid="jobs-table">
          <thead>
            <tr>
              <th>#</th>
              <th>{t('col.type')}</th>
              <th>{t('col.name')}</th>
              <th>{t('col.target')}</th>
              <th>{t('col.state')}</th>
              <th className="num">{t('col.attempts')}</th>
              <th>{t('col.next')}</th>
              <th>{t('col.error')}</th>
            </tr>
          </thead>
          <tbody>
            {jobs?.map((j) => (
              <tr key={j.id}>
                <td className="muted">{j.id}</td>
                <td><code>{j.type}</code></td>
                <td>{j.source_name ?? '—'}</td>
                <td><code>{j.target ?? '—'}</code></td>
                <td><span className={`badge job-${j.state}`}>{t(`jobstate.${j.state}`)}</span></td>
                <td className="num">{j.attempts}/{j.max_attempts}</td>
                <td className="small">{j.state === 'queued' ? formatTime(j.next_run_at, lang) : '—'}</td>
                <td className="small error-cell" title={j.last_error ?? ''}>{j.last_error ?? ''}</td>
              </tr>
            ))}
            {jobs && !jobs.length && (
              <tr>
                <td colSpan={8} className="muted">{t('queue.empty')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
