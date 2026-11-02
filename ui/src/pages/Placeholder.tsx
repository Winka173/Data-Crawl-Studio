import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/en';

export function Placeholder({ title, slice }: { title: MessageKey; slice: number }) {
  const { t } = useI18n();
  return (
    <section>
      <h1>{t(title)}</h1>
      <p className="muted">{t('common.notYet', { slice })}</p>
    </section>
  );
}
