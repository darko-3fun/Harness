import { buildPreset } from '@/generator';
import { AAVE_MAINNET, FORK_BLOCK } from '@/generator/markets';
import { scaffoldFor } from '@/generator/attacks/scaffold';
import {
  CONTRACT_NAME_RE,
  IMPORT_PATHS,
  SOLIDITY_PRAGMA,
  type FindingId,
  type GenerateOptions,
  type Preset,
} from '@/types';

/**
 * Attack-test assembler.
 *
 * Keeps only the snippets whose finding ID the generated contract actually
 * mitigates, substitutes placeholders, and emits a Foundry fork test. A snippet
 * that survives filtering but leaves an unknown {{PLACEHOLDER}} behind is a hard
 * error — a silently broken test is worse than no test.
 *
 * What these tests are for: they are the regression suite for the mitigations.
 * Each one is derived from a documented incident and fails when the mitigation it
 * cites is removed — which is what makes them meaningful for the person who
 * downloads the code and then changes it. The property suite next to this one
 * (`assemblePropertyTests`) covers what the user adds rather than what they
 * remove.
 */

export interface AttackSnippet {
  testName: string;
  title: string;
  presets?: Preset[];
  incidents: { name: string; url: string; pocFolder?: string }[];
  comments?: string[];
  body: string[];
  helpers?: string[];
}

export interface AttackSnippetFile {
  schemaVersion: string;
  snippets: Record<string, AttackSnippet>;
}

export interface AssembledTest {
  findingId: FindingId;
  testName: string;
  title: string;
  incidents: AttackSnippet['incidents'];
}

/** The `setUp` preamble every fork suite shares: select the fork, pinned when asked. */
export function forkSetUpLines(): string[] {
  return [
    `// Pinned to block ${FORK_BLOCK} by default so the suite is reproducible: an`,
    '// unpinned fork drifts with mainnet and goes red for reasons unrelated to the',
    '// code. Set FORK_BLOCK=0 to test against the latest block instead.',
    '//',
    '// This is only a block number. Any archive RPC serves it; no account with any',
    '// particular provider is required. TENDERLY_FORK_BLOCK is still read so an',
    '// older .env keeps working.',
    'uint256 forkBlock =',
    `    vm.envOr("FORK_BLOCK", vm.envOr("TENDERLY_FORK_BLOCK", uint256(${FORK_BLOCK})));`,
    'if (forkBlock == 0) {',
    '    vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));',
    '} else {',
    '    vm.createSelectFork(vm.envString("MAINNET_RPC_URL"), forkBlock);',
    '}',
  ];
}

