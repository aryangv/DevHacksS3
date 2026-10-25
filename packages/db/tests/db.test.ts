import { cpSync, mkdtempSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundMessage, SqlClient } from "@campus/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgliteClient } from "../src/client";
import { MIGRATIONS_DIR, listMigrations, migrate } from "../src/migrate";
import { PgAuditLog } from "../src/repos/audit-log";
import { PgInboundQueue } from "../src/repos/inbound-queue";
import { PgMessageLog } from "../src/repos/message-log";
import { PgTaskStore } from "../src/repos/task-store";

let sql: SqlClient;
beforeAll(async () => {
  sql = await createPgliteClient();
  await migrate(sql);
});
afterAll(async () => sql.close());

const SECTION_8_TABLES = [
  "core.users",
  "core.external_identities",
  "core.auth_challenges",
  "core.nudges",
  "core.conversations",
  "core.conversation_members",
  "core.messages",
  "core.memory_settings",
  "core.consent_grants",
  "core.agent_tasks",
  "core.coordination_events",
  "core.pending_approvals",
  "core.audit_events",
  "mcp.servers",
  "mcp.tools",
  "mcp.user_connections",
  "mcp.oauth_states",
  "mcp.tool_permissions",
  "mcp.tool_calls",
  "vault.credentials",
];

