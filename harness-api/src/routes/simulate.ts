import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem';
import { explorerTxUrl } from '../env.js';
import {
  DECIMALS,
  DEFAULT_FLASHLOAN_ENTRYPOINT,
  MAINNET_ADDRESSES_PROVIDER,
  SYMBOLS,
  TOKENS,
  UNISWAP_FEE_TIER,
  UNISWAP_V3_ROUTER,
  VARIABLE_RATE_MODE,
  addressesProviderAbi,
  erc20Abi,
  erc4626Abi,
  oracleAbi,
  poolAbi,
  swapRouterAbi,
} from '../aave.js';
import {
  deployerAccount,
  fetchTrace,
  publicClient,
  adminRpc,
  setErc20Balance,
  setNativeBalance,
  virtualNet,
  walletClient,
} from '../tenderly.js';
import {
  assertAddress,
  assertFunctionSignature,
  assertHexBytes,
  assertScenario,
  assertUintString,
  ValidationError,
} from '../validate.js';
import type { Scenario, SimulateResult } from '../types.js';

const MAX_UINT96 = (1n << 96n) - 1n;
const SLIPPAGE_BPS = 100n; // 1% — deliberately explicit, see AAVE-SWP-014
/** The receiver entrypoint is driven positionally, so its parameter list is fixed. */
const ENTRYPOINT_ARGS = '(address,uint256,bytes)';
/** Vault-scenario actors, driven by Tenderly impersonation rather than keys. Keeping them
 *  separate from the deployer means the scenario never inherits its accumulated Aave position. */
const ATTACKER = '0xbeef000000000000000000000000000000000002' as Address;
const VICTIM = '0xbeef000000000000000000000000000000000001' as Address;

export interface SimulateInput {
  scenario: Scenario;
  contractAddress?: Address;
  asset: Address;
  borrowAsset: Address;
  amount: bigint;
  borrowAmount: bigint;
  params: Hex;
  entrypoint: string;
}

export function parseSimulateBody(body: unknown): SimulateInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const scenario = assertScenario(b.scenario);
  const entrypoint =
    b.entrypoint === undefined ? DEFAULT_FLASHLOAN_ENTRYPOINT : assertFunctionSignature(b.entrypoint);
  if (!entrypoint.endsWith(ENTRYPOINT_ARGS)) {
    throw new ValidationError(`entrypoint must take exactly ${ENTRYPOINT_ARGS}`);
  }
  return {
    scenario,
    contractAddress: b.contractAddress === undefined ? undefined : assertAddress(b.contractAddress, 'contractAddress'),
    asset: b.asset === undefined ? TOKENS.USDC : assertAddress(b.asset, 'asset'),
    borrowAsset: b.borrowAsset === undefined ? TOKENS.WETH : assertAddress(b.borrowAsset, 'borrowAsset'),
    amount: b.amount === undefined ? 25_000_000_000n : assertUintString(b.amount, 'amount', MAX_UINT96),
    borrowAmount:
      b.borrowAmount === undefined ? 1_000_000_000_000_000_000n : assertUintString(b.borrowAmount, 'borrowAmount', MAX_UINT96),
    params: b.params === undefined ? '0x' : assertHexBytes(b.params),
    entrypoint,
  };
}

function label(token: Address): string {
  return SYMBOLS[token.toLowerCase()] ?? token;
}

function decimalsOf(token: Address, fallback = 18): number {
  return DECIMALS[token.toLowerCase()] ?? fallback;
}

type Tracked = { address: Address; name: string; decimals: number };

