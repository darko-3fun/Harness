// The h10 rejoin, prepared in advance. Consumes Agent A's fixtures/sample-generated.json and puts
// the generator's real output through compile → audit → deploy → simulate.
//
// Run with no arguments once Agent A publishes the fixture:
//   npm run verify:generated
// Chain steps are skipped automatically when the VE is not configured.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAINNET_ADDRESSES_PROVIDER, TOKENS } from '../aave.js';
import { auditSource } from '../routes/audit.js';
import { compileContract } from '../routes/compile.js';
import { deployContractSource } from '../routes/deploy.js';
import { runScenario } from '../routes/simulate.js';
import { env } from '../env.js';
import { deployerAccount } from '../tenderly.js';
import type { GeneratedProject, Preset, Scenario } from '../types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

// Agent A may publish to the canonical fixtures/ path or ship their tree separately.
const candidates = process.argv[2]
  ? [path.resolve(process.argv[2])]
  : [
      path.join(repoRoot, 'fixtures/sample-generated.json'),
      path.join(repoRoot, 'agent-a-work/fixtures/sample-generated.json'),
    ];
const fixture = candidates.find((p) => fs.existsSync(p));

const failures: string[] = [];
const check = (label: string, pass: boolean, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures.push(label);
};

if (!fixture) {
  console.log('sample-generated.json not found in any known location — nothing to verify.');
  console.log(`Looked in:\n  ${candidates.join('\n  ')}`);
  process.exit(0);
}
console.log(`verifying ${path.relative(repoRoot, fixture)}\n`);

const project = JSON.parse(fs.readFileSync(fixture, 'utf8')) as GeneratedProject;

// ---- shape of the shared contract --------------------------------------------------------------

const PRESETS: Preset[] = ['aave-v3-flashloan-receiver', 'aave-v3-erc4626-vault'];
check('preset declared', PRESETS.includes(project.preset), project.preset);
check('contractName present and valid', /^[A-Za-z_][A-Za-z0-9_]*$/.test(project.contractName ?? ''), project.contractName);
check('contractSource present', typeof project.contractSource === 'string' && project.contractSource.length > 0);
check('attackTestSource present', typeof project.attackTestSource === 'string' && project.attackTestSource.length > 0);
check('deployScriptSource present', typeof project.deployScriptSource === 'string');
check('remappings is an array', Array.isArray(project.remappings), `${project.remappings?.length} entries`);
check('appliedFindingIds is an array', Array.isArray(project.appliedFindingIds), project.appliedFindingIds?.join(', '));

// The preset drives which findings apply, so it is taken from the project, never guessed.
const preset: Preset = project.preset;
console.log(`\npreset: ${preset}`);

// ---- unresolved placeholders --------------------------------------------------------------------

const leftovers = [project.contractSource, project.attackTestSource, project.deployScriptSource]
  .join('\n')
  .match(/\{\{[A-Z_]+\}\}/g);
check('no unsubstituted {{PLACEHOLDER}} tokens survive', leftovers === null, leftovers?.join(', ') ?? '');

// ---- compile -------------------------------------------------------------------------------------

const compiled = compileContract({ source: project.contractSource, contractName: project.contractName });
for (const e of compiled.errors.filter((x) => x.severity === 'error')) {
  console.log(`    [solc] line ${e.line ?? '?'}: ${e.message.split('\n')[0]}`);
}
check('generated contract compiles', compiled.ok, compiled.ok ? `${compiled.sizeBytes} B, ${compiled.abi?.length} ABI entries` : '');
check('deployed size under the 24576 B EIP-170 limit', (compiled.sizeBytes ?? 0) < 24576, `${compiled.sizeBytes} B`);

// ---- audit ---------------------------------------------------------------------------------------

const audit = auditSource({ source: project.contractSource, preset });
console.log(`\naudit: ${audit.score.mitigated} mitigated, ${audit.score.triggered} triggered`);
for (const f of audit.findings.filter((x) => x.status === 'triggered')) {
  console.log(`    ❌ ${f.id} [${f.severity}] ${f.title}`);
}
check('generated contract triggers no findings', audit.score.triggered === 0);

// appliedFindingIds is Agent A's claim; the audit engine is the check on it.
const claimed = new Set(project.appliedFindingIds ?? []);
const actuallyMitigated = new Set(audit.findings.filter((f) => f.status === 'mitigated').map((f) => f.id));
const overclaimed = [...claimed].filter((id) => !actuallyMitigated.has(id));
check('appliedFindingIds does not overclaim', overclaimed.length === 0, overclaimed.join(', '));

// ---- chain ---------------------------------------------------------------------------------------

if (!env.TENDERLY_ADMIN_RPC || !env.DEPLOYER_PRIVATE_KEY) {
  console.log('\nchain not configured — skipping deploy + simulate.');
} else if (!compiled.ok) {
  console.log('\nskipping deploy + simulate because the contract did not compile.');
} else {
  const account = deployerAccount();
  const isVault = preset === 'aave-v3-erc4626-vault';
  const constructorArgs = isVault
    ? [MAINNET_ADDRESSES_PROVIDER, TOKENS.USDC, account.address, '0x8164Cc65827dcFe994AB23944CBC90e0aa80bFcb', 0n]
    : [MAINNET_ADDRESSES_PROVIDER, TOKENS.USDC, account.address];

  try {
    console.log('\ndeploying the generated contract …');
    const deployed = await deployContractSource({
      source: project.contractSource,
      contractName: project.contractName,
      constructorArgs,
    });
    check('generated contract deploys', true, deployed.address);
    console.log(`    ${deployed.explorerUrl}`);

    const scenario: Scenario = isVault ? 'vault-deposit' : 'flashloan-simple';
    const result = await runScenario({
      scenario,
      contractAddress: deployed.address,
      asset: TOKENS.USDC,
      borrowAsset: TOKENS.WETH,
      amount: 25_000_000_000n,
      borrowAmount: 100_000_000_000_000_000n,
      params: '0x',
      entrypoint: 'executeFlashLoan(address,uint256,bytes)',
    });
    check(`${scenario} runs against real mainnet Aave`, result.ok, `${result.trace.length} calls`);
    for (const b of result.balanceChanges) console.log(`    ${b.token}: ${b.delta}`);
    console.log(`    ${result.explorerUrl}`);
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] ?? 'error' : String(err);
    check('chain leg of the generated project', false, message.slice(0, 160));
  }
}

console.log(failures.length ? `\n${failures.length} check(s) failed.` : '\nAgent A output verified end to end.');
process.exit(failures.length ? 1 : 0);
