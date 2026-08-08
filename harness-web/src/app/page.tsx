'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';

import {
  buildPreset,
  printPreset,
  PRESET_BLURBS,
  PRESET_DEFAULTS,
  PRESET_LABELS,
} from '@/generator';
import { printDeployScript } from '@/generator/aave/deployScript';
import {
  assembleAttackTests,
  type AttackSnippetFile,
} from '@/generator/attacks/assembleAttackTests';
import snippetFile from '@/generated/attack-snippets.json';
import AuditPanel from '@/components/AuditPanel';
import { audit, compile } from '@/lib/api';
import { buildProjectZip, downloadBlob, remixUrl } from '@/lib/exportProject';
import {
  FINDING_TITLES,
  SEVERITY_BY_FINDING,
  REMAPPINGS,
  SOLC_VERSION,
  type AuditResult,
  type CompileResult,
  type FindingId,
  type GenerateOptions,
  type Preset,
} from '@/types';

// EditorView touches `document` in its constructor, so the editor may never be
// prerendered. `ssr: false` is only legal inside a Client Component.
const CodeEditor = dynamic(() => import('@/components/CodeEditor'), {
  ssr: false,
  loading: () => <div className="p-6 text-sm text-zinc-500">Loading editor…</div>,
});

const SNIPPETS = snippetFile as unknown as AttackSnippetFile;

type Tab = 'contract' | 'tests' | 'deploy';

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'bg-red-500/15 text-red-300 ring-red-500/30',
  high: 'bg-orange-500/15 text-orange-300 ring-orange-500/30',
  medium: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  low: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
};

