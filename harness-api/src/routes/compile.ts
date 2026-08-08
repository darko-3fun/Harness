import solc from 'solc';
import { resolveImport } from '../solc-imports.js';
import { assertContractName, assertSource } from '../validate.js';
import type { CompileResult } from '../types.js';

interface SolcError {
  severity?: string;
  type?: string;
  formattedMessage?: string;
  message?: string;
  sourceLocation?: { file?: string; start?: number };
}

function lineFromOffset(source: string, offset?: number): number | undefined {
  if (offset === undefined || offset < 0) return undefined;
  return source.slice(0, offset).split('\n').length;
}

export interface CompileInput {
  source: string;
  contractName: string;
}

export function parseCompileBody(body: unknown): CompileInput {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    source: assertSource(b.source),
    contractName: assertContractName(b.contractName),
  };
}

export function compileContract({ source, contractName }: CompileInput): CompileResult {
  const fileName = `${contractName}.sol`;
  const content = source.replace(/^\uFEFF/, '');
  const input = {
    language: 'Solidity',
    sources: { [fileName]: { content } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Mainnet is post-Cancun; paris rejects mcopy, which solc emits for string.concat.
      evmVersion: 'cancun',
      outputSelection: {
        '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: resolveImport })) as {
    errors?: SolcError[];
    contracts?: Record<string, Record<string, { abi: unknown[]; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>>;
  };

  const errors: CompileResult['errors'] = (output.errors ?? []).map((e) => ({
    severity: e.severity ?? e.type ?? 'error',
    message: e.formattedMessage ?? e.message ?? 'Unknown solc diagnostic',
    line: lineFromOffset(content, e.sourceLocation?.start),
  }));

  const fatal = errors.some((e) => e.severity === 'error');
  const artifact = output.contracts?.[fileName]?.[contractName];

  if (fatal || !artifact) {
    if (!fatal && !artifact) {
      errors.push({
        severity: 'error',
        message: `Compilation produced no artifact named "${contractName}" in ${fileName}.`,
      });
    }
    return { ok: false, errors };
  }

  const deployed = artifact.evm.deployedBytecode.object ?? '';
  return {
    ok: true,
    abi: artifact.abi,
    bytecode: `0x${artifact.evm.bytecode.object}`,
    sizeBytes: Math.floor(deployed.replace(/^0x/, '').length / 2),
    errors,
  };
}
