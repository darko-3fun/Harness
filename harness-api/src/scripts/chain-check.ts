// B10 dry run: deploy both presets to the Tenderly VE and exercise every scenario against real
// mainnet Aave. This is the rehearsal harness — run it before the demo, three times.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAbi, type Address } from 'viem';
import { MAINNET_ADDRESSES_PROVIDER, TOKENS, addressesProviderAbi, poolAbi } from '../aave.js';
import { deployContractSource } from '../routes/deploy.js';
import { runScenario } from '../routes/simulate.js';
import { deployerAccount, publicClient, setErc20Balance, setNativeBalance } from '../tenderly.js';
import type { Scenario, SimulateResult } from '../types.js';

const REWARDS_CONTROLLER = '0x8164Cc65827dcFe994AB23944CBC90e0aa80bFcb' as Address;

const here = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.resolve(here, '../../contracts/samples');
const read = (f: string) => fs.readFileSync(path.join(samplesDir, f), 'utf8');

const pub = publicClient();
const account = deployerAccount();
const only = process.argv[2] as Scenario | undefined;

const results: { scenario: Scenario; ok: boolean; detail: string }[] = [];

async function reseed(): Promise<void> {
  await setNativeBalance(account.address, 1000n * 10n ** 18n);
  await setErc20Balance(TOKENS.USDC, account.address, 5_000_000n * 10n ** 6n);
  await setErc20Balance(TOKENS.WETH, account.address, 1_000n * 10n ** 18n);
}

function report(scenario: Scenario, result: SimulateResult): void {
  console.log(`  trace: ${result.trace.length} calls`);
  for (const c of result.trace.slice(0, 6)) console.log(`    ${'  '.repeat(c.depth)}${c.fn}`);
  for (const b of result.balanceChanges) console.log(`    ${b.token}: ${b.delta}`);
  console.log(`  explorer: ${result.explorerUrl ?? '(none)'}`);
  results.push({ scenario, ok: result.ok, detail: `${result.trace.length} calls` });
}

async function run(scenario: Scenario, extra: Partial<Parameters<typeof runScenario>[0]>): Promise<void> {
  if (only && only !== scenario) return;
  console.log(`\n─── ${scenario} ─────────────────────────────────────────`);
  await reseed();
  try {
    const result = await runScenario({
      scenario,
      asset: TOKENS.USDC,
      borrowAsset: TOKENS.WETH,
      amount: 25_000_000_000n,
      borrowAmount: 100_000_000_000_000_000n, // 0.1 WETH
      params: '0x',
      entrypoint: 'executeFlashLoan(address,uint256,bytes)',
      ...extra,
    });
    report(scenario, result);
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] ?? 'error' : String(err);
    console.log(`  FAILED: ${message}`);
    results.push({ scenario, ok: false, detail: message.slice(0, 120) });
  }
}

// ---- environment ------------------------------------------------------------------------------

console.log(`deployer  ${account.address}`);
console.log(`block     ${await pub.getBlockNumber()}`);

const pool = (await pub.readContract({
  address: MAINNET_ADDRESSES_PROVIDER,
  abi: addressesProviderAbi,
  functionName: 'getPool',
})) as Address;
const aToken = (await pub.readContract({
  address: pool,
  abi: poolAbi,
  functionName: 'getReserveAToken',
  args: [TOKENS.USDC],
})) as Address;

const config = (await pub.readContract({
  address: pool,
  abi: parseAbi(['function getConfiguration(address asset) view returns (uint256)']),
  functionName: 'getConfiguration',
  args: [TOKENS.USDC],
})) as bigint;

console.log(`Pool      ${pool}  (discovered)`);
console.log(`aUSDC     ${aToken}`);
console.log(`USDC ltv ${config & 0xffffn} · active ${((config >> 56n) & 1n) === 1n} · frozen ${((config >> 57n) & 1n) === 1n}`);

await reseed();

// ---- deploy both presets ----------------------------------------------------------------------

console.log('\ndeploying …');
const vault = await deployContractSource({
  source: read('HardenedAaveV3Vault.sol'),
  contractName: 'HardenedAaveV3Vault',
  constructorArgs: [MAINNET_ADDRESSES_PROVIDER, TOKENS.USDC, account.address, REWARDS_CONTROLLER, 0n],
});
console.log(`  vault     ${vault.address}`);

const receiver = await deployContractSource({
  source: read('HardenedAaveFlashLoanReceiver.sol'),
  contractName: 'HardenedAaveFlashLoanReceiver',
  constructorArgs: [MAINNET_ADDRESSES_PROVIDER, TOKENS.USDC, account.address],
});
console.log(`  receiver  ${receiver.address}`);

// ---- scenarios ---------------------------------------------------------------------------------

await run('vault-deposit', { contractAddress: vault.address });
await run('supply-borrow', {});
await run('flashloan-simple', { contractAddress: receiver.address });
await run('leverage-loop', {});

// ---- summary -----------------------------------------------------------------------------------

console.log('\n═══ summary ═══');
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.scenario.padEnd(18)} ${r.detail}`);
console.log(`\n  vault    ${vault.explorerUrl}`);
console.log(`  receiver ${receiver.explorerUrl}`);

process.exit(results.every((r) => r.ok) ? 0 : 1);
