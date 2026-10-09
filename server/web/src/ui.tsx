import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from './api';

export const errorText = (e: unknown): string =>
  e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong.';

/** Run `fn` every `ms` while mounted. The latest `fn` is always the one called. */
export function useInterval(fn: () => void, ms: number) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/**
 * Modal dialog. Escape and a click on the backdrop close it; focus moves into it on open and
 * returns to the opener on close. Sized by `wide` for forms.
 */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // First form control, so typing works at once; the close button only if there is none.
    const body = ref.current;
    (body?.querySelector<HTMLElement>('.sheet-head ~ * input, .sheet-head ~ * select, .sheet-head ~ * textarea')
      ?? body?.querySelector<HTMLElement>('.sheet-head ~ * button')
      ?? body?.querySelector<HTMLElement>('button'))?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); opener?.focus?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal sheet${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="btn ghost small" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ServiceDot({ color, title }: { color: string; title?: string }) {
  return <span className="svc-dot" style={{ background: color }} title={title} aria-hidden="true" />;
}

const SOURCE_LABEL: Record<string, string> = { ONLINE: 'Online', PHONE: 'Phone', WALK_IN: 'Walk-in', FRONT_DESK: 'Front desk' };
export const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? s;

export function Notice({ children, kind = 'info' }: { children: ReactNode; kind?: 'info' | 'error' | 'warn' }) {
  return <div className={`notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}
