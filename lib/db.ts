import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Guard route params before they reach a uuid column — Postgres throws a 500
    on a non-uuid value (e.g. "undefined"), so callers should 404 instead. */
export function isUuid(s: string | undefined | null): s is string {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/* Single shared instance per process. The globalThis cache matters in dev:
   Next.js HMR re-evaluates modules, and two PGlite handles on the same data
   directory corrupt it. */
const g = globalThis as unknown as { __scoutnetDb?: Promise<Db> };

async function init(): Promise<Db> {
  const migrationsFolder = path.join(process.cwd(), "drizzle");

  if (process.env.DATABASE_URL) {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const { sql } = await import("drizzle-orm");
    const postgres = (await import("postgres")).default;

    /* Serialize migrations across cold-starting serverless instances with a
       session advisory lock. It MUST run on a single dedicated connection
       (max:1) — on a pool, the lock and unlock could land on different
       connections, holding nothing and leaking a lock. */
    const migrationClient = postgres(process.env.DATABASE_URL, { max: 1 });
    const mdb = drizzle(migrationClient, { schema });
    try {
      await mdb.execute(sql`SELECT pg_advisory_lock(7264118)`);
      try {
        await migrate(mdb, { migrationsFolder });
      } finally {
        await mdb.execute(sql`SELECT pg_advisory_unlock(7264118)`);
      }
    } finally {
      await migrationClient.end();
    }

    const client = postgres(process.env.DATABASE_URL, { max: 5 });
    return drizzle(client, { schema }) as unknown as Db;
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const dataDir = path.join(process.cwd(), ".data", "pglite");
  await mkdir(dataDir, { recursive: true });
  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return db as unknown as Db;
}

export function getDb(): Promise<Db> {
  if (!g.__scoutnetDb) {
    g.__scoutnetDb = init().catch((err) => {
      /* Don't cache a failed init — the next request should retry, not inherit
         a permanently rejected promise. */
      console.error(
        `[db] init failed (driver: ${process.env.DATABASE_URL ? "postgres" : "pglite"}):`,
        err
      );
      g.__scoutnetDb = undefined;
      throw err;
    });
  }
  return g.__scoutnetDb;
}