export default function Home() {
  const [opts, setOpts] = useState<GenerateOptions>(
    PRESET_DEFAULTS['aave-v3-flashloan-receiver'],
  );
  const set = <K extends keyof GenerateOptions>(k: K, v: GenerateOptions[K]) => {
    setOpts((o) => ({ ...o, [k]: v }));
    setEdited(null);
    setCompileState(null);
  };

  // §A8 — one click, no typing on stage. Switching preset resets to that preset's
  // known-good options and clears any edit, so the demo cannot land in a broken mix.
  function selectPreset(p: Preset) {
    setOpts(PRESET_DEFAULTS[p]);
    setEdited(null);
    setAuditState(null);
    setCompileState(null);
  }

  // Pause, sweep and claim all need someone authorised to call them; the generator
  // rejects them outright when access is 'none', so don't offer them here.
  // The vault holds principal, so it has no ungated mode at all.
  const noAccess = opts.access === 'none';
  const vault = opts.preset === 'aave-v3-erc4626-vault';

  const [tab, setTab] = useState<Tab>('contract');
  // A user edit detaches the contract from the options, which is the entire point of
  // step 4 of the demo: delete a require, audit, watch a Critical flip to triggered.
  const [edited, setEdited] = useState<string | null>(null);
  const [auditState, setAuditState] = useState<{ result: AuditResult; live: boolean } | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [compileState, setCompileState] = useState<CompileResult | null>(null);
  const [compiling, setCompiling] = useState(false);

  const result = useMemo(() => {
    try {
      const tests = assembleAttackTests(opts, SNIPPETS);
      return {
        contract: printPreset(opts),
        tests: tests.source,
        testNames: tests.testNames,
        deploy: printDeployScript(opts),
        applied: buildPreset(opts).appliedFindingIds,
        error: null as string | null,
      };
    } catch (e) {
      return {
        contract: '',
        tests: '',
        testNames: [] as string[],
        deploy: '',
        applied: [] as FindingId[],
        error: (e as Error).message,
      };
    }
  }, [opts]);

  const contractSource = edited ?? result.contract;
  const shown = tab === 'contract' ? contractSource : tab === 'tests' ? result.tests : result.deploy;

  async function runAudit() {
    setAuditing(true);
    try {
      setAuditState(await audit({ preset: opts.preset, source: contractSource }));
    } catch (e) {
      console.error(e);
      setAuditState(null);
    } finally {
      setAuditing(false);
    }
  }
  async function runCompile() {
    setCompiling(true);
    setCompileState(null);
    try {
      const { result } = await compile({ contractName: opts.name, source: contractSource });
      setCompileState(result);
    } catch (e) {
      setCompileState({ ok: false, errors: [{ severity: 'error', message: (e as Error).message }] });
    } finally {
      setCompiling(false);
    }
  }

  async function downloadZip() {
    setZipping(true);
    try {
      const blob = await buildProjectZip(opts, SNIPPETS, result.applied);
      downloadBlob(blob, `${opts.name}.zip`);
    } finally {
      setZipping(false);
    }
  }

  const filename =
    tab === 'contract'
      ? `src/${opts.name}.sol`
      : tab === 'tests'
        ? `test/${opts.name}.attack.t.sol`
        : `script/${opts.name}.s.sol`;

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight">
          HARNESS <span className="font-normal text-zinc-500">— OpenZeppelin Wizard, for DeFi</span>
        </h1>
        <div className="mt-1 flex items-end justify-between">
          <p className="text-xs text-zinc-500">
            Deterministic template composition. No AI in the generation path.
          </p>
          <div className="flex gap-2">
            <a
              href={result.error ? undefined : remixUrl(contractSource)}
              target="_blank"
              rel="noreferrer"
              className={`rounded px-2.5 py-1 text-xs ring-1 transition ${
                result.error
                  ? 'pointer-events-none text-zinc-700 ring-zinc-800'
                  : 'text-zinc-300 ring-zinc-700 hover:text-zinc-100 hover:ring-zinc-500'
              }`}
            >
              Open in Remix ↗
            </a>
            <button
              onClick={downloadZip}
              disabled={zipping || !!result.error}
              className="rounded px-2.5 py-1 text-xs text-zinc-300 ring-1 ring-zinc-700 transition hover:text-zinc-100 hover:ring-zinc-500 disabled:opacity-40"
            >
              {zipping ? 'Packaging…' : 'Download Foundry project'}
            </button>
          </div>
        </div>
      </header>

      <div
        className={`grid grid-cols-1 ${
          auditState ? 'lg:grid-cols-[340px_1fr_380px]' : 'lg:grid-cols-[340px_1fr]'
        }`}
      >
        <aside className="space-y-5 border-r border-zinc-800 p-6">
          <Field label="Preset">
            <div className="space-y-1.5">
              {(Object.keys(PRESET_LABELS) as Preset[]).map((p) => (
                <button
                  key={p}
                  onClick={() => selectPreset(p)}
                  className={`w-full rounded-md px-3 py-2 text-left ring-1 transition ${
                    opts.preset === p
                      ? 'bg-zinc-100 text-zinc-900 ring-zinc-100'
                      : 'text-zinc-300 ring-zinc-700 hover:ring-zinc-500'
                  }`}
                >
                  <span className="block text-xs font-medium">{PRESET_LABELS[p]}</span>
                  <span
                    className={`mt-0.5 block text-[10px] leading-snug ${
                      opts.preset === p ? 'text-zinc-600' : 'text-zinc-500'
                    }`}
                  >
                    {PRESET_BLURBS[p]}
                  </span>
                </button>
              ))}
            </div>
          </Field>

          <Field label="Contract name">
            <input
              value={opts.name}
              onChange={(e) => set('name', e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 font-mono text-sm outline-none focus:border-zinc-500"
            />
          </Field>

          <Field label="Underlying asset">
            <input
              value={opts.asset ?? ''}
              onChange={(e) => set('asset', e.target.value as `0x${string}`)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 font-mono text-xs outline-none focus:border-zinc-500"
            />
          </Field>

          <Field label="Access control">
            <div className="flex gap-1.5">
              {(['none', 'ownable', 'roles'] as const).map((a) => (
                <button
                  key={a}
                  disabled={vault && a === 'none'}
                  onClick={() => {
                    setOpts((o) =>
                      a === 'none'
                        ? { ...o, access: a, pausable: false, claimRewards: false, sweepEscapeHatch: false }
                        : { ...o, access: a },
                    );
                    setEdited(null);
                  }}
                  className={`flex-1 rounded-md px-2 py-1.5 text-xs capitalize ring-1 transition disabled:cursor-not-allowed disabled:opacity-30 ${
                    opts.access === a
                      ? 'bg-zinc-100 text-zinc-900 ring-zinc-100'
                      : 'text-zinc-400 ring-zinc-700 hover:text-zinc-100'
                  }`}
                >
                  {a}
                </button>
              ))}
            </div>
          </Field>

          <div className="space-y-2.5 border-t border-zinc-800 pt-4">
            <Toggle
              label="Pausable"
              hint="Local kill switch (AAVE-RISK-010)"
              on={opts.pausable}
              disabled={noAccess}
              onClick={() => set('pausable', !opts.pausable)}
            />
            {!vault && (
              <Toggle
                label="Router allowlist"
                hint="Vetted swap targets + minAmountOut (AAVE-SWP-014)"
                on={opts.routerAllowlist}
                onClick={() => set('routerAllowlist', !opts.routerAllowlist)}
              />
            )}
            <Toggle
              label="Claim rewards"
              hint="RewardsController claim path (AAVE-VLT-008)"
              on={opts.claimRewards}
              disabled={noAccess}
              onClick={() => set('claimRewards', !opts.claimRewards)}
            />
            <Toggle
              label="Sweep escape hatch"
              hint="Recover airdrops and dust (AAVE-VLT-009)"
              on={opts.sweepEscapeHatch}
              disabled={noAccess}
              onClick={() => set('sweepEscapeHatch', !opts.sweepEscapeHatch)}
            />
            {noAccess && (
              <p className="pt-1 text-[11px] leading-snug text-amber-400/80">
                Unavailable without access control — each of these sends tokens to a
                caller-chosen address or halts the contract.
              </p>
            )}
          </div>

          <div className="border-t border-zinc-800 pt-4">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              Hardened against {result.applied.length} known findings
            </p>
            <div className="flex flex-wrap gap-1.5">
              {result.applied.map((id) => (
                <span
                  key={id}
                  title={FINDING_TITLES[id]}
                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] ring-1 ${
                    SEVERITY_STYLE[SEVERITY_BY_FINDING[id]]
                  }`}
                >
                  {id}
                </span>
              ))}
            </div>
          </div>

          <div className="border-t border-zinc-800 pt-4">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              remappings.txt
            </p>
            <pre className="overflow-x-auto text-[10px] leading-relaxed text-zinc-500">
              {REMAPPINGS.join('\n')}
            </pre>
          </div>
        </aside>

        <section>
          <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-2">
            <div className="flex gap-1">
              {(
                [
                  ['contract', 'Contract'],
                  ['tests', `Attack tests (${result.testNames.length})`],
                  ['deploy', 'Deploy script'],
                ] as [Tab, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={`rounded px-2.5 py-1 text-xs transition ${
                    tab === id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              {edited !== null && (
                <button
                  onClick={() => setEdited(null)}
                  className="text-[11px] text-amber-400 hover:text-amber-300"
                >
                  edited · reset
                </button>
              )}
              <span className="font-mono text-[11px] text-zinc-600">
                {result.error
                  ? 'invalid options'
                  : `${filename} · ${shown.split('\n').length} lines`}
              </span>
              <button
                onClick={runCompile}
                disabled={compiling || !!result.error}
                className="rounded px-2.5 py-1 text-xs text-zinc-300 ring-1 ring-zinc-700 transition hover:text-zinc-100 hover:ring-zinc-500 disabled:opacity-40"
              >
                {compiling ? 'Compiling…' : 'Compile'}
              </button>
              <button
                onClick={runAudit}
                disabled={auditing || !!result.error}
                className="rounded bg-emerald-500/90 px-2.5 py-1 text-xs font-medium text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-40"
              >
                {auditing ? 'Auditing…' : 'Run audit'}
              </button>
            </div>
          </div>
          {compileState && (
            <div
              className={`flex items-start gap-2 border-b px-5 py-2 text-xs ${
                compileState.ok
                  ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300'
                  : 'border-red-500/20 bg-red-500/5 text-red-300'
              }`}
            >
              <span>{compileState.ok ? '✅' : '❌'}</span>
              {compileState.ok ? (
                <span>
                  Compiled with solc {SOLC_VERSION} · {compileState.sizeBytes?.toLocaleString()} bytes
                  {compileState.sizeBytes !== undefined && compileState.sizeBytes < 24576
                    ? ' (under the 24,576 EIP-170 limit)'
                    : ' — OVER the 24,576 EIP-170 limit'}{' '}
                  · {compileState.abi?.length} ABI entries
                </span>
              ) : (
                <pre className="flex-1 overflow-x-auto whitespace-pre-wrap font-mono text-[11px]">
                  {compileState.errors
                    .filter((e) => e.severity === 'error')
                    .map((e) => e.message)
                    .join('\n\n') || 'Compilation failed'}
                </pre>
              )}
              <button
                onClick={() => setCompileState(null)}
                className="ml-auto text-zinc-500 hover:text-zinc-200"
              >
                ✕
              </button>
            </div>
          )}
          {result.error ? (
            <p className="p-6 font-mono text-sm text-red-400">{result.error}</p>
          ) : (
            <CodeEditor
              value={shown}
              readOnly={tab !== 'contract'}
              onChange={tab === 'contract' ? setEdited : undefined}
            />
          )}
        </section>

        {auditState && (
          <AuditPanel
            result={auditState.result}
            live={auditState.live}
            onClose={() => setAuditState(null)}
          />
        )}
      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function Toggle({
  label,
  hint,
  on,
  onClick,
  disabled = false,
}: {
  label: string;
  hint: string;
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-start gap-2.5 text-left disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
          on ? 'border-emerald-500 bg-emerald-500 text-zinc-950' : 'border-zinc-700'
        }`}
      >
        {on ? '✓' : ''}
      </span>
      <span>
        <span className="block text-sm leading-tight">{label}</span>
        <span className="block text-[11px] leading-tight text-zinc-500">{hint}</span>
      </span>
    </button>
  );
}
