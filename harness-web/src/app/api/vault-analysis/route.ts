import { createPublicClient, http, formatUnits } from 'viem';

import {
  AAVE_MAINNET,
  MORPHO_BLUE,
  assetByAddress,
  cometFor,
  morphoLltvPct,
  resolveMorphoMarket,
} from '@/generator/markets';
import { ADDRESS_RE, type GenerateOptions } from '@/types';
import type {
  SettingAdvice,
  SettingSweep,
  StressCell,
  StressGrid,
  SweepPoint,
  VaultAnalysis,
  Verdict,
} from '@/lib/vaultAdvice';

/**
 * Vault settings advisor.
 *
 * A deposit cap, a fee and a virtual-share offset all have defensible answers
 * that depend on the lending market's live state rather than on taste, so this
 * reads that state and turns each setting into a verdict instead of leaving the
 * developer to guess.
 *
 * Two protocols, one set of advisors. Everything protocol-specific is confined to
 * reading a MarketSnapshot; the advice and the sweeps then work off that snapshot
 * and do not know which lending market produced it. The one place the difference
 * genuinely leaks is the deposit cap: Aave has a supply cap to fit under, and
 * Morpho Blue has no cap at all, so the advice there branches explicitly rather
 * than pretending Morpho has a headroom of infinity.
 *
 * Read-only: it reads the latest block from a public RPC and holds no keys.
 */

export const runtime = 'nodejs';
export const maxDuration = 30;

/** Override with HARNESS_RPC_URL. The default is a free endpoint; reads are latest-block. */
const RPC = process.env.HARNESS_RPC_URL ?? process.env.TENDERLY_PUBLIC_RPC ?? 'https://eth.drpc.org';

const SECONDS_PER_YEAR = 31_536_000;

/**
 * What every advisor needs, with nothing protocol-specific left in it.
 *
 * `supplyCap` and `headroom` are nullable because Morpho Blue markets are
 * uncapped — the only ceiling is liquidity. Making them `number` and passing
 * Infinity would have compiled, and would have quietly told every Morpho user
 * their deposit cap was fine.
 */
interface MarketSnapshot {
  protocol: string;
  decimals: number;
  supplied: number;
  availableLiquidity: number;
  supplyCap: number | null;
  headroom: number | null;
  /** Borrowed / supplied, right now. The axis the stress grid moves. */
  utilization: number;
  supplyApyPct: number;
  protocolFeePct: number;
  protocolFeeLabel: string;
  frozen: boolean;
  paused: boolean;
  extra: { label: string; value: string }[];
}

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

