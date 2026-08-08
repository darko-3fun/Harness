import type { ContractBuilder } from '@openzeppelin/wizard';

import { buildFlashLoanReceiver, printFlashLoanReceiver } from '@/generator/aave/flashLoanReceiver';
import { buildErc4626Vault, printErc4626Vault } from '@/generator/aave/erc4626Vault';
import type { FindingId, GenerateOptions, Preset } from '@/types';

/**
 * The one place presets are dispatched. Everything downstream — the assembler, the
 * deploy script, the UI — goes through here, so adding a preset means adding a case
 * rather than hunting for switch statements.
 */
export function buildPreset(opts: GenerateOptions): {
  contract: ContractBuilder;
  appliedFindingIds: FindingId[];
} {
  switch (opts.preset) {
    case 'aave-v3-flashloan-receiver':
      return buildFlashLoanReceiver(opts);
    case 'aave-v3-erc4626-vault':
      return buildErc4626Vault(opts);
  }
}

export function printPreset(opts: GenerateOptions): string {
  switch (opts.preset) {
    case 'aave-v3-flashloan-receiver':
      return printFlashLoanReceiver(opts);
    case 'aave-v3-erc4626-vault':
      return printErc4626Vault(opts);
  }
}

export const PRESET_LABELS: Record<Preset, string> = {
  'aave-v3-flashloan-receiver': 'Aave V3 Flash Loan Receiver',
  'aave-v3-erc4626-vault': 'Aave V3 ERC-4626 Vault',
};

export const PRESET_BLURBS: Record<Preset, string> = {
  'aave-v3-flashloan-receiver':
    'Callback gated to the Pool and to self-initiated loans. The bug that drained DODO and Mimo.',
  'aave-v3-erc4626-vault':
    'Share price from internal accounting, not a donatable aToken balance. The PoolTogether bug.',
};

/** Defaults that produce a good-looking contract with one click. §A8: never type on stage. */
export const PRESET_DEFAULTS: Record<Preset, GenerateOptions> = {
  'aave-v3-flashloan-receiver': {
    preset: 'aave-v3-flashloan-receiver',
    name: 'MyFlashLoanReceiver',
    access: 'ownable',
    pausable: true,
    asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    routerAllowlist: true,
    claimRewards: false,
    sweepEscapeHatch: true,
  },
  'aave-v3-erc4626-vault': {
    preset: 'aave-v3-erc4626-vault',
    name: 'MyAaveVault',
    access: 'ownable',
    pausable: true,
    asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    routerAllowlist: false,
    claimRewards: true,
    sweepEscapeHatch: true,
    depositCap: '10000000000000',
    feeBps: 200,
  },
};
