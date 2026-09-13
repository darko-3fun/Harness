'use client';

import { useState } from 'react';
import type { AuditResult } from '@/types';

const SEV: Record<string, { fg: string; bg: string }> = {
  critical: { fg: 'var(--red-3)', bg: 'var(--red-1)' },
  high: { fg: '#9a4a06', bg: 'var(--amber-1)' },
  medium: { fg: '#8a5a12', bg: 'var(--amber-1)' },
  low: { fg: 'var(--blue-3)', bg: 'var(--blue-1)' },
};

export default function AuditPanel({
  result,
  onClose,
}: {
  result: AuditResult;
  onClose: () => void;
}) {
  const [open, setOpen] = useState<string | null>(
    result.findings.find((f) => f.status === 'triggered')?.id ?? null,
  );

  return (
    <aside className="side-panel">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-soft)] px-4 py-2.5">
        <h2 className="section-title">Audit</h2>
        <span className="text-[15px] text-[var(--text-muted)]">
          {result.score.mitigated} mitigated, {result.score.triggered} triggered
        </span>
        <span
          title="Every rule is mutation-tested: the clean output triggers nothing, and removing one mitigation triggers exactly the finding that names it."
          className="rounded-full bg-[var(--card-2)] px-2 py-0.5 text-[12px] text-[var(--text-muted)]"
        >
          {result.findings.length} rules
        </span>
        <button
          onClick={onClose}
          aria-label="Close audit"
          className="ml-auto text-[var(--text-faint)] hover:text-[var(--text-color)]"
        >
          ×
        </button>
      </div>

      <div className="scroll flex-1 overflow-y-auto">
        {result.findings.map((f) => {
          const expanded = open === f.id;
          const triggered = f.status === 'triggered';
          const sev = SEV[f.severity];
          return (
            <div key={f.id} className="border-b border-[var(--border-soft)] last:border-0">
              <button
                onClick={() => setOpen(expanded ? null : f.id)}
                className="flex w-full items-start gap-2 px-4 py-3 text-left hover:bg-[var(--card-2)]"
              >
                <span
                  className="mt-[2px] shrink-0 rounded-full px-2 py-0.5 text-[12px] font-medium capitalize"
                  style={
                    triggered
                      ? { background: sev.bg, color: sev.fg }
                      : { background: 'var(--card-2)', color: 'var(--text-muted)' }
                  }
                >
                  {triggered ? f.severity : 'ok'}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className="block text-[15.5px] leading-snug"
                    style={{ color: triggered ? 'var(--text-color)' : 'var(--gray-5)' }}
                  >
                    {f.title}
                  </span>
                  <span className="mt-0.5 block font-mono text-[12px] text-[var(--text-faint)]">
                    {f.id}
                  </span>
                </span>
              </button>

              {expanded && (
                <div className="space-y-3 bg-[var(--card-2)] px-4 pb-4 pt-2 text-[15px] leading-relaxed">
                  <p>{f.summary}</p>
                  <p className="text-[var(--text-muted)]">{f.detail}</p>

                  <div>
                    <h3 className="section-title mb-1">Incidents</h3>
                    {f.incidents.map((i) => (
                      <p key={i.url} className="py-px">
                        <a
                          href={i.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[var(--blue-2)] hover:underline"
                        >
                          {i.name}
                        </a>
                        {i.loss && <span className="text-[var(--text-faint)]"> — {i.loss}</span>}
                        {i.pocFolder && (
                          <a
                            href={`https://github.com/sanbir/evm-hack-registry/tree/main/${i.pocFolder}`}
                            target="_blank"
                            rel="noreferrer"
                            className="ml-2 rounded-full bg-[var(--card-2)] px-2 py-0.5 text-[12px] text-[var(--text-color)] hover:bg-[var(--border)]"
                          >
                            Run the PoC
                          </a>
                        )}
                      </p>
                    ))}
                  </div>

                  <div>
                    <h3 className="section-title mb-1">
                      {triggered ? 'Remediation' : 'How this is mitigated'}
                    </h3>
                    <p className="text-[var(--text-muted)]">{f.remediation}</p>
                    {f.line && (
                      <p className="mt-1 font-mono text-[12px] text-[var(--text-faint)]">
                        Matched line {f.line}
                      </p>
                    )}
                  </div>

                  <p className="font-mono text-[12px] text-[var(--text-faint)]">
                    {f.vulnClasses.join('  ·  ')}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
