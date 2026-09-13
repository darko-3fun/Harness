import { audit } from '@/audit/engine';
import { PRESET_LIST } from '@/types';
import type { AuditRequest } from '@/types';

/**
 * Audit over HTTP, so anything that speaks HTTP — the MCP server, CI, a script —
 * can audit Solidity without a browser. Same engine and same corpus as the page.
 */

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  let body: Partial<AuditRequest>;
  try {
    body = (await req.json()) as Partial<AuditRequest>;
  } catch {
    return json({ error: 'Malformed JSON body' }, 400);
  }

  if (typeof body.source !== 'string' || !body.source.trim()) {
    return json({ error: 'source is required' }, 400);
  }
  if (body.source.length > 512 * 1024) {
    return json({ error: 'source is too large (512 KiB max)' }, 413);
  }
  if (!body.preset || !PRESET_LIST.includes(body.preset)) {
    return json({ error: `preset must be one of: ${PRESET_LIST.join(', ')}` }, 400);
  }

  return json(audit(body.source, body.preset), 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}
