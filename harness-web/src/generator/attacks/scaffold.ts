import {
  AAVE_MAINNET,
  COMET_REWARDS,
  MORPHO_BLUE,
  UNISWAP_V2,
  assetByAddress,
  assetBySymbol,
  cometFor,
  resolveMorphoMarket,
  USDC,
} from '@/generator/markets';
import { IMPORT_PATHS, type GenerateOptions } from '@/types';

/**
 * Test actors come from `_fresh(label)`, not `makeAddr(label)`. The keys behind
 * common labels ("alice", "owner") are public, and on mainnet those accounts now
 * carry EIP-7702 delegation code that forwards any ETH they receive — so a refund
 * paid to _fresh("alice") on a fork silently disappears. A project-specific
 * prefix avoids the famous addresses, and any delegation is cleared regardless.
 */
export const FRESH_HELPER = (name: string): string[] => [
  '/// @dev A plain account for this suite. Common labels ("alice", "owner") have public keys',
  '/// @dev and carry EIP-7702 delegation code on mainnet that swallows ETH sent to them, so',
  '/// @dev the label is prefixed and any code at the address is cleared.',
  'function _fresh(string memory label) internal returns (address a) {',
  `    a = makeAddr(string(abi.encodePacked("harness/${name}/", label)));`,
  '    if (a.code.length != 0) vm.etch(a, "");',
  '}',
];


/**
 * Per-preset test and deploy scaffolding.
 *
 * A flash-loan receiver, a vault and a launchpad need different setUp bodies,
 * helpers and placeholders, so the assemblers ask for a scaffold rather than
 * branching on the preset in a dozen places.
 *
 * Everything asset-specific is resolved at run time on the fork — the aToken from
 * the Pool, the decimals from the token — so the same suite is valid for any
 * asset the user picks. The previous scaffold hard-coded aUSDC and six-decimal
 * amounts, which meant choosing WETH produced a suite that could not pass.
 */
export interface Scaffold {
  /** Preset-specific imports. The shared ones are emitted by the assembler. */
  imports: string[];
  constants: string[];
  state: string[];
  setUp: string[];
  /** Lines that run after `harness` has been constructed. */
  afterDeploy?: string[];
  helpers: string[];
  subs: Record<string, string>;
  /** Maps a constructor argument name onto the expression the test passes. */
  bindings: Record<string, string>;
  /** The same for the deploy script, whose constants are addresses rather than fixtures. */
  deploy: { constants: string[]; bindings: Record<string, string> };
  /** Does the suite deal with Aave's Pool (imports IPool + the provider)? */
  aave: boolean;
}

const COMMON_SUBS = {
  '{{POOL}}': 'POOL',
  '{{ASSET}}': 'ASSET',
  '{{ATOKEN}}': 'ATOKEN',
  '{{OWNER}}': 'owner',
  '{{CONTRACT}}': 'harness',
  '{{ONE}}': 'ONE',
  '{{AMOUNT}}': 'AMOUNT',
};

export function scaffoldFor(opts: GenerateOptions): Scaffold {
  const s = rawScaffold(opts);
  return { ...s, helpers: [...FRESH_HELPER(opts.name), '', ...s.helpers] };
}

function rawScaffold(opts: GenerateOptions): Scaffold {
  switch (opts.preset) {
    case 'aave-v3-flashloan-receiver':
      return flashLoan(opts);
    case 'aave-v3-erc4626-vault':
      return aaveVault(opts);
    case 'morpho-blue-vault':
      return morphoVault(opts);
    case 'compound-v3-vault':
      return cometVault(opts);
    case 'token-sale-launchpad':
      return tokenSale(opts);
    case 'bonding-curve-launchpad':
      return bondingCurve(opts);
  }
}

/**
 * `AMOUNT` is roughly a thousand dollars of the asset, so a suite that deposits
 * `AMOUNT` and donates `500 * AMOUNT` stays well inside every reserve's supply cap
 * whether the asset is USDC or WBTC. For an asset outside the catalogue it falls
 * back to a thousand whole units, read off the token's own decimals.
 */
