import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';
import { generateSeedMatches } from '../src/seed.js';

const adminToken = 'admin-token-for-tests-1234567890';
const matchIngestToken = 'match-token-for-tests-1234567890';

async function fixture(corsOrigin = '') {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const store = createStore(pool);
  await store.init();
  const server = createApp({ store, adminToken, matchIngestToken, corsOrigin }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, async close() { await new Promise(resolve => server.close(resolve)); await pool.end(); } };
}

async function request(url, path, method = 'GET', body, token) {
  const response = await fetch(url + path, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test('seed de 100 y 1000 partidas, telemetría y reemplazo sin duplicados', async () => {
  const api = await fixture();
  try {
    const first = await request(api.url, '/api/test/seed', 'POST', { count: 100, seed: 7 }, adminToken);
    assert.equal(first.status, 200);
    assert.equal(first.body.insertedMatches, 100);
    const metrics100 = await request(api.url, '/api/test/telemetry?source=seed&playerId=empleado-01');
    assert.equal(metrics100.status, 200);
    assert.equal(metrics100.body.totalMatches, 100);
    assert.equal(metrics100.body.playerResults, 100);
    assert.ok(metrics100.body.kdr >= 0);
    const second = await request(api.url, '/api/test/seed', 'POST', { count: 1000, seed: 7 }, adminToken);
    assert.equal(second.status, 200);
    const metrics1000 = await request(api.url, '/api/test/telemetry?source=seed');
    assert.equal(metrics1000.body.totalMatches, 1000);
    assert.equal(metrics1000.body.playerResults, 2000);
    assert.equal(metrics1000.body.wins + metrics1000.body.losses + metrics1000.body.draws, 2000);
    const again = await request(api.url, '/api/test/seed', 'POST', { count: 1000, seed: 7 }, adminToken);
    assert.equal(again.status, 200);
    assert.equal((await request(api.url, '/api/test/telemetry?source=seed')).body.totalMatches, 1000);
  } finally { await api.close(); }
});

test('partida real: ganador por documentos, KDR, golpes y reintento idempotente', async () => {
  const api = await fixture();
  try {
    const match = {
      matchId: '7db5215d-2422-4d38-892a-c10c0bdd0041', roomCode: 'sala-uno',
      startedAt: '2026-01-01T12:00:00.000Z', endedAt: '2026-01-01T12:02:00.000Z',
      players: [
        { slot: 0, playerId: 'ana', deliveredDocuments: 8, paperBallsThrown: 10,
          paperHitsLanded: 5, paperHitsReceived: 2, knockouts: 2, deaths: 1, survivalSeconds: 117 },
        { slot: 1, playerId: 'bob', deliveredDocuments: 4, paperBallsThrown: 6,
          paperHitsLanded: 2, paperHitsReceived: 5, knockouts: 1, deaths: 2, survivalSeconds: 114 }
      ]
    };
    const saved = await request(api.url, '/api/matches', 'POST', match, matchIngestToken);
    assert.equal(saved.status, 201);
    assert.equal(saved.body.winnerSlot, 0);
    const retry = await request(api.url, '/api/matches', 'POST', match, matchIngestToken);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.duplicate, true);
    const ana = (await request(api.url, '/api/test/telemetry?source=live&playerId=ana')).body;
    assert.equal(ana.totalMatches, 1);
    assert.equal(ana.winRatePercent, 100);
    assert.equal(ana.kdr, 2);
    assert.equal(ana.paperHitsReceived, 2);
    assert.equal(ana.averageSurvivalSeconds, 117);
    const overall = (await request(api.url, '/api/test/telemetry?source=live')).body;
    assert.equal(overall.winRatePercent, 50);
    assert.equal(overall.knockouts, 3);
    assert.equal(overall.deaths, 3);
    assert.equal((await request(api.url, '/api/test/seed', 'POST', { count: 100, seed: 11 }, adminToken)).status, 200);
    assert.equal((await request(api.url, '/api/test/telemetry?source=live')).body.totalMatches, 1);
    assert.equal((await request(api.url, '/api/test/telemetry?source=all')).body.totalMatches, 101);
  } finally { await api.close(); }
});

test('rechaza escrituras sin token, datos imposibles y filtros inválidos', async () => {
  const api = await fixture();
  try {
    assert.equal((await request(api.url, '/api/test/seed', 'POST', { count: 100, seed: 1 })).status, 401);
    assert.equal((await request(api.url, '/api/matches', 'POST', {})).status, 401);
    assert.equal((await request(api.url, '/api/test/seed', 'POST', { count: 99, seed: 1 }, adminToken)).status, 400);
    assert.equal((await request(api.url, '/api/test/telemetry?source=wrong')).status, 400);
    const match = generateSeedMatches(100, 2)[0];
    match.players[0].paperHitsReceived++;
    assert.equal((await request(api.url, '/api/matches', 'POST', match, matchIngestToken)).status, 400);
    assert.equal((await request(api.url, '/api/test/telemetry')).body.totalMatches, 0);
  } finally { await api.close(); }
});

test('generador reproducible con la misma semilla', () => {
  const a = generateSeedMatches(100, 9);
  const b = generateSeedMatches(100, 9);
  assert.equal(a.length, 100);
  assert.equal(a[0].matchId, b[0].matchId);
  assert.equal(a[0].players[0].deliveredDocuments, b[0].players[0].deliveredDocuments);
});

test('preflight WebGL permite sólo los orígenes configurados', async () => {
  const origin = 'https://html-classic.itch.zone';
  const api = await fixture(`${origin},https://otro.example`);
  try {
    const preflight = await fetch(api.url + '/api/matches', {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type' }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);

    const other = await fetch(api.url + '/api/matches', {
      method: 'OPTIONS', headers: { Origin: 'https://desconocido.example' }
    });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  } finally { await api.close(); }
});
