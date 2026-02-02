// src/lib/server/postgresClient.ts
import { Pool, type PoolClient, type QueryResult } from 'pg';
import { env } from '$env/dynamic/private';
import fs from 'node:fs';

type SqlParams = readonly unknown[];

/**
 * ---- SSL helpers ----
 * Supports:
 * - PGSSLMODE=require|verify-ca|verify-full (common with RDS / managed PG)
 * - PGSSL=true
 * - Optional CA/CERT/KEY as either PEM strings or file paths
 */
function readPemMaybe(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith('-----BEGIN')) return trimmed; // inline PEM
  // treat as file path
  if (fs.existsSync(trimmed)) return fs.readFileSync(trimmed, 'utf8');
  return undefined;
}

function buildSslConfig():
  | false
  | {
      rejectUnauthorized: boolean;
      ca?: string;
      cert?: string;
      key?: string;
    } {
  const mode = (env.PGSSLMODE || '').toLowerCase(); // disable|prefer|require|verify-ca|verify-full
  const sslEnabled =
    (env.PGSSL || '').toLowerCase() === 'true' ||
    mode === 'require' ||
    mode === 'verify-ca' ||
    mode === 'verify-full';

  if (!sslEnabled) return false;

  // Default to safer behavior when verification is expected.
  // Many environments still use rejectUnauthorized=false unless you provide a CA.
  const rejectUnauthorized =
    (env.PGSSL_REJECT_UNAUTHORIZED || '').toLowerCase() === 'true' ||
    mode === 'verify-ca' ||
    mode === 'verify-full';

  const ca = readPemMaybe(env.PGSSL_CA);
  const cert = readPemMaybe(env.PGSSL_CERT);
  const key = readPemMaybe(env.PGSSL_KEY);

  return { rejectUnauthorized, ca, cert, key };
}

function buildPool() {
  const ssl = buildSslConfig();

  // Prefer DATABASE_URL, but support discrete vars too.
  const hasDatabaseUrl = !!env.DATABASE_URL;

  const pool = new Pool({
    connectionString: hasDatabaseUrl ? env.DATABASE_URL : undefined,
    host: hasDatabaseUrl ? undefined : env.PGHOST,
    port: hasDatabaseUrl ? undefined : (env.PGPORT ? Number(env.PGPORT) : undefined),
    database: hasDatabaseUrl ? undefined : env.PGDATABASE,
    user: hasDatabaseUrl ? undefined : env.PGUSER,
    password: hasDatabaseUrl ? undefined : env.PGPASSWORD,

    ssl: ssl || undefined,

    // Pool tuning
    max: env.PGPOOL_MAX ? Number(env.PGPOOL_MAX) : 10,
    idleTimeoutMillis: env.PGPOOL_IDLE_TIMEOUT_MS ? Number(env.PGPOOL_IDLE_TIMEOUT_MS) : 30_000,
    connectionTimeoutMillis: env.PGPOOL_CONN_TIMEOUT_MS ? Number(env.PGPOOL_CONN_TIMEOUT_MS) : 5_000,

    // Timeouts
    statement_timeout: env.PG_STATEMENT_TIMEOUT_MS ? Number(env.PG_STATEMENT_TIMEOUT_MS) : 15_000,
    query_timeout: env.PG_QUERY_TIMEOUT_MS ? Number(env.PG_QUERY_TIMEOUT_MS) : 20_000
  });

  pool.on('error', (err) => {
    // This usually indicates an idle client error; log for visibility.
    console.error('[postgres] pool error', err);
  });

  return pool;
}

let _pool: Pool | null = null;
export function getPool(): Pool {
  if (!_pool) _pool = buildPool();
  return _pool;
}

/**
 * Generic query helper (use for internal app queries).
 * For explore endpoints, prefer exploreQuery() below.
 */
export async function query<T = any>(text: string, params: SqlParams = []): Promise<QueryResult<T>> {
  const pool = getPool();
  try {
    return await pool.query<T>(text, params as any[]);
  } catch (err) {
    console.error('[postgres] query failed', { text: text.slice(0, 120), err });
    throw err;
  }
}

/**
 * ---- Explore allowlist (guardrails) ----
 * Explore endpoints should only call exploreQuery(name, params).
 * Add new templates here as needed.
 */
const EXPLORE_QUERIES = {
  tables: `
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
      AND table_schema NOT LIKE 'pg_toast%'
      AND ($1::text IS NULL OR table_schema = $1::text)
    ORDER BY table_schema, table_name
  `
} as const;

export type ExploreQueryName = keyof typeof EXPLORE_QUERIES;

export async function exploreQuery<T = any>(
  name: ExploreQueryName,
  params: SqlParams = []
): Promise<QueryResult<T>> {
  const sql = EXPLORE_QUERIES[name];
  if (!sql) throw new Error(`Explore query not allowlisted: ${name}`);
  return query<T>(sql, params);
}

/** Optional: use when you need a dedicated client for multi-step operations later */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
