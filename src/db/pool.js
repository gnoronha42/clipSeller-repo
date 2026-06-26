import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'clipseller',
  user: process.env.DB_USER || 'clipseller',
  password: process.env.DB_PASSWORD || '',
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[pg.pool]', err.message);
});

export async function query(text, params) {
  return pool.query(text, params);
}
