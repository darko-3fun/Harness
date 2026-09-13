'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { formatEther, parseEther } from 'viem';

import { buildPreset, PRESET_BLURBS, PRESET_DEFAULTS } from '@/generator';
import { type AttackSnippetFile } from '@/generator/attacks/assembleAttackTests';
import { describeOptionsError } from '@/generator/shared';
import {
  assetsFor,
  defaultDepositCap,
  morphoLltvPct,
  morphoMarketsFor,
  type KnownAsset,
} from '@/generator/markets';
import snippetFile from '@/generated/attack-snippets.json';
import AuditPanel from '@/components/AuditPanel';
import PresetMenu from '@/components/PresetMenu';
import TestsPanel from '@/components/TestsPanel';
import ThemeToggle from '@/components/ThemeToggle';
import VaultAdvicePanel from '@/components/VaultAdvicePanel';
import { analyzeVault, type SettingAdvice, type VaultAnalysis } from '@/lib/vaultAdvice';
import { audit, compile } from '@/lib/api';
import { buildProjectFiles, buildProjectZip, downloadBlob, remixUrl } from '@/lib/exportProject';
import {
  FINDING_TITLES,
  PRESET_CATEGORY,
  PRESET_LIST,
  SEVERITY_BY_FINDING,
  SOLC_VERSION,
  type AuditResult,
  type CompileResult,
  type FindingId,
  type GenerateOptions,
  type Preset,
  type PresetCategory,
} from '@/types';

// EditorView touches `document` in its constructor, so the editor may never be
// prerendered. `ssr: false` is only legal inside a Client Component.
const CodeEditor = dynamic(() => import('@/components/CodeEditor'), {
  ssr: false,
  loading: () => <div className="p-6 text-[var(--text-faint)]">Loading editor…</div>,
});

const SNIPPETS = snippetFile as unknown as AttackSnippetFile;

type Tab = 'contract' | 'attacks' | 'properties' | 'deploy';
type Panel = null | 'audit' | 'advice' | 'tests';

const CATEGORIES: PresetCategory[] = ['vault', 'launchpad', 'flashloan'];

const SEV_COLOR: Record<string, string> = {
  critical: 'var(--red-2)',
  high: '#d2691e',
  medium: '#b25e09',
  low: 'var(--blue-2)',
};

/**
 * The configuration lives in the URL hash so a preset can be shared as a link.
 * Read once on mount; written on every change. Nothing here is trusted: the
 * generator validates every field before anything is interpolated.
 */
function readHash(): GenerateOptions | null {
  try {
    const m = window.location.hash.match(/o=([A-Za-z0-9\-_]+)/);
    if (!m) return null;
    const json = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
    const parsed = JSON.parse(json) as Partial<GenerateOptions>;
    if (!parsed.preset || !PRESET_LIST.includes(parsed.preset)) return null;
    return { ...PRESET_DEFAULTS[parsed.preset], ...parsed };
  } catch {
    return null;
  }
}

