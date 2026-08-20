import { Pool as NeonPool, neonConfig } from '@neondatabase/serverless';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless';
import { Pool as PostgresPool } from 'pg';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import ws from "ws";
import * as schema from "@shared/schema";

neonConfig.webSocketConstructor = ws;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const databaseHost = new URL(connectionString).hostname;
const usesDirectPostgres = ["localhost", "127.0.0.1", "::1"].includes(databaseHost);

// The Neon driver communicates over WebSockets, which is correct for the
// hosted Neon database but cannot reach PostgreSQL's TCP-only CI service.
// Use node-postgres for local/CI URLs while leaving the hosted path unchanged.
const postgresPool = usesDirectPostgres
  ? new PostgresPool({ connectionString })
  : undefined;
const neonPool = usesDirectPostgres
  ? undefined
  : new NeonPool({ connectionString });

// Both drivers expose this query surface. Keeping the public type deliberately
// small prevents driver-specific overloads from leaking into application code.
type DatabasePool = {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  end(): Promise<void>;
};

export const pool = (postgresPool ?? neonPool!) as DatabasePool;
export const db = postgresPool
  ? drizzlePostgres({ client: postgresPool, schema })
  : drizzleNeon({ client: neonPool!, schema });
