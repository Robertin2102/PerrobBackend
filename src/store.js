import { performance } from 'node:perf_hooks';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS matches (
    id UUID PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('live', 'seed')),
    room_code TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ NOT NULL,
    duration_seconds DOUBLE PRECISION NOT NULL CHECK (duration_seconds > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS match_players (
    match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    slot SMALLINT NOT NULL CHECK (slot IN (0, 1)),
    player_id TEXT NOT NULL,
    result TEXT NOT NULL CHECK (result IN ('win', 'loss', 'draw')),
    delivered_documents INTEGER NOT NULL CHECK (delivered_documents >= 0),
    paper_balls_thrown INTEGER NOT NULL CHECK (paper_balls_thrown >= 0),
    paper_hits_landed INTEGER NOT NULL CHECK (paper_hits_landed >= 0),
    paper_hits_received INTEGER NOT NULL CHECK (paper_hits_received >= 0),
    knockouts INTEGER NOT NULL CHECK (knockouts >= 0),
    deaths INTEGER NOT NULL CHECK (deaths >= 0),
    survival_seconds DOUBLE PRECISION NOT NULL CHECK (survival_seconds >= 0),
    PRIMARY KEY (match_id, slot)
  )`,
  'CREATE INDEX IF NOT EXISTS matches_source_idx ON matches(source)',
  'CREATE INDEX IF NOT EXISTS match_players_player_id_idx ON match_players(player_id)'
];

function playerValues(match) {
  return match.players.map(p => [
    match.matchId, p.slot, p.playerId, p.result, p.deliveredDocuments,
    p.paperBallsThrown, p.paperHitsLanded, p.paperHitsReceived,
    p.knockouts, p.deaths, p.survivalSeconds
  ]);
}

async function insertBatch(client, table, columns, rows, suffix = '') {
  if (rows.length === 0) return;
  const width = columns.length;
  const values = rows.flat();
  const placeholders = rows.map((_, i) =>
    `(${Array.from({ length: width }, (_, j) => `$${i * width + j + 1}`).join(', ')})`
  ).join(', ');
  await client.query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders} ${suffix}`,
    values
  );
}

const MATCH_COLUMNS = ['id', 'source', 'room_code', 'started_at', 'ended_at', 'duration_seconds'];
const PLAYER_COLUMNS = ['match_id', 'slot', 'player_id', 'result', 'delivered_documents',
  'paper_balls_thrown', 'paper_hits_landed', 'paper_hits_received', 'knockouts',
  'deaths', 'survival_seconds'];

export function createStore(pool) {
  return {
    async init() {
      for (const sql of SCHEMA) await pool.query(sql);
    },
    async health() {
      await pool.query('SELECT 1');
    },
    async recordMatch(match) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const existing = await client.query('SELECT source FROM matches WHERE id = $1', [match.matchId]);
        if (existing.rowCount > 0) {
          await client.query('ROLLBACK');
          return { duplicate: true };
        }
        await client.query(
          `INSERT INTO matches (id, source, room_code, started_at, ended_at, duration_seconds)
           VALUES ($1, 'live', $2, $3, $4, $5)`,
          [match.matchId, match.roomCode, match.startedAt, match.endedAt, match.durationSeconds]
        );
        await insertBatch(client, 'match_players', PLAYER_COLUMNS, playerValues(match));
        await client.query('COMMIT');
        return { duplicate: false };
      } catch (error) {
        await client.query('ROLLBACK');
        // Dos reintentos simultáneos pueden pasar el SELECT; la PK decide el ganador.
        if (error.code === '23505') return { duplicate: true };
        throw error;
      } finally {
        client.release();
      }
    },
    async replaceSeed(matches) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // El borrado en cascada afecta únicamente a las partidas de prueba.
        await client.query("DELETE FROM matches WHERE source = 'seed'");
        for (let i = 0; i < matches.length; i += 100) {
          const chunk = matches.slice(i, i + 100);
          await insertBatch(client, 'matches', MATCH_COLUMNS, chunk.map(m => [
            m.matchId, 'seed', m.roomCode, m.startedAt, m.endedAt, m.durationSeconds
          ]));
          await insertBatch(client, 'match_players', PLAYER_COLUMNS, chunk.flatMap(playerValues));
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async telemetry(source = 'all', playerId = null) {
      const started = performance.now();
      const conditions = [];
      const params = [];
      if (source !== 'all') {
        params.push(source);
        conditions.push(`m.source = $${params.length}`);
      }
      if (playerId !== null) {
        params.push(playerId);
        conditions.push(`p.player_id = $${params.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const { rows } = await pool.query(`
        SELECT
          COUNT(DISTINCT m.id) AS total_matches,
          COUNT(p.match_id) AS player_results,
          COALESCE(SUM(CASE WHEN p.result = 'win' THEN 1 ELSE 0 END), 0) AS wins,
          COALESCE(SUM(CASE WHEN p.result = 'loss' THEN 1 ELSE 0 END), 0) AS losses,
          COALESCE(SUM(CASE WHEN p.result = 'draw' THEN 1 ELSE 0 END), 0) AS draws,
          COALESCE(SUM(p.knockouts), 0) AS knockouts,
          COALESCE(SUM(p.deaths), 0) AS deaths,
          COALESCE(SUM(p.paper_hits_landed), 0) AS paper_hits_landed,
          COALESCE(SUM(p.paper_hits_received), 0) AS paper_hits_received,
          COALESCE(AVG(p.survival_seconds), 0) AS avg_survival_seconds,
          COALESCE(SUM(p.delivered_documents), 0) AS delivered_documents
        FROM matches m JOIN match_players p ON p.match_id = m.id ${where}
      `, params);
      const row = rows[0];
      const n = key => Number(row[key]);
      const round2 = number => Math.round(number * 100) / 100;
      const results = n('player_results');
      const deaths = n('deaths');
      return {
        source, playerId,
        totalMatches: n('total_matches'),
        playerResults: results,
        wins: n('wins'), losses: n('losses'), draws: n('draws'),
        winRatePercent: results ? round2(n('wins') / results * 100) : 0,
        knockouts: n('knockouts'), deaths,
        kdr: round2(n('knockouts') / Math.max(1, deaths)),
        averageSurvivalSeconds: round2(n('avg_survival_seconds')),
        paperHitsLanded: n('paper_hits_landed'),
        paperHitsReceived: n('paper_hits_received'),
        deliveredDocuments: n('delivered_documents'),
        queryMs: round2(performance.now() - started)
      };
    }
  };
}
