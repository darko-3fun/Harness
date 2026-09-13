import type { GenerateOptions } from '@/types';

/** Shared between the analyser route and the panel that renders it. */

export type Verdict = 'ok' | 'warn' | 'bad';

export interface SettingAdvice {
  setting: 'depositCap' | 'feeBps' | 'decimalsOffset';
  label: string;
  verdict: Verdict;
  current: string;
  recommended?: string;
  /** The recommended value in the option's own units, ready to apply. */
  recommendedRaw?: string;
  finding?: string;
  detail: string;
}

/** One point on a setting's sweep: what the verdict would be at this value. */
export interface SweepPoint {
  value: number;
  label: string;
  verdict: Verdict;
  current?: boolean;
}

export interface SettingSweep {
  setting: SettingAdvice['setting'];
  label: string;
  points: SweepPoint[];
  /** Prose describing where the verdict flips — the frontier, not a point judgement. */
  frontier: string;
}

/**
 * A two-axis stress grid: one setting against one market condition.
 *
 * The 1-D sweeps hold the market fixed at what it is right now, which answers
 * "is this value sensible today" but not "does it stay sensible". Utilisation is
 * the condition worth varying: it is the one that moves fastest, it is not under
 * the vault's control, and it is what decides whether a withdrawal can actually
 * be paid out.
 *
 * Deliberately not setting-against-setting. The deposit cap and the virtual-share
 * offset look like they should interact, but they do not: the inflation attack
 * targets the first depositor into an empty vault, and the attacker's cost is
 * 10^offset times what they hope to capture regardless of where the cap sits. A
 * grid over those two would be flat along one axis and would imply a relationship
 * the model does not have.
 */
export interface StressCell {
  verdict: Verdict;
  /** True for the cell nearest the vault's configured cap at today's utilisation. */
  current?: boolean;
}

export interface StressGrid {
  setting: SettingAdvice['setting'];
  title: string;
  rowLabel: string;
  colLabel: string;
  cols: { label: string; value: number }[];
  rows: { label: string; value: number; cells: StressCell[] }[];
  /** Prose naming the utilisation at which the configured cap stops holding. */
  summary: string;
}

export interface VaultAnalysis {
  asset: { address: string; symbol: string; decimals: number };
  market: {
    /** Which protocol the numbers were read from, e.g. 'Aave v3' or 'Morpho Blue'. */
    protocol: string;
    /** Rendered, not numeric: Morpho Blue markets have no supply cap at all. */
    supplyCap: string;
    supplied: string;
    headroom: string;
    availableLiquidity: string;
    supplyApyPct: number;
    /** What the protocol itself takes off the top, before the vault's own fee. */
    protocolFeePct: number;
    /** Names that cut: Aave calls it a reserve factor, Morpho calls it a market fee. */
    protocolFeeLabel: string;
    frozen: boolean;
    paused: boolean;
    /** Facts that only one protocol has — LLTV and utilization for Morpho. */
    extra: { label: string; value: string }[];
  };
  advice: SettingAdvice[];
  sweeps: SettingSweep[];
  stress: StressGrid;
}

export async function analyzeVault(opts: GenerateOptions): Promise<VaultAnalysis> {
  const res = await fetch('/api/vault-analysis', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `Analysis failed (${res.status})`);
  return body as VaultAnalysis;
}
