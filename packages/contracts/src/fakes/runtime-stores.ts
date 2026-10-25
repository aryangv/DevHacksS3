import { HarnessError } from "../errors";
import type {
  AuditLog,
  ConversationLine,
  InboundEvent,
  InboundQueue,
  MessageLog,
  TaskStore,
} from "../interfaces/p1";
import type { AuditEvent, AuditQuery } from "../schemas/audit";
import type { InboundMessage } from "../schemas/messaging";
import {
  type AgentTask,
  type CoordinationEvent,
  type NewTask,
  TERMINAL_TASK_STATUSES,
} from "../schemas/tasks";
import { type Clock, newId, systemClock } from "../util/ids";
import { redact } from "../util/redact";

// In-memory implementations of P1's stores. Used by the simulator, unit tests and RUNTIME_STORE=memory.
// Postgres implementations with the same semantics live in @campus/db.

export class InMemoryAuditLog implements AuditLog {
  readonly events: AuditEvent[] = [];
  constructor(private readonly clock: Clock = systemClock) {}

  async record(event: AuditEvent): Promise<void> {
    this.events.push({ ...redact(event), id: newId(), createdAt: this.clock.now().toISOString() });
  }

  async query(q: AuditQuery): Promise<AuditEvent[]> {
    return this.events
      .filter(
        (e) =>
          (!q.turnId || e.turnId === q.turnId) &&
          (!q.conversationId || e.conversationId === q.conversationId) &&
          (!q.actorUserId || e.actorUserId === q.actorUserId) &&
          (!q.action || e.action === q.action),
      )
      .slice(-(q.limit ?? 500));
  }
}

export class InMemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, AgentTask>();
  private readonly events: CoordinationEvent[] = [];
  constructor(private readonly clock: Clock = systemClock) {}

  async create<S extends Record<string, unknown>>(task: NewTask<S>): Promise<AgentTask<S>> {
    const now = this.clock.now().toISOString();
    const t: AgentTask<S> = {
      ...task,
      id: newId(),
      version: 0,
      createdAt: now,
      updatedAt: now,
      state: structuredClone(task.state),
    };
    this.tasks.set(t.id, t as AgentTask);
    return structuredClone(t);
  }

  async get<S extends Record<string, unknown>>(taskId: string): Promise<AgentTask<S> | null> {
    const t = this.tasks.get(taskId);
    return t ? (structuredClone(t) as AgentTask<S>) : null;
  }

  async listByStatus<S extends Record<string, unknown>>(
    type: string,
    statuses: string[],
  ): Promise<Array<AgentTask<S>>> {
    return [...this.tasks.values()]
      .filter((t) => t.type === type && statuses.includes(t.status))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((t) => structuredClone(t) as AgentTask<S>);
  }

  async findActive<S extends Record<string, unknown>>(
    conversationId: string,
    type: string,
  ): Promise<AgentTask<S> | null> {
    const terminal = new Set<string>(TERMINAL_TASK_STATUSES);
    const found = [...this.tasks.values()]
      .filter((t) => t.conversationId === conversationId && t.type === type && !terminal.has(t.status))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    return found ? (structuredClone(found) as AgentTask<S>) : null;
  }

  async update<S extends Record<string, unknown>>(
    taskId: string,
    patch: { status?: string; state?: S },
    expectedVersion: number,
  ): Promise<AgentTask<S>> {
    const t = this.tasks.get(taskId);
    if (!t) throw new HarnessError("task_not_found", `task ${taskId} not found`);
    if (t.version !== expectedVersion)
      throw new HarnessError("task_conflict", `task ${taskId} version ${t.version} != ${expectedVersion}`, {
        retryable: true,
      });
    if (patch.status !== undefined) t.status = patch.status;
    if (patch.state !== undefined) t.state = structuredClone(patch.state);
    t.version += 1;
    t.updatedAt = this.clock.now().toISOString();
    return structuredClone(t) as AgentTask<S>;
  }

  async appendEvent(event: Omit<CoordinationEvent, "id" | "createdAt">): Promise<CoordinationEvent> {
    const e: CoordinationEvent = {
      ...structuredClone(event),
      id: newId(),
      createdAt: this.clock.now().toISOString(),
    };
    this.events.push(e);
    return structuredClone(e);
  }

  async listEvents(taskId: string): Promise<CoordinationEvent[]> {
    return this.events.filter((e) => e.taskId === taskId).map((e) => structuredClone(e));
  }
}

type QueueRow = {
  event: InboundEvent;
  status: "pending" | "processing" | "done" | "dead";
  availableAt: number;
  seq: number;
  lastError?: string;
};

export const conversationKeyOf = (m: Pick<InboundMessage, "platform" | "providerConversationId">) =>
  `${m.platform}:${m.providerConversationId}`;

