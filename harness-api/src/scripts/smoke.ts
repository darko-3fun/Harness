// Offline proof of the B5 done-criterion and demo step 4: deleting a mitigation must flip a
// Critical finding from ✅ to ❌. Requires no chain, no Tenderly, no solc.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSource, loadFindings } from '../routes/audit.js';
import { PRESET_LIST, type Preset } from '../types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.resolve(here, '../../contracts/samples');
const fixturesDir = path.resolve(here, '../../../fixtures');

const failures: string[] = [];
const fail = (msg: string) => failures.push(msg);

interface Case {
  label: string;
  preset: Preset;
  file: string;
  /** The exact mitigation a user would delete on stage. */
  mitigation: string;
  expectFlipped: string;
  /**
   * Findings this sample triggers by design, and why.
   *
   * These reference contracts are hand-written and predate the generator, which has
   * since chosen stricter patterns for the same problems. The gaps are real — the
   * engine is right to report them — but they are deliberate here, so they are named
   * rather than silenced. Anything NOT on this list still fails the check.
   */
  knownGaps?: Record<string, string>;
}

const cases: Case[] = [
  {
    label: 'VAULT (demo path)',
    preset: 'aave-v3-erc4626-vault',
    file: 'HardenedAaveV3Vault.sol',
    mitigation: [
      '    function _decimalsOffset() internal pure override returns (uint8) {',
      '        return 3;',
      '    }',
    ].join('\n'),
    expectFlipped: 'AAVE-VLT-003',
  },
  {
    label: 'FLASH-LOAN RECEIVER',
    preset: 'aave-v3-flashloan-receiver',
    file: 'HardenedAaveFlashLoanReceiver.sol',
    mitigation: 'if (initiator != address(this)) revert NotSelfInitiated(initiator);',
    expectFlipped: 'AAVE-FL-001',
    knownGaps: {
      'AAVE-SWP-014':
        'the sample allowlists a router but never enforces a floor on swap output. The ' +
        'generator requires a non-zero minAmountOut before it will route a swap at all.',
    },
  },
];

for (const c of cases) {
  const hardened = fs.readFileSync(path.join(samplesDir, c.file), 'utf8').replace(/\r\n/g, '\n');
  if (!hardened.includes(c.mitigation)) {
    fail(`${c.label}: sample no longer contains the ${c.expectFlipped} mitigation`);
    continue;
  }

  const clean = auditSource({ source: hardened, preset: c.preset });
  const broken = auditSource({ source: hardened.replace(c.mitigation, ''), preset: c.preset });
  const flipped = broken.findings.find((f) => f.id === c.expectFlipped);

  console.log(`\n${c.label}  (${c.preset})`);
  console.log(`  hardened → mitigated ${clean.score.mitigated}, triggered ${clean.score.triggered}`);
  console.log(`  tampered → mitigated ${broken.score.mitigated}, triggered ${broken.score.triggered}`);
  for (const f of broken.findings.filter((x) => x.status === 'triggered')) {
    console.log(`    ❌ ${f.id} [${f.severity}] ${f.title}`);
  }

  const gaps = c.knownGaps ?? {};
  const stillTriggered = clean.findings.filter((f) => f.status === 'triggered').map((f) => f.id);
  for (const id of stillTriggered) {
    if (gaps[id]) console.log(`    known gap ${id}: ${gaps[id]}`);
  }
  const unexpected = stillTriggered.filter((id) => !gaps[id]);
  if (unexpected.length) fail(`${c.label}: hardened sample triggered ${unexpected.join(', ')}`);

  // A gap that has been closed should be removed from the list rather than left asserting.
  const stale = Object.keys(gaps).filter((id) => !stillTriggered.includes(id));
  if (stale.length) fail(`${c.label}: knownGaps lists ${stale.join(', ')}, which no longer trigger`);

  if (flipped?.status !== 'triggered') fail(`${c.label}: deleting the mitigation did not trigger ${c.expectFlipped}`);
  if (flipped && flipped.severity !== 'critical') fail(`${c.label}: ${c.expectFlipped} must be critical for the demo`);
  // The deletion must add exactly one finding on top of the documented gaps.
  const added = broken.findings.filter((f) => f.status === 'triggered' && !stillTriggered.includes(f.id));
  if (added.length !== 1) {
    fail(`${c.label}: deleting the mitigation should add exactly 1 finding, added ${added.length}`);
  }
}

