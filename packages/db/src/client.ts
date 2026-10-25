import { PGlite } from "@electric-sql/pglite";
import type { QueryResult, SqlClient } from "@campus/contracts";
import pg from "pg";

// SqlClient implementations: node-postgres (production) and PGlite (tests / local dev without Docker).
//   postgres://user:pass@host/db  → node-postgres pool
//   pglite://memory               → in-memory Postgres (WASM)
//   pglite://./.data/pglite       → file-backed Postgres (WASM)

type Queryable = {
  query: (
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount?: number | null; affectedRows?: number }>;
};

function wrapResult<Row>(res: {
  rows: unknown[];
  rowCount?: number | null;
  affectedRows?: number;
}): QueryResult<Row> {
  return { rows: res.rows as Row[], rowCount: res.rowCount ?? res.affectedRows ?? res.rows.length };
}

export function createPgClient(connectionString: string, opts: { max?: number } = {}): SqlClient {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10 });
  const fromQueryable = (q: Queryable, inTx: boolean): SqlClient => ({
    query: async <Row>(text: string, params?: unknown[]) => wrapResult<Row>(await q.query(text, params)),
    transaction: async (fn) => {
      if (inTx) return fn(fromQueryable(q, true));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(fromQueryable(client as unknown as Queryable, true));
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    exec: async (sql) => {
      await q.query(sql);
    },
    close: async () => {
      if (!inTx) await pool.end();
    },
  });
  return fromQueryable(pool as unknown as Queryable, false);
}

export async function createPgliteClient(dataDir?: string): Promise<SqlClient & { db: PGlite }> {
  const db = dataDir ? await PGlite.create(dataDir) : await PGlite.create();
  type Tx = { query: PGlite["query"]; exec: PGlite["exec"] };
  const fromTx = (tx: Tx, nested: boolean): SqlClient => ({
    query: async <Row>(text: string, params?: unknown[]) =>
      wrapResult<Row>(await tx.query(text, params as unknown[])),
    transaction: async (fn) =>
      nested ? fn(fromTx(tx, true)) : db.transaction((inner) => fn(fromTx(inner as unknown as Tx, true))),
    exec: async (sql) => {
      await tx.exec(sql);
    },
    close: async () => {
      if (!nested) await db.close();
    },
  });
  return Object.assign(fromTx(db as unknown as Tx, false), { db });
}

export async function createSqlClient(url: string): Promise<SqlClient> {
  if (url.startsWith("pglite://")) {
    const target = url.slice("pglite://".length);
    return createPgliteClient(target === "memory" || target === "" ? undefined : target);
  }
  return createPgClient(url);
}

/** Postgres returns Date for timestamptz in both drivers; normalize to ISO strings. */
export const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
