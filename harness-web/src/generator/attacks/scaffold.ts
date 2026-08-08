import { MAINNET } from '@/generator/attacks/addresses';
import type { GenerateOptions, Preset } from '@/types';

/**
 * Per-preset test scaffolding. A flash-loan receiver and a vault need different
 * setUp bodies, helpers and placeholders, so the assembler asks for a scaffold
 * rather than branching on the preset in six places.
 */
export interface Scaffold {
  constants: string[];
  state: string[];
  setUp: string[];
  helpers: string[];
  subs: Record<string, string>;
  /** Maps a constructor argument name onto the expression the test passes. */
  bindings: Record<string, string>;
}

const COMMON_SUBS = {
  '{{POOL}}': 'POOL',
  '{{ASSET}}': 'ASSET',
  '{{ATOKEN}}': 'ATOKEN',
  '{{OWNER}}': 'owner',
  '{{CONTRACT}}': 'harness',
};

export function scaffoldFor(opts: GenerateOptions): Scaffold {
  return opts.preset === 'aave-v3-flashloan-receiver' ? flashLoan(opts) : vault(opts);
}

function flashLoan(opts: GenerateOptions): Scaffold {
  return {
    constants: [
      `address internal constant ASSET = ${opts.asset ?? MAINNET.USDC};`,
      `address internal constant ATOKEN = ${MAINNET.aUSDC};`,
    ],
    state: ['IPool internal POOL;', `${opts.name} internal harness;`, 'address internal owner;'],
    setUp: [
      'POOL = IPool(PROVIDER.getPool());',
      'owner = makeAddr("owner");',
    ],
    helpers: [
      '/// @dev A valid, benign FlashParams. Attack tests deviate from this deliberately.',
      `function _defaultFlashParams() internal pure returns (${opts.name}.FlashParams memory) {`,
      `    return ${opts.name}.FlashParams({`,
      ...flashParamFields(opts).map((f, i, a) => `        ${f}${i === a.length - 1 ? '' : ','}`),
      '    });',
      '}',
      '',
      'function _defaultParams() internal pure returns (bytes memory) {',
      '    return abi.encode(_defaultFlashParams());',
      '}',
    ],
    subs: {
      ...COMMON_SUBS,
      '{{CONTRACT_TYPE}}': opts.name,
      '{{PARAMS}}': '_defaultParams()',
      '{{PARAMS_STRUCT}}': '_defaultFlashParams()',
    },
    bindings: {
      addressesProvider: 'address(PROVIDER)',
      asset_: 'ASSET',
      initialOwner: 'owner',
      defaultAdmin: 'owner',
      operator: 'owner',
      rewardsController: 'REWARDS_CONTROLLER',
    },
  };
}

function vault(opts: GenerateOptions): Scaffold {
  return {
    constants: [
      `address internal constant ASSET = ${opts.asset ?? MAINNET.USDC};`,
      `address internal constant ATOKEN = ${MAINNET.aUSDC};`,
    ],
    state: [
      'IPool internal POOL;',
      `${opts.name} internal harness;`,
      'address internal owner;',
      'address internal alice;',
      'address internal bob;',
    ],
    setUp: [
      'POOL = IPool(PROVIDER.getPool());',
      'owner = makeAddr("owner");',
      'alice = makeAddr("alice");',
      'bob = makeAddr("bob");',
    ],
    helpers: [
      '/// @dev Funds `who` and deposits into the vault on their behalf.',
      'function _deposit(address who, uint256 assets) internal returns (uint256 shares) {',
      '    deal(ASSET, who, assets);',
      '    vm.startPrank(who);',
      '    IERC20(ASSET).approve(address(harness), assets);',
      '    shares = harness.deposit(assets, who);',
      '    vm.stopPrank();',
      '}',
    ],
    subs: { ...COMMON_SUBS, '{{CONTRACT_TYPE}}': opts.name },
    bindings: {
      addressesProvider: 'address(PROVIDER)',
      asset_: 'IERC20(ASSET)',
      initialOwner: 'owner',
      defaultAdmin: 'owner',
      harvester: 'owner',
      feeRecipient_: 'owner',
      rewardsController: 'REWARDS_CONTROLLER',
    },
  };
}

function flashParamFields(opts: GenerateOptions): string[] {
  const fields = ['minAmountOut: 1', 'deadline: type(uint256).max'];
  if (opts.routerAllowlist) fields.push('router: address(0)');
  return fields;
}

export const PRESET_LIST: Preset[] = ['aave-v3-flashloan-receiver', 'aave-v3-erc4626-vault'];