export async function POST(req: Request): Promise<Response> {
  let opts: GenerateOptions;
  try {
    opts = (await req.json()) as GenerateOptions;
  } catch {
    return json({ error: 'Malformed JSON body' }, 400);
  }

  const asset = opts.asset;
  if (!asset || !ADDRESS_RE.test(asset)) {
    return json({ error: 'A valid underlying asset address is required' }, 400);
  }

  const client = createPublicClient({ transport: http(RPC) });

  let snap: MarketSnapshot;
  try {
    snap =
      opts.preset === 'morpho-blue-vault'
        ? await readMorphoMarket(client, asset, opts.morphoMarketId)
        : opts.preset === 'compound-v3-vault'
          ? await readCometMarket(client, asset)
          : await readAaveMarket(client, asset);
  } catch (e) {
    const msg = (e as Error).message;
    return json({ error: msg.startsWith('ADVISOR:') ? msg.slice(8).trim() : `Could not read market state for ${asset}. (${msg.slice(0, 140)})` }, 502);
  }

  const advice: SettingAdvice[] = [
    adviseDepositCap(opts, snap),
    adviseFee(opts, snap),
    adviseOffset(opts, snap),
  ];

  // The advise* functions are pure given the market snapshot, so the same market
  // read supports evaluating neighbouring values — one RPC round trip, many
  // verdicts. That turns a point judgement into a frontier: not just "this is
  // wrong" but "it is fine up to here".
  const sweeps: SettingSweep[] = [
    sweepDepositCap(opts, snap),
    sweepFee(opts, snap),
    sweepOffset(opts, snap),
  ];

  const analysis: VaultAnalysis = {
    asset: { address: asset, symbol: await symbolFor(client, asset), decimals: snap.decimals },
    market: {
      protocol: snap.protocol,
      supplyCap: snap.supplyCap === null ? 'no cap' : fmt(snap.supplyCap),
      supplied: fmt(snap.supplied),
      headroom: snap.headroom === null ? 'uncapped' : fmt(snap.headroom),
      availableLiquidity: fmt(snap.availableLiquidity),
      supplyApyPct: snap.supplyApyPct,
      protocolFeePct: snap.protocolFeePct,
      protocolFeeLabel: snap.protocolFeeLabel,
      frozen: snap.frozen,
      paused: snap.paused,
      extra: snap.extra,
    },
    advice,
    sweeps,
    stress: stressDepositCap(opts, snap),
  };

  return json(analysis, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The catalogue first, then the token's own symbol(); 'token' only if both fail. */
async function symbolFor(client: Client, a: string): Promise<string> {
  const known = assetByAddress(a);
  if (known) return known.symbol;
  try {
    return await client.readContract({ address: a as `0x${string}`, abi: erc20Abi, functionName: 'symbol' });
  } catch {
    return 'token';
  }
}

// ---------------------------------------------------------------------------
// Protocol readers. The only code that knows which lending market it is talking to.
// ---------------------------------------------------------------------------

const dataProviderAbi = [
  {
    name: 'getReserveCaps',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'borrowCap', type: 'uint256' },
      { name: 'supplyCap', type: 'uint256' },
    ],
  },
  {
    name: 'getReserveConfigurationData',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'decimals', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'liquidationThreshold', type: 'uint256' },
      { name: 'liquidationBonus', type: 'uint256' },
      { name: 'reserveFactor', type: 'uint256' },
      { name: 'usageAsCollateralEnabled', type: 'bool' },
      { name: 'borrowingEnabled', type: 'bool' },
      { name: 'stableBorrowRateEnabled', type: 'bool' },
      { name: 'isActive', type: 'bool' },
      { name: 'isFrozen', type: 'bool' },
    ],
  },
  {
    name: 'getReserveData',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'unbacked', type: 'uint256' },
      { name: 'accruedToTreasuryScaled', type: 'uint256' },
      { name: 'totalAToken', type: 'uint256' },
      { name: 'totalStableDebt', type: 'uint256' },
      { name: 'totalVariableDebt', type: 'uint256' },
      { name: 'liquidityRate', type: 'uint256' },
      { name: 'variableBorrowRate', type: 'uint256' },
      { name: 'stableBorrowRate', type: 'uint256' },
      { name: 'averageStableBorrowRate', type: 'uint256' },
      { name: 'liquidityIndex', type: 'uint256' },
      { name: 'variableBorrowIndex', type: 'uint256' },
      { name: 'lastUpdateTimestamp', type: 'uint40' },
    ],
  },
  {
    name: 'getPaused',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: 'isPaused', type: 'bool' }],
  },
] as const;

