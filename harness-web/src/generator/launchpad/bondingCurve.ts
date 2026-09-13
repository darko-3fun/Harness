import { ContractBuilder, defineFunctions, setAccessControl, addPausable } from '@openzeppelin/wizard';

import {
  accessOf,
  gate,
  imp,
  print,
  throwIfInvalid,
  validateCommon,
  validateGatedFeatures,
  withPreamble,
  type ValidationMessages,
} from '@/generator/shared';
import { FINDING_IDS, IMPORT_PATHS, UINT_RE, type FindingId, type GenerateOptions } from '@/types';

/**
 * Bonding-curve launch that graduates into a Uniswap V2 pool.
 *
 * The shape is pump.fun's: a constant-product curve over virtual reserves, ETH in
 * and tokens out until a fixed amount of ETH has been raised, then every remaining
 * token and all of the ETH become a Uniswap V2 pool whose LP tokens are burned.
 *
 * What the 2025 launchpad incidents were, and what this contract does about them:
 *
 *   LPAD-CURVE-040  tokens reached the DEX pair before graduation, so an attacker
 *                   seeded the pool at their own price (Four.meme, twice; the
 *                   pump-clone drain). Here the token refuses every transfer that
 *                   is not to or from the curve until the curve has graduated.
 *   LPAD-CURVE-041  the launchpad added liquidity through the router, which quotes
 *                   at whatever ratio the pair already holds. Here the pair is
 *                   created in the constructor and liquidity is minted on the pair
 *                   directly, so a pre-seeded pair cannot set the price or brick
 *                   the graduation.
 *   LPAD-CURVE-042  buy() and sell() take a minimum output and a deadline.
 *   LPAD-CURVE-043  every ETH payout happens after state is final, under a
 *                   reentrancy guard — the Decent Crescendo bug.
 *   LPAD-CURVE-044  the residual reserve is rounded UP on both sides, so the
 *                   trader's output is always floored: a buy-then-sell never
 *                   returns more than it put in.
 *   LPAD-CURVE-045  LP tokens are minted straight to the dead address.
 *   LPAD-CURVE-046  an optional per-wallet cap on the curve (anti-snipe friction).
 *   LPAD-CURVE-047  graduation happens inside the buy that crosses the threshold,
 *                   and the curve refuses trades from then on. The ETH raised is
 *                   never reachable by anyone — there is no admin path to the
 *                   reserves, which is what pump.fun's insider used.
 */

function validate(opts: GenerateOptions): void {
  const messages: ValidationMessages = {};
  validateCommon(opts, messages);
  validateGatedFeatures(opts, messages);
  if (opts.curveSupply === undefined || !UINT_RE.test(opts.curveSupply) || opts.curveSupply === '0') {
    messages.curveSupply = 'Must be a positive whole number of tokens';
  } else if (BigInt(opts.curveSupply) < BigInt(1000)) {
    messages.curveSupply = 'Too small: the curve needs at least 1,000 tokens to have any granularity';
  }
  if (opts.graduationEth === undefined || !UINT_RE.test(opts.graduationEth) || opts.graduationEth === '0') {
    messages.graduationEth = 'Must be a positive amount of wei';
  } else if (BigInt(opts.graduationEth) < BigInt('10000000000000000')) {
    messages.graduationEth = 'Too small: graduate at 0.01 ETH or more, or rounding dominates the curve';
  }
  if (
    opts.tradingFeeBps !== undefined &&
    !(Number.isInteger(opts.tradingFeeBps) && opts.tradingFeeBps >= 0 && opts.tradingFeeBps <= 500)
  ) {
    messages.tradingFeeBps = 'Must be an integer between 0 and 500';
  }
  if (
    opts.maxWalletBps !== undefined &&
    !(
      Number.isInteger(opts.maxWalletBps) &&
      (opts.maxWalletBps === 0 || (opts.maxWalletBps >= 50 && opts.maxWalletBps <= 5000))
    )
  ) {
    messages.maxWalletBps =
      'Must be 0 (no cap) or between 50 and 5000 bps: below 0.5% a wallet cannot make a meaningful buy, above 50% the cap does nothing';
  }
  throwIfInvalid(messages);
}

