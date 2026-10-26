import { Pool } from 'pg';
import { createApp } from './app.js';
import { createStore } from './store.js';

const { DATABASE_URL, ADMIN_TOKEN, MATCH_INGEST_TOKEN, CORS_ORIGIN = '', PORT = '3000' } = process.env;
if (!DATABASE_URL || !ADMIN_TOKEN || ADMIN_TOKEN.length < 24 ||
    !MATCH_INGEST_TOKEN || MATCH_INGEST_TOKEN.length < 24) {
  throw new Error('Configura DATABASE_URL, ADMIN_TOKEN y MATCH_INGEST_TOKEN (tokens de 24+ caracteres).');
}
const port = Number(PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválido.');

const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
const store = createStore(pool);
try {
  await store.init();
  const corsOrigins = [CORS_ORIGIN, 'https://html-classic.itch.zone'].filter(Boolean).join(',');
  const app = createApp({ store, adminToken: ADMIN_TOKEN,
    matchIngestToken: MATCH_INGEST_TOKEN, corsOrigin: corsOrigins });
  const server = app.listen(port, '0.0.0.0', () => console.log(`API escuchando en puerto ${port}`));
  const shutdown = () => server.close(() => pool.end());
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (error) {
  await pool.end();
  throw error;
}
