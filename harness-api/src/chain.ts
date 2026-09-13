import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  pad,
  toFunctionSelector,
  toHex,
  type AbiFunction,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  addressesProviderAbi,
  erc20Abi,
  erc4626Abi,
  oracleAbi,
  poolAbi,
  traceDecodeAbi,
} from './aave.js';
import { ConfigError, env, requireDeployerKey } from './env.js';
import type { SimulateResult } from './types.js';

/**
 * The chain this service talks to: a local Anvil forking Ethereum mainnet.
 *
 * This replaced a hosted Tenderly Virtual Environment. The swap costs nothing in
 * fidelity — both are a fork of real mainnet, executing real contracts against
 * real state — and removes the account, the key and the bill. What it gives up
 * is a public explorer URL, because a local fork has nowhere to publish to.
 *
 * Three Tenderly RPC methods had to be replaced:
 *
 *   tenderly_setBalance        -> anvil_setBalance         (same idea, one address not an array)
 *   tenderly_setErc20Balance   -> no equivalent; see setErc20Balance below
 *   eth_sendTransaction (any `from`) -> anvil_autoImpersonateAccount, then the same call
 *
 * Tracing needed no replacement: the old code already fell back to the geth
 * `debug_traceTransaction` callTracer, which is what Anvil speaks natively.
 */

export const localChain = () =>
  defineChain({
    id: env.CHAIN_ID || 1,
    name: 'Anvil (mainnet fork)',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [env.RPC_URL] } },
  });

export function deployerAccount() {
  requireDeployerKey();
  const key = env.DEPLOYER_PRIVATE_KEY.startsWith('0x')
    ? (env.DEPLOYER_PRIVATE_KEY as Hex)
    : (`0x${env.DEPLOYER_PRIVATE_KEY}` as Hex);
  return privateKeyToAccount(key);
}

export function publicClient(): PublicClient {
  return createPublicClient({ chain: localChain(), transport: http(env.RPC_URL) });
}

export function walletClient(): WalletClient {
  return createWalletClient({
    account: deployerAccount(),
    chain: localChain(),
    transport: http(env.RPC_URL),
  });
}

let rpcId = 0;