const PREAMBLE = `/// @dev The slice of Uniswap V2 this launch uses. Declared here rather than imported: the
/// @dev published interfaces compile, but the graduation path deliberately never touches
/// @dev the router (LPAD-CURVE-041), so a two-function pair interface is all that is needed.
interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

interface IUniswapV2Pair {
    function mint(address to) external returns (uint256 liquidity);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

interface IWETH {
    function deposit() external payable;
}

interface ILaunch {
    function graduated() external view returns (bool);
}

/// @dev The token this launch sells. LPAD-CURVE-040 — until the curve graduates, the only
/// @dev transfers allowed are between the curve and holders, so nobody can seed the DEX
/// @dev pair ahead of graduation. That is the Four.meme (Feb and Mar 2025) and the
/// @dev pump-clone (Mar 2025) bug: tokens reached the pair early, the pair was seeded
/// @dev at the attacker's price, and the launchpad added its liquidity into it.
contract LaunchToken is ERC20 {
    address public immutable LAUNCH;

    error TransfersLockedUntilGraduation();

    constructor(string memory name_, string memory symbol_, uint256 supply) ERC20(name_, symbol_) {
        LAUNCH = msg.sender;
        _mint(msg.sender, supply);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && from != LAUNCH && to != LAUNCH && !ILaunch(LAUNCH).graduated()) {
            revert TransfersLockedUntilGraduation();
        }
        super._update(from, to, value);
    }
}`;

export function buildBondingCurve(opts: GenerateOptions): {
  contract: ContractBuilder;
  appliedFindingIds: FindingId[];
} {
  validate(opts);

  const applied: FindingId[] = [];
  const c = new ContractBuilder(opts.name);
  c.license = 'MIT';

  c.addParent(imp('ReentrancyGuard', IMPORT_PATHS.REENTRANCY_GUARD));
  c.addImportOnly(imp('ERC20', IMPORT_PATHS.ERC20));
  c.addImportOnly(imp('IERC20', IMPORT_PATHS.IERC20));
  c.addLibrary(imp('SafeERC20', IMPORT_PATHS.SAFE_ERC20), ['IERC20']);
  applied.push(FINDING_IDS.UNCHECKED_EXTERNAL_CALL);

  c.addNatspecTag('title', opts.name);
  c.addNatspecTag(
    'notice',
    'Bonding-curve launch generated by HARNESS. Tokens are locked until the curve graduates into a Uniswap V2 pool, liquidity is minted on the pair directly and the LP tokens are burned.',
  );

  addCurveConstructor(c, opts, applied);
  addCurveMath(c, opts, applied);
  addBuySell(c, opts, applied);
  addGraduation(c, opts, applied);
  addCurveSurface(c, opts, applied);

  return { contract: c, appliedFindingIds: applied };
}

export function printBondingCurve(opts: GenerateOptions): string {
  const { contract } = buildBondingCurve(opts);
  return withPreamble(print(contract), PREAMBLE);
}

// ---------------------------------------------------------------------------

const DEAD = '0x000000000000000000000000000000000000dEaD';

