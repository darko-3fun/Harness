// Prints the exact command that starts the fork this service expects, and tells you
// whether one is already running. Anvil ships with Foundry; nothing else is needed.

import { env } from '../env.js';

const command =
  `anvil --fork-url ${process.env.MAINNET_RPC_URL ?? 'https://eth.drpc.org'}` +
  `${env.FORK_BLOCK ? ` --fork-block-number ${env.FORK_BLOCK}` : ''}` +
  ` --host 0.0.0.0`;

async function main(): Promise<void> {
  console.log(`RPC_URL   ${env.RPC_URL}`);
  console.log(`fork block ${env.FORK_BLOCK || '(latest)'}\n`);

  try {
    const res = await fetch(env.RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    });
    const json = (await res.json()) as { result?: string };
    const block = json.result ? BigInt(json.result).toString() : '?';

    let anvil = true;
    try {
      const info = await fetch(env.RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'anvil_nodeInfo', params: [] }),
      });
      anvil = !((await info.json()) as { error?: unknown }).error;
    } catch {
      anvil = false;
    }

    console.log(`A chain is already running at block ${block}.`);
    console.log(
      anvil
        ? 'It accepts cheatcodes, so deploy and simulate will work.'
        : 'It is NOT an Anvil node, so cheatcodes will fail. Start one with the command below.',
    );
  } catch {
    console.log('No chain is running. Start one with:\n');
    console.log(`  ${command}\n`);
    console.log('On Windows, run that inside WSL — the port is reachable from Windows as-is.');
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
