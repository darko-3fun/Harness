import { ContractBuilder, defineFunctions } from '@openzeppelin/wizard';

import { imp } from '@/generator/shared';
import { FINDING_IDS, IMPORT_PATHS, type FindingId, type GenerateOptions } from '@/types';

/**
 * Honest ERC-4626 limits, shared by every vault preset.
 *
 * EIP-4626 says maxDeposit "MUST return 0 if deposits are entirely disabled"
 * and maxWithdraw "MUST factor in both global and user-specific limits". A vault
 * whose _deposit is `whenNotPaused` while maxDeposit still answers uint256.max
 * breaks every integrator that checks the limit before calling — which is what
 * the standard tells them to do. The same holds for a lending market that has
 * paused, frozen or filled the reserve, or that has no liquidity left to pay a
 * withdrawal: the vault knows, so it should say so instead of reverting.
 *
 * This is the constructive half of AAVE-RISK-010. The pause switch keeps the
 * operator in control; these overrides make the condition visible to callers.
 */
export interface LimitSources {
  /** Lines that `return 0;` when the market refuses supply, e.g. `if (X.isSupplyPaused()) return 0;`. */
  depositBlocked: string[];
  /** Lines that lower `room` below the market's supply headroom, if the market has one. */
  depositRoom: string[];
  /** Lines that `return 0;` when the market refuses withdrawals. */
  withdrawBlocked: string[];
  /** An expression for the underlying the market can pay out right now. */
  liquidity: string;
}

export function addErc4626Limits(
  c: ContractBuilder,
  opts: GenerateOptions,
  applied: FindingId[],
  src: LimitSources,
): void {
  c.addImportOnly(imp('Math', IMPORT_PATHS.MATH));

  const fns = defineFunctions({
    maxDeposit: {
      kind: 'public',
      args: [{ type: 'address', name: '' }],
      returns: ['uint256'],
      mutability: 'view',
    },
    maxMint: {
      kind: 'public',
      args: [{ type: 'address', name: 'receiver' }],
      returns: ['uint256'],
      mutability: 'view',
    },
    maxWithdraw: {
      kind: 'public',
      args: [{ type: 'address', name: 'owner' }],
      returns: ['uint256'],
      mutability: 'view',
    },
    maxRedeem: {
      kind: 'public',
      args: [{ type: 'address', name: 'owner' }],
      returns: ['uint256'],
      mutability: 'view',
    },
  });

  const deposit: string[] = [];
  if (opts.pausable) deposit.push('if (paused()) return 0;');
  deposit.push(...src.depositBlocked);
  deposit.push('', 'uint256 room = type(uint256).max;', ...src.depositRoom);
  if (opts.depositCap !== undefined) {
    deposit.push(
      'if (DEPOSIT_CAP <= _managedAssets) return 0;',
      'uint256 capRoom = DEPOSIT_CAP - _managedAssets;',
      'if (capRoom < room) room = capRoom;',
    );
  }
  deposit.push('return room;');

  c.setFunctionComments(
    [
      '/// @notice AAVE-RISK-010 — the limit tells the truth. Zero while paused or while the',
      '/// @notice market refuses supply, the remaining headroom otherwise, so an integrator',
      '/// @notice that checks before depositing never hits a revert.',
    ],
    fns.maxDeposit,
  );
  c.setFunctionBody(deposit, fns.maxDeposit);
  c.addOverride({ name: 'ERC4626' }, fns.maxDeposit);

  c.setFunctionBody(
    [
      'uint256 assets = maxDeposit(receiver);',
      'return assets == type(uint256).max ? assets : _convertToShares(assets, Math.Rounding.Floor);',
    ],
    fns.maxMint,
  );
  c.addOverride({ name: 'ERC4626' }, fns.maxMint);

  c.setFunctionComments(
    [
      '/// @notice Bounded by what the market can actually pay out right now, not only by',
      '/// @notice the caller\'s shares. A withdrawal inside this limit does not revert.',
    ],
    fns.maxWithdraw,
  );
  c.setFunctionBody(
    [
      ...src.withdrawBlocked,
      'uint256 own = _convertToAssets(balanceOf(owner), Math.Rounding.Floor);',
      `uint256 liquid = ${src.liquidity};`,
      'return own < liquid ? own : liquid;',
    ],
    fns.maxWithdraw,
  );
  c.addOverride({ name: 'ERC4626' }, fns.maxWithdraw);

  c.setFunctionBody(
    [
      ...src.withdrawBlocked,
      'uint256 own = balanceOf(owner);',
      `uint256 liquid = ${src.liquidity};`,
      '// Compared in assets: converting the liquidity to shares would floor away the',
      '// last share and refuse a holder whose whole position fits.',
      'if (_convertToAssets(own, Math.Rounding.Floor) <= liquid) return own;',
      'return _convertToShares(liquid, Math.Rounding.Floor);',
    ],
    fns.maxRedeem,
  );
  c.addOverride({ name: 'ERC4626' }, fns.maxRedeem);

  if (!applied.includes(FINDING_IDS.RISK_CAPS_AND_PAUSE_REVERTS)) {
    applied.push(FINDING_IDS.RISK_CAPS_AND_PAUSE_REVERTS);
  }
}
