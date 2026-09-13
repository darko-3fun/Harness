'use client';

import type { AssembledTest } from '@/generator/attacks/assembleAttackTests';
import type { PropertyTest } from '@/generator/properties/assemblePropertyTests';
import { FINDING_TITLES, SEVERITY_BY_FINDING } from '@/types';

const SEV_COLOR: Record<string, string> = {
  critical: 'var(--red-2)',
  high: '#d2691e',
  medium: '#b25e09',
  low: 'var(--blue-2)',
};

/**
 * What the two test files are for, test by test. The attack suite is the
 * regression suite for the mitigations; the property suite is for what the user
 * adds. Both statements are made here, next to the tests, so nobody has to read
 * the README to know why a green suite on unchanged code is not the point.
 */
export default function TestsPanel({
  attacks,
  properties,
  which,
  onClose,
}: {
  attacks: AssembledTest[];
  properties: PropertyTest[];
  which: 'attacks' | 'properties';
  onClose: () => void;
}) {
  const fuzz = properties.filter((p) => p.kind === 'fuzz');
  const invariants = properties.filter((p) => p.kind === 'invariant');

  return (
    <aside className="card flex w-[380px] shrink-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-soft)] px-4 py-2.5">
        <h2 className="section-title">{which === 'attacks' ? 'Attack tests' : 'Property tests'}</h2>
        <span className="text-[14px] text-[var(--text-muted)]">
          {which === 'attacks'
            ? `${attacks.length} on a mainnet fork`
            : `${fuzz.length} fuzz · ${invariants.length} invariants`}
        </span>
        <button
          onClick={onClose}
          aria-label="Close"
          className="ml-auto text-[var(--text-faint)] hover:text-[var(--text-color)]"
        >
          ×
        </button>
      </div>

      <div className="shrink-0 border-b border-[var(--border-soft)] bg-[var(--card-2)] px-4 py-3 text-[14px] leading-relaxed text-[var(--text-muted)]">
        {which === 'attacks' ? (
          <>
            <p>
              <strong className="text-[var(--text-color)]">The regression suite for the mitigations.</strong>{' '}
              Each test is derived from a documented incident and fails when the mitigation it names is
              removed. It does not prove the code is safe; it proves the defences it shipped with are still
              there after you change it.
            </p>
            <p className="mt-2">
              Try it: delete a mitigation in the editor, run Audit to see the finding flip, then run{' '}
              <code className="font-mono text-[12.5px]">forge test</code> in the download to watch the
              matching test go red.
            </p>
          </>
        ) : (
          <>
            <p>
              <strong className="text-[var(--text-color)]">For what you add.</strong> These properties hold
              for the generated contract and must keep holding for any strategy, hook or feature you build on
              top. Foundry drives them with random inputs and random action sequences, so they exercise your
              code rather than a fixed example.
            </p>
            <p className="mt-2">
              A revert inside a valid action is itself a failure: the handler only ever performs valid actions.
            </p>
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {which === 'attacks'
          ? attacks.map((t) => (
              <div key={t.testName} className="border-b border-[var(--border-soft)] px-4 py-3 last:border-0">
                <div className="flex items-start gap-2">
                  <span
                    className="mt-[7px] h-[7px] w-[7px] shrink-0 rounded-full"
                    style={{ background: SEV_COLOR[SEVERITY_BY_FINDING[t.findingId]] }}
                  />
                  <div className="min-w-0">
                    <code className="block truncate font-mono text-[13px]">{t.testName}</code>
                    <p className="mt-0.5 text-[14px] leading-snug text-[var(--text-muted)]">
                      <span className="font-mono text-[12px] text-[var(--text-faint)]">{t.findingId}</span>{' '}
                      {FINDING_TITLES[t.findingId] ?? t.title}
                    </p>
                    <p className="mt-1 text-[13px] leading-snug">
                      {t.incidents.map((i, n) => (
                        <span key={i.url + n}>
                          {n > 0 && <span className="text-[var(--text-faint)]"> · </span>}
                          <a href={i.url} target="_blank" rel="noreferrer" className="text-[var(--blue-2)] hover:underline">
                            {i.name}
                          </a>
                        </span>
                      ))}
                    </p>
                  </div>
                </div>
              </div>
            ))
          : [
              ['Fuzz', fuzz],
              ['Invariants', invariants],
            ].map(([label, list]) => (
              <div key={label as string}>
                <p className="section-title px-4 pb-1 pt-3">{label as string}</p>
                {(list as PropertyTest[]).map((p) => (
                  <div key={p.name} className="border-b border-[var(--border-soft)] px-4 py-2.5 last:border-0">
                    <code className="block truncate font-mono text-[13px]">{p.name}</code>
                    <p className="mt-0.5 text-[14px] leading-snug text-[var(--text-muted)]">{p.claim}</p>
                  </div>
                ))}
              </div>
            ))}
      </div>
    </aside>
  );
}
