import type { Preset } from '@/types';

/**
 * The on-chain catalogue every preset draws from: which assets are known, and for
 * each protocol, the deployment that serves that asset on Ethereum mainnet.
 *
 * One table instead of addresses scattered through the generator, the test
 * scaffold and the settings advisor — those three drifted apart before (the tests
 * hard-coded aUSDC while the asset field accepted anything), so now they cannot.
 *
 * Every address here was read from the chain or the protocol's own registry at
 * the pinned fork block, not recalled. Aave's aToken and Compound's Comet are
 * resolved at run time inside the tests wherever possible; the tables exist for
 * the cases where the protocol offers no registry (Morpho markets, Comet
 * deployments).
 */

export type Address = `0x${string}`;

export interface KnownAsset {
  symbol: string;
  address: Address;
  decimals: number;
  /** A sensible starting deposit cap in whole tokens: roughly ten million dollars. */
  defaultCapWhole: number;
}

export const KNOWN_ASSETS: KnownAsset[] = [
  { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, defaultCapWhole: 10_000_000 },
  { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, defaultCapWhole: 2_500 },
  { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, defaultCapWhole: 10_000_000 },
  { symbol: 'DAI', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18, defaultCapWhole: 10_000_000 },
  { symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8, defaultCapWhole: 100 },
  { symbol: 'wstETH', address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', decimals: 18, defaultCapWhole: 2_000 },
];

/** The default deposit cap for an asset, in raw units; undefined for an asset outside the catalogue. */
export function defaultDepositCap(address: string | undefined): string | undefined {
  const a = assetByAddress(address);
  return a ? `${a.defaultCapWhole}${'0'.repeat(a.decimals)}` : undefined;
}

export const assetBySymbol = (symbol: string): KnownAsset =>
  KNOWN_ASSETS.find((a) => a.symbol === symbol)!;

export const assetByAddress = (address: string | undefined): KnownAsset | undefined =>
  address ? KNOWN_ASSETS.find((a) => a.address.toLowerCase() === address.toLowerCase()) : undefined;

export const USDC = assetBySymbol('USDC').address;
export const WETH = assetBySymbol('WETH').address;

// ---------------------------------------------------------------------------
// Aave v3 Ethereum. Only the provider is pinned; the Pool, the aToken and the data
// provider are all resolved through it, which is what makes the same bytecode
// valid across Aave's own upgrades (§9.1: never hardcode the Pool).
// ---------------------------------------------------------------------------

export const AAVE_MAINNET = {
  POOL_ADDRESSES_PROVIDER: '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e' as Address,
  REWARDS_CONTROLLER: '0x8164Cc65827dcFe994AB23944CBC90e0aa80bFcb' as Address,
} as const;

// ---------------------------------------------------------------------------
// Morpho Blue Ethereum. A market IS the hash of its five parameters, so there is
// nothing to resolve — a vault pins one. These are the deepest listed markets per
// loan asset from Morpho's own API, ranked by supplied value.
// ---------------------------------------------------------------------------

export interface MorphoMarket {
  id: Address;               // bytes32
  loanAsset: Address;
  collateralSymbol: string;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: string;              // 1e18 = 100%
}

export const MORPHO_BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as Address;

const IRM_ADAPTIVE = '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC' as Address;

export const MORPHO_MARKETS: MorphoMarket[] = [
  {
    id: '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64',
    loanAsset: assetBySymbol('USDC').address,
    collateralSymbol: 'cbBTC',
    collateralToken: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    oracle: '0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a',
    irm: IRM_ADAPTIVE,
    lltv: '860000000000000000',
  },
  {
    id: '0x3a85e619751152991742810df6ec69ce473daef99e28a64ab2340d7b7ccfee49',
    loanAsset: assetBySymbol('USDC').address,
    collateralSymbol: 'WBTC',
    collateralToken: assetBySymbol('WBTC').address,
    oracle: '0xDddd770BADd886dF3864029e4B377B5F6a2B6b83',
    irm: IRM_ADAPTIVE,
    lltv: '860000000000000000',
  },
  {
    id: '0xe7e9694b754c4d4f7e21faf7223f6fa71abaeb10296a4c43a54a7977149687d2',
    loanAsset: assetBySymbol('USDT').address,
    collateralSymbol: 'wstETH',
    collateralToken: assetBySymbol('wstETH').address,
    oracle: '0x95DB30fAb9A3754e42423000DF27732CB2396992',
    irm: IRM_ADAPTIVE,
    lltv: '860000000000000000',
  },
  {
    id: '0xa921ef34e2fc7a27ccc50ae7e4b154e16c9799d3387076c421423ef52ac4df99',
    loanAsset: assetBySymbol('USDT').address,
    collateralSymbol: 'WBTC',
    collateralToken: assetBySymbol('WBTC').address,
    oracle: '0x008bF4B1cDA0cc9f0e882E0697f036667652E1ef',
    irm: IRM_ADAPTIVE,
    lltv: '860000000000000000',
  },
  {
    id: '0xb8fc70e82bc5bb53e773626fcc6a23f7eefa036918d7ef216ecfb1950a94a85e',
    loanAsset: assetBySymbol('WETH').address,
    collateralSymbol: 'wstETH',
    collateralToken: assetBySymbol('wstETH').address,
    oracle: '0xbD60A6770b27E084E8617335ddE769241B0e71D8',
    irm: IRM_ADAPTIVE,
    lltv: '965000000000000000',
  },
  {
    id: '0xd0e50cdac92fe2172043f5e0c36532c6369d24947e40968f34a5e8819ca9ec5d',
    loanAsset: assetBySymbol('WETH').address,
    collateralSymbol: 'wstETH',
    collateralToken: assetBySymbol('wstETH').address,
    oracle: '0xbD60A6770b27E084E8617335ddE769241B0e71D8',
    irm: IRM_ADAPTIVE,
    lltv: '945000000000000000',
  },
  {
    id: '0x39d11026eae1c6ec02aa4c0910778664089cdd97c3fd23f68f7cd05e2e95af48',
    loanAsset: assetBySymbol('DAI').address,
    collateralSymbol: 'sUSDe',
    collateralToken: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497',
    oracle: '0x5D916980D5Ae1737a8330Bf24dF812b2911Aae25',
    irm: IRM_ADAPTIVE,
    lltv: '860000000000000000',
  },
];

export const morphoMarketsFor = (asset: string | undefined): MorphoMarket[] =>
  asset ? MORPHO_MARKETS.filter((m) => m.loanAsset.toLowerCase() === asset.toLowerCase()) : [];

/** The market a Morpho vault pins: the explicit id if given, else the deepest for the asset. */
export function resolveMorphoMarket(
  asset: string | undefined,
  marketId: string | undefined,
): MorphoMarket | undefined {
  const candidates = morphoMarketsFor(asset);
  if (marketId) return candidates.find((m) => m.id.toLowerCase() === marketId.toLowerCase());
  return candidates[0];
}

export const morphoLltvPct = (m: MorphoMarket): string => `${Number(m.lltv) / 1e16}%`;

// ---------------------------------------------------------------------------
// Compound v3 (Comet) Ethereum. One Comet per base asset; verified by calling
// baseToken() on each at the pinned block.
// ---------------------------------------------------------------------------

export interface CometDeployment {
  name: string;
  comet: Address;
  baseAsset: Address;
}

export const COMET_REWARDS = '0x1B0e765F6224C21223AeA2af16c1C46E38885a40' as Address;
export const COMP = '0xc00e94Cb662C3520282E6f5717214004A7f26888' as Address;

export const COMETS: CometDeployment[] = [
  { name: 'cUSDCv3', comet: '0xc3d688B66703497DAA19211EEdff47f25384cdc3', baseAsset: assetBySymbol('USDC').address },
  { name: 'cWETHv3', comet: '0xA17581A9E3356d9A858b789D68B4d866e593aE94', baseAsset: assetBySymbol('WETH').address },
  { name: 'cUSDTv3', comet: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840', baseAsset: assetBySymbol('USDT').address },
];

export const cometFor = (asset: string | undefined): CometDeployment | undefined =>
  asset ? COMETS.find((c) => c.baseAsset.toLowerCase() === asset.toLowerCase()) : undefined;

// ---------------------------------------------------------------------------
// Uniswap V2 Ethereum — the bonding-curve launchpad graduates into it.
// ---------------------------------------------------------------------------

export const UNISWAP_V2 = {
  FACTORY: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f' as Address,
  ROUTER02: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' as Address,
  WETH: WETH,
} as const;

// ---------------------------------------------------------------------------
// Which assets each preset can be generated for, and why the others cannot.
// ---------------------------------------------------------------------------

export function assetsFor(preset: Preset): KnownAsset[] {
  switch (preset) {
    case 'morpho-blue-vault':
      return KNOWN_ASSETS.filter((a) => morphoMarketsFor(a.address).length > 0);
    case 'compound-v3-vault':
      return KNOWN_ASSETS.filter((a) => cometFor(a.address) !== undefined);
    case 'aave-v3-erc4626-vault':
    case 'aave-v3-flashloan-receiver':
      // Every asset in the catalogue is an active Aave v3 Ethereum reserve.
      return KNOWN_ASSETS;
    case 'token-sale-launchpad':
    case 'bonding-curve-launchpad':
      return [];
  }
}

/** Fork tests pin a block so a suite that is green today is green tomorrow. */
export const FORK_BLOCK = 25710954;