// The fixture handshake is the only cross-agent contract, so it is validated here rather than
// discovered at integration time. Schema is harness-attack-snippets/v1 — the shape Agent A's
// assembler consumes; keys are finding IDs, optionally '<ID>#<variant>'.
const knownIds = new Set(loadFindings().map((f) => f.id));
// Both derived, never restated. A hardcoded copy of either is a check that goes stale the
// day a preset or a placeholder is added, and then reports its own staleness as a failure
// of the thing it is checking.
const PRESETS: string[] = PRESET_LIST;

interface Snippet {
  testName: string;
  title: string;
  presets?: string[];
  incidents: { name: string; url: string; pocFolder?: string }[];
  comments?: string[];
  body: string[];
  helpers?: string[];
}

const fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'attack-snippets.json'), 'utf8')) as {
  schemaVersion?: string;
  placeholders?: Record<string, string>;
  snippets: Record<string, Snippet>;
};

// The fixture documents its own placeholders; that list is the contract.
const ALLOWED_PLACEHOLDERS = Object.keys(fixture.placeholders ?? {}).filter((k) => k.startsWith('{{'));

if (fixture.schemaVersion !== 'harness-attack-snippets/v1') {
  fail(`unexpected schemaVersion "${fixture.schemaVersion}" — Agent A's assembler expects harness-attack-snippets/v1`);
}

const perPreset: Record<string, number> = {};
const helperSignatures = new Map<string, string>();

for (const [key, snippet] of Object.entries(fixture.snippets ?? {})) {
  const id = key.split('#')[0]!;
  if (!knownIds.has(id)) fail(`snippet "${key}" is not a known finding id`);
  if (!snippet.body?.length) fail(`snippet "${key}" has an empty body`);
  if (!snippet.incidents?.length) fail(`snippet "${key}" cites no incident`);

  for (const preset of snippet.presets ?? PRESETS) {
    if (!PRESETS.includes(preset)) fail(`snippet "${key}" targets unknown preset "${preset}"`);
    perPreset[preset] = (perPreset[preset] ?? 0) + 1;
  }

  const text = [...(snippet.comments ?? []), ...snippet.body, ...(snippet.helpers ?? [])].join('\n');
  for (const token of text.match(/\{\{[A-Z_]+\}\}/g) ?? []) {
    if (!ALLOWED_PLACEHOLDERS.includes(token)) fail(`${key} uses unsupported placeholder ${token}`);
  }

  // Snippet helpers are emitted per chosen snippet without de-duplication, so two snippets
  // declaring the same function would produce a contract that does not compile.
  for (const line of snippet.helpers ?? []) {
    const match = /^\s*function\s+(\w+)\s*\(/.exec(line);
    if (!match) continue;
    const previous = helperSignatures.get(match[1]!);
    if (previous) fail(`helper ${match[1]}() declared by both "${previous}" and "${key}"`);
    helperSignatures.set(match[1]!, key);
  }
}

console.log('\nfixtures  (harness-attack-snippets/v1)');
for (const preset of PRESETS) {
  const count = perPreset[preset] ?? 0;
  console.log(`  ${preset}: ${count} attack tests`);
  if (count < 6) fail(`${preset} has only ${count} attack tests, need >= 6`);
}

for (const name of ['sample-compile.json', 'sample-audit.json', 'sample-simulate.json']) {
  try {
    JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8'));
  } catch (err) {
    fail(`${name} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
}

if (failures.length) {
  console.error('');
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log('\nOK — audit engine flips on user-edited code for both presets; fixtures are consistent.');
