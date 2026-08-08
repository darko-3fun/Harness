// Throwaway probe: dump the shape of each tracer's response so fetchTrace parses reality
// instead of a guess. Usage: tsx src/scripts/trace-probe.ts <txHash>

import { env } from '../env.js';

const hash = process.argv[2];
if (!hash) throw new Error('pass a tx hash');

function shape(value: unknown, depth = 0): string {
  if (depth > 3) return '…';
  if (Array.isArray(value)) return `[${value.length}× ${value.length ? shape(value[0], depth + 1) : ''}]`;
  if (value && typeof value === 'object') {
    return `{ ${Object.keys(value as object).slice(0, 24).join(', ')} }`;
  }
  return typeof value;
}

for (const [method, params] of [
  ['tenderly_traceTransaction', [hash]],
  ['debug_traceTransaction', [hash, { tracer: 'callTracer' }]],
] as Array<[string, unknown[]]>) {
  const res = await fetch(env.TENDERLY_ADMIN_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message?: string } };

  console.log(`\n=== ${method} ===`);
  if (json.error) {
    console.log(`  error: ${json.error.message}`);
    continue;
  }
  console.log(`  root: ${shape(json.result)}`);
  const r = json.result as Record<string, unknown>;
  for (const key of Object.keys(r ?? {})) {
    console.log(`    ${key}: ${shape(r[key], 1)}`);
  }
  const calls = (r?.calls ?? r?.trace ?? r?.call_trace) as unknown[] | undefined;
  if (Array.isArray(calls) && calls.length) {
    console.log(`  first nested entry: ${shape(calls[0], 1)}`);
    console.log(`  sample: ${JSON.stringify(calls[0]).slice(0, 400)}`);
  }
}
