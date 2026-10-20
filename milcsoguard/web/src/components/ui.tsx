import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../lib/api';
import type { Severity } from '../lib/types';

export function SeverityBadge({ s }: { s: Severity | string }) {
  return <span className={`badge sev-${s}`}>{s}</span>;
}

export function Badge({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'; title?: string }) {
  return <span className={`badge ${tone}`} title={title}>{children}</span>;
}

export function Loading({ label = 'Betöltés…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" /> {label}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'Ismeretlen hiba';
  return (
    <div className="error-state" role="alert">
      <strong>Nem sikerült betölteni.</strong> <span>{msg}</span>
      {retry && <button className="btn sm" onClick={retry}>Újra</button>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 2 4 6v6c0 5 3.5 9 8 10 4.5-1 8-5 8-10V6l-8-4z" /></svg>
      <div className="empty-title">{title}</div>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager">
      <span className="muted">{total} találat</span>
      <button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Előző oldal">‹</button>
      <span>{page} / {pages}</span>
      <button className="btn sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Következő oldal">›</button>
    </div>
  );
}

export function StatTile({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'danger' | 'warn' }) {
  return (
    <div className={`card stat ${tone ?? ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const all = document.querySelectorAll('.modal');
      if (all[all.length - 1] === ref.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  // Portalled to <body> so nested dialogs (confirm inside a detail view) stack correctly.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
        <div className="modal-head">
          <h2 id={id}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Bezárás">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Confirmation for destructive actions: a reason (>= 3 chars) is always required. */
export function ConfirmReason({
  title, description, confirmLabel = 'Megerősítés', danger, onConfirm, onClose, children, reasonLabel = 'Indoklás (kötelező)',
}: {
  title: string; description?: ReactNode; confirmLabel?: string; danger?: boolean; reasonLabel?: string;
  onConfirm: (reason: string) => Promise<unknown>; onClose: () => void; children?: ReactNode;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valid = reason.trim().length >= 3;
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Hiba');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>Mégse</button>
        <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={!valid || busy} onClick={submit}>{busy ? 'Folyamatban…' : confirmLabel}</button>
      </>}
    >
      {description && <p className="muted">{description}</p>}
      {children}
      <label className="field">
        <span>{reasonLabel}</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} placeholder="Min. 3 karakter – az auditnaplóba kerül" />
      </label>
      {err && <div className="form-error" role="alert">{err}</div>}
    </Modal>
  );
}

export function FieldError({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  return (
    <div className="form-error" role="alert">
      {e.message}
      {e.details?.length ? <ul>{e.details.slice(0, 8).map((d, i) => <li key={i}><code>{d.path}</code>: {d.message}</li>)}</ul> : null}
    </div>
  );
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {options.map(([k, l]) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'active' : ''} onClick={() => onChange(k)}>{l}</button>
      ))}
    </div>
  );
}

export function RiskBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value / 1.4));
  return (
    <div className="risk" title={`Kockázati pontszám: ${value}`}>
      <div className="risk-bar"><i style={{ width: `${pct}%` }} /></div>
      <span>{value}</span>
    </div>
  );
}

export function JsonView({ value }: { value: unknown }) {
  // Rendered as text: evidence is attacker-influenced and must never be interpreted as HTML.
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}
