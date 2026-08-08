import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, '..');

/**
 * Roots solc imports may be resolved from. Import strings come from user-submitted Solidity, so
 * resolution is confined to these directories and any path escaping them is rejected outright
 * (OWASP A01 / path traversal).
 */
const ROOTS = [
  path.join(apiRoot, 'node_modules'),
  path.join(apiRoot, 'contracts'),
].filter((dir) => fs.existsSync(dir));

const ALLOWED_PREFIXES = ['@openzeppelin/', '@aave/', 'forge-std/', 'src/', 'contracts/', './', '../'];

const cache = new Map<string, string>();

function isAllowed(importPath: string): boolean {
  if (importPath.includes('\0')) return false;
  return ALLOWED_PREFIXES.some((p) => importPath.startsWith(p));
}

function readWithin(root: string, importPath: string): string | undefined {
  const candidate = path.resolve(root, importPath);
  const rel = path.relative(root, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return undefined;
  return fs.readFileSync(candidate, 'utf8');
}

/** solc's import callback is synchronous by contract — every lookup must hit the local disk. */
export function resolveImport(importPath: string): { contents: string } | { error: string } {
  if (!isAllowed(importPath)) {
    return { error: `Import "${importPath}" is not on the allowlist (${ALLOWED_PREFIXES.join(', ')})` };
  }
  const cached = cache.get(importPath);
  if (cached !== undefined) return { contents: cached };

  for (const root of ROOTS) {
    const contents = readWithin(root, importPath);
    if (contents !== undefined) {
      cache.set(importPath, contents);
      return { contents };
    }
  }
  return {
    error:
      `Could not resolve "${importPath}". Install the dependency in harness-api ` +
      `(npm i @openzeppelin/contracts @aave/core-v3) or vendor it under harness-api/contracts/.`,
  };
}

export function remappings(): string[] {
  const file = path.join(apiRoot, 'remappings.txt');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}
