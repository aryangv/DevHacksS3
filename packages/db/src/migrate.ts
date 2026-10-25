import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Logger, type SqlClient, sha256Hex, silentLogger } from "@campus/contracts";

// Migration runner (spec 18.3 item 4, 18.6 rule 3).
// - One folder per owner: migrations/p1, p2, p3, p4. Never edit another owner's migration.
// - Files are `YYYYMMDDHHMMSS_description.sql`; all folders are applied in global timestamp order.
// - Applied files are checksummed; editing an applied migration is an error (additive only after M0).

export const OWNERS = ["p1", "p2", "p3", "p4"] as const;
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const FILE_RE = /^\d{14}_[a-z0-9_]+\.sql$/;

export type MigrationFile = { owner: string; filename: string; path: string; checksum: string; sql: string };

export function listMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const owner of OWNERS) {
    const folder = join(dir, owner);
    if (!existsSync(folder)) continue;
    for (const filename of readdirSync(folder)) {
      if (!filename.endsWith(".sql")) continue;
      if (!FILE_RE.test(filename))
        throw new Error(`migration ${owner}/${filename} must be named YYYYMMDDHHMMSS_description.sql`);
      const sql = readFileSync(join(folder, filename), "utf8");
      files.push({
        owner,
        filename,
        path: join(folder, filename),
        checksum: sha256Hex(sql.replace(/\r\n/g, "\n")),
        sql,
      });
    }
  }
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.filename))
      throw new Error(`duplicate migration filename ${f.filename} across owner folders`);
    seen.add(f.filename);
  }
  return files.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
}

export async function migrate(
  sql: SqlClient,
  opts: { dir?: string; logger?: Logger } = {},
): Promise<{ applied: string[]; alreadyApplied: string[] }> {
  const log = opts.logger ?? silentLogger;
  await sql.exec(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
    filename text PRIMARY KEY,
    owner text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const files = listMigrations(opts.dir);
  const applied = new Map(
    (
      await sql.query<{ filename: string; checksum: string }>(
        "SELECT filename, checksum FROM public.schema_migrations",
      )
    ).rows.map((r) => [r.filename, r.checksum]),
  );
  for (const [filename, checksum] of applied) {
    const f = files.find((x) => x.filename === filename);
    if (f && f.checksum !== checksum) {
      throw new Error(
        `migration ${f.owner}/${filename} was modified after being applied. Add a new migration instead.`,
      );
    }
  }

  const done: string[] = [];
  for (const f of files) {
    if (applied.has(f.filename)) continue;
    await sql.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(4242001)");
      const again = await tx.query("SELECT 1 FROM public.schema_migrations WHERE filename = $1", [
        f.filename,
      ]);
      if (again.rows.length) return;
      await tx.exec(f.sql);
      await tx.query("INSERT INTO public.schema_migrations (filename, owner, checksum) VALUES ($1, $2, $3)", [
        f.filename,
        f.owner,
        f.checksum,
      ]);
    });
    log.info("migration applied", { migration: `${f.owner}/${f.filename}` });
    done.push(`${f.owner}/${f.filename}`);
  }
  return { applied: done, alreadyApplied: [...applied.keys()] };
}
