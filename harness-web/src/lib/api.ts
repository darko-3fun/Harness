import { audit as auditLocally } from '@/audit/engine';
import {
  API_ROUTES,
  type AuditRequest,
  type AuditResult,
  type CompileRequest,
  type CompileResult,
} from '@/types';

/**
 * The single place API_BASE is read. When it points at a running `harness-api`,
 * compile goes there; otherwise the app's own Next route runs the same solc.
 *
 * The audit always runs the engine bundled with the app: it is the one that knows
 * every preset and it needs no network, so it cannot be down. `harness-api`'s
 * engine covers only the two original Aave presets.
 */
const API_BASE = process.env.NEXT_PUBLIC_API_BASE?.replace(/\/$/, '') ?? '';

export async function compile(req: CompileRequest): Promise<{ result: CompileResult; live: boolean }> {
  const url = API_BASE ? `${API_BASE}${API_ROUTES.compile}` : '/api/compile';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok && res.status >= 500) {
    throw new Error(`Compile failed: ${res.status} ${res.statusText}`);
  }
  return { result: (await res.json()) as CompileResult, live: API_BASE !== '' };
}

export async function audit(req: AuditRequest): Promise<AuditResult> {
  return auditLocally(req.source, req.preset);
}
