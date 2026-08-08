// B8 — seed the virtual net so the demo account visibly holds real USDC/WETH on the explorer.

import { formatUnits } from 'viem';
import { DECIMALS, TOKENS, erc20Abi } from '../aave.js';
import { deployerAccount, publicClient, setErc20Balance, setNativeBalance } from '../tenderly.js';

const SEED = [
  { token: TOKENS.USDC, amount: 1_000_000n * 10n ** 6n },
  { token: TOKENS.WETH, amount: 500n * 10n ** 18n },
] as const;

async function main(): Promise<void> {
  const account = deployerAccount();
  const pub = publicClient();

  await setNativeBalance(account.address, 1000n * 10n ** 18n);
  for (const { token, amount } of SEED) await setErc20Balance(token, account.address, amount);

  console.log(`Seeded ${account.address}`);
  console.log(`  ETH   ${formatUnits(await pub.getBalance({ address: account.address }), 18)}`);
  for (const { token } of SEED) {
    const balance = (await pub.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    })) as bigint;
    console.log(`  ${token}  ${formatUnits(balance, DECIMALS[token.toLowerCase()] ?? 18)}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
