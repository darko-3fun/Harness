'use client';

import { useEffect, useRef, useState } from 'react';

import { PRESET_BLURBS, PRESET_LABELS, PRESETS_BY_CATEGORY } from '@/generator';
import { CATEGORY_LABELS, PRESET_CATEGORY, type Preset, type PresetCategory } from '@/types';

/**
 * One dropdown per category, mirroring the wizard's top row: the category is the
 * button, the presets are the menu. The button for the category that holds the
 * selected preset shows that preset's name and is highlighted, so the row reads
 * as "Vaults: Aave V3 Vault" rather than as three identical buttons.
 */
export default function PresetMenu({
  category,
  selected,
  onSelect,
}: {
  category: PresetCategory;
  selected: Preset;
  onSelect: (p: Preset) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const presets = PRESETS_BY_CATEGORY[category];
  const active = PRESET_CATEGORY[selected] === category;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        className="btn lg"
        data-selected={active}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={active ? 'opacity-75' : 'text-[var(--text-muted)]'}>
          {CATEGORY_LABELS[category]}
        </span>
        {active && <span className="font-medium">{PRESET_LABELS[selected]}</span>}
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="opacity-70">
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="card absolute left-0 top-[calc(100%+6px)] z-30 w-[380px] overflow-hidden border border-[var(--border)]"
        >
          {presets.map((p) => (
            <button
              key={p}
              role="menuitemradio"
              aria-checked={p === selected}
              onClick={() => {
                onSelect(p);
                setOpen(false);
              }}
              className="block w-full border-b border-[var(--border-soft)] px-4 py-3 text-left last:border-0 hover:bg-[var(--card-2)]"
              style={p === selected ? { background: 'var(--tint)' } : undefined}
            >
              <span className="block text-[15.5px] font-medium">{PRESET_LABELS[p]}</span>
              <span className="mt-0.5 block text-[13.5px] leading-snug text-[var(--text-muted)]">
                {PRESET_BLURBS[p]}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
