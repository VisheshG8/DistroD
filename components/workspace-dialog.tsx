"use client";

import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

export function WorkspaceDialog({ title, children, onClose, wide = false, busy = false }: {
  title: string; children: React.ReactNode; onClose: () => void; wide?: boolean; busy?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null), close = useRef(onClose), isBusy = useRef(busy);
  const titleId = useId(); close.current = onClose; isBusy.current = busy;
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const elements = () => Array.from(box.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]') ?? []);
    const timer = setTimeout(() => (box.current?.querySelector<HTMLElement>('[data-autofocus]') ?? elements()[0] ?? box.current)?.focus(), 0);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isBusy.current) close.current();
      if (event.key !== 'Tab') return;
      const all = elements(), first = all[0], last = all.at(-1);
      if (!first) { event.preventDefault(); box.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === box.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { clearTimeout(timer); document.body.style.overflow = overflow; document.removeEventListener('keydown', key); prior?.focus(); };
  }, []);
  return <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy} className={`dialog workspace-dialog ${wide ? 'wide' : ''}`} ref={box} tabIndex={-1}>
      <div className="dialog-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={20}/></button></div>
      {children}
    </div>
  </div>;
}