/** Dedupe + per-conversation FIFO with nothing else in flight for that conversation. */
export class InMemoryInboundQueue implements InboundQueue {
  private readonly rows = new Map<string, QueueRow>();
  private readonly dedupe = new Map<string, string>();
  private seq = 0;
  constructor(private readonly clock: Clock = systemClock) {}

  async enqueue(message: InboundMessage): Promise<{ eventId: string; inserted: boolean }> {
    const key = `${message.platform}:${message.providerMessageId}`;
    const existing = this.dedupe.get(key);
    if (existing) return { eventId: existing, inserted: false };
    const id = newId();
    this.dedupe.set(key, id);
    this.rows.set(id, {
      event: {
        id,
        conversationKey: conversationKeyOf(message),
        message: structuredClone(message),
        attempts: 0,
        receivedAt: this.clock.now().toISOString(),
      },
      status: "pending",
      availableAt: 0,
      seq: ++this.seq,
    });
    return { eventId: id, inserted: true };
  }

  async claimNext(): Promise<InboundEvent | null> {
    const now = this.clock.now().getTime();
    const rows = [...this.rows.values()].sort((a, b) => a.seq - b.seq);
    const busy = new Set(rows.filter((r) => r.status === "processing").map((r) => r.event.conversationKey));
    const blocked = new Set<string>();
    for (const r of rows) {
      if (r.status !== "pending") continue;
      const k = r.event.conversationKey;
      if (busy.has(k) || blocked.has(k)) continue;
      if (r.availableAt > now) {
        blocked.add(k); // keep FIFO: later events of this conversation wait for the retry
        continue;
      }
      r.status = "processing";
      r.event.attempts += 1;
      return structuredClone(r.event);
    }
    return null;
  }

  async complete(eventId: string): Promise<void> {
    const r = this.rows.get(eventId);
    if (r) r.status = "done";
  }

  async fail(eventId: string, error: string, opts: { retryAt?: Date; deadLetter: boolean }): Promise<void> {
    const r = this.rows.get(eventId);
    if (!r) return;
    r.lastError = error;
    if (opts.deadLetter) r.status = "dead";
    else {
      r.status = "pending";
      r.availableAt = opts.retryAt?.getTime() ?? 0;
    }
  }

  async counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = { pending: 0, processing: 0, done: 0, dead: 0 };
    for (const r of this.rows.values()) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  }
}

export class InMemoryMessageLog implements MessageLog {
  private readonly rows: Array<{
    id: string;
    conversationId: string;
    platform: string;
    providerMessageId: string;
    senderExternalIdentityId: string | null;
    senderUserId: string | null;
    senderDisplayName: string | null;
    direction: "inbound" | "outbound";
    body: string | null;
    at: string;
    processedAt: string | null;
  }> = [];

  /** Optional lookup so `recent()` can label senders like the SQL join does. */
  constructor(
    private readonly senderLookup?: (
      externalIdentityId: string,
    ) => { userId: string | null; displayName: string | null } | undefined,
  ) {}

  async recordInbound(
    input: Parameters<MessageLog["recordInbound"]>[0],
  ): Promise<{ id: string; inserted: boolean }> {
    const dup = this.rows.find(
      (r) => r.platform === input.platform && r.providerMessageId === input.providerMessageId,
    );
    if (dup) return { id: dup.id, inserted: false };
    const sender = input.senderExternalIdentityId
      ? this.senderLookup?.(input.senderExternalIdentityId)
      : undefined;
    const id = newId();
    this.rows.push({
      id,
      conversationId: input.conversationId,
      platform: input.platform,
      providerMessageId: input.providerMessageId,
      senderExternalIdentityId: input.senderExternalIdentityId,
      senderUserId: sender?.userId ?? null,
      senderDisplayName: sender?.displayName ?? null,
      direction: "inbound",
      body: input.body,
      at: input.receivedAt,
      processedAt: null,
    });
    return { id, inserted: true };
  }

  async recordOutbound(input: Parameters<MessageLog["recordOutbound"]>[0]): Promise<void> {
    this.rows.push({
      id: newId(),
      conversationId: input.conversationId,
      platform: input.platform,
      providerMessageId: input.providerMessageId,
      senderExternalIdentityId: null,
      senderUserId: null,
      senderDisplayName: null,
      direction: "outbound",
      body: input.body,
      at: new Date().toISOString(),
      processedAt: new Date().toISOString(),
    });
  }

  async markProcessed(id: string): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.processedAt = new Date().toISOString();
  }

  async recent(conversationId: string, limit: number): Promise<ConversationLine[]> {
    return this.rows
      .filter((r) => r.conversationId === conversationId && r.body !== null)
      .slice(-limit)
      .map((r) => ({
        direction: r.direction,
        senderUserId: r.senderUserId,
        senderDisplayName: r.senderDisplayName,
        body: r.body!,
        at: r.at,
      }));
  }

  all() {
    return this.rows;
  }
}
