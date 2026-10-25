// pnpm db:migrate — applies migrations/p1..p4 in timestamp order using DATABASE_URL_ADMIN (or DATABASE_URL).
import { createLogger, loadConfig } from "@campus/contracts";
import { createSqlClient } from "../client";
import { migrate } from "../migrate";

const config = loadConfig();
const url = config.DATABASE_URL_ADMIN ?? config.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL (or DATABASE_URL_ADMIN) — e.g. postgres://… or pglite://./.data/pglite");
  process.exit(1);
}
const logger = createLogger({ level: config.LOG_LEVEL });
const sql = await createSqlClient(url);
try {
  const res = await migrate(sql, { logger });
  console.log(
    res.applied.length
      ? `Applied ${res.applied.length} migration(s):\n  ${res.applied.join("\n  ")}`
      : "Database is up to date.",
  );
} finally {
  await sql.close();
}
