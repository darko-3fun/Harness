import type { ContractBuilder } from '@openzeppelin/wizard';

import { buildFlashLoanReceiver, printFlashLoanReceiver } from '@/generator/aave/flashLoanReceiver';
import { buildErc4626Vault, printErc4626Vault } from '@/generator/aave/erc4626Vault';
import { buildMorphoVault, printMorphoVault } from '@/generator/morpho/morphoVault';
import { buildCometVault, printCometVault } from '@/generator/compound/cometVault';
import { buildTokenSale, printTokenSale } from '@/generator/launchpad/tokenSale';
import { buildBondingCurve, printBondingCurve } from '@/generator/launchpad/bondingCurve';
import { USDC } from '@/generator/markets';
import { PRESET_CATEGORY, type FindingId, type GenerateOptions, type Preset, type PresetCategory } from '@/types';

export interface BuiltPreset {
  contract: ContractBuilder;
  appliedFindingIds: FindingId[];
}

/**
 * The one place presets are dispatched. Everything downstream — the assemblers, the
 * deploy script, the UI — goes through here, so adding a preset means adding a case
 * rather than hunting for switch statements. The switch is exhaustive: a new Preset
 * member that is not handled here is a compile error.
 */
export function buildPreset(opts: GenerateOptions): BuiltPreset {
  switch (opts.preset) {
    case 'aave-v3-flashloan-receiver':
      return buildFlashLoanReceiver(opts);
    case 'aave-v3-erc4626-vault':
      return buildErc4626Vault(opts);
    case 'morpho-blue-vault':
      return buildMorphoVault(opts);
    case 'compound-v3-vault':
      return buildCometVault(opts);
    case 'token-sale-launchpad':
      return buildTokenSale(opts);
    case 'bonding-curve-launchpad':
      return buildBondingCurve(opts);
  }
}

export function printPreset(opts: GenerateOptions): string {
  switch (opts.preset) {
    case 'aave-v3-flashloan-receiver':
      return printFlashLoanReceiver(opts);
    case 'aave-v3-erc4626-vault':
      return printErc4626Vault(opts);
    case 'morpho-blue-vault':
      return printMorphoVault(opts);
    case 'compound-v3-vault':
      return printCometVault(opts);
    case 'token-sale-launchpad':
      return printTokenSale(opts);
    case 'bonding-curve-launchpad':
      return printBondingCurve(opts);
  }
}

export const PRESET_LABELS: Record<Preset, string> = {
  'aave-v3-erc4626-vault': 'Aave V3 Vault',
  'morpho-blue-vault': 'Morpho Blue Vault',
  'compound-v3-vault': 'Compound V3 Vault',
  'token-sale-launchpad': 'Token Sale',
  'bonding-curve-launchpad': 'Bonding Curve',
  'aave-v3-flashloan-receiver': 'Aave V3 Flash Loan Receiver',
};

/** One line under the preset name: what it is and which documented bug it exists to avoid. */
export const PRESET_BLURBS: Record<Preset, string> = {
  'aave-v3-erc4626-vault':
    'ERC-4626 over Aave v3. Share price from internal accounting, not a donatable aToken balance — the PoolTogether bug.',
  'morpho-blue-vault':
    'ERC-4626 over one pinned Morpho Blue market. No callback surface, assets and shares kept mutually exclusive.',
  'compound-v3-vault':
    'ERC-4626 over a Compound v3 Comet. Withdrawals capped at the supplied balance, so a gifted collateral position can never turn an exit into a borrow.',
  'token-sale-launchpad':
    'Fixed-price sale with caps, an optional Merkle allowlist, vesting and pull-based refunds. Raised funds cannot move until the sale is finalized.',
  'bonding-curve-launchpad':
    'Constant-product curve that graduates into a Uniswap V2 pool. Tokens are locked until graduation, so the pool cannot be pre-seeded — the Four.meme bug.',
  'aave-v3-flashloan-receiver':
    'Callback gated to the Pool and to self-initiated loans. The bug that drained DODO and Mimo.',
};

export const PRESETS_BY_CATEGORY: Record<PresetCategory, Preset[]> = {
  vault: ['aave-v3-erc4626-vault', 'morpho-blue-vault', 'compound-v3-vault'],
  launchpad: ['token-sale-launchpad', 'bonding-curve-launchpad'],
  flashloan: ['aave-v3-flashloan-receiver'],
};

export const categoryOf = (p: Preset): PresetCategory => PRESET_CATEGORY[p];

const VAULT_COMMON = {
  access: 'ownable' as const,
  pausable: true,
  asset: USDC,
  routerAllowlist: false,
  sweepEscapeHatch: true,
  depositCap: '10000000000000',
  feeBps: 200,
  decimalsOffset: 6,
};

/** Defaults that produce a good-looking contract with one click. Never type on stage. */
export const PRESET_DEFAULTS: Record<Preset, GenerateOptions> = {
  'aave-v3-erc4626-vault': {
    preset: 'aave-v3-erc4626-vault',
    name: 'MyAaveVault',
    claimRewards: true,
    ...VAULT_COMMON,
  },
  'morpho-blue-vault': {
    preset: 'morpho-blue-vault',
    name: 'MyMorphoVault',
    claimRewards: false,
    ...VAULT_COMMON,
  },
  'compound-v3-vault': {
    preset: 'compound-v3-vault',
    name: 'MyCompoundVault',
    claimRewards: true,
    ...VAULT_COMMON,
  },
  'token-sale-launchpad': {
    preset: 'token-sale-launchpad',
    name: 'MyTokenSale',
    access: 'ownable',
    pausable: true,
    routerAllowlist: false,
    claimRewards: false,
    sweepEscapeHatch: true,
    tokenPriceWei: '100000000000000',      // 0.0001 ETH per token
    hardCapWei: '100000000000000000000',   // 100 ETH
    softCapWei: '20000000000000000000',    // 20 ETH
    minContributionWei: '10000000000000000',   // 0.01 ETH
    maxContributionWei: '5000000000000000000', // 5 ETH per wallet
    whitelist: true,
    vestingCliffDays: 7,
    vestingDurationDays: 90,
  },
  'bonding-curve-launchpad': {
    preset: 'bonding-curve-launchpad',
    name: 'MyLaunch',
    access: 'ownable',
    pausable: true,
    routerAllowlist: false,
    claimRewards: false,
    sweepEscapeHatch: false,
    curveSupply: '800000000',              // 800M of a 1B supply sold on the curve
    graduationEth: '4000000000000000000',  // 4 ETH
    tradingFeeBps: 100,
    maxWalletBps: 500,                     // 5% of the curve supply per wallet
  },
  'aave-v3-flashloan-receiver': {
    preset: 'aave-v3-flashloan-receiver',
    name: 'MyFlashLoanReceiver',
    access: 'ownable',
    pausable: true,
    asset: USDC,
    routerAllowlist: true,
    claimRewards: false,
    sweepEscapeHatch: true,
  },
};
