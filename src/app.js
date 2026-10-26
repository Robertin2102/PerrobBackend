import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { generateSeedMatches } from './seed.js';
import { validateMatch, validateSeedRequest, ValidationError } from './validation.js';

function authorized(header, expected) {
  if (typeof expected !== 'string' || expected.length < 24 ||
      typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

export function createApp({ store, adminToken, matchIngestToken, corsOrigin = '' }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (corsOrigin && req.headers.origin === corsOrigin) {
      res.set('Access-Control-Allow-Origin', corsOrigin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });
  app.use(express.json({ limit: '5mb', strict: true }));

  app.get('/health', async (_req, res) => {
    await store.health();
    res.json({ status: 'ok' });
  });

  app.get('/api/test/telemetry', async (req, res) => {
    const started = performance.now();
    const source = req.query.source ?? 'all';
    if (typeof source !== 'string' || !['all', 'seed', 'live'].includes(source)) {
      throw new ValidationError('source debe ser all, seed o live.');
    }
    const playerId = req.query.playerId ?? null;
    if (playerId !== null && (typeof playerId !== 'string' || playerId.trim().length < 1 ||
        playerId.trim().length > 64)) {
      throw new ValidationError('playerId debe tener entre 1 y 64 caracteres.');
    }
    const metrics = await store.telemetry(source, playerId?.trim() ?? null);
    res.json({ ...metrics, serverProcessingMs: Math.round((performance.now() - started) * 100) / 100 });
  });

  app.post('/api/test/seed', async (req, res) => {
    if (!authorized(req.get('authorization'), adminToken)) {
      return res.status(401).json({ error: 'Se requiere el token de administración.' });
    }
    const request = validateSeedRequest(req.body);
    const matches = Array.isArray(request) ? request : generateSeedMatches(request.count, request.seed);
    const started = performance.now();
    await store.replaceSeed(matches);
    res.status(200).json({ source: 'seed', insertedMatches: matches.length,
      message: 'Datos de prueba reemplazados; las partidas reales se conservaron.',
      writeMs: Math.round((performance.now() - started) * 100) / 100 });
  });

  app.post('/api/matches', async (req, res) => {
    if (!authorized(req.get('authorization'), matchIngestToken)) {
      return res.status(401).json({ error: 'Se requiere el token de ingestión de partidas.' });
    }
    const match = validateMatch(req.body);
    const result = await store.recordMatch(match);
    res.status(result.duplicate ? 200 : 201).json({ matchId: match.matchId,
      saved: !result.duplicate, duplicate: result.duplicate,
      winnerSlot: match.players.find(p => p.result === 'win')?.slot ?? null });
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof ValidationError || error instanceof SyntaxError && error.status === 400) {
      return res.status(400).json({ error: error.message });
    }
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ error: 'El JSON excede el límite de 5 MB.' });
    }
    console.error(error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  });
  return app;
}