const providerAbi = [
  {
    name: 'getPoolDataProvider',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;

type Client = ReturnType<typeof createPublicClient>;

async function readAaveMarket(client: Client, asset: `0x${string}`): Promise<MarketSnapshot> {
  // Resolved through the provider rather than pinned: Aave's data provider address
  // has moved across its own upgrades, and the vault resolves the Pool the same way.
  const dataProvider = await client.readContract({
    address: AAVE_MAINNET.POOL_ADDRESSES_PROVIDER,
    abi: providerAbi,
    functionName: 'getPoolDataProvider',
  });
  const base = { address: dataProvider, abi: dataProviderAbi, args: [asset] } as const;
  const [caps, cfg, rd, paused] = await Promise.all([
    client.readContract({ ...base, functionName: 'getReserveCaps' }),
    client.readContract({ ...base, functionName: 'getReserveConfigurationData' }),
    client.readContract({ ...base, functionName: 'getReserveData' }),
    client.readContract({ ...base, functionName: 'getPaused' }),
  ]);

  const decimals = Number(cfg[0]);
  // Caps are denominated in whole tokens; balances are not.
  const supplyCap = Number(caps[1]);
  const supplied = Number(formatUnits(rd[2], decimals));
  const variableDebt = Number(formatUnits(rd[4], decimals));

  return {
    protocol: 'Aave v3',
    decimals,
    supplied,
    availableLiquidity: Math.max(supplied - variableDebt, 0),
    supplyCap,
    headroom: Math.max(supplyCap - supplied, 0),
    utilization: supplied === 0 ? 0 : variableDebt / supplied,
    supplyApyPct: (Number(rd[5]) / 1e27) * 100,
    protocolFeePct: Number(cfg[4]) / 100,
    protocolFeeLabel: 'Reserve factor',
    frozen: cfg[9],
    paused,
    extra: [],
  };
}

const morphoAbi = [
  {
    name: 'market',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'totalSupplyAssets', type: 'uint128' },
      { name: 'totalSupplyShares', type: 'uint128' },
      { name: 'totalBorrowAssets', type: 'uint128' },
      { name: 'totalBorrowShares', type: 'uint128' },
      { name: 'lastUpdate', type: 'uint128' },
      { name: 'fee', type: 'uint128' },
    ],
  },
  {
    name: 'idToMarketParams',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'loanToken', type: 'address' },
      { name: 'collateralToken', type: 'address' },
      { name: 'oracle', type: 'address' },
      { name: 'irm', type: 'address' },
      { name: 'lltv', type: 'uint256' },
    ],
  },
] as const;