describe("migrations", () => {
  it("creates every Section 8 table in the three schemas", async () => {
    const r = await sql.query<{ t: string }>(
      "SELECT table_schema || '.' || table_name AS t FROM information_schema.tables WHERE table_schema IN ('core','mcp','vault')",
    );
    const tables = r.rows.map((x) => x.t);
    for (const t of SECTION_8_TABLES) expect(tables).toContain(t);
  });

  it("is idempotent", async () => {
    expect((await migrate(sql)).applied).toEqual([]);
  });

  it("refuses to run when an applied migration was edited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    try {
      cpSync(MIGRATIONS_DIR, dir, { recursive: true });
      const fresh = await createPgliteClient();
      await migrate(fresh, { dir });
      appendFileSync(join(dir, "p1", listMigrations(dir)[0]!.filename), "\n-- sneaky edit\n");
      await expect(migrate(fresh, { dir })).rejects.toThrow(/modified after being applied/);
      await fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("orders migrations across owner folders by timestamp", () => {
    const files = listMigrations();
    expect(files.map((f) => f.filename)).toEqual([...files.map((f) => f.filename)].sort());
    expect(files[0]!.owner).toBe("p1");
  });

  it("only the gateway role can read vault.* (spec 6.4)", async () => {
    await sql.transaction(async (tx) => {
      await tx.query("SET LOCAL ROLE campus_gateway");
      await tx.query("SELECT count(*) FROM vault.credentials");
    });
    await expect(
      sql.transaction(async (tx) => {
        await tx.query("SET LOCAL ROLE campus_app");
        await tx.query("SELECT count(*) FROM vault.credentials");
      }),
    ).rejects.toThrow(/permission denied/);
    await sql.transaction(async (tx) => {
      await tx.query("SET LOCAL ROLE campus_app");
      await tx.query("SELECT count(*) FROM core.audit_events");
    });
  });
});

const msg = (id: string, conv: string): InboundMessage => ({
  platform: "imessage",
  providerMessageId: id,
  providerConversationId: conv,
  senderExternalId: "+15550001001",
  participantExternalIds: ["+15550001001"],
  isGroup: false,
  text: `hello ${id}`,
  timestamp: new Date().toISOString(),
});

describe("PgInboundQueue", () => {
  it("dedupes on (platform, provider_message_id)", async () => {
    const q = new PgInboundQueue(sql);
    const a = await q.enqueue(msg("dup-1", "convD"));
    const b = await q.enqueue(msg("dup-1", "convD"));
    expect(a.inserted).toBe(true);
    expect(b).toEqual({ eventId: a.eventId, inserted: false });
  });

  it("keeps one event in flight per conversation, FIFO, other conversations proceed", async () => {
    const q = new PgInboundQueue(sql);
    await sql.query("UPDATE core.inbound_events SET status = 'done'");
    await q.enqueue(msg("f-1", "convA"));
    await q.enqueue(msg("f-2", "convA"));
    await q.enqueue(msg("f-3", "convB"));
    const first = await q.claimNext();
    const second = await q.claimNext();
    expect(first?.message.providerMessageId).toBe("f-1");
    expect(second?.message.providerMessageId).toBe("f-3");
    expect(await q.claimNext()).toBeNull();
    await q.complete(first!.id);
    const third = await q.claimNext();
    expect(third?.message.providerMessageId).toBe("f-2");
    expect(third?.attempts).toBe(1);
  });

  it("retries later and dead-letters poison messages", async () => {
    const q = new PgInboundQueue(sql);
    await sql.query("UPDATE core.inbound_events SET status = 'done'");
    await q.enqueue(msg("p-1", "convP"));
    const e = await q.claimNext();
    await q.fail(e!.id, "boom", { deadLetter: false, retryAt: new Date(Date.now() + 60_000) });
    expect(await q.claimNext()).toBeNull(); // not yet available
    await sql.query("UPDATE core.inbound_events SET available_at = now() WHERE id = $1", [e!.id]);
    const again = await q.claimNext();
    expect(again?.attempts).toBe(2);
    await q.fail(again!.id, "boom", { deadLetter: true });
    expect((await q.counts()).dead).toBeGreaterThanOrEqual(1);
    expect(await q.claimNext()).toBeNull();
  });
});

describe("P1 repositories", () => {
  it("PgTaskStore: create, findActive, optimistic concurrency, coordination events", async () => {
    const conv = await sql.query<{ id: string }>(
      "INSERT INTO core.conversations (platform, provider_id, type) VALUES ('imessage', 'g-tasks', 'group') RETURNING id",
    );
    const convId = conv.rows[0]!.id;
    const s = new PgTaskStore(sql);
    const t = await s.create({
      ownerType: "group",
      ownerId: convId,
      conversationId: convId,
      type: "group_meal",
      status: "collecting",
      state: { round: 0 },
    });
    expect((await s.findActive(convId, "group_meal"))?.id).toBe(t.id);
    const u = await s.update(t.id, { status: "proposed", state: { round: 1 } }, 0);
    expect(u).toMatchObject({ version: 1, status: "proposed", state: { round: 1 } });
    await expect(s.update(t.id, { status: "x" }, 0)).rejects.toMatchObject({ code: "task_conflict" });
    await s.update(t.id, { status: "cancelled" }, 1);
    expect(await s.findActive(convId, "group_meal")).toBeNull();
    await s.appendEvent({
      taskId: t.id,
      fromAgent: "group:g",
      toAgent: "personal:u",
      type: "request.evaluate_option",
      payload: { options: [] },
    });
    expect((await s.listEvents(t.id))[0]).toMatchObject({ type: "request.evaluate_option" });
  });

  it("PgAuditLog: redacts on write and returns a turn's timeline in order", async () => {
    const audit = new PgAuditLog(sql);
    const turnId = "11111111-1111-4111-8111-111111111111";
    await audit.record({ action: "turn.received", turnId, detail: { apiKey: "should-not-store" } });
    await audit.record({ action: "turn.completed", turnId, detail: { status: "replied" } });
    const events = await audit.query({ turnId });
    expect(events.map((e) => e.action)).toEqual(["turn.received", "turn.completed"]);
    expect(JSON.stringify(events)).not.toContain("should-not-store");
  });

  it("PgMessageLog: idempotent inbound, outbound rows, recent history", async () => {
    const conv = await sql.query<{ id: string }>(
      "INSERT INTO core.conversations (platform, provider_id, type) VALUES ('imessage', 'dm-log', 'dm') RETURNING id",
    );
    const convId = conv.rows[0]!.id;
    const user = await sql.query<{ id: string }>(
      "INSERT INTO core.users (display_name) VALUES ('Avery') RETURNING id",
    );
    const ident = await sql.query<{ id: string }>(
      "INSERT INTO core.external_identities (user_id, platform, external_id, status) VALUES ($1, 'imessage', '+15550009999', 'verified') RETURNING id",
      [user.rows[0]!.id],
    );
    const log = new PgMessageLog(sql);
    const input = {
      conversationId: convId,
      platform: "imessage" as const,
      providerMessageId: "ml-1",
      senderExternalIdentityId: ident.rows[0]!.id,
      body: "hi",
      receivedAt: new Date().toISOString(),
    };
    const a = await log.recordInbound(input);
    const b = await log.recordInbound(input);
    expect(a.inserted).toBe(true);
    expect(b).toEqual({ id: a.id, inserted: false });
    await log.recordOutbound({
      conversationId: convId,
      platform: "imessage",
      providerMessageId: "out-1",
      body: "hello Avery",
    });
    const recent = await log.recent(convId, 10);
    expect(recent.map((l) => [l.direction, l.senderDisplayName, l.body])).toEqual([
      ["inbound", "Avery", "hi"],
      ["outbound", null, "hello Avery"],
    ]);
  });
});
