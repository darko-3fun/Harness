import type { Abi } from 'viem';
import { explorerAddressUrl } from '../env.js';
import { deployerAccount, publicClient, setNativeBalance, walletClient, virtualNet } from '../tenderly.js';
import { assertConstructorArgs, assertContractName, assertSource, ValidationError } from '../validate.js';
import { compileContract } from './compile.js';
import type { DeployResult } from '../types.js';

const GAS_FLOOR = 10n ** 18n; // 1 ETH on the virtual net

export interface DeployInput {
  source: string;
  contractName: string;
  constructorArgs: (string | bigint | boolean)[];
}

export function parseDeployBody(body: unknown): DeployInput {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    source: assertSource(b.source),
    contractName: assertContractName(b.contractName),
    constructorArgs: assertConstructorArgs(b.constructorArgs),
  };
}

export async function deployContractSource(input: DeployInput): Promise<DeployResult> {
  const compiled = compileContract({ source: input.source, contractName: input.contractName });
  if (!compiled.ok || !compiled.bytecode || !compiled.abi) {
    const first = compiled.errors.find((e) => e.severity === 'error')?.message ?? 'compilation failed';
    throw new ValidationError(`Cannot deploy: ${first}`);
  }

  const account = deployerAccount();
  const pub = publicClient();

  if ((await pub.getBalance({ address: account.address })) < GAS_FLOOR) {
    await setNativeBalance(account.address, GAS_FLOOR * 100n);
  }

  const hash = await walletClient().deployContract({
    abi: compiled.abi as Abi,
    bytecode: compiled.bytecode,
    args: input.constructorArgs,
    account,
    chain: virtualNet(),
  });

  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`Deployment reverted (tx ${hash})`);
  }

  return {
    address: receipt.contractAddress,
    explorerUrl: explorerAddressUrl(receipt.contractAddress),
    txHash: hash,
  };
}
