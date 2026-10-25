import { PGlite } from "@electric-sql/pglite";
import {
  type ConversationMember,
  type MembershipService,
  type SqlClient,
  fixedClock,
  groupAgentId,
  loadConfig,
  silentLogger,
} from "@campus/contracts";
import { InMemoryAuditLog } from "@campus/contracts/fakes";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContextServices, Supermemory } from "../src/index";
import { FakeSupermemory, type FakeSupermemoryOptions } from "../src/testing/index";

// Test scaffolding for P3's own tests. Applies the REAL migration files (p1 then p3, in the runner's
// global timestamp order) to an in-process Postgres. Read from disk — not imported — so the
// package boundary (only @campus/contracts) holds.

const MIGRATIONS = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
export const T0 = new Date("2026-10-24T18:00:00.000Z");
export const HOUR = 60 * 60 * 1000;

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

export async function createDb(): Promise<{ db: PGlite; sql: SqlClient }> {
  const db = await PGlite.create();
  for (const migration of migrationFiles()) await db.exec(migration);
  const sql: SqlClient = {
    query: async <Row>(text: string, params?: unknown[]) => {
      const r = await db.query(text, params);
      return { rows: r.rows as Row[], rowCount: r.affectedRows ?? r.rows.length };
    },
    transaction: (fn) => fn(sql),
    exec: async (text) => {
      await db.exec(text);
    },
    close: () => db.close(),
  };
  return { db, sql };
}

/** P2 stand-in: current members per conversation, with identity status. */
export class TestMembership implements MembershipService {
  readonly members = new Map<string, Map<string, ConversationMember>>();

  add(conversationId: string, userId: string, status: ConversationMember["status"] = "verified") {
    const m = this.members.get(conversationId) ?? new Map<string, ConversationMember>();
    m.set(userId, {
      externalIdentityId: `ext-${userId}`,
      userId,
      status,
      displayName: null,
      joinedAt: T0.toISOString(),
    });
    this.members.set(conversationId, m);
  }

  leave(conversationId: string, userId: string) {
    this.members.get(conversationId)?.delete(userId);
  }

  async listActiveMembers(conversationId: string) {
    return [...(this.members.get(conversationId)?.values() ?? [])];
  }

  async isActiveMember(conversationId: string, externalIdentityId: string) {
    return [...(this.members.get(conversationId)?.values() ?? [])].some(
      (m) => m.externalIdentityId === externalIdentityId,
    );
  }

  ensureConversation(): never {
    throw new Error("not used by P3");
  }
  syncParticipants(): never {
    throw new Error("not used by P3");
  }
  activate(): never {
    throw new Error("not used by P3");
  }
}

async function id(sql: SqlClient, text: string, params: unknown[]): Promise<string> {
  return (await sql.query<{ id: string }>(text, params)).rows[0]!.id;
}

/**
 * Dinner scenario (spec 4.6.1): an active group of Alice, Bob, Carol; Dan is in the group but
 * unverified; Olly is verified but outside it. One open group_meal task.
 */
export async function scenario(options: { fake?: FakeSupermemoryOptions; scopedKeys?: boolean } = {}) {
  const { db, sql } = await createDb();
  const clock = fixedClock(T0);
  const fake = new FakeSupermemory(options.fake);
  const membership = new TestMembership();
  const audit = new InMemoryAuditLog(clock);

  const user = async (name: string, verified: boolean) => {
    const userId = await id(sql, `INSERT INTO core.users (display_name) VALUES ($1) RETURNING id`, [name]);
    await sql.query(
      `INSERT INTO core.external_identities (user_id, platform, external_id, status) VALUES ($1, 'imessage', $2, $3)`,
      [userId, `+1555${Math.floor(Math.random() * 1e7)}`, verified ? "verified" : "unverified"],
    );
    return userId;
  };
  const alice = await user("Alice", true);
  const bob = await user("Bob", true);
  const carol = await user("Carol", true);
  const dan = await user("Dan", false);
  const olly = await user("Olly", true);

  const conversation = (provider: string) =>
    id(
      sql,
      `INSERT INTO core.conversations (platform, provider_id, type, status) VALUES ('imessage', $1, 'group', 'active') RETURNING id`,
      [provider],
    );
  const group = await conversation("grp_dinner");
  const otherGroup = await conversation("grp_other");
  for (const u of [alice, bob, carol]) membership.add(group, u);
  membership.add(group, dan, "unverified");
  for (const u of [alice, olly]) membership.add(otherGroup, u);

  const createTask = (conversationId: string, status = "collecting") =>
    id(
      sql,
      `INSERT INTO core.agent_tasks (owner_type, owner_id, conversation_id, type, status) VALUES ('group', $1, $1, 'group_meal', $2) RETURNING id`,
      [conversationId, status],
    );
  const task = await createTask(group);

  const supermemory = new Supermemory({
    apiKey: fake.orgKey,
    fetch: fake.fetch,
    maxRetries: 0,
    scopedKeys: options.scopedKeys ?? true,
    clock,
  });
  const p3 = await createContextServices({
    config: loadConfig({ NODE_ENV: "test", LOG_LEVEL: "error" }),
    logger: silentLogger,
    sql,
    audit,
    clock,
    membership,
    supermemory,
  });

  return {
    db,
    sql,
    fake,
    membership,
    audit,
    clock,
    ...p3,
    alice,
    bob,
    carol,
    dan,
    olly,
    group,
    otherGroup,
    task,
    createTask,
    groupAgent: groupAgentId(group),
    /** A verified user's DM to their own agent, as the pipeline does it: policy, then store. */
    async dm(userId: string, text: string, kind: "preference" | "fact" | "conversation" = "preference") {
      const decision = await p3.memoryPolicy.evaluate({
        principal: { kind: "user", userId },
        authorUserId: userId,
        write: {
          content: text,
          kind,
          customId: `conv_dm-${userId.slice(0, 8)}`,
          metadata: { source: "imessage", conversation_id: `dm-${userId.slice(0, 8)}` },
        },
      });
      if (decision.ingest) await p3.memoryStore.add({ kind: "user", userId }, decision.write);
      return decision;
    },
  };
}

export type Scenario = Awaited<ReturnType<typeof scenario>>;

/** Everything observable, with UUIDs masked (so random ids can't trip value checks). */
export function visibleText(...parts: unknown[]): string {
  return JSON.stringify(parts).replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    "<id>",
  );
}
