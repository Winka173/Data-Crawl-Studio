import { useCallback, useEffect, useRef, useState } from 'react';
import { get } from './api';

/** GET a worker endpoint now and every `ms` while the page is visible. */
export function usePoll<T>(path: string | null, ms = 3000): { data: T | null; error: unknown; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  const reload = useCallback(() => {
    const p = pathRef.current;
    if (!p) return;
    get<T>(p).then(
      (d) => {
        if (pathRef.current === p) {
          setData(d);
          setError(null);
        }
      },
      (e: unknown) => setError(e),
    );
  }, []);

  useEffect(() => {
    reload();
    if (!ms) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, ms);
    return () => clearInterval(id);
  }, [path, ms, reload]);

  return { data, error, reload };
}

export function fmtNum(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : n.toLocaleString();
}
