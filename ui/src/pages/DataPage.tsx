import { useMemo, useState } from 'react';
import type { CommentView, PostDetail, PostListItem, SourceView } from '../../../shared/contracts';
import { PLATFORMS } from '../../../shared/contracts';
import { Card } from '../components';
import { fmtNum, usePoll } from '../hooks';
import { formatTime, useI18n } from '../i18n';

const PAGE = 50;

export function DataPage() {
  const { t } = useI18n();
  const [platform, setPlatform] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);
  const { data: sources } = usePoll<SourceView[]>('/sources', 0);

  const qs = new URLSearchParams();
  if (platform) qs.set('platform', platform);
  if (sourceId) qs.set('sourceId', sourceId);
  if (q.trim()) qs.set('q', q.trim());
  if (from) qs.set('from', new Date(from).toISOString());
  if (to) qs.set('to', new Date(new Date(to).getTime() + 86_400_000).toISOString());
  qs.set('limit', String(PAGE));
  qs.set('offset', String(offset));
  const { data } = usePoll<{ total: number; items: PostListItem[] }>(openId ? null : `/posts?${qs}`, 0);

  if (openId) return <PostDetailView id={openId} onBack={() => setOpenId(null)} />;

  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setOffset(0);
  };
  return (
    <section>
      <h1>{t('nav.data')}</h1>
      <div className="filters">
        <input placeholder={t('data.search')} value={q} onChange={(e) => reset(setQ)(e.target.value)} data-testid="data-search" />
        <select value={platform} onChange={(e) => reset(setPlatform)(e.target.value)}>
          <option value="">{t('data.allPlatforms')}</option>
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select value={sourceId} onChange={(e) => reset(setSourceId)(e.target.value)}>
          <option value="">{t('data.allSources')}</option>
          {sources?.map((s) => (
            <option key={s.id} value={s.id}>{s.name ?? s.input_url}</option>
          ))}
        </select>
        <label className="small">{t('data.from')} <input type="date" value={from} onChange={(e) => reset(setFrom)(e.target.value)} /></label>
        <label className="small">{t('data.to')} <input type="date" value={to} onChange={(e) => reset(setTo)(e.target.value)} /></label>
      </div>
      {data && <p className="muted small" data-testid="data-total">{t('data.total', { n: data.total })}</p>}
      <div className="post-list" data-testid="post-list">
        {data?.items.map((p) => (
          <button key={p.id} className="post-item" onClick={() => setOpenId(p.id)}>
            <PostSummary p={p} />
          </button>
        ))}
        {data && !data.items.length && <p className="muted">{t('data.empty')}</p>}
      </div>
      {data && data.total > PAGE && (
        <div className="row-actions">
          <button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>{t('data.prev')}</button>
          <span className="muted small">{offset + 1}–{Math.min(offset + PAGE, data.total)} / {data.total}</span>
          <button className="btn" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>{t('data.next')}</button>
        </div>
      )}
    </section>
  );
}

function PostSummary({ p, full = false }: { p: PostListItem; full?: boolean }) {
  const { t, lang } = useI18n();
  return (
    <>
      <div className="post-head">
        <span className={`plat plat-${p.platform}`}>{p.platform}</span>
        <b>{p.author_entity_name ?? p.author_pseudonym ?? p.container_name}</b>
        <span className="muted small">{formatTime(p.published_at, lang)}</span>
        {p.unavailable_at && <span className="badge badge-blocked">{t('data.unavailable')}</span>}
      </div>
      {p.title && <div className="post-title">{p.title}</div>}
      {p.text && <div className={full ? 'post-text full' : 'post-text clamp'}>{p.text}</div>}
      <div className="post-stats muted small">
        {p.view_count !== null && <span>{fmtNum(p.view_count)} {t('data.views')}</span>}
        <span>{fmtNum(p.like_count)} {t('data.likes')}</span>
        <span>{fmtNum(p.comment_count)} {t('data.comments')}</span>
        <span>{t('data.stored', { n: p.stored_comments })}</span>
      </div>
    </>
  );
}

