import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { CONTRACT_NAME_RE, EVM_VERSION, type CompileRequest, type CompileResult } from '@/types';

/**
 * Fallback for Agent B's POST /compile (task B4).
 *
 * The spec assigns compile to `harness-api`, but §5.2 specifies the mechanism as
 * "Next route + npm solc" — so this lives in harness-web to avoid colliding with
 * Agent B's directory. When API_BASE is set, `src/lib/api.ts` prefers the real
 * service and this becomes dead weight.
 *
 * solc's import callback is synchronous, which is exactly why this cannot run in
 * the browser: every OZ and Aave source has to be readable from disk right now.
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

const require = createRequire(import.meta.url);

/** Import strings the generator emits map onto npm packages under node_modules. */
const ROOT = process.cwd();

function resolveImport(importPath: string): { contents: string } | { error: string } {
  // Reject traversal before touching the filesystem: `importPath` is attacker-
  // reachable through a pasted contract.
  if (importPath.includes('..') || path.isAbsolute(importPath)) {
    return { error: `Refused to resolve suspicious import path: ${importPath}` };
  }
  try {
    return { contents: fs.readFileSync(path.join(ROOT, 'node_modules', importPath), 'utf8') };
  } catch {
    return { error: `Source "${importPath}" not found` };
  }
}

export async function POST(req: Request): Promise<Response> {
  let body: CompileRequest;
  try {
    body = (await req.json()) as CompileRequest;
  } catch {
    return json({ ok: false, errors: [{ severity: 'error', message: 'Malformed JSON body' }] }, 400);
  }

  const { contractName, source } = body;
  if (typeof source !== 'string' || !source.trim()) {
    return json({ ok: false, errors: [{ severity: 'error', message: 'Missing source' }] }, 400);
  }
  if (!CONTRACT_NAME_RE.test(contractName ?? '')) {
    return json(
      { ok: false, errors: [{ severity: 'error', message: 'Invalid contract name' }] },
      400,
    );
  }

  const solc = require('solc');
  const input = {
    language: 'Solidity',
    sources: { [`${contractName}.sol`]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Pinned to match the exported foundry.toml. If these diverge, the bytecode
      // the UI reports is not the bytecode the user's local build produces.
      evmVersion: EVM_VERSION,
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  let out: {
    errors?: { severity: string; formattedMessage?: string; message: string; sourceLocation?: { start: number } }[];
    contracts?: Record<string, Record<string, { abi: unknown[]; evm: { bytecode: { object: string } } }>>;
  };
  try {
    out = JSON.parse(solc.compile(JSON.stringify(input), { import: resolveImport }));
  } catch (e) {
    return json({ ok: false, errors: [{ severity: 'error', message: (e as Error).message }] }, 200);
  }

  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  const artifact = out.contracts?.[`${contractName}.sol`]?.[contractName];

  const result: CompileResult = {
    ok: errors.length === 0 && artifact !== undefined,
    errors: (out.errors ?? []).map((e) => ({
      severity: e.severity,
      message: e.formattedMessage ?? e.message,
      line: lineFromMessage(e.formattedMessage),
    })),
  };

  if (artifact) {
    result.abi = artifact.abi;
    result.bytecode = `0x${artifact.evm.bytecode.object}`;
    result.sizeBytes = artifact.evm.bytecode.object.length / 2;
  }

  return json(result, 200);
}

function lineFromMessage(formatted?: string): number | undefined {
  const m = formatted?.match(/\.sol:(\d+):/);
  return m ? Number(m[1]) : undefined;
}

function json(body: CompileResult | Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