function addCurveConstructor(c: ContractBuilder, opts: GenerateOptions, applied: FindingId[]): void {
  c.addConstructorArgument({ type: 'string memory', name: 'tokenName_' });
  c.addConstructorArgument({ type: 'string memory', name: 'tokenSymbol_' });
  c.addConstructorArgument({ type: 'address', name: 'factory_' });
  c.addConstructorArgument({ type: 'address', name: 'weth_' });
  c.addConstructorArgument({ type: 'address', name: 'feeRecipient_' });

  const supply = BigInt(opts.curveSupply!);
  // pump.fun's ratios: 800M of 1B on the curve, virtual reserves 30 SOL / 1.073B tokens,
  // graduating at 85 SOL. Scaled to the requested curve supply and ETH target they give a
  // ~15x price climb and a pool that opens at the curve's closing price.
  c.addConstantOrImmutableOrErrorDefinition(
    `uint256 public constant CURVE_SUPPLY = ${supply.toString()} ether;`,
    ['/// @notice Tokens available on the curve (18 decimals).'],
  );
  c.addConstantOrImmutableOrErrorDefinition(
    'uint256 public constant TOTAL_SUPPLY = (CURVE_SUPPLY * 5) / 4;',
    ['/// @notice Curve tokens plus the quarter reserved for the pool.'],
  );
  c.addConstantOrImmutableOrErrorDefinition(
    `uint256 public constant GRADUATION_ETH = ${opts.graduationEth};`,
    ['/// @notice ETH in the curve (net of fees) at which it graduates.'],
  );
  c.addConstantOrImmutableOrErrorDefinition(
    'uint256 public constant VIRTUAL_ETH = (GRADUATION_ETH * 6) / 17;',
    [
      '/// @dev Virtual reserves shaped like pump.fun\'s (30 SOL against 1.073B tokens,',
      '/// @dev graduating at 85 SOL): the curve sells ~99% of CURVE_SUPPLY by graduation',
      '/// @dev and the pool opens at the curve\'s closing price.',
    ],
  );
  c.addConstantOrImmutableOrErrorDefinition(
    'uint256 public constant VIRTUAL_TOKENS = (CURVE_SUPPLY * 1073) / 800;',
    ['/// @dev The token side of the same virtual reserves.'],
  );
  c.addConstantOrImmutableOrErrorDefinition(
    'uint256 public constant K = VIRTUAL_ETH * VIRTUAL_TOKENS;',
    ['/// @dev The constant product. Never recomputed from state, so rounding cannot drift it.'],
  );
  c.addConstantOrImmutableOrErrorDefinition(
    `uint16 public constant FEE_BPS = ${opts.tradingFeeBps ?? 0};`,
    ['/// @notice Fee on the ETH side of every trade, in basis points.'],
  );
  if (opts.maxWalletBps) {
    c.addConstantOrImmutableOrErrorDefinition(
      `uint256 public constant MAX_WALLET = (CURVE_SUPPLY * ${opts.maxWalletBps}) / 10_000;`,
      ['/// @notice LPAD-CURVE-046 — most a single wallet may hold while the curve is open.'],
    );
  }
  c.addConstantOrImmutableOrErrorDefinition(`address public constant DEAD = ${DEAD};`);

  c.addConstantOrImmutableOrErrorDefinition('IERC20 public immutable TOKEN;');
  c.addConstantOrImmutableOrErrorDefinition('address public immutable PAIR;', [
    '/// @notice LPAD-CURVE-041 — created here, in the constructor, so the launch owns the',
    '/// @notice pair from block zero. Nobody else can create it at a price of their choosing.',
  ]);
  c.addConstantOrImmutableOrErrorDefinition('address public immutable WETH;');
  c.addConstantOrImmutableOrErrorDefinition('address public immutable feeRecipient;');

  c.addStateVariable('uint256 public reserveEth;', false);
  c.addStateVariable('uint256 public tokensSold;', false);
  c.addStateVariable('uint256 public pendingFees;', false);
  c.addStateVariable('bool public graduated;', false);

  c.addConstructorCode('TOKEN = IERC20(address(new LaunchToken(tokenName_, tokenSymbol_, TOTAL_SUPPLY)));');
  c.addConstructorCode('WETH = weth_;');
  c.addConstructorCode('feeRecipient = feeRecipient_;');
  c.addConstructorCode('');
  c.addConstructorCode('// LPAD-CURVE-041 — take the pair now. If someone front-ran the deployment');
  c.addConstructorCode('// (the token address is predictable), reuse theirs: it holds no tokens,');
  c.addConstructorCode('// because the token refuses transfers to it until graduation.');
  c.addConstructorCode('address existing = IUniswapV2Factory(factory_).getPair(address(TOKEN), weth_);');
  c.addConstructorCode(
    'PAIR = existing == address(0) ? IUniswapV2Factory(factory_).createPair(address(TOKEN), weth_) : existing;',
  );
  applied.push(FINDING_IDS.CURVE_TRANSFERS_BEFORE_GRADUATION);
  applied.push(FINDING_IDS.CURVE_PAIR_PRESEEDED);

  setAccessControl(c, accessOf(opts));
}

