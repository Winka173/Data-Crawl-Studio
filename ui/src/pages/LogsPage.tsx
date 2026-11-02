import { useCallback, useEffect, useState } from 'react';
import { get } from '../api';
import { useI18n } from '../i18n';

export function LogsPage() {
  const { t } = useI18n();
  const [lines, setLines] = useState<string[]>([]);
  const load = useCallback(() => void get<{ lines: string[] }>('/logs?lines=500').then((r) => setLines(r.lines)), []);
  useEffect(load, [load]);

  return (
    <section>
      <div className="page-head">
        <h1>{t('logs.title')}</h1>
        <button className="btn" onClick={load}>{t('common.refresh')}</button>
      </div>
      <p className="muted">{t('logs.note')}</p>
      <pre className="log-view">
        {lines
          .slice()
          .reverse()
          .map((l, i) => {
            try {
              const j = JSON.parse(l) as { t: string; level: string; msg: string; data?: unknown };
              return (
                <div key={i} className={`log-line log-${j.level}`}>
                  <span className="log-t">{j.t.replace('T', ' ').slice(0, 19)}</span> <b>{j.level}</b> {j.msg}
                  {j.data !== undefined && <span className="log-data"> {JSON.stringify(j.data)}</span>}
                </div>
              );
            } catch {
              return <div key={i}>{l}</div>;
            }
          })}
      </pre>
    </section>
  );
}
