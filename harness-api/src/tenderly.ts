import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  toFunctionSelector,
  type AbiFunction,
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
import { env, requireChainConfig, requireDeployerKey } from './env.js';
import type { SimulateResult } from './types.js';

export const virtualNet = () =>
  defineChain({
    id: env.TENDERLY_CHAIN_ID || 1,
    name: 'Tenderly Virtual Mainnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [env.TENDERLY_ADMIN_RPC] } },
  });

export function deployerAccount() {
  requireDeployerKey();
  const key = env.DEPLOYER_PRIVATE_KEY.startsWith('0x')
    ? (env.DEPLOYER_PRIVATE_KEY as Hex)
    : (`0x${env.DEPLOYER_PRIVATE_KEY}` as Hex);
  return privateKeyToAccount(key);
}

export function publicClient(): PublicClient {
  requireChainConfig();
  return createPublicClient({ chain: virtualNet(), transport: http(env.TENDERLY_ADMIN_RPC) });
}

export function walletClient(): WalletClient {
  return createWalletClient({
    account: deployerAccount(),
    chain: virtualNet(),
    transport: http(env.TENDERLY_ADMIN_RPC),
  });
}

let rpcId = 0;

/** Raw admin-RPC call, for the tenderly_* / debug_* methods viem does not model. */
export async function adminRpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
  requireChainConfig();
  const res = await fetch(env.TENDERLY_ADMIN_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`Admin RPC ${method} failed with HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(`Admin RPC ${method} failed: ${json.error.message ?? 'unknown'}`);
  return json.result as T;
}

const toQuantity = (value: bigint) => `0x${value.toString(16)}`;

export async function setNativeBalance(address: string, wei: bigint): Promise<void> {
  await adminRpc('tenderly_setBalance', [[address], toQuantity(wei)]);
}

export async function setErc20Balance(
  token: string,
  holder: string,
  amount: bigint,
): Promise<void> {
  await adminRpc('tenderly_setErc20Balance', [token, holder, toQuantity(amount)]);
}

type FlatCall = {
  type?: string;
  from?: string;
  to?: string;
  value?: string;
  input?: string;
  /** tenderly_traceTransaction: depth is the length of this path. */
  traceAddress?: number[];
};

type TreeCall = FlatCall & { calls?: TreeCall[] };

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

function label(call: FlatCall): string {
  const selector = (call.input ?? '0x').slice(0, 10);
  return selectorNames.get(selector) ?? (selector.length === 10 ? selector : call.type ?? 'call');
}

function entry(call: FlatCall, depth: number): SimulateResult['trace'][number] {
  return {
    depth,
    from: call.from ?? '0x',
    to: call.to ?? '0x',
    fn: label(call),
    value: call.value && call.value !== '0x0' && call.value !== '0x' ? call.value : undefined,
  };
}

function flattenTree(call: TreeCall, depth: number, out: SimulateResult['trace'], budget: number): void {
  if (out.length >= budget) return;
  out.push(entry(call, depth));
  for (const child of call.calls ?? []) flattenTree(child, depth + 1, out, budget);
}

/**
 * Call trace for a mined tx. Tenderly's tracer returns a FLAT list whose depth is encoded in
 * traceAddress; geth's callTracer returns a nested tree. Both shapes are handled, and selectors
 * are decoded to names where we know them. A trace failure never fails the scenario.
 */
export async function fetchTrace(txHash: string, budget = 200): Promise<SimulateResult['trace']> {
  try {
    const raw = await adminRpc<{ trace?: FlatCall[] }>('tenderly_traceTransaction', [txHash]);
    const flat = raw?.trace;
    if (Array.isArray(flat) && flat.length) {
      return flat.slice(0, budget).map((c) => entry(c, c.traceAddress?.length ?? 0));
    }
  } catch {
    // fall through to the geth tracer
  }

  try {
    const raw = await adminRpc<TreeCall>('debug_traceTransaction', [txHash, { tracer: 'callTracer' }]);
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
