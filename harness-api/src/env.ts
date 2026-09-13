import 'dotenv/config';

/**
 * Reads the first of `keys` that is set to something non-empty, else `fallback`.
 *
 * Empty counts as absent on purpose. A `.env` scaffolded from `.env.example` is full
 * of `KEY=` lines, and treating those as real values would override every default
 * with an empty string — which is exactly how the RPC URL came out blank the first
 * time this ran.
 */
function optional(keys: string | string[], fallback = ''): string {
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    const value = (process.env[key] ?? '').trim();
    if (value) return value;
  }
  return fallback;
}

/**
 * Anvil's first dev account. It is printed by Anvil on every start and is in its
 * public documentation, so it is not a secret and never will be — which is exactly
 * why it is safe as a default: it only ever holds play money on a local fork, and
 * nobody can mistake it for a key worth guarding. Override it for anything else.
 */
const ANVIL_ACCOUNT_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

/**
 * The block the fork is pinned at. Shared with the generated Foundry projects so the
 * API and the downloaded tests see the same chain state. Only a block number — any
 * archive RPC serves it, no account anywhere required.
 */
const DEFAULT_FORK_BLOCK = '25710954';

export const env = {
  PORT: Number(optional('PORT', '8787')),
  WEB_ORIGIN: optional('WEB_ORIGIN', 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  /** The fork to talk to. A local Anvil by default; TENDERLY_ADMIN_RPC still works. */
  RPC_URL: optional(['RPC_URL', 'TENDERLY_ADMIN_RPC'], 'http://127.0.0.1:8545'),
  CHAIN_ID: Number(optional(['CHAIN_ID', 'TENDERLY_CHAIN_ID'], '1')),
  FORK_BLOCK: optional(['FORK_BLOCK', 'TENDERLY_FORK_BLOCK'], DEFAULT_FORK_BLOCK),

  /**
   * Only set if you run an explorer against the fork (Otterscan, say). Empty means
   * deploy and simulate simply report no link, which is the honest answer for a
   * local chain rather than a broken URL.
   */
  EXPLORER_BASE: optional(['EXPLORER_BASE', 'TENDERLY_EXPLORER_BASE']).replace(/\/+$/, ''),

  DEPLOYER_PRIVATE_KEY: optional('DEPLOYER_PRIVATE_KEY', ANVIL_ACCOUNT_0),
};

export class ConfigError extends Error {}

/** Throws a message safe to return to the client — never echoes the key itself. */
export function requireDeployerKey(): void {
  if (!env.DEPLOYER_PRIVATE_KEY) {
    throw new ConfigError('DEPLOYER_PRIVATE_KEY is empty. See harness-api/.env.example.');
  }
}

export function explorerTxUrl(hash: string): string | undefined {
  return env.EXPLORER_BASE ? `${env.EXPLORER_BASE}/tx/${hash}` : undefined;
}

export function explorerAddressUrl(address: string): string | undefined {
  return env.EXPLORER_BASE ? `${env.EXPLORER_BASE}/address/${address}` : undefined;
}