/** Raw JSON-RPC, for the anvil_* / debug_* methods viem does not model. */
export async function rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
  let res: Response;
  try {
    res = await fetch(env.RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
  } catch (cause) {
    throw new ConfigError(
      `Cannot reach a chain at ${env.RPC_URL}. Start one with:\n` +
        `  anvil --fork-url <an archive RPC> --fork-block-number ${env.FORK_BLOCK || '<block>'}\n` +
        `or point RPC_URL at an existing fork. (${(cause as Error)?.message ?? 'connection failed'})`,
    );
  }
  if (!res.ok) throw new Error(`RPC ${method} failed with HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(`RPC ${method} failed: ${json.error.message ?? 'unknown'}`);
  return json.result as T;
}

const toQuantity = (value: bigint) => `0x${value.toString(16)}`;

/**
 * Is this a fork we are allowed to write to? Anvil answers anvil_nodeInfo; a plain
 * archive RPC does not, and writing cheatcodes to one would fail confusingly later.
 */
export async function assertWritableFork(): Promise<void> {
  try {
    await rpc('anvil_nodeInfo', []);
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    throw new ConfigError(
      `${env.RPC_URL} answered, but it is not an Anvil node: chain features need a fork ` +
        `that accepts cheatcodes. Start one with:\n` +
        `  anvil --fork-url <an archive RPC> --fork-block-number ${env.FORK_BLOCK || '<block>'}`,
    );
  }
}

export async function setNativeBalance(address: string, wei: bigint): Promise<void> {
  await rpc('anvil_setBalance', [address, toQuantity(wei)]);
}

/**
 * Save and restore the whole chain, so one scenario cannot leave state that changes
 * the next one's answer.
 *
 * This matters more than it sounds. Scenarios supply and borrow against the same Aave
 * reserves as the same deployer, so running them in sequence lets an earlier position
 * decide whether a later borrow is collateralised — which showed up as a scenario that
 * passed alone and failed in company. Reverting between them makes each one a
 * measurement of itself.
 *
 * A snapshot id is consumed by the revert that uses it, so take a fresh one after.
 */
export async function saveState(): Promise<Hex> {
  return rpc<Hex>('evm_snapshot', []);
}

/**
 * Throw the fork away and re-fork from the same upstream at the same block.
 *
 * Snapshots isolate scenarios from each other inside one run; this isolates whole runs
 * from each other. Without it a second run inherits the Aave positions the first one
 * opened, and a borrow that was fine on a clean chain is refused on a loaded one.
 * The upstream URL is left unset so Anvil re-uses the one it was started with, but the
 * block is named explicitly: an empty config re-forks at LATEST, which silently throws
 * away the pinned block and with it the reproducibility that pinning exists for.
 */
export async function resetFork(): Promise<void> {
  const forking = env.FORK_BLOCK ? { blockNumber: Number(env.FORK_BLOCK) } : {};
  await rpc('anvil_reset', [{ forking }]);
}

export async function restoreState(id: Hex): Promise<boolean> {
  return rpc<boolean>('evm_revert', [id]);
}

/**
 * Lets any address send transactions without a key, which is how the vault scenario
 * drives a separate attacker and victim. Tenderly allowed this unconditionally; Anvil
 * wants it switched on. Idempotent, so callers need not track whether it ran.
 */
export async function enableImpersonation(): Promise<void> {
  await rpc('anvil_autoImpersonateAccount', [true]);
}

/**
 * Give `holder` a balance of `token`.
 *
 * Anvil has no `setErc20Balance`. A token's balance lives in a mapping whose slot
 * number is an implementation detail of that token, so the slot is DISCOVERED: for
 * each candidate, write the desired value at the mapping key and ask the token what
 * it now reports. The slot that makes `balanceOf` agree is the right one; every
 * other write is rolled back. This is the technique Foundry's own `deal` cheatcode
 * uses, and it works on USDC, WETH, DAI and WBTC alike without a table of slots.
 *
 * Both key layouts are tried. Solidity hashes (key, slot); Vyper hashes (slot, key).
 */
const slotCache = new Map<string, { slot: bigint; vyper: boolean }>();

function mappingKey(holder: string, slot: bigint, vyper: boolean): Hex {
  const holderWord = pad(holder as Address, { size: 32 });
  const slotWord = pad(toHex(slot), { size: 32 });
  return keccak256(
    vyper
      ? encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [slotWord, holderWord])
      : encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [holderWord, slotWord]),
  );
}

/** How many storage slots to probe before giving up. Every token we use is far below this. */
const MAX_SLOT = 64n;

export async function setErc20Balance(
  token: string,
  holder: string,
  amount: bigint,
): Promise<void> {
  const pub = publicClient();
  const read = async (): Promise<bigint> =>
    (await pub.readContract({
      address: token as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [holder as Address],
    })) as bigint;

  const write = async (key: Hex, value: bigint): Promise<void> => {
    await rpc('anvil_setStorageAt', [token, key, pad(toHex(value), { size: 32 })]);
  };

  const target = pad(toHex(amount), { size: 32 });

  // A slot found earlier for this token is reused; layouts do not change mid-run.
  const cached = slotCache.get(token.toLowerCase());
  if (cached) {
    await write(mappingKey(holder, cached.slot, cached.vyper), amount);
    if ((await read()) === amount) return;
    slotCache.delete(token.toLowerCase());
  }

  for (let slot = 0n; slot < MAX_SLOT; slot++) {
    for (const vyper of [false, true]) {
      const key = mappingKey(holder, slot, vyper);
      const before = await rpc<Hex>('eth_getStorageAt', [token, key, 'latest']);
      if (before === target) {
        // Already exactly right (rare, but then this slot is as good as proven).
        slotCache.set(token.toLowerCase(), { slot, vyper });
        return;
      }
      await write(key, amount);
      if ((await read()) === amount) {
        slotCache.set(token.toLowerCase(), { slot, vyper });
        return;
      }
      // Wrong guess: put the slot back exactly as it was.
      await rpc('anvil_setStorageAt', [token, key, pad(before ?? '0x0', { size: 32 })]);
    }
  }

  throw new Error(
    `Could not locate the balance slot for token ${token} within ${MAX_SLOT} slots. ` +
      `If it stores balances in an unusual layout, seed it by impersonating a holder instead.`,
  );
}

type TreeCall = {
  type?: string;
  from?: string;
  to?: string;
  value?: string;
  input?: string;
  calls?: TreeCall[];
};

const selectorNames = (() => {
  const map = new Map<string, string>();
  for (const abi of [poolAbi, erc20Abi, erc4626Abi, oracleAbi, addressesProviderAbi, traceDecodeAbi]) {
    for (const item of abi) {
      if (item.type !== 'function') continue;
      const fn = item as AbiFunction;
      try {
        map.set(toFunctionSelector(fn), `${fn.name}(${fn.inputs.map((i) => i.type).join(',')})`);
      } catch {
        // a signature we cannot hash is simply not decodable
      }
    }
  }
  return map;
})();

function label(call: TreeCall): string {
  const selector = (call.input ?? '0x').slice(0, 10);
  return selectorNames.get(selector) ?? (selector.length === 10 ? selector : call.type ?? 'call');
}

function flattenTree(call: TreeCall, depth: number, out: SimulateResult['trace'], budget: number): void {
  if (out.length >= budget) return;
  out.push({
    depth,
    from: call.from ?? '0x',
    to: call.to ?? '0x',
    fn: label(call),
    value: call.value && call.value !== '0x0' && call.value !== '0x' ? call.value : undefined,
  });
  for (const child of call.calls ?? []) flattenTree(child, depth + 1, out, budget);
}

/**
 * Call trace for a mined transaction, from the geth-style callTracer Anvil implements.
 * Selectors are decoded to names where we know them. A trace failure never fails the
 * scenario — the balance changes are the evidence, the trace is the narration.
 */
export async function fetchTrace(txHash: string, budget = 200): Promise<SimulateResult['trace']> {
  try {
    const raw = await rpc<TreeCall>('debug_traceTransaction', [txHash, { tracer: 'callTracer' }]);
    if (raw && typeof raw === 'object') {
      const out: SimulateResult['trace'] = [];
      flattenTree(raw, 0, out, budget);
      if (out.length) return out;
    }
  } catch {
    // no trace available
  }
  return [];
}