function addCurveMath(c: ContractBuilder, opts: GenerateOptions, applied: FindingId[]): void {
  const fns = defineFunctions({
    virtualReserves: {
      kind: 'public',
      args: [],
      returns: ['uint256 vEth', 'uint256 vTokens'],
      mutability: 'view',
    },
    previewBuy: {
      kind: 'public',
      args: [{ type: 'uint256', name: 'ethIn' }],
      returns: ['uint256 tokensOut'],
      mutability: 'view',
    },
    previewSell: {
      kind: 'public',
      args: [{ type: 'uint256', name: 'tokensIn' }],
      returns: ['uint256 ethOut'],
      mutability: 'view',
    },
    _ceilDiv: {
      kind: 'internal',
      args: [
        { type: 'uint256', name: 'a' },
        { type: 'uint256', name: 'b' },
      ],
      returns: ['uint256'],
      mutability: 'pure',
    },
  });

  c.setFunctionComments(
    [
      '/// @notice The curve\'s virtual reserves, derived from state rather than stored:',
      '/// @notice they cannot disagree with the ETH held or the tokens sold.',
    ],
    fns.virtualReserves,
  );
  c.setFunctionBody(
    ['vEth = VIRTUAL_ETH + reserveEth;', 'vTokens = VIRTUAL_TOKENS - tokensSold;'],
    fns.virtualReserves,
  );

  c.setFunctionComments(
    [
      '/// @notice Tokens received for `ethIn` (net of fee) at the current state.',
      '/// @dev LPAD-CURVE-044 — the residual token reserve is rounded UP, so the output is',
      '/// @dev floored. Rounding always lands on the curve\'s side of the trade.',
    ],
    fns.previewBuy,
  );
  c.setFunctionBody(
    [
      '(uint256 vEth, uint256 vTokens) = virtualReserves();',
      'uint256 vTokensAfter = _ceilDiv(K, vEth + ethIn);',
      'tokensOut = vTokens > vTokensAfter ? vTokens - vTokensAfter : 0;',
    ],
    fns.previewBuy,
  );

  c.setFunctionComments(
    ['/// @notice ETH received for `tokensIn` before the fee. Same rounding rule as previewBuy.'],
    fns.previewSell,
  );
  c.setFunctionBody(
    [
      '(uint256 vEth, uint256 vTokens) = virtualReserves();',
      'uint256 vEthAfter = _ceilDiv(K, vTokens + tokensIn);',
      'ethOut = vEth > vEthAfter ? vEth - vEthAfter : 0;',
    ],
    fns.previewSell,
  );

  c.setFunctionBody(['return a == 0 ? 0 : (a - 1) / b + 1;'], fns._ceilDiv);
  applied.push(FINDING_IDS.CURVE_ROUNDING_FAVOURS_TRADER);
}

