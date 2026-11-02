import { useState } from 'react';
import type { AddSourcesResult, AppSettings, DepthDays, SourceView } from '../../../shared/contracts';
import { del, patch, post } from '../api';
import { Card, ErrorText, Field } from '../components';
import { DepthInput, useDepthLabel } from '../depth';
import { fmtNum, usePoll } from '../hooks';
import { formatTime, useI18n } from '../i18n';

const SCHEDULES: (number | null)[] = [null, 60, 360, 720, 1440];

export function SourcesPage({ settings }: { settings: AppSettings }) {
  const { t } = useI18n();
  const { data: sources, reload } = usePoll<SourceView[]>('/sources', 3000);
  const [links, setLinks] = useState('');
  const [depth, setDepth] = useState<DepthDays>(settings.defaultDepthDays);
  const [schedule, setSchedule] = useState<number | null>(null);
  const [collectComments, setCollectComments] = useState(true);
  const [result, setResult] = useState<AddSourcesResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<AddSourcesResult>('/sources', { links, depthDays: depth, scheduleMinutes: schedule, collectComments });
      setResult(r);
      if (!r.errors.length) setLinks('');
      else setLinks(r.errors.map((e) => e.input).join('\n'));
      reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h1>{t('nav.sources')}</h1>
      <Card title={t('sources.add')}>
        <Field label={t('sources.linksLabel')}>
          <textarea rows={4} value={links} onChange={(e) => setLinks(e.target.value)} placeholder={t('sources.linksPlaceholder')} spellCheck={false} data-testid="links" />
        </Field>
        <div className="form-row">
          <Field label={t('sources.depth')}>
            <DepthInput value={depth} onChange={setDepth} testId="depth" />
          </Field>
          <Field label={t('sources.schedule')} hint={t('sources.scheduleHint')}>
            <ScheduleSelect value={schedule} onChange={setSchedule} />
          </Field>
          <Field label={t('sources.comments')} hint={t('sources.commentsHint')}>
            <label className="check">
              <input type="checkbox" checked={collectComments} onChange={(e) => setCollectComments(e.target.checked)} data-testid="collect-comments" /> {t('sources.collectComments')}
            </label>
          </Field>
        </div>
        <button className="btn primary" disabled={!links.trim() || busy} onClick={() => void add()} data-testid="add-sources">
          {t('sources.addBtn')}
        </button>
        {result && (
          <div className="result" data-testid="add-result">
            <p>{t('sources.result', { added: result.added.length, dups: result.duplicates.length, errors: result.errors.length })}</p>
            {result.errors.length > 0 && (
              <ul className="error-list">
                {result.errors.map((e) => (
                  <li key={e.input}>
                    <code>{e.input}</code> — {t(`link.${e.code}`)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <ErrorText error={error} />
      </Card>

      <div className="table-wrap">
        <table className="table" data-testid="sources-table">
          <thead>
            <tr>
              <th>{t('col.name')}</th>
              <th>{t('col.status')}</th>
              <th className="num">{t('col.posts')}</th>
              <th className="num">{t('col.comments')}</th>
              <th>{t('col.lastRun')}</th>
              <th>{t('col.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {sources?.map((s) => <SourceRowView key={s.id} s={s} reload={reload} />)}
            {sources && !sources.length && (
              <tr>
                <td colSpan={6} className="muted">{t('sources.empty')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ScheduleSelect({ value, onChange }: { value: number | null; onChange(m: number | null): void }) {
  const { t } = useI18n();
  const options = SCHEDULES.includes(value) ? SCHEDULES : [...SCHEDULES, value];
  return (
    <select value={String(value)} onChange={(e) => onChange(e.target.value === 'null' ? null : Number(e.target.value))}>
      {options.map((m) => (
        <option key={String(m)} value={String(m)}>
          {m === null ? t('sources.scheduleManual') : t('sources.everyHours', { h: m / 60 })}
        </option>
      ))}
    </select>
  );
}

/** Inline editor for a source's depth, schedule and comment switch. */
function SourceSettings({ s, done }: { s: SourceView; done(): void }) {
  const { t } = useI18n();
  const [depth, setDepth] = useState<DepthDays>(s.depth_days);
  const [schedule, setSchedule] = useState<number | null>(s.schedule_minutes);
  const [comments, setComments] = useState(!!s.collect_comments);
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    setError(null);
    try {
      await patch(`/sources/${s.id}`, { depthDays: depth, scheduleMinutes: schedule, collectComments: comments });
      done();
    } catch (e) {
      setError(e);
    }
  };
  const deeper = s.initial_crawl_done && s.depth_days !== null && (depth === null || depth > s.depth_days);
  return (
    <div className="source-settings" data-testid="source-settings">
      <Field label={t('sources.depth')}>
        <DepthInput value={depth} onChange={setDepth} testId="edit-depth" />
      </Field>
      <Field label={t('sources.schedule')}>
        <ScheduleSelect value={schedule} onChange={setSchedule} />
      </Field>
      <label className="check">
        <input type="checkbox" checked={comments} onChange={(e) => setComments(e.target.checked)} data-testid="edit-comments" /> {t('sources.collectComments')}
      </label>
      {deeper ? <p className="muted small">{t('sources.deeperNote')}</p> : null}
      {s.collect_comments && !comments ? <p className="muted small">{t('sources.commentsOffNote')}</p> : null}
      <div className="row-actions tight">
        <button className="btn small primary" onClick={() => void save()} data-testid="save-source">{t('common.save')}</button>
        <button className="btn small" onClick={done}>{t('common.cancel')}</button>
      </div>
      <ErrorText error={error} />
    </div>
  );
}

function SourceRowView({ s, reload }: { s: SourceView; reload(): void }) {
  const { t, lang } = useI18n();
  const depthLabel = useDepthLabel();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleteData, setDeleteData] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    }
    reload();
  };
  const stats = s.last_run_stats ?? {};
  return (
    <tr data-source-id={s.id}>
      <td>
        <div className="src-name">
          <span className={`plat plat-${s.platform}`}>{s.platform}</span>
          <a href={s.canonical_url ?? s.input_url} target="_blank" rel="noreferrer">
            {s.name ?? t('sources.unresolved')}
          </a>
        </div>
        <div className="muted small">
          {s.kind} · {t('col.depth')}: {depthLabel(s.depth_days)}
          {!s.collect_comments && <> · <span className="tag" data-testid="comments-off">{t('sources.postsOnly')}</span></>}
        </div>
        {editing && (
          <SourceSettings
            s={s}
            done={() => {
              setEditing(false);
              reload();
            }}
          />
        )}
      </td>
      <td>
        <span className={`badge src-${s.status}`} data-testid="source-status">{t(`srcstatus.${s.status}`)}</span>
        {s.status_detail && <div className="muted small">{s.status_detail}</div>}
        {s.active_jobs > 0 && <div className="muted small">{t('sources.activeJobs', { n: s.active_jobs })}</div>}
      </td>
      <td className="num" data-testid="source-posts">{fmtNum(s.posts)}</td>
      <td className="num" data-testid="source-comments">{fmtNum(s.comments)}</td>
      <td>
        {s.last_run_status ? (
          <>
            <div>{t(`run.${s.last_run_status}`)}</div>
            <div className="muted small">
              {formatTime(s.last_run_finished_at ?? s.last_run_started_at, lang)}
              {stats.apiUnits ? ` · ${stats.apiUnits} units` : ''}
            </div>
          </>
        ) : (
          '—'
        )}
      </td>
      <td>
        <div className="row-actions tight">
          <button className="btn small" onClick={() => void act(() => post(`/sources/${s.id}/run`))}>{t('sources.run')}</button>
          {!editing && <button className="btn small" onClick={() => setEditing(true)} data-testid="edit-source">{t('sources.edit')}</button>}
          {s.paused ? (
            <button className="btn small" onClick={() => void act(() => post(`/sources/${s.id}/resume`))}>{t('sources.resume')}</button>
          ) : (
            <button className="btn small" onClick={() => void act(() => post(`/sources/${s.id}/pause`))}>{t('sources.pause')}</button>
          )}
          {s.active_jobs > 0 && <button className="btn small" onClick={() => void act(() => post(`/sources/${s.id}/cancel`))}>{t('sources.cancel')}</button>}
          {!confirming && <button className="btn small danger" onClick={() => setConfirming(true)}>{t('sources.delete')}</button>}
        </div>
        {confirming && (
          <div className="confirm small">
            <p>{t('sources.deleteConfirm')}</p>
            <label>
              <input type="checkbox" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} /> {t('sources.deleteData')}
            </label>
            <button className="btn small danger" onClick={() => void act(() => del(`/sources/${s.id}${deleteData ? '?deleteData=1' : ''}`))}>{t('common.confirm')}</button>
            <button className="btn small" onClick={() => setConfirming(false)}>{t('common.cancel')}</button>
          </div>
        )}
        <ErrorText error={error} />
      </td>
    </tr>
  );
}
