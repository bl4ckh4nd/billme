import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Settings2 } from 'lucide-react';

export const DashboardSettingsPopover: React.FC<{
  children: React.ReactNode;
  onSave: (values: Record<string, number>) => void;
  fields: Array<{ key: string; label: string; min?: number; max?: number; step?: number }>;
  values: Record<string, number>;
  dark?: boolean;
}> = ({ children, onSave, fields, values, dark }) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(values);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, right: 0 });

  // Sync draft when opening
  useEffect(() => {
    if (open) setDraft(values);
  }, [open, values]);

  // Compute position from button rect (runs every render while open)
  useEffect(() => {
    if (!open || !buttonRef.current) return;
    const update = () => {
      if (!buttonRef.current) return;
      const rect = buttonRef.current.getBoundingClientRect();
      setPos({
        top: rect.bottom + 8,
        right: window.innerWidth - rect.right,
      });
    };
    update();
    // Reposition on scroll/resize so it stays anchored
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target) || dropdownRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className={`p-1.5 rounded-lg transition-colors ${dark ? 'hover:bg-white/10 text-white/40 hover:text-white/80' : 'hover:bg-canvas text-muted hover:text-foreground'}`}
        title="Einstellungen"
      >
        <Settings2 size={14} />
      </button>
      {open && createPortal(
        <div
          ref={dropdownRef}
          style={{ position: 'fixed', top: pos.top, right: pos.right, zIndex: 9999 }}
          className="bg-surface text-foreground rounded-xl shadow-2xl border border-border p-4 min-w-[260px] animate-scale-in"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="space-y-3">
            {fields.map((f) => (
              <div key={f.key}>
                <label className="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">{f.label}</label>
                <input
                  type="number"
                  min={f.min ?? 1}
                  max={f.max}
                  step={f.step ?? 1}
                  value={draft[f.key] ?? 0}
                  onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
                  className="w-full bg-canvas border border-border rounded-lg px-3 py-2 text-sm tabular-nums font-bold text-foreground outline-none focus:ring-2 focus:ring-accent focus:border-accent"
                />
              </div>
            ))}
          </div>
          <button
            onClick={() => { onSave(draft); setOpen(false); }}
            className="mt-3 w-full py-2 bg-foreground text-white rounded-xl text-xs font-bold hover:bg-dark-1 transition-colors duration-200 ease-out"
          >
            Speichern
          </button>
        </div>,
        document.body,
      )}
      {children}
    </>
  );
};