interface Node {
  c: CommentView;
  children: Node[];
}

function PostDetailView({ id, onBack }: { id: number; onBack(): void }) {
  const { t, lang } = useI18n();
  const { data } = usePoll<PostDetail>(`/posts/${id}`, 0);
  const tree = useMemo(() => {
    if (!data) return [];
    const byId = new Map<number, Node>();
    data.comments.forEach((c) => byId.set(c.id, { c, children: [] }));
    const roots: Node[] = [];
    for (const n of byId.values()) {
      const parent = n.c.parent_id ? byId.get(n.c.parent_id) : undefined;
      (parent ? parent.children : roots).push(n);
    }
    const sort = (list: Node[]) => {
      list.sort((a, b) => (a.c.published_at ?? '').localeCompare(b.c.published_at ?? ''));
      list.forEach((n) => sort(n.children));
    };
    sort(roots);
    return roots;
  }, [data]);

  if (!data) return <p className="muted">{t('common.loading')}</p>;
  const p = data.post;
  return (
    <section>
      <button className="btn" onClick={onBack}>{t('data.back')}</button>
      <Card>
        <PostSummary p={p} full />
        {p.url && (
          <p className="small">
            <a href={p.url} target="_blank" rel="noreferrer">{p.url}</a>
          </p>
        )}
      </Card>
      <div className="grid-2">
        <Card title={t('data.media')}>
          <ul className="plain small">
            {data.media.map((m, i) => (
              <li key={i}>
                <span className="chip">{m.media_type}</span> <code>{m.url}</code>
                {m.width && m.height ? ` (${m.width}×${m.height})` : ''}
                {m.duration_seconds ? ` · ${m.duration_seconds}s` : ''}
              </li>
            ))}
          </ul>
        </Card>
        <Card title={t('data.snapshots')}>
          <table className="table compact">
            <tbody>
              {data.snapshots.map((s, i) => (
                <tr key={i}>
                  <td className="small">{formatTime(s.observed_at, lang)}</td>
                  <td className="num small">{fmtNum(s.view_count)} {t('data.views')}</td>
                  <td className="num small">{fmtNum(s.like_count)} {t('data.likes')}</td>
                  <td className="num small">{fmtNum(s.comment_count)} {t('data.comments')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
      <h3 className="section-gap">
        {t('data.commentsShown', { shown: data.comments.length, total: data.commentsTotal })}
      </h3>
      <div className="comment-tree" data-testid="comment-tree">
        {tree.map((n) => (
          <CommentNode key={n.c.id} n={n} />
        ))}
      </div>
    </section>
  );
}

function CommentNode({ n }: { n: Node }) {
  const { t, lang } = useI18n();
  const c = n.c;
  return (
    <div className={`comment depth-${Math.min(c.depth, 4)}${c.unavailable_at ? ' gone' : ''}`}>
      <div className="comment-head small">
        <b className={c.author_kind === 'entity' ? 'entity' : 'pseudo'}>{c.author_entity_name ?? c.author_pseudonym ?? '?'}</b>
        <span className="muted">{formatTime(c.published_at, lang)}</span>
        {c.is_edited ? <span className="muted">· {t('data.edited')}</span> : null}
        <span className="muted">· {fmtNum(c.like_count)} {t('data.likes')}</span>
        {c.reply_count ? <span className="muted">· {c.reply_count} {t('data.replies')}</span> : null}
        {c.unavailable_at && <span className="badge badge-blocked">{t('data.unavailable')}</span>}
      </div>
      <div className="comment-text">{c.text}</div>
      {n.children.length > 0 && (
        <div className="comment-children">
          {n.children.map((ch) => (
            <CommentNode key={ch.c.id} n={ch} />
          ))}
        </div>
      )}
    </div>
  );
}
