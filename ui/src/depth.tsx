import { useState } from 'react';
import type { DepthDays } from '../../shared/contracts';
import { DEPTH_OPTIONS, MAX_DEPTH_DAYS } from '../../shared/contracts';
import { useI18n } from './i18n';

/** "30 days", "1 year", "45 days", "All history". */
export function useDepthLabel(): (d: DepthDays) => string {
  const { t } = useI18n();
  return (d) => (d === null ? t('depth.all') : DEPTH_OPTIONS.includes(d) ? t(`depth.${d}`) : t('depth.days', { n: d }));
}

/** Preset depths plus "Custom…", which reveals a number of days (1 to MAX_DEPTH_DAYS). */
export function DepthInput({ value, onChange, testId }: { value: DepthDays; onChange(d: DepthDays): void; testId?: string }) {
  const { t } = useI18n();
  const label = useDepthLabel();
  const preset = DEPTH_OPTIONS.includes(value);
  const [custom, setCustom] = useState(!preset);
  const [text, setText] = useState(value === null ? '' : String(value));
  const commit = (s: string) => {
    setText(s);
    const n = Number(s);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_DEPTH_DAYS) onChange(n);
  };
  return (
    <span className="depth-input">
      <select
        value={custom ? 'custom' : String(value)}
        data-testid={testId}
        onChange={(e) => {
          if (e.target.value === 'custom') {
            setCustom(true);
            setText(value === null ? '180' : String(value));
            if (value === null) onChange(180);
            return;
          }
          setCustom(false);
          onChange(e.target.value === 'null' ? null : Number(e.target.value));
        }}
      >
        {DEPTH_OPTIONS.map((d) => (
          <option key={String(d)} value={String(d)}>
            {label(d)}
          </option>
        ))}
        <option value="custom">{t('depth.custom')}</option>
      </select>
      {custom && (
        <span className="depth-days">
          <input
            type="number"
            min={1}
            max={MAX_DEPTH_DAYS}
            step={1}
            value={text}
            onChange={(e) => commit(e.target.value)}
            data-testid={testId ? `${testId}-days` : undefined}
            aria-invalid={!(Number.isInteger(Number(text)) && Number(text) >= 1 && Number(text) <= MAX_DEPTH_DAYS)}
          />{' '}
          {t('depth.daysUnit')}
        </span>
      )}
    </span>
  );
}