export function assembleAttackTests(
  opts: GenerateOptions,
  file: AttackSnippetFile,
): { source: string; testNames: string[]; tests: AssembledTest[]; skipped: FindingId[] } {
  if (!CONTRACT_NAME_RE.test(opts.name)) {
    throw new Error(`Refusing to interpolate an invalid contract name: ${opts.name}`);
  }

  const { contract, appliedFindingIds } = buildPreset(opts);
  const applied = new Set<string>(appliedFindingIds);
  const scaffold = scaffoldFor(opts);

  const chosen: [FindingId, AttackSnippet][] = [];
  const skipped: FindingId[] = [];
  // A finding can carry more than one snippet, keyed '<FINDING_ID>#<variant>' —
  // typically one per preset, since a vault and a flash-loan receiver mitigate the
  // same finding in very different code.
  for (const [key, snippet] of Object.entries(file.snippets)) {
    const id = key.split('#')[0] as FindingId;
    const presetOk = !snippet.presets || snippet.presets.includes(opts.preset);
    if (presetOk && applied.has(id)) chosen.push([id, snippet]);
    else skipped.push(id);
  }

  // A schema mismatch filters every snippet out rather than throwing, so without
  // this the assembler happily emits a test file containing no tests — which looks
  // like success everywhere downstream. Fail loudly instead.
  if (chosen.length === 0) {
    const keys = Object.keys(file.snippets ?? {});
    throw new Error(
      keys.length === 0
        ? `No snippets found. Expected ${file.schemaVersion ?? 'an unknown schema'} with a top-level "snippets" object.`
        : `Emitted 0 tests for preset '${opts.preset}'. ${keys.length} snippet(s) were present but none matched — ` +
          `check that keys are finding IDs (optionally '<ID>#<variant>') and that 'presets' includes this preset.`,
    );
  }

  const ctorArgs = contract.constructorArgs.map((a) => {
    const bound = scaffold.bindings[a.name];
    if (!bound) throw new Error(`No test binding for constructor argument '${a.name}'`);
    return bound;
  });

  const lines: string[] = [
    '// SPDX-License-Identifier: MIT',
    `pragma solidity ${SOLIDITY_PRAGMA};`,
    '',
    `import {Test} from "${IMPORT_PATHS.FORGE_TEST}";`,
    ...(scaffold.aave
      ? [
          `import {IPool} from "${IMPORT_PATHS.POOL}";`,
          `import {IPoolAddressesProvider} from "${IMPORT_PATHS.POOL_ADDRESSES_PROVIDER}";`,
        ]
      : []),
    `import {IERC20} from "${IMPORT_PATHS.IERC20}";`,
    ...scaffold.imports,
    `import {${opts.name}} from "../src/${opts.name}.sol";`,
    '',
    `/// @title ${opts.name}AttackTest`,
    '/// @notice Generated by HARNESS. Every test below is derived from a documented',
    '/// @notice incident, cited in the comment above it, and fails when the mitigation',
    '/// @notice it names is removed. These run on a mainnet fork against the real',
    '/// @notice protocol — not against a mock.',
    `contract ${opts.name}AttackTest is Test {`,
    ...(scaffold.aave
      ? [
          '    IPoolAddressesProvider internal constant PROVIDER =',
          `        IPoolAddressesProvider(${AAVE_MAINNET.POOL_ADDRESSES_PROVIDER});`,
        ]
      : []),
    ...scaffold.constants.map((l) => `    ${l}`),
  ];

  if (opts.claimRewards && scaffold.aave) {
    lines.push(`    address internal constant REWARDS_CONTROLLER = ${AAVE_MAINNET.REWARDS_CONTROLLER};`);
  }

  lines.push(
    '',
    ...scaffold.state.map((l) => `    ${l}`),
    '',
    '    function setUp() public {',
    ...forkSetUpLines().map((l) => `        ${l}`),
    '',
    ...scaffold.setUp.map((l) => `        ${l}`),
    `        harness = new ${opts.name}(${ctorArgs.join(', ')});`,
    ...(scaffold.afterDeploy ?? []).map((l) => `        ${l}`),
    '    }',
    '',
    ...scaffold.helpers.map((l) => (l === '' ? '' : `    ${l}`)),
  );

  for (const [id, snippet] of chosen) {
    lines.push('', ...renderTest(id, snippet, scaffold.subs));
  }
  for (const [, snippet] of chosen) {
    if (snippet.helpers?.length) {
      lines.push('', ...snippet.helpers.map((h) => (h === '' ? '' : `    ${h}`)));
    }
  }

  lines.push('}', '');

  const source = lines.join('\n');
  const leftover = source.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) {
    throw new Error(
      `Unsubstituted placeholder(s) in attack tests: ${[...new Set(leftover)].join(', ')}`,
    );
  }

  const tests: AssembledTest[] = chosen.map(([findingId, s]) => ({
    findingId,
    testName: s.testName,
    title: s.title,
    incidents: s.incidents,
  }));

  return { source, testNames: tests.map((t) => t.testName), tests, skipped };
}

function renderTest(
  id: FindingId,
  snippet: AttackSnippet,
  subs: Record<string, string>,
): string[] {
  const substitute = (s: string) =>
    Object.entries(subs).reduce((acc, [k, v]) => acc.split(k).join(v), s);

  const out: string[] = [`    /// ${id} — ${snippet.title}`];
  for (const c of snippet.comments ?? []) out.push(`    /// ${substitute(c)}`);
  for (const inc of snippet.incidents) {
    out.push(`    /// @dev Incident: ${inc.name} — ${inc.url}`);
    if (inc.pocFolder) {
      out.push(
        `    /// @dev Runnable PoC: https://github.com/sanbir/evm-hack-registry/tree/main/${inc.pocFolder}`,
      );
    }
  }
  out.push(`    function ${snippet.testName}() public {`);
  for (const line of snippet.body) {
    out.push(line === '' ? '' : `        ${substitute(line)}`);
  }
  out.push('    }');
  return out;
}
