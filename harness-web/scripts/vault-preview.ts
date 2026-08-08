import { printErc4626Vault } from '../src/generator/aave/erc4626Vault';
import type { GenerateOptions } from '../src/types';
const opts: GenerateOptions = {
  preset: 'aave-v3-erc4626-vault', name: 'MyAaveVault', access: 'ownable', pausable: true,
  asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  routerAllowlist: false, claimRewards: true, sweepEscapeHatch: true,
  depositCap: '10000000000000', feeBps: 200,
};
console.log(printErc4626Vault(opts));