export async function runScenario(input: SimulateInput): Promise<SimulateResult> {
  const pub = publicClient();
  const wallet = walletClient();
  const account = deployerAccount();
  const chain = virtualNet();

  const pool = (await pub.readContract({
    address: MAINNET_ADDRESSES_PROVIDER,
    abi: addressesProviderAbi,
    functionName: 'getPool',
  })) as Address;

  const oracle = (await pub.readContract({
    address: MAINNET_ADDRESSES_PROVIDER,
    abi: addressesProviderAbi,
    functionName: 'getPriceOracle',
  })) as Address;

  await setNativeBalance(account.address, 1000n * 10n ** 18n);

  const tracked: Tracked[] = [
    { address: input.asset, name: label(input.asset), decimals: decimalsOf(input.asset, 6) },
    { address: input.borrowAsset, name: label(input.borrowAsset), decimals: decimalsOf(input.borrowAsset) },
  ];

  const aToken = await tryRead<Address>(() =>
    pub.readContract({ address: pool, abi: poolAbi, functionName: 'getReserveAToken', args: [input.asset] }),
  );
  if (aToken) tracked.push({ address: aToken, name: `a${label(input.asset)}`, decimals: decimalsOf(input.asset, 6) });

  const debtToken = await tryRead<Address>(() =>
    pub.readContract({
      address: pool,
      abi: poolAbi,
      functionName: 'getReserveVariableDebtToken',
      args: [input.borrowAsset],
    }),
  );
  if (debtToken) {
    tracked.push({ address: debtToken, name: `debt${label(input.borrowAsset)}`, decimals: decimalsOf(input.borrowAsset) });
  }

  // Seed BEFORE the snapshot. Seeding mid-scenario would make every delta a measurement across a
  // cheatcode write rather than across real economic movement.
  await setNativeBalance(account.address, 1000n * 10n ** 18n);
  await setErc20Balance(input.asset, account.address, input.amount * 20n);

  // The vault scenario's economics belong to the victim, not the deploying operator.
  const subject = input.scenario === 'vault-deposit' ? VICTIM : account.address;
  if (input.scenario === 'vault-deposit') {
    await setNativeBalance(VICTIM, 10n ** 19n);
    await setErc20Balance(input.asset, VICTIM, input.amount * 2n);
    await setNativeBalance(ATTACKER, 10n ** 19n);
    await setErc20Balance(input.asset, ATTACKER, input.amount * 10n);
  }

  const before = await snapshot(tracked, subject);

  let primaryTx: Hex;
  const extraRows: { token: string; delta: string }[] = [];
  switch (input.scenario) {
    case 'supply-borrow':
      primaryTx = await supplyBorrow(input, pool);
      break;
    case 'flashloan-simple':
      primaryTx = await flashLoanSimple(input, pool);
      break;
    case 'leverage-loop':
      primaryTx = await leverageLoop(input, pool, oracle);
      break;
    case 'vault-deposit':
      primaryTx = await vaultDeposit(input);
      break;
  }

  const after = await snapshot(tracked, subject);
  const trace = await fetchTrace(primaryTx);

  const balanceChanges = tracked.map((t, i) => ({
    token: t.name,
    delta: signedDelta(after[i]! - before[i]!, t.decimals),
  }));

  // Scenario-specific findings ride the existing field so the wire format stays frozen.
  balanceChanges.push(...extraRows);

  return {
    ok: true,
    scenario: input.scenario,
    trace,
    balanceChanges,
    explorerUrl: explorerTxUrl(primaryTx),
  };

  // ---- scenarios -------------------------------------------------------------------------

  async function supplyBorrow(inp: SimulateInput, poolAddress: Address): Promise<Hex> {
    await send({ address: inp.asset, abi: erc20Abi, functionName: 'approve', args: [poolAddress, inp.amount] });
    await send({
      address: poolAddress,
      abi: poolAbi,
      functionName: 'supply',
      args: [inp.asset, inp.amount, account.address, 0],
    });
    return send({
      address: poolAddress,
      abi: poolAbi,
      functionName: 'borrow',
      args: [inp.borrowAsset, inp.borrowAmount, VARIABLE_RATE_MODE, 0, account.address],
    });
  }

  async function flashLoanSimple(inp: SimulateInput, poolAddress: Address): Promise<Hex> {
    if (!inp.contractAddress) {
      throw new ValidationError('flashloan-simple requires contractAddress (the deployed receiver)');
    }
    const premiumBps = (await pub.readContract({
      address: poolAddress,
      abi: poolAbi,
      functionName: 'FLASHLOAN_PREMIUM_TOTAL',
    })) as bigint;

    const premium = (inp.amount * premiumBps) / 10_000n + 1n;

    // Which receiver shape is deployed? The generator emits a typed-struct entrypoint (carrying no
    // bytes payload, which is itself the AAVE-FL-002 mitigation), so the selector is looked up in
    // the runtime dispatch table rather than assumed.
    const code = (await pub.getCode({ address: inp.contractAddress })) ?? '0x';
    const selectorOf = (sig: string) => toFunctionSelector(sig);
    const exposes = (sig: string) => code.includes(selectorOf(sig).slice(2));

    const TYPED_ENTRYPOINT = 'initiateFlashLoan(uint256,(uint256,uint256,address))';
    const ROUTER_SETTER = 'setRouterAllowed(address,bool)';

    if (exposes(TYPED_ENTRYPOINT)) {
      if (exposes(ROUTER_SETTER)) {
        await sendRaw(
          inp.contractAddress,
          concatHex([
            selectorOf(ROUTER_SETTER),
            encodeAbiParameters([{ type: 'address' }, { type: 'bool' }], [UNISWAP_V3_ROUTER, true]),
          ]),
        );
      }

      // The generated strategy is a deliberate no-op, so it earns nothing to cover the premium.
      // The initiator funds exactly the premium for the duration of the call.
      await send({
        address: inp.asset,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [inp.contractAddress, premium],
      });

      const block = await pub.getBlock();
      const data = concatHex([
        selectorOf(TYPED_ENTRYPOINT),
        encodeAbiParameters(
          [
            { type: 'uint256' },
            { type: 'tuple', components: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'address' }] },
          ],
          [inp.amount, [1n, block.timestamp + 600n, UNISWAP_V3_ROUTER]],
        ),
      ]);
      return sendRaw(inp.contractAddress, data);
    }

    await send({
      address: inp.asset,
      abi: erc20Abi,
      functionName: 'approve',
      args: [inp.contractAddress, premium * 10n],
    });

    const data = concatHex([
      toFunctionSelector(`function ${inp.entrypoint}`),
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }],
        [inp.asset, inp.amount, inp.params],
      ),
    ]);

    return sendRaw(inp.contractAddress, data);
  }

  async function leverageLoop(inp: SimulateInput, poolAddress: Address, oracleAddress: Address): Promise<Hex> {
    await supplyBorrow(inp, poolAddress);

    const [priceIn, priceOut, baseUnit] = await Promise.all([
      pub.readContract({ address: oracleAddress, abi: oracleAbi, functionName: 'getAssetPrice', args: [inp.borrowAsset] }) as Promise<bigint>,
      pub.readContract({ address: oracleAddress, abi: oracleAbi, functionName: 'getAssetPrice', args: [inp.asset] }) as Promise<bigint>,
      pub.readContract({ address: oracleAddress, abi: oracleAbi, functionName: 'BASE_CURRENCY_UNIT' }) as Promise<bigint>,
    ]);
    if (priceOut === 0n || baseUnit === 0n) throw new Error('Aave oracle returned a zero price');

    // AAVE-ORC-012: normalise both sides explicitly instead of multiplying raw amounts by raw prices.
    const inDecimals = BigInt(decimalsOf(inp.borrowAsset));
    const outDecimals = BigInt(decimalsOf(inp.asset, 6));
    const expectedOut = (inp.borrowAmount * priceIn * 10n ** outDecimals) / (priceOut * 10n ** inDecimals);
    // AAVE-SWP-014: a real bound derived from the oracle, never amountOutMinimum: 0.
    const minOut = (expectedOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    if (minOut === 0n) throw new Error('Computed minAmountOut is zero; refusing to swap unprotected');

    const block = await pub.getBlock();
    await send({
      address: inp.borrowAsset,
      abi: erc20Abi,
      functionName: 'approve',
      args: [UNISWAP_V3_ROUTER, inp.borrowAmount],
    });
    await send({
      address: UNISWAP_V3_ROUTER,
      abi: swapRouterAbi,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: inp.borrowAsset,
          tokenOut: inp.asset,
          fee: UNISWAP_FEE_TIER,
          recipient: account.address,
          deadline: block.timestamp + 600n,
          amountIn: inp.borrowAmount,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });

    await send({ address: inp.asset, abi: erc20Abi, functionName: 'approve', args: [poolAddress, minOut] });
    return send({
      address: poolAddress,
      abi: poolAbi,
      functionName: 'supply',
      args: [inp.asset, minOut, account.address, 0],
    });
  }

  /**
   * The demo scenario, and the real first-depositor inflation attack rather than a gesture at it.
   * A donation cannot rob a sole shareholder — it just gifts the money back — so this needs two
   * parties: the attacker opens a dust position and donates aTokens, then a victim deposits. The
   * assertion that matters is that the victim still gets fair value back out.
   */
  async function vaultDeposit(inp: SimulateInput): Promise<Hex> {
    if (!inp.contractAddress) {
      throw new ValidationError('vault-deposit requires contractAddress (the deployed vault)');
    }
    const vault = inp.contractAddress;
    const decimals = decimalsOf(inp.asset, 6);
    const call = (abi: readonly unknown[], functionName: string, args: unknown[]) =>
      encodeFunctionData({ abi: abi as never, functionName, args } as never);

    // 1. attacker takes the first position. Not 1 wei: Aave scales the supply by the liquidity
    //    index, and anything that rounds to zero scaled units reverts with InvalidAmount().
    const dust = 10n ** BigInt(Math.max(decimals - 3, 1));
    await sendAs(ATTACKER, inp.asset, call(erc20Abi, 'approve', [vault, inp.amount * 10n]));
    await sendAs(ATTACKER, vault, call(erc4626Abi, 'deposit', [dust, ATTACKER]));

    // 2. attacker donates aTokens straight at the vault. Acquired by genuinely supplying to Aave,
    //    because aToken balances are scaled and a cheatcode-written slot would lie.
    let donated = 0n;
    if (aToken) {
      const pool = (await pub.readContract({
        address: MAINNET_ADDRESSES_PROVIDER,
        abi: addressesProviderAbi,
        functionName: 'getPool',
      })) as Address;

      await sendAs(ATTACKER, inp.asset, call(erc20Abi, 'approve', [pool, inp.amount * 4n]));
      await sendAs(ATTACKER, pool, call(poolAbi, 'supply', [inp.asset, inp.amount * 4n, ATTACKER, 0]));

      donated = (await pub.readContract({
        address: aToken,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [ATTACKER],
      })) as bigint;

      if (donated > 0n) await sendAs(ATTACKER, aToken, call(erc20Abi, 'transfer', [vault, donated]));
    }

    // 3. the victim deposits into the poisoned vault
    await sendAs(VICTIM, inp.asset, call(erc20Abi, 'approve', [vault, inp.amount]));
    const victimTx = await sendAs(VICTIM, vault, call(erc4626Abi, 'deposit', [inp.amount, VICTIM]));

    const victimShares = (await pub.readContract({
      address: vault,
      abi: erc4626Abi,
      functionName: 'balanceOf',
      args: [VICTIM],
    })) as bigint;

    const victimRedeemable = (await pub.readContract({
      address: vault,
      abi: erc4626Abi,
      functionName: 'convertToAssets',
      args: [victimShares],
    })) as bigint;

    const lost = inp.amount > victimRedeemable ? inp.amount - victimRedeemable : 0n;
    extraRows.push(
      { token: 'attacker donated (aToken, direct transfer)', delta: signedDelta(donated, decimals) },
      { token: 'victim deposited', delta: signedDelta(inp.amount, decimals) },
      { token: 'victim redeemable after the donation', delta: signedDelta(victimRedeemable, decimals) },
      { token: 'victim value LOST to the attacker (AAVE-VLT-003)', delta: signedDelta(lost, decimals) },
      { token: 'victim shares minted (0 would mean total loss)', delta: victimShares.toString() },
      {
        token: 'attacker spend per unit extracted (higher = less profitable)',
        delta: lost > 0n ? `${donated / lost}:1` : 'infinite — attack extracted nothing',
      },
    );

    return victimTx;
  }

  // ---- helpers ---------------------------------------------------------------------------

  // viem's write helpers are generic over a literal ABI; these calls are dispatched dynamically,
  // so the ABI is bridged through `any` at this single boundary rather than everywhere.
  async function send(call: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: unknown[];
  }): Promise<Hex> {
    const { request } = await (pub.simulateContract as any)({
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
      account,
    });
    const hash = (await (wallet.writeContract as any)({ ...request, account, chain })) as Hex;
    await expectSuccess(hash);
    return hash;
  }

  async function expectSuccess(hash: Hex): Promise<void> {
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`Transaction reverted (${hash})`);
  }

  /** Sends from an address we hold no key for, using the virtual net's impersonation support. */
  async function sendAs(from: Address, to: Address, data: Hex): Promise<Hex> {
    const hash = await adminRpc<Hex>('eth_sendTransaction', [{ from, to, data, gas: '0x7a1200' }]);
    await expectSuccess(hash);
    return hash;
  }

  /** Raw call from the deployer, for ABIs discovered at runtime rather than known up front. */
  async function sendRaw(to: Address, data: Hex): Promise<Hex> {
    const hash = await wallet.sendTransaction({ account, chain, to, data });
    await expectSuccess(hash);
    return hash;
  }

  async function snapshot(tokens: Tracked[], owner: Address): Promise<bigint[]> {
    return Promise.all(
      tokens.map(
        async (t) =>
          (await tryRead<bigint>(() =>
            pub.readContract({ address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
          )) ?? 0n,
      ),
    );
  }
}

async function tryRead<T>(fn: () => Promise<unknown>): Promise<T | undefined> {
  try {
    return (await fn()) as T;
  } catch {
    return undefined;
  }
}

function signedDelta(delta: bigint, decimals: number): string {
  const sign = delta < 0n ? '-' : '+';
  return `${sign}${formatUnits(delta < 0n ? -delta : delta, decimals)}`;
}