function amountLines(opts: GenerateOptions): string[] {
  const known = assetByAddress(opts.asset ?? USDC);
  const dec = 'ONE = 10 ** IERC20Metadata(ASSET).decimals();';
  if (!known) return [dec, 'AMOUNT = 1_000 * ONE;'];
  const perThousandDollars: Record<string, string> = {
    USDC: '1_000 * ONE',
    USDT: '1_000 * ONE',
    DAI: '1_000 * ONE',
    WETH: 'ONE / 4',
    wstETH: 'ONE / 5',
    WBTC: 'ONE / 100',
  };
  return [dec, `AMOUNT = ${perThousandDollars[known.symbol] ?? '1_000 * ONE'};`];
}

const assetConstant = (opts: GenerateOptions) =>
  `address internal constant ASSET = ${opts.asset ?? USDC};`;

const IERC20_METADATA_IMPORT = `import {IERC20Metadata} from "${IMPORT_PATHS.IERC20_METADATA}";`;

function flashLoan(opts: GenerateOptions): Scaffold {
  return {
    aave: true,
    imports: [IERC20_METADATA_IMPORT],
    constants: [assetConstant(opts)],
    state: [
      'IPool internal POOL;',
      'address internal ATOKEN;',
      'uint256 internal ONE;',
      'uint256 internal AMOUNT;',
      `${opts.name} internal harness;`,
      'address internal owner;',
      'address internal router;',
    ],
    setUp: [
      'POOL = IPool(PROVIDER.getPool());',
      'ATOKEN = POOL.getReserveData(ASSET).aTokenAddress;',
      ...amountLines(opts),
      'owner = _fresh("owner");',
      'router = _fresh("router");',
    ],
    afterDeploy: opts.routerAllowlist
      ? ['vm.prank(owner);', 'harness.setRouterAllowed(router, true);']
      : [],
    helpers: [
      '/// @dev A valid, benign FlashParams. Attack tests deviate from this deliberately.',
      `function _defaultFlashParams() internal view returns (${opts.name}.FlashParams memory) {`,
      `    return ${opts.name}.FlashParams({`,
      ...flashParamFields(opts).map((f, i, a) => `        ${f}${i === a.length - 1 ? '' : ','}`),
      '    });',
      '}',
      '',
      'function _defaultParams() internal view returns (bytes memory) {',
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
    deploy: {
      constants: [
        `address constant POOL_ADDRESSES_PROVIDER = ${AAVE_MAINNET.POOL_ADDRESSES_PROVIDER};`,
        `address constant ASSET = ${opts.asset ?? USDC};`,
        ...(opts.claimRewards
          ? [`address constant REWARDS_CONTROLLER = ${AAVE_MAINNET.REWARDS_CONTROLLER};`]
          : []),
      ],
      bindings: {
        addressesProvider: 'POOL_ADDRESSES_PROVIDER',
        asset_: 'ASSET',
        initialOwner: 'deployer',
        defaultAdmin: 'deployer',
        operator: 'deployer',
        rewardsController: 'REWARDS_CONTROLLER',
      },
    },
  };
}

const VAULT_HELPERS = [
  '/// @dev Funds `who` and deposits into the vault on their behalf.',
  'function _deposit(address who, uint256 assets) internal returns (uint256 shares) {',
  '    deal(ASSET, who, assets);',
  '    vm.startPrank(who);',
  '    IERC20(ASSET).approve(address(harness), assets);',
  '    shares = harness.deposit(assets, who);',
  '    vm.stopPrank();',
  '}',
];

const VAULT_ACTORS = ['owner = _fresh("owner");', 'alice = _fresh("alice");', 'bob = _fresh("bob");'];

function aaveVault(opts: GenerateOptions): Scaffold {
  return {
    aave: true,
    imports: [IERC20_METADATA_IMPORT],
    constants: [assetConstant(opts)],
    state: [
      'IPool internal POOL;',
      'address internal ATOKEN;',
      'uint256 internal ONE;',
      'uint256 internal AMOUNT;',
      `${opts.name} internal harness;`,
      'address internal owner;',
      'address internal alice;',
      'address internal bob;',
    ],
    setUp: [
      'POOL = IPool(PROVIDER.getPool());',
      'ATOKEN = POOL.getReserveData(ASSET).aTokenAddress;',
      ...amountLines(opts),
      ...VAULT_ACTORS,
    ],
    helpers: VAULT_HELPERS,
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
    deploy: {
      constants: [
        `address constant POOL_ADDRESSES_PROVIDER = ${AAVE_MAINNET.POOL_ADDRESSES_PROVIDER};`,
        `address constant ASSET = ${opts.asset ?? USDC};`,
        ...(opts.claimRewards
          ? [`address constant REWARDS_CONTROLLER = ${AAVE_MAINNET.REWARDS_CONTROLLER};`]
          : []),
      ],
      bindings: {
        addressesProvider: 'POOL_ADDRESSES_PROVIDER',
        asset_: 'IERC20(ASSET)',
        initialOwner: 'deployer',
        defaultAdmin: 'deployer',
        harvester: 'deployer',
        feeRecipient_: 'deployer',
        rewardsController: 'REWARDS_CONTROLLER',
      },
    },
  };
}

/**
 * Morpho markets are identified by a parameter hash, so the test has to pin a
 * real one. The generator already refused any asset without a known market, so
 * the lookup cannot miss here.
 */
function morphoVault(opts: GenerateOptions): Scaffold {
  const market = resolveMorphoMarket(opts.asset ?? USDC, opts.morphoMarketId);
  if (!market) throw new Error('No known Morpho Blue market for this asset');

  const marketConstants = (indent: string) => [
    `${indent}address internal constant MORPHO = ${MORPHO_BLUE};`,
    `${indent}address internal constant COLLATERAL = ${market.collateralToken}; // ${market.collateralSymbol}`,
    `${indent}address internal constant ORACLE = ${market.oracle};`,
    `${indent}address internal constant IRM = ${market.irm};`,
    `${indent}uint256 internal constant LLTV = ${market.lltv};`,
  ];

  return {
    aave: false,
    imports: [
      IERC20_METADATA_IMPORT,
      `import {IMorpho, MarketParams} from "${IMPORT_PATHS.MORPHO}";`,
    ],
    constants: [assetConstant(opts), ...marketConstants('')],
    state: [
      'uint256 internal ONE;',
      'uint256 internal AMOUNT;',
      `${opts.name} internal harness;`,
      'address internal owner;',
      'address internal alice;',
      'address internal bob;',
    ],
    setUp: [...amountLines(opts), ...VAULT_ACTORS],
    helpers: VAULT_HELPERS,
    subs: { ...COMMON_SUBS, '{{CONTRACT_TYPE}}': opts.name, '{{MORPHO}}': 'MORPHO' },
    bindings: {
      morpho_: 'MORPHO',
      asset_: 'IERC20(ASSET)',
      collateralToken_: 'COLLATERAL',
      oracle_: 'ORACLE',
      irm_: 'IRM',
      lltv_: 'LLTV',
      initialOwner: 'owner',
      defaultAdmin: 'owner',
      harvester: 'owner',
      feeRecipient_: 'owner',
    },
    deploy: {
      constants: [
        `address constant ASSET = ${opts.asset ?? USDC};`,
        `address constant MORPHO = ${MORPHO_BLUE};`,
        `address constant COLLATERAL = ${market.collateralToken}; // ${market.collateralSymbol}`,
        `address constant ORACLE = ${market.oracle};`,
        `address constant IRM = ${market.irm};`,
        `uint256 constant LLTV = ${market.lltv};`,
      ],
      bindings: {
        morpho_: 'MORPHO',
        asset_: 'IERC20(ASSET)',
        collateralToken_: 'COLLATERAL',
        oracle_: 'ORACLE',
        irm_: 'IRM',
        lltv_: 'LLTV',
        initialOwner: 'deployer',
        defaultAdmin: 'deployer',
        harvester: 'deployer',
        feeRecipient_: 'deployer',
      },
    },
  };
}

/** Compound v3: one Comet per base asset, so the deployment is looked up, never resolved. */
function cometVault(opts: GenerateOptions): Scaffold {
  const comet = cometFor(opts.asset ?? USDC);
  if (!comet) throw new Error('No Compound v3 Comet lends this asset');

  return {
    aave: false,
    imports: [
      IERC20_METADATA_IMPORT,
      'import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";',
      '',
      '/// @dev The slice of Comet the tests drive that the vault itself never calls.',
      'interface ICometTest {',
      '    function supplyTo(address dst, address asset, uint256 amount) external;',
      '    function balanceOf(address account) external view returns (uint256);',
      '    function borrowBalanceOf(address account) external view returns (uint256);',
      '    function pauseGuardian() external view returns (address);',
      '    function pause(bool supplyPaused, bool transferPaused, bool withdrawPaused, bool absorbPaused, bool buyPaused) external;',
      '}',
    ],
    constants: [
      assetConstant(opts),
      `address internal constant COMET = ${comet.comet}; // ${comet.name}`,
      `address internal constant COMET_REWARDS = ${COMET_REWARDS};`,
      `address internal constant WBTC = ${assetBySymbol('WBTC').address}; // a Comet collateral, for the gifted-position test`,
    ],
    state: [
      'uint256 internal ONE;',
      'uint256 internal AMOUNT;',
      `${opts.name} internal harness;`,
      'address internal owner;',
      'address internal alice;',
      'address internal bob;',
    ],
    setUp: [...amountLines(opts), ...VAULT_ACTORS],
    helpers: ['using stdStorage for StdStorage;', '', ...VAULT_HELPERS],
    subs: { ...COMMON_SUBS, '{{CONTRACT_TYPE}}': opts.name, '{{COMET}}': 'COMET' },
    bindings: {
      comet_: 'COMET',
      asset_: 'IERC20(ASSET)',
      rewards_: 'COMET_REWARDS',
      initialOwner: 'owner',
      defaultAdmin: 'owner',
      harvester: 'owner',
      feeRecipient_: 'owner',
    },
    deploy: {
      constants: [
        `address constant ASSET = ${opts.asset ?? USDC};`,
        `address constant COMET = ${comet.comet}; // ${comet.name}`,
        ...(opts.claimRewards ? [`address constant COMET_REWARDS = ${COMET_REWARDS};`] : []),
      ],
      bindings: {
        comet_: 'COMET',
        asset_: 'IERC20(ASSET)',
        rewards_: 'COMET_REWARDS',
        initialOwner: 'deployer',
        defaultAdmin: 'deployer',
        harvester: 'deployer',
        feeRecipient_: 'deployer',
      },
    },
  };
}

/**
 * The sale distributes an existing ERC20. The test deploys a plain 18-decimal
 * token to sell, funds the sale with it, and drives contributions in ETH from a
 * fixed set of 32 wallets. With the allowlist on, those wallets are the Merkle
 * tree, so every helper works the same way whether the allowlist is on or off.
 */
function tokenSale(opts: GenerateOptions): Scaffold {
  const whitelist = !!opts.whitelist;
  return {
    aave: false,
    imports: [
      `import {ERC20} from "${IMPORT_PATHS.ERC20}";`,
      '',
      'contract SaleToken is ERC20 {',
      '    constructor() ERC20("Sale Token", "SALE") {}',
      '',
      '    function mint(address to, uint256 amount) external {',
      '        _mint(to, amount);',
      '    }',
      '}',
      '',
      '/// @dev Contributes, then tries to take its refund twice by re-entering from receive().',
      'contract RefundReenterer {',
      '    address public immutable SALE;',
      '    uint256 public reentered;',
      '',
      '    constructor(address sale) {',
      '        SALE = sale;',
      '    }',
      '',
      '    function contribute(bytes32[] calldata proof) external payable {',
      '        (bool ok,) = SALE.call{value: msg.value}(abi.encodeWithSignature("contribute(bytes32[])", proof));',
      '        require(ok, "contribute failed");',
      '    }',
      '',
      '    function refund() external {',
      '        (bool ok,) = SALE.call(abi.encodeWithSignature("refund()"));',
      '        require(ok, "refund failed");',
      '    }',
      '',
      '    receive() external payable {',
      '        (bool ok,) = SALE.call(abi.encodeWithSignature("refund()"));',
      '        if (ok) reentered++;',
      '    }',
      '}',
    ],
    constants: [
      `bool internal constant WHITELIST = ${whitelist};`,
      'uint256 internal constant N_WALLETS = 32;',
    ],
    state: [
      `${opts.name} internal harness;`,
      'SaleToken internal token;',
      'RefundReenterer internal reenterer;',
      'address internal owner;',
      'address internal alice;',
      'address internal bob;',
      'uint64 internal start;',
      'uint64 internal end;',
    ],
    setUp: [
      ...VAULT_ACTORS,
      'token = new SaleToken();',
      'start = uint64(block.timestamp + 1 hours);',
      'end = start + 3 days;',
    ],
    afterDeploy: [
      'reenterer = new RefundReenterer(address(harness));',
      '// Deterministic deploy addresses collect dust on mainnet; start from zero.',
      'vm.deal(address(harness), 0);',
    ],
    helpers: [
      '/// @dev The fixed cast. Wallet 2 is a contract so the allowlist covers the reentrancy test.',
      'function _wallet(uint256 i) internal returns (address) {',
      '    if (i == 0) return alice;',
      '    if (i == 1) return bob;',
      '    if (i == 2) return address(reenterer);',
      '    return _fresh(string(abi.encodePacked("wallet", vm.toString(i))));',
      '}',
      '',
      '/// @dev OpenZeppelin\'s leaf shape: double-hashed so a leaf cannot collide with a node.',
      'function _leaf(address account) internal pure returns (bytes32) {',
      '    return keccak256(bytes.concat(keccak256(abi.encode(account))));',
      '}',
      '',
      'function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {',
      '    return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));',
      '}',
      '',
      'function _leaves() internal returns (bytes32[] memory nodes) {',
      '    nodes = new bytes32[](N_WALLETS);',
      '    for (uint256 i = 0; i < N_WALLETS; i++) nodes[i] = _leaf(_wallet(i));',
      '}',
      '',
      'function _root() internal returns (bytes32) {',
      '    bytes32[] memory nodes = _leaves();',
      '    while (nodes.length > 1) {',
      '        bytes32[] memory next = new bytes32[](nodes.length / 2);',
      '        for (uint256 i = 0; i < next.length; i++) next[i] = _hashPair(nodes[2 * i], nodes[2 * i + 1]);',
      '        nodes = next;',
      '    }',
      '    return nodes[0];',
      '}',
      '',
      '/// @dev The proof for one of the fixed wallets; empty when the sale has no allowlist.',
      'function _proofFor(address who) internal returns (bytes32[] memory proof) {',
      '    if (!WHITELIST) return new bytes32[](0);',
      '    bytes32[] memory nodes = _leaves();',
      '    uint256 idx = type(uint256).max;',
      '    for (uint256 i = 0; i < N_WALLETS; i++) {',
      '        if (_wallet(i) == who) idx = i;',
      '    }',
      '    require(idx != type(uint256).max, "not one of the allowlisted test wallets");',
      '    proof = new bytes32[](5);',
      '    uint256 p;',
      '    while (nodes.length > 1) {',
      '        proof[p++] = nodes[idx ^ 1];',
      '        bytes32[] memory next = new bytes32[](nodes.length / 2);',
      '        for (uint256 i = 0; i < next.length; i++) next[i] = _hashPair(nodes[2 * i], nodes[2 * i + 1]);',
      '        nodes = next;',
      '        idx /= 2;',
      '    }',
      '}',
      '',
      '/// @dev Funds the sale for its hard cap, sets the allowlist if any, and opens the window.',
      'function _openSale() internal {',
      '    uint256 needed = harness.tokensFor(harness.HARD_CAP_WEI());',
      '    token.mint(owner, needed);',
      '    vm.startPrank(owner);',
      '    token.approve(address(harness), needed);',
      '    harness.fund(needed);',
      '    vm.stopPrank();',
      '    _openSaleUnfunded();',
      '}',
      '',
      '/// @dev Opens the window without funding: what an operator who forgot to fund gets.',
      'function _openSaleUnfunded() internal {',
      ...(whitelist ? ['    vm.prank(owner);', '    harness.setMerkleRoot(_root());'] : []),
      '    vm.warp(start);',
      '}',
      '',
      '/// @dev An amount every cap accepts right now.',
      'function _validContribution() internal view returns (uint256 c) {',
      '    c = 1 ether;',
      '    uint256 maxWei = harness.MAX_CONTRIBUTION_WEI();',
      '    if (maxWei != 0 && c > maxWei) c = maxWei;',
      '    uint256 room = harness.HARD_CAP_WEI() - harness.totalRaised();',
      '    if (c > room) c = room;',
      '    if (c < harness.MIN_CONTRIBUTION_WEI()) c = harness.MIN_CONTRIBUTION_WEI();',
      '}',
      '',
      'function _contribute(address who, uint256 wei_) internal {',
      '    vm.deal(who, who.balance + wei_);',
      '    bytes32[] memory proof = _proofFor(who);',
      '    vm.prank(who);',
      '    harness.contribute{value: wei_}(proof);',
      '}',
      '',
      '/// @dev Raises `target` across the fixed wallets, respecting every cap. Alice goes first.',
      'function _raiseTo(uint256 target) internal {',
      '    uint256 minWei = harness.MIN_CONTRIBUTION_WEI();',
      '    uint256 maxWei = harness.MAX_CONTRIBUTION_WEI();',
      '    for (uint256 i = 0; i < N_WALLETS && harness.totalRaised() < target; i++) {',
      '        address who = _wallet(i);',
      '        uint256 c = target - harness.totalRaised();',
      '        if (maxWei != 0 && c > maxWei - harness.contributed(who)) c = maxWei - harness.contributed(who);',
      '        uint256 room = harness.HARD_CAP_WEI() - harness.totalRaised();',
      '        if (c > room) c = room;',
      '        if (c < minWei || c == 0) continue;',
      '        _contribute(who, c);',
      '    }',
      '    require(harness.totalRaised() >= target, "could not reach the target with 32 wallets: lower the cap or raise the per-wallet max");',
      '}',
      '',
      'function _closeSale() internal {',
      '    vm.warp(end + 1);',
      '}',
    ],
    subs: { ...COMMON_SUBS, '{{CONTRACT_TYPE}}': opts.name, '{{TOKEN}}': 'token' },
    bindings: {
      token_: 'IERC20(address(token))',
      start_: 'start',
      end_: 'end',
      treasury_: 'owner',
      initialOwner: 'owner',
      defaultAdmin: 'owner',
    },
    deploy: {
      constants: [
        '// The ERC20 being sold. Fund the sale with fund(amount) after deployment.',
        'address constant SALE_TOKEN = address(0); // <-- set me',
        'uint64 constant START = 0; // <-- unix timestamp the sale opens',
        'uint64 constant END = 0; // <-- unix timestamp the sale closes',
      ],
      bindings: {
        token_: 'IERC20(SALE_TOKEN)',
        start_: 'START',
        end_: 'END',
        treasury_: 'deployer',
        initialOwner: 'deployer',
        defaultAdmin: 'deployer',
      },
    },
  };
}

/** The curve mints its own token, so the only external dependency is Uniswap V2. */
function bondingCurve(opts: GenerateOptions): Scaffold {
  const capped = !!opts.maxWalletBps;
  return {
    aave: false,
    imports: [
      '',
      'interface IWETH9 {',
      '    function deposit() external payable;',
      '}',
      '',
      'interface IUniswapV2PairTest {',
      '    function sync() external;',
      '    function getReserves() external view returns (uint112, uint112, uint32);',
      '}',
      '',
      'interface ILaunchTest {',
      '    function buy(uint256 minTokensOut, uint256 deadline) external payable returns (uint256);',
      '    function sell(uint256 tokensIn, uint256 minEthOut, uint256 deadline) external returns (uint256);',
      '}',
      '',
      '/// @dev Buys, then sells half and tries to sell the other half from inside the payout.',
      'contract SellReenterer {',
      '    address public immutable LAUNCH;',
      '    address public immutable TOKEN;',
      '    uint256 public reentered;',
      '',
      '    constructor(address launch, address token) {',
      '        LAUNCH = launch;',
      '        TOKEN = token;',
      '    }',
      '',
      '    function buy() external payable {',
      '        ILaunchTest(LAUNCH).buy{value: msg.value}(1, block.timestamp);',
      '    }',
      '',
      '    function sellHalf() external {',
      '        uint256 half = IERC20(TOKEN).balanceOf(address(this)) / 2;',
      '        IERC20(TOKEN).approve(LAUNCH, type(uint256).max);',
      '        ILaunchTest(LAUNCH).sell(half, 0, block.timestamp);',
      '    }',
      '',
      '    receive() external payable {',
      '        uint256 rest = IERC20(TOKEN).balanceOf(address(this));',
      '        (bool ok,) = LAUNCH.call(abi.encodeWithSignature("sell(uint256,uint256,uint256)", rest, uint256(0), block.timestamp));',
      '        if (ok) reentered++;',
      '    }',
      '}',
    ],
    constants: [
      `address internal constant UNISWAP_V2_FACTORY = ${UNISWAP_V2.FACTORY};`,
      `address internal constant WETH = ${UNISWAP_V2.WETH};`,
    ],
    state: [
      `${opts.name} internal harness;`,
      'IERC20 internal token;',
      'address internal owner;',
      'address internal alice;',
      'address internal bob;',
    ],
    setUp: VAULT_ACTORS,
    afterDeploy: [
      'token = harness.TOKEN();',
      '// Deterministic deploy addresses collect dust on mainnet; start from zero.',
      'vm.deal(address(harness), 0);',
    ],
    helpers: [
      '/// @dev An ETH amount small enough to sit under any wallet cap at the start of the curve.',
      'function _smallBuy() internal view returns (uint256) {',
      '    return harness.GRADUATION_ETH() / 1000;',
      '}',
      '',
      'function _buy(address who, uint256 wei_) internal returns (uint256 tokensOut) {',
      '    vm.deal(who, who.balance + wei_);',
      '    vm.prank(who);',
      '    tokensOut = harness.buy{value: wei_}(1, block.timestamp);',
      '}',
      '',
      '/// @dev Buys until the curve graduates, spread over fresh wallets so any wallet cap holds.',
      'function _graduate() internal {',
      '    uint256 i;',
      '    while (!harness.graduated()) {',
      '        address buyer = _fresh(string(abi.encodePacked("buyer", vm.toString(i++))));',
      '        uint256 remaining = harness.GRADUATION_ETH() - harness.reserveEth();',
      '        // Gross up for the fee so the final chunk actually crosses the threshold.',
      '        uint256 chunk = (remaining * 10_000) / (10_000 - harness.FEE_BPS()) + 1;',
      ...(capped
        ? [
            '        uint256 lo = 1;',
            '        uint256 hi = chunk;',
            '        while (harness.previewBuy(hi) > harness.MAX_WALLET()) {',
            '            // Largest amount that still fits under the cap, by bisection.',
            '            uint256 mid = (lo + hi) / 2;',
            '            if (harness.previewBuy(mid) > harness.MAX_WALLET()) hi = mid;',
            '            else lo = mid;',
            '            if (hi - lo <= 1) {',
            '                hi = lo;',
            '                break;',
            '            }',
            '        }',
            '        chunk = hi;',
          ]
        : []),
      '        vm.deal(buyer, chunk);',
      '        vm.prank(buyer);',
      '        harness.buy{value: chunk}(1, block.timestamp);',
      '        require(i < 500, "graduation did not trigger");',
      '    }',
      '}',
    ],
    subs: { ...COMMON_SUBS, '{{CONTRACT_TYPE}}': opts.name },
    bindings: {
      tokenName_: '"Launch Token"',
      tokenSymbol_: '"LAUNCH"',
      factory_: 'UNISWAP_V2_FACTORY',
      weth_: 'WETH',
      feeRecipient_: 'owner',
      initialOwner: 'owner',
      defaultAdmin: 'owner',
    },
    deploy: {
      constants: [
        `address constant UNISWAP_V2_FACTORY = ${UNISWAP_V2.FACTORY};`,
        `address constant WETH = ${UNISWAP_V2.WETH};`,
        'string constant TOKEN_NAME = "My Launch Token"; // <-- set me',
        'string constant TOKEN_SYMBOL = "LAUNCH"; // <-- set me',
      ],
      bindings: {
        tokenName_: 'TOKEN_NAME',
        tokenSymbol_: 'TOKEN_SYMBOL',
        factory_: 'UNISWAP_V2_FACTORY',
        weth_: 'WETH',
        feeRecipient_: 'deployer',
        initialOwner: 'deployer',
        defaultAdmin: 'deployer',
      },
    },
  };
}

function flashParamFields(opts: GenerateOptions): string[] {
  const fields = ['minAmountOut: 1', 'deadline: type(uint256).max'];
  if (opts.routerAllowlist) fields.push('router: router');
  return fields;
}