function addBuySell(c: ContractBuilder, opts: GenerateOptions, applied: FindingId[]): void {
  const fns = defineFunctions({
    buy: {
      kind: 'external',
      args: [
        { type: 'uint256', name: 'minTokensOut' },
        { type: 'uint256', name: 'deadline' },
      ],
      returns: ['uint256 tokensOut'],
      mutability: 'payable',
    },
    sell: {
      kind: 'external',
      args: [
        { type: 'uint256', name: 'tokensIn' },
        { type: 'uint256', name: 'minEthOut' },
        { type: 'uint256', name: 'deadline' },
      ],
      returns: ['uint256 ethOut'],
      mutability: 'nonpayable',
    },
  });

  c.addConstantOrImmutableOrErrorDefinition('error CurveGraduated();');
  c.addConstantOrImmutableOrErrorDefinition('error DeadlinePassed(uint256 deadline);');
  c.addConstantOrImmutableOrErrorDefinition('error SlippageExceeded(uint256 out, uint256 min);');
  c.addConstantOrImmutableOrErrorDefinition('error ZeroInput();');
  c.addConstantOrImmutableOrErrorDefinition('error ZeroOutput();');
  c.addConstantOrImmutableOrErrorDefinition('error EthTransferFailed(address to, uint256 amount);');
  if (opts.maxWalletBps) {
    c.addConstantOrImmutableOrErrorDefinition('error WalletCapExceeded(uint256 wouldHold, uint256 cap);');
  }
  c.addConstantOrImmutableOrErrorDefinition(
    'event Bought(address indexed buyer, uint256 ethIn, uint256 fee, uint256 tokensOut);',
  );
  c.addConstantOrImmutableOrErrorDefinition(
    'event Sold(address indexed seller, uint256 tokensIn, uint256 fee, uint256 ethOut);',
  );

  const buy: string[] = [
    '// LPAD-CURVE-047 — the curve is closed for good once it has graduated.',
    'if (graduated) revert CurveGraduated();',
    '// LPAD-CURVE-042 — a bound on output and a deadline, or the buy is a free sandwich.',
    'if (block.timestamp > deadline) revert DeadlinePassed(deadline);',
    'if (msg.value == 0) revert ZeroInput();',
    '',
    'uint256 fee = (msg.value * FEE_BPS) / 10_000;',
    'uint256 ethIn = msg.value - fee;',
    'uint256 refund;',
    '',
    '// The buy that crosses the threshold is filled up to it and refunded the rest, so',
    '// graduation is atomic with the crossing trade and nobody can overshoot it.',
    'uint256 remaining = GRADUATION_ETH - reserveEth;',
    'if (ethIn > remaining) {',
    '    ethIn = remaining;',
    '    fee = FEE_BPS == 0 ? 0 : _ceilDiv(ethIn * FEE_BPS, 10_000 - FEE_BPS);',
    '    if (ethIn + fee > msg.value) fee = msg.value - ethIn; // rounding guard',
    '    refund = msg.value - ethIn - fee;',
    '}',
    '',
    'tokensOut = previewBuy(ethIn);',
    'if (tokensOut == 0) revert ZeroOutput();',
    'if (tokensOut < minTokensOut) revert SlippageExceeded(tokensOut, minTokensOut);',
  ];
  if (opts.maxWalletBps) {
    buy.push(
      '// LPAD-CURVE-046 — friction against one wallet sniping the curve. Balances are',
      '// honest here because tokens cannot move between wallets before graduation.',
      'uint256 wouldHold = TOKEN.balanceOf(msg.sender) + tokensOut;',
      'if (wouldHold > MAX_WALLET) revert WalletCapExceeded(wouldHold, MAX_WALLET);',
    );
    applied.push(FINDING_IDS.CURVE_NO_WALLET_CAP);
  }
  buy.push(
    '',
    '// Effects before any transfer (LPAD-CURVE-043).',
    'reserveEth += ethIn;',
    'tokensSold += tokensOut;',
    'pendingFees += fee;',
    'emit Bought(msg.sender, ethIn, fee, tokensOut);',
    '',
    'TOKEN.safeTransfer(msg.sender, tokensOut);',
    'if (reserveEth == GRADUATION_ETH) _graduate();',
    'if (refund != 0) _sendEth(msg.sender, refund);',
  );

  c.setFunctionComments(
    [
      '/// @notice Buy from the curve with ETH. Fills up to the graduation threshold and',
      '/// @notice refunds the rest; the fill that reaches the threshold graduates the curve.',
      '/// @param minTokensOut Revert if fewer tokens would be received (LPAD-CURVE-042).',
      '/// @param deadline Revert if mined after this timestamp (LPAD-CURVE-042).',
    ],
    fns.buy,
  );
  c.setFunctionBody(buy, fns.buy);
  c.addModifier('nonReentrant', fns.buy);

  c.setFunctionComments(
    [
      '/// @notice Sell tokens back to the curve for ETH. Requires a prior approval.',
      '/// @dev LPAD-CURVE-043 — state is final and the tokens are in before any ETH leaves,',
      '/// @dev under a reentrancy guard. A receive() that calls back in reverts.',
    ],
    fns.sell,
  );
  c.setFunctionBody(
    [
      'if (graduated) revert CurveGraduated();',
      'if (block.timestamp > deadline) revert DeadlinePassed(deadline);',
      'if (tokensIn == 0) revert ZeroInput();',
      '',
      'uint256 gross = previewSell(tokensIn);',
      'if (gross == 0) revert ZeroOutput();',
      'uint256 fee = (gross * FEE_BPS) / 10_000;',
      'ethOut = gross - fee;',
      'if (ethOut < minEthOut) revert SlippageExceeded(ethOut, minEthOut);',
      '',
      '// Effects before interactions (LPAD-CURVE-043).',
      'reserveEth -= gross;',
      'tokensSold -= tokensIn;',
      'pendingFees += fee;',
      'emit Sold(msg.sender, tokensIn, fee, ethOut);',
      '',
      'TOKEN.safeTransferFrom(msg.sender, address(this), tokensIn);',
      '_sendEth(msg.sender, ethOut);',
    ],
    fns.sell,
  );
  c.addModifier('nonReentrant', fns.sell);

  const send = defineFunctions({
    _sendEth: {
      kind: 'internal',
      args: [
        { type: 'address', name: 'to' },
        { type: 'uint256', name: 'amount' },
      ],
      mutability: 'nonpayable',
    },
  });
  c.setFunctionComments(
    ['/// @dev call(), never transfer(): a 2300-gas stipend strands contract recipients.'],
    send._sendEth,
  );
  c.setFunctionBody(
    ['(bool ok,) = to.call{value: amount}("");', 'if (!ok) revert EthTransferFailed(to, amount);'],
    send._sendEth,
  );

  applied.push(FINDING_IDS.CURVE_NO_SLIPPAGE_OR_DEADLINE);
  applied.push(FINDING_IDS.CURVE_SELL_REENTRANCY);
  applied.push(FINDING_IDS.CURVE_TRADING_AFTER_GRADUATION);

  if (opts.pausable) {
    addPausable(c, accessOf(opts), [fns.buy, fns.sell]);
    applied.push(FINDING_IDS.RISK_CAPS_AND_PAUSE_REVERTS);
  }
}

