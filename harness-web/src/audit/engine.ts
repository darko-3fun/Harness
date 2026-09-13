import { FINDINGS } from '@/audit/findings';
import type { AuditResult, Finding, Preset } from '@/types';

/**
 * The audit rule engine.
 *
 * Runs every finding's detect rules over a Solidity source. `absence` means the
 * mitigation the pattern describes is missing; `regex` means a vulnerable pattern
 * is present. Either way the finding is triggered.
 *
 * Two things make this an audit of the CODE rather than of the text:
 *   - comments and string literals are blanked before matching, byte for byte, so
 *     a mitigation that survives only in a `// TODO` reads as absent and a bug
 *     pattern quoted in a revert string reads as absent too. Line numbers are
 *     preserved because only the characters change, never the newlines;
 *   - patterns are compiled without the `m` flag, so an absence rule may say
 *     `(mitigation)|^(?![\s\S]*trigger)` — "mitigated, or the risky operation is
 *     not performed at all" — with `^` anchored to the start of the whole source.
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
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

export function findingsFor(preset: Preset): Finding[] {
  return FINDINGS.filter((f) => f.detect.some((d) => d.appliesTo.includes(preset)));
}

export function audit(source: string, preset: Preset): AuditResult {
  // CRLF would break multi-line patterns and a BOM would shift the first match.
  const masked = maskSource(source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'));
  const findings: AuditResult['findings'] = [];

  for (const finding of FINDINGS) {
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
      // For a satisfied absence rule, point at the mitigation so the UI can show it.
      if (rule.kind === 'absence' && match && line === undefined && match[0].trim().length > 0) {
        line = lineOf(masked, match.index);
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