const irmAbi = [
  {
    name: 'borrowRateView',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      {
        name: 'marketParams',
        type: 'tuple',
        components: [
          { name: 'loanToken', type: 'address' },
          { name: 'collateralToken', type: 'address' },
          { name: 'oracle', type: 'address' },
          { name: 'irm', type: 'address' },
          { name: 'lltv', type: 'uint256' },
        ],
      },
      {
        name: 'market',
        type: 'tuple',
        components: [
          { name: 'totalSupplyAssets', type: 'uint128' },
          { name: 'totalSupplyShares', type: 'uint128' },
          { name: 'totalBorrowAssets', type: 'uint128' },
          { name: 'totalBorrowShares', type: 'uint128' },
          { name: 'lastUpdate', type: 'uint128' },
          { name: 'fee', type: 'uint128' },
        ],
      },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const erc20Abi = [
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

const cometAbi = [
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalBorrow', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'getUtilization', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'getSupplyRate', type: 'function', stateMutability: 'view', inputs: [{ name: 'utilization', type: 'uint256' }], outputs: [{ type: 'uint64' }] },
  { name: 'getBorrowRate', type: 'function', stateMutability: 'view', inputs: [{ name: 'utilization', type: 'uint256' }], outputs: [{ type: 'uint64' }] },
  { name: 'isSupplyPaused', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { name: 'isWithdrawPaused', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

/**
 * Compound v3. One Comet per base asset, no supply cap on the base asset at all
 * (caps are per collateral), and two independent pause switches. The supply rate
 * is a per-second rate scaled by 1e18; the spread between what borrowers pay and
 * what suppliers earn is the protocol's take.
 */
async function readCometMarket(client: Client, asset: `0x${string}`): Promise<MarketSnapshot> {
  const comet = cometFor(asset);
  if (!comet) {
    throw new Error(
      `ADVISOR: No Compound v3 Comet lends ${(await symbolFor(client, asset))} on Ethereum. Pick USDC, WETH or USDT.`,
    );
  }
  const base = { address: comet.comet, abi: cometAbi } as const;
  const [totalSupply, totalBorrow, utilization, supplyPaused, withdrawPaused, decimals] = await Promise.all([
    client.readContract({ ...base, functionName: 'totalSupply' }),
    client.readContract({ ...base, functionName: 'totalBorrow' }),
    client.readContract({ ...base, functionName: 'getUtilization' }),
    client.readContract({ ...base, functionName: 'isSupplyPaused' }),
    client.readContract({ ...base, functionName: 'isWithdrawPaused' }),
    client.readContract({ ...base, functionName: 'decimals' }),
  ]);
  const [supplyRate, borrowRate] = await Promise.all([
    client.readContract({ ...base, functionName: 'getSupplyRate', args: [utilization] }),
    client.readContract({ ...base, functionName: 'getBorrowRate', args: [utilization] }),
  ]);

  const supplied = Number(formatUnits(totalSupply, decimals));
  const borrowed = Number(formatUnits(totalBorrow, decimals));
  const util = Number(utilization) / 1e18;
  const supplyApyPct = (Number(supplyRate) / 1e18) * SECONDS_PER_YEAR * 100;
  const borrowApyPct = (Number(borrowRate) / 1e18) * SECONDS_PER_YEAR * 100;
  const spreadPct = borrowApyPct * util - supplyApyPct;

  return {
    protocol: 'Compound v3',
    decimals,
    supplied,
    availableLiquidity: Math.max(supplied - borrowed, 0),
    supplyCap: null,
    headroom: null,
    utilization: util,
    supplyApyPct,
    // Comet has no explicit supply-side fee; the take is the spread between rates,
    // shown as a share of what borrowers pay.
    protocolFeePct: borrowApyPct * util > 0 ? (spreadPct / (borrowApyPct * util)) * 100 : 0,
    protocolFeeLabel: 'Rate spread',
    frozen: false,
    paused: supplyPaused || withdrawPaused,
    extra: [
      { label: 'Utilisation', value: `${(util * 100).toFixed(1)}%` },
      { label: 'Borrowed', value: fmt(borrowed) },
      { label: 'Comet', value: comet.name },
      ...(withdrawPaused ? [{ label: 'Withdrawals', value: 'paused' }] : []),
    ],
  };
}

/**
 * Morpho Blue. Three things differ from Aave and each one changes the advice:
 *
 *   - there is no supply cap, so the only ceiling on a deposit is liquidity;
 *   - the market is the hash of its parameters, so the vault's asset MUST be the
 *     pinned market's loan token — otherwise we would be advising on a market the
 *     generated contract never touches (MRPH-MKT-018);
 *   - the supply rate is not stored. It is derived: borrow rate from the IRM,
 *     scaled by utilisation, less the market fee.
 */
async function readMorphoMarket(
  client: Client,
  asset: `0x${string}`,
  marketId: string | undefined,
): Promise<MarketSnapshot> {
  // The vault pins one market at construction (MRPH-MKT-018), so the advice has to
  // be about that market and no other. The catalogue holds the deepest markets per
  // loan asset; an asset with none is refused rather than analysed against the
  // wrong market.
  const market = resolveMorphoMarket(asset, marketId);
  if (!market) {
    throw new Error(
      `ADVISOR: No catalogued Morpho Blue market lends ${await symbolFor(client, asset)}. ` +
        'A Morpho market is the hash of its five parameters (MRPH-MKT-018), so there is nothing to advise on until one is pinned.',
    );
  }
  const id = market.id;
  const base = { address: MORPHO_BLUE, abi: morphoAbi, args: [id] } as const;

  const [mkt, params] = await Promise.all([
    client.readContract({ ...base, functionName: 'market' }),
    client.readContract({ ...base, functionName: 'idToMarketParams' }),
  ]);

  const [loanToken, collateralToken, , irm, lltv] = params;
  if (loanToken.toLowerCase() !== asset.toLowerCase()) {
    throw new Error('ADVISOR: The catalogued market does not lend this asset; the catalogue is stale.');
  }

  const decimals = Number(
    await client.readContract({ address: loanToken, abi: erc20Abi, functionName: 'decimals' }),
  );

  const borrowRatePerSecond = await client.readContract({
    address: irm,
    abi: irmAbi,
    functionName: 'borrowRateView',
    args: [
      { loanToken, collateralToken, oracle: params[2], irm, lltv },
      {
        totalSupplyAssets: mkt[0],
        totalSupplyShares: mkt[1],
        totalBorrowAssets: mkt[2],
        totalBorrowShares: mkt[3],
        lastUpdate: mkt[4],
        fee: mkt[5],
      },
    ],
  });

  const supplied = Number(formatUnits(mkt[0], decimals));
  const borrowed = Number(formatUnits(mkt[2], decimals));
  const utilization = supplied === 0 ? 0 : borrowed / supplied;
  const feePct = Number(mkt[5]) / 1e18;

  // Morpho compounds continuously (wTaylorCompounded), so expm1 of the annualised
  // per-second rate is the APY rather than an approximation of it.
  const borrowApy = Math.expm1((Number(borrowRatePerSecond) / 1e18) * SECONDS_PER_YEAR);
  const supplyApyPct = borrowApy * utilization * (1 - feePct) * 100;

  return {
    protocol: 'Morpho Blue',
    decimals,
    supplied,
    availableLiquidity: Math.max(supplied - borrowed, 0),
    // Not a large cap — no cap. Morpho Blue markets are uncapped by design.
    supplyCap: null,
    headroom: null,
    utilization,
    supplyApyPct,
    protocolFeePct: feePct * 100,
    protocolFeeLabel: 'Market fee',
    // Morpho markets cannot be frozen or paused: there is no admin that can do it.
    frozen: false,
    paused: false,
    extra: [
      { label: 'Utilisation', value: `${(utilization * 100).toFixed(1)}%` },
      { label: 'LLTV', value: morphoLltvPct(market) },
      { label: 'Collateral', value: market.collateralSymbol },
      { label: 'Borrowed', value: fmt(borrowed) },
    ],
  };
}

// ---------------------------------------------------------------------------
// Advisors. Protocol-agnostic: everything they need is on the snapshot.
// ---------------------------------------------------------------------------

/**
 * A deposit cap the market cannot honour is a promise the vault cannot keep.
 *
 * On Aave that means fitting under the supply cap (AAVE-RISK-010): deposits
 * revert outright once the market fills. Morpho has no cap, so the binding
 * constraint is liquidity instead — the vault will accept the deposit and only
 * fail on the way out, which is the quieter and later failure of the two.
 */
function adviseDepositCap(opts: GenerateOptions, snap: MarketSnapshot): SettingAdvice {
  const { decimals, headroom, availableLiquidity } = snap;
  const capTokens = opts.depositCap ? Number(opts.depositCap) / 10 ** decimals : null;
  const label = 'Deposit cap';
  const setting = 'depositCap' as const;

  // Aave: half the headroom leaves room for the rest of the market to keep
  // depositing. Morpho: half the free liquidity, for the same reason applied to
  // the only ceiling that exists.
  const ceiling = headroom ?? availableLiquidity;
  const suggested = Math.max(Math.floor(ceiling / 2), 0);
  const suggestedRaw = suggested > 0 ? `${suggested}${'0'.repeat(decimals)}` : '0';
  const recommended = `${fmt(suggested)} (${suggestedRaw})`;
  const recommendedRaw = suggestedRaw;

  if (capTokens === null) {
    return {
      setting,
      label,
      verdict: 'warn',
      current: 'unset',
      recommended,
      recommendedRaw,
      finding: headroom === null ? 'AAVE-VLT-004' : 'AAVE-RISK-010',
      detail:
        headroom === null
          ? `Morpho Blue has no supply cap, so an uncapped vault will keep taking deposits into a single market with ${fmt(availableLiquidity)} of free liquidity. Nothing reverts on the way in; the concentration only shows up when depositors try to leave together.`
          : 'With no cap the vault will keep accepting deposits after Aave stops accepting supply, and every deposit reverts from that point on.',
    };
  }

  if (headroom !== null && capTokens > headroom) {
    return {
      setting,
      label,
      verdict: 'bad',
      current: fmt(capTokens),
      recommended,
      recommendedRaw,
      finding: 'AAVE-RISK-010',
      detail: `Your cap exceeds Aave's remaining headroom of ${fmt(headroom)}. Deposits revert once the market cap is reached, and the vault has no way to signal that in advance.`,
    };
  }

  if (capTokens > availableLiquidity) {
    return {
      setting,
      label,
      verdict: headroom === null ? 'bad' : 'warn',
      current: fmt(capTokens),
      recommended: fmt(Math.floor(availableLiquidity / 2)),
      recommendedRaw: `${Math.max(Math.floor(availableLiquidity / 2), 0)}${'0'.repeat(decimals)}`,
      finding: 'AAVE-VLT-004',
      detail:
        headroom === null
          ? `Your cap exceeds the market's free liquidity of ${fmt(availableLiquidity)} — and Morpho has no cap to stop you reaching it. Once the vault holds more than the market can release, withdrawals revert until borrowers repay, and the vault has no second market to fall back on.`
          : `Your cap fits under the supply cap but exceeds available liquidity of ${fmt(availableLiquidity)}. If depositors exit together, Aave cannot pay out in full and withdrawals revert until borrowers repay.`,
    };
  }

  return {
    setting,
    label,
    verdict: 'ok',
    current: fmt(capTokens),
    detail:
      headroom === null
        ? `Fits inside the market's free liquidity of ${fmt(availableLiquidity)}. Morpho has no supply cap, so liquidity is the only ceiling — and it moves, so re-check before mainnet.`
        : `Fits under Aave's headroom of ${fmt(headroom)} and current liquidity of ${fmt(availableLiquidity)}. Both move, so re-check before mainnet.`,
  };
}

/** The fee is taken on yield, and yield is already net of the protocol's own cut. */
function adviseFee(opts: GenerateOptions, snap: MarketSnapshot): SettingAdvice {
  const bps = opts.feeBps ?? 0;
  const takes = (snap.supplyApyPct * bps) / 10000;
  const depositorsGet = snap.supplyApyPct - takes;
  const verdict: Verdict = bps > 500 ? 'warn' : 'ok';

  const alreadyTaken =
    snap.protocolFeePct > 0
      ? `${snap.protocol} has already taken a ${snap.protocolFeePct.toFixed(0)}% ${snap.protocolFeeLabel.toLowerCase()} before this point, so the fee compounds on an already-reduced yield.`
      : `${snap.protocol} currently takes no ${snap.protocolFeeLabel.toLowerCase()} on this market, so your fee is the only one depositors pay — but the market fee is governable and can be turned on without asking you.`;

  return {
    setting: 'feeBps',
    label: 'Performance fee',
    verdict,
    current: `${bps} bps`,
    recommended: verdict === 'warn' ? '≤ 500 bps' : undefined,
    recommendedRaw: verdict === 'warn' ? '500' : undefined,
    detail:
      `At the current ${snap.supplyApyPct.toFixed(2)}% supply APY, ${bps} bps takes ${takes.toFixed(3)}% and leaves depositors ${depositorsGet.toFixed(3)}%. ` +
      alreadyTaken +
      (verdict === 'warn'
        ? ' Above 500 bps the vault is hard to justify against supplying to the market directly.'
        : ''),
  };
}

/**
 * AAVE-VLT-003. The offset is the exponent on virtual shares: it multiplies what an
 * attacker must risk to win the empty-vault rounding attack. Protocol-independent —
 * this is an ERC-4626 property, not a lending-market one.
 */
function adviseOffset(opts: GenerateOptions, snap: MarketSnapshot): SettingAdvice {
  const offset = opts.decimalsOffset ?? 6;
  const multiplier = 10 ** offset;
  const setting = 'decimalsOffset' as const;
  const label = 'Virtual share offset';
  const recommended = snap.decimals <= 8 ? '6' : '3';

  if (offset === 0) {
    return {
      setting,
      label,
      verdict: 'bad',
      current: '0',
      recommended,
      recommendedRaw: recommended,
      finding: 'AAVE-VLT-003',
      detail:
        'With no offset there are no virtual shares, and the first depositor into an empty vault can be front-run and have their deposit rounded away entirely. This is the PoolTogether bug.',
    };
  }

  if (offset < 3) {
    return {
      setting,
      label,
      verdict: 'warn',
      current: String(offset),
      recommended,
      recommendedRaw: recommended,
      finding: 'AAVE-VLT-003',
      detail: `An attacker must donate roughly ${fmt(multiplier)}× the deposit they want to capture. That is affordable for a small first deposit. Raise the offset until the attack costs more than it can win.`,
    };
  }

  return {
    setting,
    label,
    verdict: 'ok',
    current: String(offset),
    detail: `Capturing a first deposit requires donating roughly ${fmt(multiplier)}× its size, which makes the rounding attack uneconomic. Share precision is ${snap.decimals} + ${offset} = ${snap.decimals + offset} decimals.`,
  };
}

// ---------------------------------------------------------------------------
// Sweeps. Same advisors, evaluated across a range, off the one market read.
// ---------------------------------------------------------------------------

/**
 * Describes the band of sensible values. Direction-agnostic on purpose: a deposit
 * cap gets worse as it rises, a virtual-share offset gets worse as it falls, so
 * anything that assumes "higher is worse" is wrong for half the settings.
 */
function frontierOf(points: SweepPoint[], fmtValue: (n: number) => string): string {
  const okIdx = points.map((p, i) => (p.verdict === 'ok' ? i : -1)).filter((i) => i >= 0);
  if (okIdx.length === 0) return 'No value in this range is sensible against the current market.';
  if (okIdx.length === points.length) return 'Every value in this range is sensible.';

  const lo = points[okIdx[0]];
  const hi = points[okIdx[okIdx.length - 1]];
  const badBelow = okIdx[0] > 0;
  const badAbove = okIdx[okIdx.length - 1] < points.length - 1;

  if (badBelow && badAbove) {
    return `Sensible between ${fmtValue(lo.value)} and ${fmtValue(hi.value)}; outside that, reconsider.`;
  }
  if (badAbove) return `Sensible up to ${fmtValue(hi.value)}; above that, reconsider.`;
  return `Sensible from ${fmtValue(lo.value)} upward; below that, reconsider.`;
}

function sweepDepositCap(opts: GenerateOptions, snap: MarketSnapshot): SettingSweep {
  const { decimals } = snap;
  const current = opts.depositCap ? Number(opts.depositCap) / 10 ** decimals : null;
  // Sweep past whichever ceiling actually binds, so the frontier is visible rather
  // than sitting off the right-hand edge of the strip.
  const ceiling = snap.headroom ?? snap.availableLiquidity;
  const top = Math.max(ceiling * 1.5, 1);

  const points: SweepPoint[] = Array.from({ length: 13 }, (_, i) => {
    const value = Math.round((top / 12) * i);
    const probe = { ...opts, depositCap: `${value}${'0'.repeat(decimals)}` };
    return { value, label: fmt(value), verdict: adviseDepositCap(probe, snap).verdict };
  });
  if (current !== null) markNearest(points, current);

  return {
    setting: 'depositCap',
    label: 'Deposit cap',
    points,
    frontier: frontierOf(points, (n) => fmt(n)),
  };
}

function sweepFee(opts: GenerateOptions, snap: MarketSnapshot): SettingSweep {
  const points: SweepPoint[] = Array.from({ length: 11 }, (_, i) => {
    const value = i * 100;
    return { value, label: `${value}`, verdict: adviseFee({ ...opts, feeBps: value }, snap).verdict };
  });
  markNearest(points, opts.feeBps ?? 0);

  return {
    setting: 'feeBps',
    label: 'Performance fee (bps)',
    points,
    frontier: frontierOf(points, (n) => `${n} bps`),
  };
}

function sweepOffset(opts: GenerateOptions, snap: MarketSnapshot): SettingSweep {
  const points: SweepPoint[] = Array.from({ length: 13 }, (_, i) => ({
    value: i,
    label: `${i}`,
    verdict: adviseOffset({ ...opts, decimalsOffset: i }, snap).verdict,
  }));
  markNearest(points, opts.decimalsOffset ?? 6);

  return {
    setting: 'decimalsOffset',
    label: 'Virtual share offset',
    points,
    frontier: frontierOf(points, (n) => `offset ${n}`),
  };
}

/** Flags the swept point closest to what the user actually set. */
function markNearest(points: SweepPoint[], current: number): void {
  let best = 0;
  for (let i = 1; i < points.length; i++) {
    if (Math.abs(points[i].value - current) < Math.abs(points[best].value - current)) best = i;
  }
  points[best].current = true;
}

// ---------------------------------------------------------------------------
// Stress grid: the deposit cap against a market condition it does not control.
// ---------------------------------------------------------------------------

const COLS = 5;
const ROWS = 6;
/** Past this the market is effectively fully lent out; further precision is noise. */
const MAX_UTILIZATION = 0.995;

const compact = (n: number): string => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${Math.round(n / 1e6)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return `${Math.round(n)}`;
};

/**
 * Re-runs the deposit-cap advice across a grid of caps and utilisations.
 *
 * Utilisation is a fact about the market, not a vault setting, which is exactly
 * why it belongs on the second axis: the vault cannot choose it, borrowers move
 * it, and it decides whether a withdrawal can be paid at all. Supplied stays
 * constant as utilisation rises — more borrowing, not more supply — so the
 * headroom under a supply cap is unchanged and only liquidity moves. That is the
 * whole point: on Aave the cap can look safe against headroom and still fail
 * against liquidity, and on Morpho liquidity is the only ceiling there is.
 */
function stressDepositCap(opts: GenerateOptions, snap: MarketSnapshot): StressGrid {
  const startU = Math.min(snap.utilization, MAX_UTILIZATION);
  const span = MAX_UTILIZATION - startU;
  const cols = Array.from({ length: COLS }, (_, i) => {
    const value = startU + (span / (COLS - 1)) * i;
    // 99.5% must not render as "100%" — a fully lent market and a nearly fully
    // lent one are different claims, and the second one is the one being made.
    const pct = value * 100;
    return { label: `${pct >= 99 ? pct.toFixed(1) : pct.toFixed(0)}%`, value };
  });

  const currentCap = opts.depositCap ? Number(opts.depositCap) / 10 ** snap.decimals : null;

  // Anchored on the configured cap, not on the market ceiling. A linear ladder up
  // to the ceiling puts its lowest rung above any modest cap — on Aave USDC that
  // meant a 20M cap sat below the 86M bottom row and the grid never showed it.
  // Multiples of the cap always contain the value being asked about, and answer
  // the follow-up question too: what happens if I raise or lower it.
  const rowValues =
    currentCap !== null && currentCap > 0
      ? [0.25, 0.5, 1, 2, 4, 8].map((m) => Math.round(currentCap * m))
      : Array.from({ length: ROWS }, (_, i) =>
          Math.round((Math.max((snap.headroom ?? snap.availableLiquidity) * 1.5, 1) / ROWS) * (i + 1)),
        );
  // The cap is row index 2 by construction of the multiplier ladder.
  const nearestRow = currentCap === null ? -1 : nearestIndex(rowValues, currentCap);

  const rows = rowValues.map((value, r) => {
    const probe = { ...opts, depositCap: `${value}${'0'.repeat(snap.decimals)}` };
    const cells: StressCell[] = cols.map((c, i) => ({
      verdict: adviseDepositCap(probe, atUtilization(snap, c.value)).verdict,
      // Today's utilisation is the leftmost column by construction.
      current: r === nearestRow && i === 0 ? true : undefined,
    }));
    return { label: compact(value), value, cells };
  });

  return {
    setting: 'depositCap',
    title: 'Deposit cap under market stress',
    rowLabel: 'Deposit cap',
    colLabel: 'Utilisation',
    cols,
    rows,
    summary: stressSummary(opts, snap, cols),
  };
}

/**
 * The same market with borrowing dialled up. Supplied is unchanged, so headroom
 * is unchanged and only free liquidity moves — which is what utilisation means.
 */
function atUtilization(snap: MarketSnapshot, u: number): MarketSnapshot {
  return { ...snap, utilization: u, availableLiquidity: Math.max(snap.supplied * (1 - u), 0) };
}

/** Names the utilisation at which the configured cap stops being payable. */
function stressSummary(
  opts: GenerateOptions,
  snap: MarketSnapshot,
  cols: { label: string; value: number }[],
): string {
  if (!opts.depositCap) {
    return 'Set a deposit cap to see how far the market can move before it stops holding.';
  }

  const verdicts = cols.map((c) => adviseDepositCap(opts, atUtilization(snap, c.value)).verdict);
  const firstBad = verdicts.findIndex((v) => v !== 'ok');

  if (firstBad === -1) {
    return `This cap still holds at ${cols[cols.length - 1].label} utilisation, so the market would have to be lent out almost entirely before withdrawals were affected.`;
  }
  if (firstBad === 0) {
    return `This cap does not hold even at today's ${cols[0].label} utilisation — the market cannot release that much right now.`;
  }
  return `Holds up to roughly ${cols[firstBad - 1].label} utilisation; it is currently ${(snap.utilization * 100).toFixed(0)}%. Borrowers move this, not you.`;
}

function nearestIndex(values: number[], target: number): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (Math.abs(values[i] - target) < Math.abs(values[best] - target)) best = i;
  }
  return best;
}
