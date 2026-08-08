import { parseAbi } from 'viem';

// Spec §9.1: NEVER hardcode the Pool. Only the AddressesProvider is pinned; Pool and PriceOracle
// are discovered from it at runtime.
export const MAINNET_ADDRESSES_PROVIDER = '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e' as const;

export const TOKENS = {
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
} as const;

export const DECIMALS: Record<string, number> = {
  [TOKENS.USDC.toLowerCase()]: 6,
  [TOKENS.WETH.toLowerCase()]: 18,
};

export const SYMBOLS: Record<string, string> = {
  [TOKENS.USDC.toLowerCase()]: 'USDC',
  [TOKENS.WETH.toLowerCase()]: 'WETH',
};

// Uniswap v3 SwapRouter, used only by the leverage-loop scenario.
export const UNISWAP_V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564' as const;
export const UNISWAP_FEE_TIER = 500;

export const addressesProviderAbi = parseAbi([
  'function getPool() view returns (address)',
  'function getPriceOracle() view returns (address)',
]);

export const poolAbi = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)',
  'function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes params, uint16 referralCode)',
  'function getReserveAToken(address asset) view returns (address)',
  'function getReserveVariableDebtToken(address asset) view returns (address)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)',
]);

export const oracleAbi = parseAbi([
  'function getAssetPrice(address asset) view returns (uint256)',
  'function BASE_CURRENCY_UNIT() view returns (uint256)',
]);

export const erc20Abi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

export const swapRouterAbi = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
]);

export const erc4626Abi = parseAbi([
  'function asset() view returns (address)',
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)',
  'function totalAssets() view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
]);

/** Not called directly — used only to turn selectors in a call trace into readable names. */
export const traceDecodeAbi = parseAbi([
  'function executeFlashLoan(address asset, uint256 amount, bytes params)',
  'function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes params) returns (bool)',
  'function getConfiguration(address asset) view returns (uint256)',
  'function mint(address caller, address onBehalfOf, uint256 amount, uint256 index) returns (bool)',
  'function burn(address from, address receiverOfUnderlying, uint256 amount, uint256 index)',
  'function handleAction(address user, uint256 totalSupply, uint256 userBalance)',
  'function transferUnderlyingTo(address target, uint256 amount)',
  'function scaledBalanceOf(address user) view returns (uint256)',
  'function scaledTotalSupply() view returns (uint256)',
  'function getReserveNormalizedIncome(address asset) view returns (uint256)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function totalSupply() view returns (uint256)',
  'function name() view returns (string)',
  'function getReserveData(address asset) view returns (bytes)',
  'function getAssetPrice(address asset) view returns (uint256)',
]);

/**
 * Frozen entrypoint the generated flash-loan receiver must expose so /simulate can drive it.
 * The receiver gates `initiator == address(this)`, so the Pool call has to originate inside the
 * contract — an external `flashLoanSimple` naming it as receiver is supposed to revert.
 * If Agent A's generator renames this, only DEFAULT_FLASHLOAN_ENTRYPOINT changes.
 */
export const DEFAULT_FLASHLOAN_ENTRYPOINT = 'executeFlashLoan(address,uint256,bytes)';

/** Aave v3: variable rate only. Stable rate is deprecated (spec §9.1). */
export const VARIABLE_RATE_MODE = 2n;
