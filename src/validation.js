const MAX_COUNT = 1_000_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value, label, max = MAX_COUNT) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new ValidationError(`${label} debe ser un entero entre 0 y ${max}.`);
  }
  return value;
}

function text(value, label, max = 64) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > max) {
    throw new ValidationError(`${label} debe tener entre 1 y ${max} caracteres.`);
  }
  return value.trim();
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function validateMatch(value) {
  if (!isRecord(value)) throw new ValidationError('La partida debe ser un objeto JSON.');
  if (typeof value.matchId !== 'string' || !UUID_RE.test(value.matchId)) {
    throw new ValidationError('matchId debe ser un UUID.');
  }
  if (typeof value.startedAt !== 'string' || typeof value.endedAt !== 'string' ||
      !value.startedAt.endsWith('Z') || !value.endedAt.endsWith('Z')) {
    throw new ValidationError('startedAt y endedAt deben ser fechas ISO 8601 en UTC (terminadas en Z).');
  }
  const startedAt = new Date(value.startedAt);
  const endedAt = new Date(value.endedAt);
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime()) ||
      endedAt <= startedAt || endedAt.getTime() > Date.now() + 60_000) {
    throw new ValidationError('startedAt y endedAt deben ser fechas válidas, ordenadas y no futuras.');
  }
  const durationSeconds = (endedAt - startedAt) / 1000;
  if (durationSeconds < 1 || durationSeconds > 3600) {
    throw new ValidationError('La duración debe estar entre 1 y 3600 segundos.');
  }
  if (!Array.isArray(value.players) || value.players.length !== 2) {
    throw new ValidationError('Se requieren exactamente dos jugadores.');
  }
  const players = value.players.map((p, i) => {
    if (!isRecord(p)) throw new ValidationError(`players[${i}] debe ser un objeto.`);
    return {
      slot: integer(p.slot, `players[${i}].slot`, 1),
      playerId: text(p.playerId, `players[${i}].playerId`),
      deliveredDocuments: integer(p.deliveredDocuments, `players[${i}].deliveredDocuments`),
      paperBallsThrown: integer(p.paperBallsThrown, `players[${i}].paperBallsThrown`),
      paperHitsLanded: integer(p.paperHitsLanded, `players[${i}].paperHitsLanded`),
      paperHitsReceived: integer(p.paperHitsReceived, `players[${i}].paperHitsReceived`),
      knockouts: integer(p.knockouts, `players[${i}].knockouts`),
      deaths: integer(p.deaths, `players[${i}].deaths`),
      survivalSeconds: p.survivalSeconds
    };
  });
  if (players[0].slot === players[1].slot || players[0].playerId === players[1].playerId) {
    throw new ValidationError('Los jugadores deben tener slots e identificadores diferentes.');
  }
  for (const [i, p] of players.entries()) {
    if (typeof p.survivalSeconds !== 'number' || !Number.isFinite(p.survivalSeconds) ||
        p.survivalSeconds < 0 || p.survivalSeconds > durationSeconds + 0.001) {
      throw new ValidationError(`players[${i}].survivalSeconds debe estar entre 0 y la duración.`);
    }
    if (p.paperHitsLanded > p.paperBallsThrown || p.knockouts > p.paperHitsLanded) {
      throw new ValidationError(`players[${i}] tiene más impactos o eliminaciones que lanzamientos.`);
    }
  }
  const [a, b] = players;
  if (a.paperHitsLanded !== b.paperHitsReceived || b.paperHitsLanded !== a.paperHitsReceived ||
      a.knockouts !== b.deaths || b.knockouts !== a.deaths) {
    throw new ValidationError('Los impactos y eliminaciones deben coincidir entre los dos jugadores.');
  }
  for (const p of players) {
    const opponent = players.find(other => other.slot !== p.slot);
    p.result = p.deliveredDocuments === opponent.deliveredDocuments ? 'draw' :
      p.deliveredDocuments > opponent.deliveredDocuments ? 'win' : 'loss';
    p.survivalSeconds = Math.round(p.survivalSeconds * 1000) / 1000;
  }
  return {
    matchId: value.matchId.toLowerCase(),
    roomCode: value.roomCode == null ? null : text(value.roomCode, 'roomCode'),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationSeconds: Math.round(durationSeconds * 1000) / 1000,
    players
  };
}

export function validateSeedRequest(body) {
  if (!isRecord(body)) throw new ValidationError('Se requiere un objeto JSON.');
  if (Array.isArray(body.matches)) {
    if (body.matches.length < 100 || body.matches.length > 1000) {
      throw new ValidationError('matches debe contener entre 100 y 1000 partidas.');
    }
    const matches = body.matches.map(validateMatch);
    if (new Set(matches.map(m => m.matchId)).size !== matches.length) {
      throw new ValidationError('matchId no puede repetirse en el lote.');
    }
    return matches;
  }
  if (!Number.isSafeInteger(body.count) || body.count < 100 || body.count > 1000) {
    throw new ValidationError('count debe ser un entero entre 100 y 1000, o enviar matches.');
  }
  if (!Number.isSafeInteger(body.seed) || body.seed < 0 || body.seed > 2147483647) {
    throw new ValidationError('seed debe ser un entero entre 0 y 2147483647.');
  }
  return { count: body.count, seed: body.seed };
}
