'use client';

import { Fragment } from 'react';

import type { SettingAdvice, SettingSweep, StressGrid, VaultAnalysis, Verdict } from '@/lib/vaultAdvice';

const TONE: Record<Verdict, { fg: string; bg: string; word: string }> = {
  ok: { fg: 'var(--green-2)', bg: 'var(--green-1)', word: 'Sensible' },
  warn: { fg: '#9a4a06', bg: 'var(--amber-1)', word: 'Reconsider' },
  bad: { fg: 'var(--red-3)', bg: 'var(--red-1)', word: 'Change this' },
};

/** Solid fills for the sweep strip — the tint backgrounds are too pale at this size. */
const SWEEP_FILL: Record<Verdict, string> = {
  ok: 'var(--green-2)',
  warn: '#c9822f',
  bad: 'var(--red-2)',
};

export default function VaultAdvicePanel({
  analysis,
  onApply,
  onClose,
}: {
  analysis: VaultAnalysis;
  onApply: (a: SettingAdvice) => void;
  onClose: () => void;
}) {
  const m = analysis.market;

  return (
    <aside className="side-panel">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-soft)] px-4 py-2.5">
        <h2 className="section-title">Vault settings</h2>
        <span className="text-[14px] text-[var(--text-muted)]">
          against live {m.protocol} {analysis.asset.symbol}
        </span>
        <button
          onClick={onClose}
          aria-label="Close settings advice"
          className="ml-auto text-[var(--text-faint)] hover:text-[var(--text-color)]"
        >
          ×
        </button>
      </div>

      {/* What the recommendations are derived from. Shown so the numbers are
          auditable rather than asserted. */}
      <div className="shrink-0 border-b border-[var(--border-soft)] bg-[var(--card-2)] px-4 py-3">
        <p className="section-title mb-2">Market right now</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13.5px]">
          <Stat k="Supply cap" v={m.supplyCap} />
          <Stat k="Supplied" v={m.supplied} />
          <Stat k="Headroom" v={m.headroom} />
          <Stat k="Available liquidity" v={m.availableLiquidity} />
          <Stat k="Supply APY" v={`${m.supplyApyPct.toFixed(2)}%`} />
          <Stat k={m.protocolFeeLabel} v={`${m.protocolFeePct.toFixed(0)}%`} />
          {/* Facts only one protocol has. Morpho carries utilisation and LLTV;
              Aave sends an empty array and the grid is unchanged. */}
          {m.extra.map((e) => (
            <Stat key={e.label} k={e.label} v={e.value} />
          ))}
        </dl>
        {(m.frozen || m.paused) && (
          <p className="mt-2 text-[13px]" style={{ color: 'var(--red-3)' }}>
            This reserve is {m.frozen ? 'frozen' : ''}
            {m.frozen && m.paused ? ' and ' : ''}
            {m.paused ? 'paused' : ''}. Deposits will revert.
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {analysis.advice.map((a) => {
          const tone = TONE[a.verdict];
          return (
            <div key={a.setting} className="border-b border-[var(--border-soft)] px-4 py-3 last:border-0">
              <div className="flex items-baseline gap-2">
                <span
                  className="shrink-0 rounded-full px-2 py-0.5 text-[12px] font-medium"
                  style={{ background: tone.bg, color: tone.fg }}
                >
                  {tone.word}
                </span>
                <span className="text-[15px]">{a.label}</span>
                {a.finding && (
                  <span className="ml-auto font-mono text-[12px] text-[var(--text-faint)]">
                    {a.finding}
                  </span>
                )}
              </div>

              <p className="mt-2 text-[14px] leading-relaxed text-[var(--text-muted)]">{a.detail}</p>

              {sweepFor(analysis, a.setting) && <Sweep sweep={sweepFor(analysis, a.setting)!} />}
              {analysis.stress?.setting === a.setting && <Stress grid={analysis.stress} />}

              <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[13px]">
                <span className="text-[var(--text-faint)]">now</span>
                <code className="rounded bg-[var(--card-2)] px-1.5 py-0.5 font-mono">
                  {a.current}
                </code>
                {a.recommended && (
                  <>
                    <span className="text-[var(--text-faint)]">→</span>
                    <code className="rounded bg-[var(--card-2)] px-1.5 py-0.5 font-mono">
                      {a.recommended}
                    </code>
                    <button className="btn ml-1 !py-1 !text-[13px]" onClick={() => onApply(a)}>
                      Apply
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

const sweepFor = (a: VaultAnalysis, setting: SettingAdvice['setting']) =>
  a.sweeps?.find((s) => s.setting === setting);

/**
 * The frontier, not a point judgement: every value the advisor was asked about,
 * coloured by its verdict, with your current value marked. Shows *where* a
 * setting stops being sensible rather than only that this one isn't.
 */
function Sweep({ sweep }: { sweep: SettingSweep }) {
  return (
    <div className="mt-3">
      <div className="flex gap-[2px]" role="img" aria-label={sweep.frontier}>
        {sweep.points.map((p) => (
          <div key={p.value} className="flex-1" title={`${p.label} — ${p.verdict}`}>
            <div
              className="h-[10px] rounded-[2px]"
              style={{ background: SWEEP_FILL[p.verdict], opacity: p.current ? 1 : 0.45 }}
            />
            {p.current && (
              <div className="mt-1 text-center text-[10px] leading-none text-[var(--text-faint)]">
                ▲
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[13px] leading-snug text-[var(--text-muted)]">{sweep.frontier}</p>
      <p className="mt-0.5 text-[12px] text-[var(--text-faint)]">
        {sweep.points[0].label} → {sweep.points[sweep.points.length - 1].label} · ▲ is your value
      </p>
    </div>
  );
}

/**
 * The setting against a market condition it does not control.
 *
 * The strip above answers "is this value sensible today". This answers "how far
 * can the market move before it stops being sensible" — which is the question
 * that matters, because utilisation is set by borrowers rather than by the vault.
 */
function Stress({ grid }: { grid: StressGrid }) {
  return (
    <div className="mt-3">
      <p className="section-title mb-1.5">{grid.title}</p>

      <div
        className="grid gap-[2px]"
        style={{ gridTemplateColumns: `36px repeat(${grid.cols.length}, 1fr)` }}
      >
        <div />
        {grid.cols.map((c) => (
          <div
            key={c.label}
            className="pb-0.5 text-center text-[10px] leading-none text-[var(--text-faint)]"
          >
            {c.label}
          </div>
        ))}

        {grid.rows.map((r) => (
          <Fragment key={r.value}>
            <div className="pr-1.5 text-right font-mono text-[10px] leading-[14px] text-[var(--text-faint)]">
              {r.label}
            </div>
            {r.cells.map((cell, i) => (
              <div
                key={grid.cols[i].label}
                title={`${grid.rowLabel} ${r.label} at ${grid.cols[i].label} ${grid.colLabel.toLowerCase()} — ${cell.verdict}`}
                className="h-[14px] rounded-[2px]"
                style={{
                  background: SWEEP_FILL[cell.verdict],
                  opacity: cell.current ? 1 : 0.42,
                  boxShadow: cell.current ? '0 0 0 1.5px var(--text-color)' : undefined,
                }}
              />
            ))}
          </Fragment>
        ))}
      </div>

      <p className="mt-2 text-[13px] leading-snug text-[var(--text-muted)]">{grid.summary}</p>
      <p className="mt-0.5 text-[12px] text-[var(--text-faint)]">
        rows {grid.rowLabel.toLowerCase()} · columns {grid.colLabel.toLowerCase()} · outlined cell is
        where you are now
      </p>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-[var(--text-faint)]">{k}</dt>
      <dd className="text-right font-mono">{v}</dd>
    </>
  );
}
