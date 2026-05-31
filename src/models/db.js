import pkg from 'pg';
import { config } from 'dotenv';

config();

const { Pool } = pkg;

const buildConfigFromEnv = () => {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    };
  }

  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'solarpayg',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  };
};

const pool = new Pool(buildConfigFromEnv());
const MAX_RETRIES = parseInt(process.env.DB_CONNECT_RETRIES, 10) || 5;
const RETRY_DELAY_MS = parseInt(process.env.DB_CONNECT_RETRY_MS, 10) || 3000;

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err);
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const testConnection = async () => {
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      const client = await pool.connect();
      client.release();
      console.log('✅ PostgreSQL connected successfully');
      return true;
    } catch (err) {
      attempt += 1;
      console.warn(`PostgreSQL connection attempt ${attempt}/${MAX_RETRIES} failed:`, err.message);
      if (attempt >= MAX_RETRIES) {
        console.error('❌ PostgreSQL connection failed after retries');
        return false;
      }
      await delay(RETRY_DELAY_MS);
    }
  }
  return false;
};

export const query = async (text, params = []) => {
  const client = await pool.connect();
  try {
    const start = Date.now();
    const res = await client.query(text, params);
    const duration = Date.now() - start;
    if (process.env.LOG_LEVEL === 'debug') {
      console.debug('PG query', { text, duration, rows: res.rowCount });
    }
    return res;
  } catch (err) {
    console.error('PostgreSQL query error:', err);
    throw err;
  } finally {
    client.release();
  }
};

export const transaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const closePool = async () => pool.end();

export default pool;
