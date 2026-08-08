'use client';

import { useState } from 'react';
import type { AuditResult } from '@/types';

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'bg-red-500/15 text-red-300 ring-red-500/30',
  high: 'bg-orange-500/15 text-orange-300 ring-orange-500/30',
  medium: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  low: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
};

export default function AuditPanel({
  result,
  live,
  onClose,
}: {
  result: AuditResult;
  live: boolean;
  onClose: () => void;
}) {
  const [open, setOpen] = useState<string | null>(
    result.findings.find((f) => f.status === 'triggered')?.id ?? null,
  );

  return (
    <aside className="flex h-[calc(100vh-73px)] flex-col border-l border-zinc-800">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
        <div className="flex items-center gap-2.5 text-xs">
          <span className="text-emerald-400">{result.score.mitigated} mitigated</span>
          <span className="text-zinc-700">·</span>
          <span className={result.score.triggered > 0 ? 'text-red-400' : 'text-zinc-500'}>
            {result.score.triggered} triggered
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!live && (
            <span
              title="Agent B's /audit is not wired up yet; these results come from a local mock of the same rule shape."
              className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400 ring-1 ring-amber-500/25"
            >
              mock
            </span>
          )}
          <button onClick={onClose} className="text-xs text-zinc-500 hover:text-zinc-200">
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 divide-y divide-zinc-800/70 overflow-y-auto">
        {result.findings.map((f) => {
          const expanded = open === f.id;
          return (
            <div key={f.id}>
              <button
                onClick={() => setOpen(expanded ? null : f.id)}
                className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left hover:bg-zinc-900/60"
              >
                <span className="mt-0.5 text-xs">
                  {f.status === 'mitigated' ? '✅' : '❌'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span
                      className={`rounded px-1 py-px font-mono text-[9px] uppercase ring-1 ${
                        SEVERITY_STYLE[f.severity]
                      }`}
                    >
                      {f.severity}
                    </span>
                    <span className="font-mono text-[10px] text-zinc-500">{f.id}</span>
                  </span>
                  <span className="mt-1 block text-xs leading-snug text-zinc-200">{f.title}</span>
                </span>
              </button>

              {expanded && (
                <div className="space-y-3 bg-zinc-900/40 px-4 pb-4 pt-1 text-[11px] leading-relaxed">
                  <p className="text-zinc-300">{f.summary}</p>
                  <p className="text-zinc-500">{f.detail}</p>

                  <div>
                    <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-600">
                      Historical incidents
                    </p>
                    <ul className="space-y-1">
                      {f.incidents.map((i) => (
                        <li key={i.url}>
                          <a
                            href={i.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sky-400 hover:underline"
                          >
                            {i.name}
                          </a>
                          {i.loss && <span className="text-zinc-500"> — {i.loss}</span>}
                          {i.pocFolder && (
                            <a
                              href={`https://github.com/sanbir/evm-hack-registry/tree/main/${i.pocFolder}`}
                              target="_blank"
                              rel="noreferrer"
                              className="ml-1.5 rounded bg-zinc-800 px-1 py-px font-mono text-[9px] text-zinc-300 hover:bg-zinc-700"
                            >
                              ▶ runnable PoC
                            </a>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div>
                    <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-600">
                      {f.status === 'mitigated' ? 'How this is mitigated' : 'Remediation'}
                    </p>
                    <p className="text-zinc-400">{f.remediation}</p>
                    {f.line && (
                      <p className="mt-1 font-mono text-[10px] text-zinc-600">
                        matched at line {f.line}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-1">
                    {f.vulnClasses.map((v) => (
                      <span
                        key={v}
                        className="rounded bg-zinc-800/80 px-1.5 py-px font-mono text-[9px] text-zinc-400"
                      >
                        {v}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
