// Minimal SQL client contract so packages can receive a database handle through DI without
// importing @campus/db. Implemented over node-postgres (production) and PGlite (tests/local dev).

export type QueryResult<Row> = { rows: Row[]; rowCount: number };

export interface SqlClient {
  query<Row = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<Row>>;
  /** Runs `fn` in a single transaction; commits on resolve, rolls back on throw. */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  /** Multi-statement SQL without parameters (migrations). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

const IDENT = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`unsafe SQL identifier: ${name}`);
  return name;
}

/**
 * Idempotent insert helper (spec 18.3 item 10). Inserts `row` unless a row with the same values in
 * `conflictColumns` exists (which must be covered by a UNIQUE constraint). Returns the existing or new
 * row and whether this call inserted it. Safe under concurrent callers.
 */
export async function insertIdempotent<Row extends Record<string, unknown>>(
  sql: SqlClient,
  table: string,
  row: Record<string, unknown>,
  conflictColumns: string[],
  returning = "*",
): Promise<{ inserted: boolean; row: Row }> {
  const cols = Object.keys(row).map(ident);
  const conflict = conflictColumns.map(ident);
  const params = Object.values(row);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
  const inserted = await sql.query<Row>(
    `INSERT INTO ${ident(table)} (${cols.join(", ")}) VALUES (${placeholders})
     ON CONFLICT (${conflict.join(", ")}) DO NOTHING RETURNING ${returning}`,
    params,
  );
  if (inserted.rows[0]) return { inserted: true, row: inserted.rows[0] };

  const where = conflict.map((c, i) => `${c} = $${i + 1}`).join(" AND ");
  const existing = await sql.query<Row>(
    `SELECT ${returning} FROM ${ident(table)} WHERE ${where}`,
    conflict.map((c) => row[c]),
  );
  if (!existing.rows[0]) throw new Error(`insertIdempotent: conflict on ${table} but no existing row found`);
  return { inserted: false, row: existing.rows[0] };
}
