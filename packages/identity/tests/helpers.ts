import { PGlite } from "@electric-sql/pglite";
import { type InboundMessage, type SqlClient, fixedClock, loadConfig, silentLogger } from "@campus/contracts";
import { FakeMessagingAdapter, InMemoryAuditLog } from "@campus/contracts/fakes";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createIdentityServices } from "../src/index";

// P2 test scaffolding: the REAL migration files (all owners, runner order) on in-process Postgres.
// Read from disk — not imported — so the package boundary (only @campus/contracts) holds.

const MIGRATIONS = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
export const T0 = new Date("2026-10-24T18:00:00.000Z");
export const HOUR = 3_600_000;
export const BOT = "+15550000000";

function migrationFiles(): string[] {
  const files: Array<{ name: string; path: string }> = [];
  for (const owner of ["p1", "p2", "p3", "p4"]) {
    let names: string[];
    try {
      names = readdirSync(`${MIGRATIONS}${owner}`);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => /^\d{14}_[a-z0-9_]+\.sql$/.test(n)))
      files.push({ name, path: `${MIGRATIONS}${owner}/${name}` });
  }
  return files.sort((a, b) => (a.name < b.name ? -1 : 1)).map((f) => readFileSync(f.path, "utf8"));
}

export async function createDb(): Promise<SqlClient> {
  const db = await PGlite.create();
  for (const m of migrationFiles()) await db.exec(m);
  const sql: SqlClient = {
    query: async <Row>(text: string, params?: unknown[]) => {
      const r = await db.query(text, params);
      return { rows: r.rows as Row[], rowCount: r.affectedRows ?? r.rows.length };
    },
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          ...sql,
          query: async <Row>(t: string, p?: unknown[]) => {
            const r = await tx.query(t, p);
            return { rows: r.rows as Row[], rowCount: r.affectedRows ?? r.rows.length };
          },
        }),
      ),
    exec: async (text) => {
      await db.exec(text);
    },
    close: () => db.close(),
  };
  return sql;
}

export async function setup(env: Record<string, string> = {}) {
  const sql = await createDb();
  const clock = fixedClock(T0);
  const audit = new InMemoryAuditLog(clock);
  const messaging = new FakeMessagingAdapter(BOT);
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    APP_ORIGIN: "https://app.test",
    BLUEBUBBLES_BOT_ADDRESS: BOT,
    ...env,
  });
  const s = createIdentityServices({ config, logger: silentLogger, sql, audit, clock, messaging });
  return { ...s, sql, clock, audit, messaging, config };
}

export type Setup = Awaited<ReturnType<typeof setup>>;

/** A normalized inbound message as the adapter would produce it. */
export function inbound(over: Partial<InboundMessage> = {}) {
  return {
    platform: "imessage" as const,
    providerMessageId: `m-${Math.random().toString(36).slice(2)}`,
    providerConversationId: over.senderExternalId ?? "+15550001001",
    senderExternalId: "+15550001001",
    participantExternalIds: [over.senderExternalId ?? "+15550001001"],
    isGroup: false,
    text: "hello",
    timestamp: T0.toISOString(),
    ...over,
  };
}
