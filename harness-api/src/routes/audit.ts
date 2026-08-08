import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuditResult, Finding, Preset } from '../types.js';
import { assertPreset, assertSource } from '../validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const findingsPath = path.resolve(here, '../../knowledge/findings.json');

let cachedFindings: Finding[] | null = null;

export function loadFindings(): Finding[] {
  if (cachedFindings) return cachedFindings;
  const parsed = JSON.parse(fs.readFileSync(findingsPath, 'utf8')) as { findings: Finding[] };
  cachedFindings = parsed.findings;
  return cachedFindings;
}

/**
 * Blanks out comments and string literals with spaces, keeping every byte offset (and therefore
 * every line number) intact. Without this a mitigation named in a `// TODO` comment would read as
 * present, and a bug pattern quoted inside a revert string would read as triggered.
 */
export function maskSource(source: string): string {
  const out = source.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (source[i] === '"' || source[i] === "'") {
      const quote = source[i];
      let j = i + 1;
      while (j < source.length && source[j] !== quote) {
        if (source[j] === '\\') j++;
        if (source[j] === '\n') break;
        j++;
      }
      blank(i, Math.min(j + 1, source.length));
      i = Math.min(j + 1, source.length);
    } else {
      i++;
    }
  }
  return out.join('');
}

const lineOf = (source: string, index: number) => source.slice(0, index).split('\n').length;

function compile(pattern: string): RegExp | null {
  try {
    // No 'm' flag: absence rules use `^(?![\s\S]*trigger)` to mean "trigger absent from the whole
    // source", which only works when ^ anchors to the start of the string rather than each line.
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

export interface AuditInput {
  source: string;
  preset: Preset;
}

export function parseAuditBody(body: unknown): AuditInput {
  const b = (body ?? {}) as Record<string, unknown>;
  return { source: assertSource(b.source), preset: assertPreset(b.preset) };
}

export function auditSource({ source, preset }: AuditInput): AuditResult {
  // CRLF would break multi-line patterns and a BOM would shift the first match; normalise once.
  const masked = maskSource(source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'));
  const findings: AuditResult['findings'] = [];

  for (const finding of loadFindings()) {
    const rules = finding.detect.filter((r) => r.appliesTo.includes(preset));
    if (rules.length === 0) continue;

    let status: 'mitigated' | 'triggered' = 'mitigated';
    let line: number | undefined;

    for (const rule of rules) {
      const re = compile(rule.pattern);
      if (!re) continue;
      const match = re.exec(masked);
      const fired = rule.kind === 'regex' ? match !== null : match === null;
      if (fired) {
        status = 'triggered';
        if (rule.kind === 'regex' && match) line = lineOf(masked, match.index);
        break;
      }
    }

    findings.push({ ...finding, status, ...(line !== undefined ? { line } : {}) });
  }

  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  findings.sort(
    (a, b) =>
      Number(b.status === 'triggered') - Number(a.status === 'triggered') ||
      severityRank[a.severity] - severityRank[b.severity] ||
      a.id.localeCompare(b.id),
  );

  return {
    findings,
    score: {
      mitigated: findings.filter((f) => f.status === 'mitigated').length,
      triggered: findings.filter((f) => f.status === 'triggered').length,
    },
  };
}