function writeHash(opts: GenerateOptions): void {
  const b64 = btoa(JSON.stringify(opts)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  history.replaceState(null, '', `#o=${b64}`);
}

export default function Home() {
  const [opts, setOpts] = useState<GenerateOptions>(PRESET_DEFAULTS['aave-v3-erc4626-vault']);
  const [tab, setTab] = useState<Tab>('contract');
  const [edited, setEdited] = useState<string | null>(null);
  const [auditResult, setAuditResult] = useState<AuditResult | null>(null);
  const [compileState, setCompileState] = useState<CompileResult | null>(null);
  const [busy, setBusy] = useState<null | 'audit' | 'compile' | 'zip' | 'advice'>(null);
  const [advice, setAdvice] = useState<VaultAnalysis | null>(null);
  const [adviceError, setAdviceError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [copied, setCopied] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // Deferred a tick: the first client render must match the server's, and the
    // hash is only readable on the client.
    const t = setTimeout(() => {
      const fromHash = readHash();
      if (fromHash) setOpts(fromHash);
      setHydrated(true);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (hydrated) writeHash(opts);
  }, [opts, hydrated]);

  const set = <K extends keyof GenerateOptions>(k: K, v: GenerateOptions[K]) => {
    setOpts((o) => ({ ...o, [k]: v }));
    setEdited(null);
    setCompileState(null);
  };

  function selectPreset(p: Preset) {
    setOpts(PRESET_DEFAULTS[p]);
    setEdited(null);
    setAuditResult(null);
    setCompileState(null);
    setAdvice(null);
    setAdviceError(null);
    setPanel(null);
    setTab('contract');
  }

  const category = PRESET_CATEGORY[opts.preset];
  const vault = category === 'vault';
  const launchpad = category === 'launchpad';
  const flash = category === 'flashloan';
  const morpho = opts.preset === 'morpho-blue-vault';
  const sale = opts.preset === 'token-sale-launchpad';
  const curve = opts.preset === 'bonding-curve-launchpad';
  // Aave and Compound pay incentives to the position holder; Morpho does not, and a
  // launchpad holds no position. Offering the toggle where it does nothing is worse
  // than not offering it.
  const hasRewards = opts.preset === 'aave-v3-erc4626-vault' || opts.preset === 'compound-v3-vault' || flash;
  const noAccess = opts.access === 'none';

  const result = useMemo(() => {
    try {
      const files = buildProjectFiles(opts, SNIPPETS);
      return { ...files, applied: buildPreset(opts).appliedFindingIds, error: null as string | null };
    } catch (e) {
      return {
        contract: '',
        attackTests: '',
        propertyTests: '',
        deployScript: '',
        attacks: [],
        properties: [],
        applied: [] as FindingId[],
        error: describeOptionsError(e),
      };
    }
  }, [opts]);

  const source = edited ?? result.contract;
  const shown =
    tab === 'contract'
      ? source
      : tab === 'attacks'
        ? result.attackTests
        : tab === 'properties'
          ? result.propertyTests
          : result.deployScript;

  async function runAudit() {
    setBusy('audit');
    try {
      setAuditResult(await audit({ preset: opts.preset, source }));
      setPanel('audit');
    } finally {
      setBusy(null);
    }
  }

  async function runCompile() {
    setBusy('compile');
    setCompileState(null);
    try {
      const { result: r } = await compile({ contractName: opts.name, source });
      setCompileState(r);
    } catch (e) {
      setCompileState({ ok: false, errors: [{ severity: 'error', message: (e as Error).message }] });
    } finally {
      setBusy(null);
    }
  }

  /** Reads the live market and judges the vault settings against it. */
  async function runAdvice() {
    setBusy('advice');
    setAdviceError(null);
    try {
      setAdvice(await analyzeVault(opts));
      setPanel('advice');
    } catch (e) {
      setAdvice(null);
      setAdviceError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function applyAdvice(a: SettingAdvice) {
    const raw = a.recommendedRaw ?? a.recommended?.match(/[0-9]+/)?.[0];
    if (!raw) return;
    if (a.setting === 'depositCap') set('depositCap', raw);
    if (a.setting === 'feeBps') set('feeBps', Number(raw));
    if (a.setting === 'decimalsOffset') set('decimalsOffset', Number(raw));
  }

  async function downloadZip() {
    setBusy('zip');
    try {
      downloadBlob(await buildProjectZip(opts, SNIPPETS, result.applied, edited), `${opts.name}.zip`);
    } finally {
      setBusy(null);
    }
  }

  async function copyCode() {
    await navigator.clipboard.writeText(shown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  function selectTab(t: Tab) {
    setTab(t);
    if (t === 'attacks' || t === 'properties') setPanel('tests');
    else if (panel === 'tests') setPanel(null);
  }

  return (
    <div className="flex min-h-screen flex-col p-4 lg:h-screen lg:overflow-hidden">
      {/* Category menus + actions, mirroring the wizard's top row. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 pb-4">
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((c) => (
            <PresetMenu key={c} category={c} selected={opts.preset} onSelect={selectPreset} />
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <ThemeToggle />
          <button className="btn" onClick={copyCode}>
            {copied ? 'Copied' : 'Copy to Clipboard'}
          </button>
          <a
            className="btn no-underline"
            href={result.error ? undefined : remixUrl(source)}
            target="_blank"
            rel="noreferrer"
            aria-disabled={!!result.error}
          >
            Open in Remix
          </a>
          <button className="btn" onClick={downloadZip} disabled={busy === 'zip' || !!result.error}>
            {busy === 'zip' ? 'Packaging…' : edited !== null ? 'Download (edited)' : 'Download'}
          </button>
          <button
            className="btn"
            onClick={runCompile}
            disabled={busy === 'compile' || !!result.error}
          >
            {busy === 'compile' ? 'Compiling…' : 'Compile'}
          </button>
          <button
            className="btn primary"
            onClick={runAudit}
            disabled={busy === 'audit' || !!result.error}
          >
            {busy === 'audit' ? 'Auditing…' : 'Audit'}
          </button>
        </div>
      </div>

      {/* `relative` anchors the side panel when it overlays the code on a narrow screen. */}
      <div className="relative flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        {/* Controls */}
        <aside className="card w-full shrink-0 overflow-y-auto p-5 lg:w-[336px]">
          <p className="mb-5 text-[14px] leading-snug text-[var(--text-muted)]">
            {PRESET_BLURBS[opts.preset]}
          </p>

          <Group title="Settings">
            <Field label="Name">
              <input
                value={opts.name}
                onChange={(e) => set('name', e.target.value)}
                spellCheck={false}
                className="text-input text-[14.5px]"
              />
            </Field>
            {!launchpad && (
              <AssetPicker
                preset={opts.preset}
                value={opts.asset}
                onChange={(a) => {
                  // The cap is in raw units, so it has to follow the asset's decimals.
                  setOpts((o) => ({
                    ...o,
                    asset: a,
                    morphoMarketId: undefined,
                    depositCap: o.depositCap === undefined ? undefined : (defaultDepositCap(a) ?? o.depositCap),
                  }));
                  setEdited(null);
                  setCompileState(null);
                }}
              />
            )}
            {morpho && <MorphoMarketPicker opts={opts} onChange={(id) => set('morphoMarketId', id)} />}
          </Group>

          <Group title="Features">
            <Toggle
              label="Pausable"
              checked={opts.pausable}
              disabled={noAccess}
              onChange={() => set('pausable', !opts.pausable)}
            />
            {flash && (
              <Toggle
                label="Router allowlist"
                checked={opts.routerAllowlist}
                onChange={() => set('routerAllowlist', !opts.routerAllowlist)}
              />
            )}
            {hasRewards && (
              <Toggle
                label="Claim rewards"
                checked={opts.claimRewards}
                disabled={noAccess}
                onChange={() => set('claimRewards', !opts.claimRewards)}
              />
            )}
            <Toggle
              label="Sweep escape hatch"
              checked={opts.sweepEscapeHatch}
              disabled={noAccess}
              onChange={() => set('sweepEscapeHatch', !opts.sweepEscapeHatch)}
            />
            {sale && (
              <Toggle
                label="Merkle allowlist"
                checked={!!opts.whitelist}
                onChange={() => set('whitelist', !opts.whitelist)}
              />
            )}
            {noAccess && (
              <p className="pt-2 text-[14px] leading-snug text-[var(--text-faint)]">
                Each of these sends tokens to a caller-chosen address or halts the contract. Without
                access control they are the vulnerability, so they cannot be enabled.
              </p>
            )}
          </Group>

          {vault && (
            <Group title="Vault settings">
              <Field label="Deposit cap (raw units)">
                <input
                  value={opts.depositCap ?? ''}
                  onChange={(e) => set('depositCap', e.target.value || undefined)}
                  spellCheck={false}
                  className="text-input text-[13px]"
                />
              </Field>
              <Slider
                label={`Performance fee — ${opts.feeBps ?? 0} bps`}
                min={0}
                max={1000}
                step={25}
                value={opts.feeBps ?? 0}
                onChange={(v) => set('feeBps', v)}
              />
              <Slider
                label={`Virtual share offset — ${opts.decimalsOffset ?? 6}`}
                min={0}
                max={12}
                step={1}
                value={opts.decimalsOffset ?? 6}
                onChange={(v) => set('decimalsOffset', v)}
              />
              <button
                className="btn mt-1 w-full justify-center"
                onClick={runAdvice}
                disabled={busy === 'advice'}
              >
                {busy === 'advice' ? 'Reading the market…' : 'Check against the live market'}
              </button>
              {adviceError && (
                <p className="mt-2 text-[13px] leading-snug" style={{ color: 'var(--red-3)' }}>
                  {adviceError}
                </p>
              )}
            </Group>
          )}

          {sale && (
            <Group title="Sale settings">
              <EthField label="Price per token (ETH)" value={opts.tokenPriceWei} onChange={(v) => set('tokenPriceWei', v)} />
              <EthField label="Hard cap (ETH)" value={opts.hardCapWei} onChange={(v) => set('hardCapWei', v)} />
              <EthField label="Soft cap (ETH) — below this the sale refunds" value={opts.softCapWei} onChange={(v) => set('softCapWei', v)} />
              <EthField label="Minimum contribution (ETH)" value={opts.minContributionWei} onChange={(v) => set('minContributionWei', v)} />
              <EthField label="Maximum per wallet (ETH) — 0 disables" value={opts.maxContributionWei} onChange={(v) => set('maxContributionWei', v)} />
              <Slider
                label={`Vesting cliff — ${opts.vestingCliffDays ?? 0} days`}
                min={0}
                max={365}
                step={1}
                value={opts.vestingCliffDays ?? 0}
                onChange={(v) => set('vestingCliffDays', v)}
              />
              <Slider
                label={`Vesting duration after the cliff — ${opts.vestingDurationDays ?? 0} days`}
                min={0}
                max={730}
                step={1}
                value={opts.vestingDurationDays ?? 0}
                onChange={(v) => set('vestingDurationDays', v)}
              />
            </Group>
          )}

          {curve && (
            <Group title="Curve settings">
              <Field label="Tokens sold on the curve (whole tokens)">
                <input
                  value={opts.curveSupply ?? ''}
                  onChange={(e) => set('curveSupply', e.target.value.replace(/[^0-9]/g, ''))}
                  spellCheck={false}
                  className="text-input text-[13px]"
                />
                <span className="mt-1 block text-[12.5px] text-[var(--text-faint)]">
                  A quarter as many again are reserved for the pool, so total supply is{' '}
                  {formatCompact(opts.curveSupply)}×1.25.
                </span>
              </Field>
              <EthField label="ETH raised at graduation" value={opts.graduationEth} onChange={(v) => set('graduationEth', v)} />
              <Slider
                label={`Trading fee — ${opts.tradingFeeBps ?? 0} bps`}
                min={0}
                max={500}
                step={5}
                value={opts.tradingFeeBps ?? 0}
                onChange={(v) => set('tradingFeeBps', v)}
              />
              <Slider
                label={
                  opts.maxWalletBps
                    ? `Wallet cap — ${(opts.maxWalletBps / 100).toFixed(1)}% of the curve`
                    : 'Wallet cap — off'
                }
                min={0}
                max={5000}
                step={50}
                value={opts.maxWalletBps ?? 0}
                onChange={(v) => set('maxWalletBps', v)}
              />
            </Group>
          )}

          <Group title="Access Control">
            <div className="segmented">
              {(['none', 'ownable', 'roles'] as const).map((a) => {
                const blocked = a === 'none' && (vault || sale);
                return (
                  <button
                    key={a}
                    data-selected={opts.access === a}
                    disabled={blocked}
                    title={
                      blocked
                        ? vault
                          ? 'A vault holds principal, so it always needs an owner.'
                          : 'A sale needs an owner to fund it and set the allowlist.'
                        : undefined
                    }
                    onClick={() => {
                      setOpts((o) =>
                        a === 'none'
                          ? { ...o, access: a, pausable: false, claimRewards: false, sweepEscapeHatch: false }
                          : { ...o, access: a },
                      );
                      setEdited(null);
                      setCompileState(null);
                    }}
                  >
                    {a}
                  </button>
                );
              })}
            </div>
          </Group>

          <Group title={`Hardened against ${result.applied.length}`} last>
            {result.applied.map((id) => (
              <div key={id} className="flex items-start gap-2 py-[3px]" title={FINDING_TITLES[id]}>
                <span
                  className="mt-[7px] h-[7px] w-[7px] shrink-0 rounded-full"
                  style={{ background: SEV_COLOR[SEVERITY_BY_FINDING[id]] }}
                />
                <span className="text-[14.5px] leading-snug text-[var(--text-muted)]">
                  <span className="font-mono text-[12px] text-[var(--text-faint)]">{id}</span>{' '}
                  {FINDING_TITLES[id]}
                </span>
              </div>
            ))}
          </Group>
        </aside>

        {/* Code */}
        <main className="card flex min-h-[26rem] min-w-0 flex-1 flex-col overflow-hidden lg:min-h-0">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-soft)] p-3">
            {(
              [
                ['contract', `src/${opts.name}.sol`],
                ['attacks', `Attack tests · ${result.attacks.length}`],
                ['properties', `Properties · ${result.properties.length}`],
                ['deploy', 'Deploy script'],
              ] as [Tab, string][]
            ).map(([id, label]) => (
              <button key={id} onClick={() => selectTab(id)} className="btn" data-selected={tab === id}>
                {label}
              </button>
            ))}
            {edited !== null && (
              <button
                onClick={() => setEdited(null)}
                className="ml-auto text-[15px] text-[var(--blue-2)] hover:underline"
              >
                Edited · revert
              </button>
            )}
          </div>

          {compileState && (
            <Banner tone={compileState.ok ? 'ok' : 'bad'} onClose={() => setCompileState(null)}>
              {compileState.ok ? (
                <>
                  Compiled with solc {SOLC_VERSION} — {compileState.sizeBytes?.toLocaleString()} bytes
                  {compileState.sizeBytes !== undefined &&
                    (compileState.sizeBytes < 24576
                      ? ' (within the 24,576 EIP-170 limit)'
                      : ' — over the 24,576 EIP-170 limit')}
                  , {compileState.abi?.length} ABI entries.
                </>
              ) : (
                <pre className="scroll overflow-x-auto whitespace-pre-wrap font-mono text-[12px]">
                  {compileState.errors
                    .filter((e) => e.severity === 'error')
                    .map((e) => e.message)
                    .join('\n\n') || 'Compilation failed.'}
                </pre>
              )}
            </Banner>
          )}

          <div className="min-h-0 flex-1">
            {result.error ? (
              <div className="p-6">
                <p className="section-title mb-2">The generator refused these options</p>
                <pre className="whitespace-pre-wrap font-mono text-[14px] text-[var(--red-3)]">{result.error}</pre>
                <p className="mt-3 text-[14px] text-[var(--text-muted)]">
                  Nothing is generated from options that would produce an unsafe contract.
                </p>
              </div>
            ) : (
              <CodeEditor
                value={shown}
                readOnly={tab !== 'contract'}
                onChange={tab === 'contract' ? setEdited : undefined}
              />
            )}
          </div>
        </main>

        {panel === 'advice' && advice && (
          <VaultAdvicePanel analysis={advice} onApply={applyAdvice} onClose={() => setPanel(null)} />
        )}
        {panel === 'audit' && auditResult && (
          <AuditPanel result={auditResult} onClose={() => setPanel(null)} />
        )}
        {panel === 'tests' && !result.error && (
          <TestsPanel
            attacks={result.attacks}
            properties={result.properties}
            which={tab === 'properties' ? 'properties' : 'attacks'}
            onClose={() => setPanel(null)}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * The assets a preset can be generated for. Morpho and Compound are limited to
 * what has a catalogued market or Comet; Aave takes any listed reserve, so a
 * custom address is offered there.
 */
function AssetPicker({
  preset,
  value,
  onChange,
}: {
  preset: Preset;
  value: `0x${string}` | undefined;
  onChange: (a: `0x${string}`) => void;
}) {
  const known = assetsFor(preset);
  const isKnown = known.some((a) => a.address.toLowerCase() === value?.toLowerCase());
  const allowCustom = preset === 'aave-v3-erc4626-vault' || preset === 'aave-v3-flashloan-receiver';
  const [custom, setCustom] = useState(!isKnown);

  return (
    <Field label="Underlying asset">
      <select
        className="text-input text-[14px]"
        value={custom ? 'custom' : (value ?? '')}
        onChange={(e) => {
          if (e.target.value === 'custom') {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(e.target.value as `0x${string}`);
        }}
      >
        {known.map((a: KnownAsset) => (
          <option key={a.address} value={a.address}>
            {a.symbol}
          </option>
        ))}
        {allowCustom && <option value="custom">Custom address…</option>}
      </select>
      {custom && (
        <input
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value as `0x${string}`)}
          placeholder="0x…"
          spellCheck={false}
          className="text-input mt-1.5 text-[13px]"
        />
      )}
      {custom && (
        <span className="mt-1 block text-[12.5px] leading-snug text-[var(--text-faint)]">
          Any active Aave reserve. The tests resolve the aToken and decimals on the fork.
        </span>
      )}
    </Field>
  );
}

function MorphoMarketPicker({
  opts,
  onChange,
}: {
  opts: GenerateOptions;
  onChange: (id: `0x${string}` | undefined) => void;
}) {
  const markets = morphoMarketsFor(opts.asset);
  if (markets.length === 0) return null;
  const selected = opts.morphoMarketId ?? markets[0].id;
  return (
    <Field label="Morpho market (pinned at deployment)">
      <select
        className="text-input text-[14px]"
        value={selected}
        onChange={(e) => onChange(e.target.value === markets[0].id ? undefined : (e.target.value as `0x${string}`))}
      >
        {markets.map((m) => (
          <option key={m.id} value={m.id}>
            {m.collateralSymbol} collateral · {morphoLltvPct(m)} LLTV
          </option>
        ))}
      </select>
      <span className="mt-1 block text-[12.5px] leading-snug text-[var(--text-faint)]">
        A market is the hash of five parameters; the deepest markets per asset are catalogued.
      </span>
    </Field>
  );
}

/** Wei in the options, ETH in the box. Invalid input leaves the option untouched. */
function EthField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | undefined;
  onChange: (wei: string) => void;
}) {
  const [text, setText] = useState(() => (value ? formatEther(BigInt(value)) : ''));

  /**
   * Commit once typing settles.
   *
   * Selecting the field and typing a new number passes through states like "" and "0",
   * which are keystrokes rather than intentions. Committing each one sets the option to
   * zero and flashes the generator's refusal panel mid-word. Waiting for a pause means
   * the user sees a refusal only when they have actually asked for something impossible.
   */
  useEffect(() => {
    const t = text.trim();
    if (t === '' || t.endsWith('.')) return;
    let wei: string;
    try {
      wei = parseEther(t).toString();
    } catch {
      return;
    }
    if (wei === value) return;
    const id = setTimeout(() => onChange(wei), 400);
    return () => clearTimeout(id);
  }, [text, value, onChange]);
  const [seen, setSeen] = useState(value);
  // The option changed from outside (preset switch, URL): resync the box. Adjusting
  // state during render is the sanctioned way to derive state from a prop change.
  if (value !== seen) {
    setSeen(value);
    let matches = false;
    try {
      matches = parseEther(text || '0').toString() === value;
    } catch {
      matches = false;
    }
    if (!matches) setText(value ? formatEther(BigInt(value)) : '');
  }
  return (
    <Field label={label}>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        inputMode="decimal"
        className="text-input text-[13px]"
      />
    </Field>
  );
}

function formatCompact(n: string | undefined): string {
  const v = Number(n ?? 0);
  if (v >= 1e9) return `${(v / 1e9).toFixed(v % 1e9 ? 1 : 0)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v % 1e6 ? 1 : 0)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(v);
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <Field label={label}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
        style={{ accentColor: 'var(--blue-2)' }}
      />
    </Field>
  );
}

function Group({ title, children, last = false }: { title: string; children: React.ReactNode; last?: boolean }) {
  return (
    <section className={last ? '' : 'mb-5 border-b border-[var(--border-soft)] pb-5'}>
      <h2 className="section-title mb-2.5">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-2 block last:mb-0">
      <span className="mb-1.5 block text-[15px] text-[var(--text-muted)]">{label}</span>
      {children}
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-center gap-2.5 py-[5px] text-[16px] ${
        disabled ? 'cursor-not-allowed text-[var(--text-faint)]' : 'cursor-pointer'
      }`}
    >
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
      {label}
    </label>
  );
}

function Banner({ tone, children, onClose }: { tone: 'ok' | 'bad'; children: React.ReactNode; onClose: () => void }) {
  const ok = tone === 'ok';
  return (
    <div
      className="flex shrink-0 items-start gap-2 border-b px-4 py-3 text-[15px]"
      style={{
        background: ok ? 'var(--green-1)' : 'var(--red-1)',
        borderColor: ok ? '#c3e9d4' : '#f7caca',
        color: ok ? 'var(--green-2)' : 'var(--red-3)',
      }}
    >
      <div className="min-w-0 flex-1">{children}</div>
      <button onClick={onClose} aria-label="Dismiss" className="shrink-0 opacity-60 hover:opacity-100">
        ×
      </button>
    </div>
  );
}
