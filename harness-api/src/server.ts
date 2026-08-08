import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ConfigError, env } from './env.js';
import { ValidationError } from './validate.js';
import { compileContract, parseCompileBody } from './routes/compile.js';
import { auditSource, loadFindings, parseAuditBody } from './routes/audit.js';
import { deployContractSource, parseDeployBody } from './routes/deploy.js';
import { parseSimulateBody, runScenario } from './routes/simulate.js';
import { remappings } from './solc-imports.js';

const app = express();

app.disable('x-powered-by');
// bigints reach the wire as decimal strings — this is the h10 serialization bug, pre-fixed.
app.set('json replacer', (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value,
);

app.use(
  cors({
    // cb(null, false) simply withholds the CORS headers; throwing here would surface as a 500
    // and hide the real cause from the browser console.
    origin: (origin, cb) => cb(null, !origin || env.WEB_ORIGIN.includes(origin)),
    methods: ['GET', 'POST', 'OPTIONS'],
  }),
);
app.use(express.json({ limit: '1mb' }));

// solc and the virtual net are both expensive; a coarse per-IP window keeps a stray loop from
// taking the demo down.
const hits = new Map<string, number[]>();
const WINDOW_MS = 60_000;
const MAX_HITS = 60;
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  const key = req.ip ?? 'unknown';
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  if (recent.length > MAX_HITS) return res.status(429).json({ error: 'Too many requests' });
  next();
});

const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    findings: loadFindings().length,
    chainConfigured: Boolean(env.TENDERLY_ADMIN_RPC && env.DEPLOYER_PRIVATE_KEY),
    publicRpc: env.TENDERLY_PUBLIC_RPC || null,
    explorerBase: env.TENDERLY_EXPLORER_BASE || null,
  });
});

// Frozen item #3 of §5.6 — Agent A's generated Solidity must import against exactly these.
app.get('/remappings', (_req, res) => res.json({ remappings: remappings() }));

app.get('/findings', (_req, res) => res.json({ findings: loadFindings() }));

app.post(
  '/compile',
  asyncRoute(async (req, res) => {
    res.json(compileContract(parseCompileBody(req.body)));
  }),
);

app.post(
  '/audit',
  asyncRoute(async (req, res) => {
    res.json(auditSource(parseAuditBody(req.body)));
  }),
);

app.post(
  '/deploy',
  asyncRoute(async (req, res) => {
    res.json(await deployContractSource(parseDeployBody(req.body)));
  }),
);

app.post(
  '/simulate',
  asyncRoute(async (req, res) => {
    res.json(await runScenario(parseSimulateBody(req.body)));
  }),
);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  if (err instanceof ConfigError) return res.status(503).json({ error: err.message });
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Request body is not valid JSON' });
  }
  const message = err instanceof Error ? err.message : 'Internal error';
  console.error('[harness-api]', message);
  res.status(500).json({ error: message.slice(0, 500) });
});

app.listen(env.PORT, () => {
  console.log(`harness-api listening on :${env.PORT} (CORS: ${env.WEB_ORIGIN.join(', ')})`);
});
