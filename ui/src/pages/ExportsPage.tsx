import { useState } from 'react';
import type { ExportFormat, ExportView, SourceView } from '../../../shared/contracts';
import { post } from '../api';
import { Card, CopyButton, ErrorText, Field } from '../components';
import { fmtNum, usePoll } from '../hooks';
import { formatTime, useI18n } from '../i18n';

/** A date input (local calendar day) to the UTC instant at the start of that day. */
const dayStart = (d: string): string | null => (d ? new Date(`${d}T00:00:00`).toISOString() : null);
const dayAfter = (d: string): string | null => (d ? new Date(new Date(`${d}T00:00:00`).getTime() + 86400_000).toISOString() : null);

export function ExportsPage() {
  const { t, lang } = useI18n();
  const { data: sources } = usePoll<SourceView[]>('/sources', 10_000);
  const { data: exports, reload } = usePoll<ExportView[]>('/exports', 10_000);
  const [sourceId, setSourceId] = useState<number | 'all'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [format, setFormat] = useState<ExportFormat>('jsonl');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [last, setLast] = useState<ExportView | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<ExportView>('/exports', { sourceIds: sourceId === 'all' ? null : [sourceId], from: dayStart(from), to: dayAfter(to), format });
      setLast(r);
      reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h1>{t('nav.exports')}</h1>
      <Card title={t('exports.new')}>
        <div className="form-row">
          <Field label={t('exports.source')}>
            <select value={String(sourceId)} onChange={(e) => setSourceId(e.target.value === 'all' ? 'all' : Number(e.target.value))} data-testid="export-source">
              <option value="all">{t('exports.allSources')}</option>
              {(sources ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name ?? s.input_url} ({fmtNum(s.posts)} / {fmtNum(s.comments)})
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('exports.from')} hint={t('exports.rangeHint')}>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t('exports.to')}>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label={t('exports.format')}>
            <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)} data-testid="export-format">
              <option value="jsonl">JSONL</option>
              <option value="csv">CSV (Excel)</option>
            </select>
          </Field>
        </div>
        <button className="btn primary" disabled={busy} onClick={() => void run()} data-testid="run-export">
          {busy ? t('exports.running') : t('exports.run')}
        </button>
        <ErrorText error={error} />
        {last && (
          <div className="result" data-testid="export-result">
            <p>{t('exports.done', { files: last.files.map((f) => `${f.file}: ${fmtNum(f.rows)}`).join(', ') })}</p>
            <p className="muted small">
              <code>{last.dir}</code> <CopyButton text={last.dir} />
            </p>
          </div>
        )}
        <p className="muted small">{t('exports.privacy')}</p>
      </Card>
      <Card title={t('exports.history')}>
        {!exports?.length ? (
          <p className="muted">{t('exports.none')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('exports.created')}</th>
                <th>{t('exports.format')}</th>
                <th>{t('exports.files')}</th>
                <th>{t('exports.folder')}</th>
              </tr>
            </thead>
            <tbody>
              {exports.map((x) => (
                <tr key={x.name}>
                  <td>{formatTime(x.createdAt, lang)}</td>
                  <td>{x.format.toUpperCase()}</td>
                  <td className="small">{x.files.map((f) => `${f.file}: ${fmtNum(f.rows)}`).join(' · ')}</td>
                  <td className="small">
                    <code>{x.dir}</code> <CopyButton text={x.dir} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </section>
  );
}