function addGraduation(c: ContractBuilder, opts: GenerateOptions, applied: FindingId[]): void {
  const fns = defineFunctions({
    _graduate: { kind: 'internal', args: [], mutability: 'nonpayable' },
  });

  c.addConstantOrImmutableOrErrorDefinition(
    'event Graduated(address indexed pair, uint256 tokens, uint256 eth, uint256 liquidity);',
  );

  c.setFunctionComments(
    [
      '/// @dev Moves every remaining token and all raised ETH into the pair and burns the LP.',
      '/// @dev LPAD-CURVE-041 — liquidity is minted on the pair directly. The router would',
      '/// @dev quote against whatever the pair already holds; the pair itself prices a first',
      '/// @dev mint from the amounts transferred in. Anything donated to the pair beforehand',
      '/// @dev (only WETH is possible, the token is locked) simply becomes pool depth.',
      '/// @dev LPAD-CURVE-045 — the LP tokens go to the dead address, not to an owner.',
      '/// @dev The pool opens at the curve\'s closing price by construction of the constants.',
    ],
    fns._graduate,
  );
  c.setFunctionBody(
    [
      '// Effect first: lifting the transfer lock is what lets the tokens reach the pair.',
      'graduated = true;',
      'uint256 ethForPool = reserveEth;',
      'reserveEth = 0;',
      'uint256 tokensForPool = TOKEN.balanceOf(address(this));',
      '',
      'IWETH(WETH).deposit{value: ethForPool}();',
      'IERC20(WETH).safeTransfer(PAIR, ethForPool);',
      'TOKEN.safeTransfer(PAIR, tokensForPool);',
      'uint256 liquidity = IUniswapV2Pair(PAIR).mint(DEAD);',
      'emit Graduated(PAIR, tokensForPool, ethForPool, liquidity);',
    ],
    fns._graduate,
  );
  applied.push(FINDING_IDS.CURVE_LP_RETAINED);
  void opts;
}

function addCurveSurface(c: ContractBuilder, opts: GenerateOptions, applied: FindingId[]): void {
  const fns = defineFunctions({
    withdrawFees: { kind: 'external', args: [], mutability: 'nonpayable' },
  });
  c.setFunctionComments(
    [
      '/// @notice Pays accrued fees to the fee recipient. Permissionless and pull-based, so a',
      '/// @notice recipient that cannot receive ETH can never block a trade or the graduation.',
    ],
    fns.withdrawFees,
  );
  c.setFunctionBody(
    ['uint256 amount = pendingFees;', 'pendingFees = 0;', '_sendEth(feeRecipient, amount);'],
    fns.withdrawFees,
  );
  c.addModifier('nonReentrant', fns.withdrawFees);

  if (opts.sweepEscapeHatch) {
    const sweep = defineFunctions({
      sweep: {
        kind: 'external',
        args: [
          { type: 'address', name: 'token' },
          { type: 'address', name: 'to' },
        ],
        mutability: 'nonpayable',
      },
    });
    c.setFunctionComments(
      [
        '/// @notice AAVE-VLT-009 — recover tokens that arrived by mistake.',
        '/// @dev The launch token and WETH are excluded: the first is the inventory, the',
        '/// @dev second is what the pool is seeded with. ETH is not reachable at all.',
      ],
      sweep.sweep,
    );
    c.setFunctionBody(
      [
        'if (token == address(TOKEN) || token == WETH) revert CannotSweepPrincipal(token);',
        '',
        'uint256 balance = IERC20(token).balanceOf(address(this));',
        'IERC20(token).safeTransfer(to, balance);',
        'emit Swept(token, to, balance);',
      ],
      sweep.sweep,
    );
    c.addConstantOrImmutableOrErrorDefinition('error CannotSweepPrincipal(address token);');
    c.addConstantOrImmutableOrErrorDefinition(
      'event Swept(address indexed token, address indexed to, uint256 amount);',
    );
    gate(c, sweep.sweep, opts, 'SWEEPER', undefined);
    applied.push(FINDING_IDS.VAULT_NO_ESCAPE_HATCH);
  }
}
