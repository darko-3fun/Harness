import { ContractBuilder, defineFunctions, requireAccessControl } from '@openzeppelin/wizard';

import { accessOf } from '@/generator/shared';
import type { GenerateOptions } from '@/types';

/**
 * Yield booking shared by every vault preset: harvest(), the optional fee, and
 * the clamp that keeps the book from ever exceeding the market position.
 *
 * Two decisions here came out of running the property suite against the real
 * markets rather than out of a design document:
 *
 *   - the fee is ACCRUED by harvest() and paid out by collectFees(). A harvest
 *     that tried to withdraw a dust-sized fee would be refused by the market (a
 *     withdraw whose scaled amount rounds to zero reverts on Aave) and would
 *     block the whole harvest;
 *   - every path that moves the position ends with _clampToPosition(). Aave and
 *     Morpho round the position down by up to a unit on each withdraw, Comet on
 *     each supply and withdraw. A book that exceeds the real position by a single
 *     wei fails the last redeemer, so the excess is written off — from the
 *     pending fee first, then from the book.
 */
export interface YieldSources {
  /** Expression for the vault's position in the market, interest accrued. */
  position: string;
  /** Lines that pay `fee` to `feeRecipient` and leave the amount paid in `paid`. */
  payFee: string[];
  /** Extra @dev lines for harvest(). */
  notes: string[];
}

export function addYieldBooking(c: ContractBuilder, opts: GenerateOptions, src: YieldSources): void {
  const fns = defineFunctions({
    harvest: { kind: 'external', args: [], returns: ['uint256'], mutability: 'nonpayable' },
    collectFees: { kind: 'external', args: [], returns: ['uint256'], mutability: 'nonpayable' },
    _clampToPosition: { kind: 'internal', args: [], mutability: 'nonpayable' },
  });

  c.addConstantOrImmutableOrErrorDefinition('event Harvested(uint256 yield, uint256 fee);');

  const body = [`uint256 held = ${src.position};`];

  if (opts.feeBps) {
    c.addConstantOrImmutableOrErrorDefinition(`uint16 public constant FEE_BPS = ${opts.feeBps};`, [
      '/// @notice Performance fee on yield, in basis points. Never on principal.',
    ]);
    c.addStateVariable('address public feeRecipient;', false);
    c.addStateVariable('uint256 public pendingFees;', false);
    c.addConstructorArgument({ type: 'address', name: 'feeRecipient_' });
    c.addConstructorCode('feeRecipient = feeRecipient_;');
    c.addConstantOrImmutableOrErrorDefinition('event FeesCollected(address indexed to, uint256 amount);');

    body.push(
      'uint256 booked = _managedAssets + pendingFees;',
      'if (held <= booked) return 0;',
      '',
      'uint256 yield_ = held - booked;',
      'uint256 fee = (yield_ * FEE_BPS) / 10_000;',
      'pendingFees += fee;',
      '_managedAssets += yield_ - fee;',
      'emit Harvested(yield_, fee);',
      'return yield_;',
    );

    c.setFunctionComments(
      [
        '/// @notice Pays the accrued fee to the fee recipient.',
        '/// @dev Separate from harvest() so a dust-sized fee — which the market would',
        '/// @dev refuse to pay out — can never block the booking of yield.',
      ],
      fns.collectFees,
    );
    c.setFunctionBody(
      [
        'uint256 fee = pendingFees;',
        'if (fee == 0) return 0;',
        'pendingFees = 0;',
        ...src.payFee,
        '// Whatever the market did not pay stays in the position, booked to depositors.',
        'if (paid < fee) _managedAssets += fee - paid;',
        '_clampToPosition();',
        'emit FeesCollected(feeRecipient, paid);',
        'return paid;',
      ],
      fns.collectFees,
    );
    requireAccessControl(c, fns.collectFees, accessOf(opts), 'HARVESTER', undefined);
  } else {
    body.push(
      'if (held <= _managedAssets) return 0;',
      '',
      'uint256 yield_ = held - _managedAssets;',
      '_managedAssets = held;',
      'emit Harvested(yield_, 0);',
      'return yield_;',
    );
  }

  c.setFunctionComments(
    ['/// @notice Credits accrued interest to the vault, taking the fee on yield only.', ...src.notes],
    fns.harvest,
  );
  c.setFunctionBody(body, fns.harvest);
  requireAccessControl(c, fns.harvest, accessOf(opts), 'HARVESTER', 'harvester');

  c.setFunctionComments(
    [
      '/// @dev The market rounds the position down by up to a unit on some operations. A',
      '/// @dev book that exceeds the real position by even a wei fails the last redeemer,',
      '/// @dev so the excess is written off — from the pending fee first, then the book.',
    ],
    fns._clampToPosition,
  );
  c.setFunctionBody(
    opts.feeBps
      ? [
          `uint256 held = ${src.position};`,
          'uint256 booked = _managedAssets + pendingFees;',
          'if (booked <= held) return;',
          'uint256 excess = booked - held;',
          'if (excess <= pendingFees) {',
          '    pendingFees -= excess;',
          '} else {',
          '    _managedAssets -= excess - pendingFees;',
          '    pendingFees = 0;',
          '}',
        ]
      : [
          `uint256 held = ${src.position};`,
          'if (_managedAssets > held) _managedAssets = held;',
        ],
    fns._clampToPosition,
  );
}
