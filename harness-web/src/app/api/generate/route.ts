import { buildPreset, PRESET_DEFAULTS } from '@/generator';
import { type AttackSnippetFile } from '@/generator/attacks/assembleAttackTests';
import { describeOptionsError } from '@/generator/shared';
import { buildProjectFiles } from '@/lib/exportProject';
import snippets from '@/generated/attack-snippets.json';
import { PRESET_LIST, REMAPPINGS, type GenerateOptions, type GeneratedProject } from '@/types';

/**
 * Generation over HTTP, for the MCP server, CI and scripts. The generator is a
 * pure function, so exposing it is a matter of giving it a route. Defaults fill
 * the gaps so a caller can send just {preset} and get something that compiles.
 */

export const runtime = 'nodejs';

const SNIPPETS = snippets as unknown as AttackSnippetFile;

export async function POST(req: Request): Promise<Response> {
  let body: Partial<GenerateOptions>;
  try {
    body = (await req.json()) as Partial<GenerateOptions>;
  } catch {
    return json({ error: 'Malformed JSON body' }, 400);
  }

  if (!body.preset || !PRESET_LIST.includes(body.preset)) {
    return json({ error: `preset must be one of: ${PRESET_LIST.join(', ')}` }, 400);
  }

  const opts: GenerateOptions = { ...PRESET_DEFAULTS[body.preset], ...body };

  try {
    const files = buildProjectFiles(opts, SNIPPETS);
    const project: GeneratedProject & {
      testNames: string[];
      attackTests: typeof files.attacks;
      propertyTests: typeof files.properties;
    } = {
      preset: opts.preset,
      contractName: opts.name,
      contractSource: files.contract,
      attackTestSource: files.attackTests,
      propertyTestSource: files.propertyTests,
      deployScriptSource: files.deployScript,
      remappings: REMAPPINGS,
      appliedFindingIds: buildPreset(opts).appliedFindingIds,
      testNames: files.attacks.map((t) => t.testName),
      attackTests: files.attacks,
      propertyTests: files.properties,
    };
    return json(project, 200);
  } catch (e) {
    // OptionsError carries per-field messages; surface them rather than a bare 500.
    const err = e as Error & { messages?: Record<string, string> };
    return json({ error: describeOptionsError(e), fields: err.messages }, 400);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}
