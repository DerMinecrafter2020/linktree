// =========================================================
// PostgreSQL-Verbindung (pg Pool)
// =========================================================

require('dotenv').config();

const { Pool } = require('pg');

function buildConfig() {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL };
  }

  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'openweb',
    user: process.env.DB_USER || 'openweb',
    password: process.env.DB_PASSWORD || 'openweb',
  };
}

const pool = new Pool(buildConfig());

pool.on('error', (err) => {
  console.error('[db] Unerwarteter Pool-Fehler:', err);
});

async function query(text, params) {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query,
  transaction,
};
