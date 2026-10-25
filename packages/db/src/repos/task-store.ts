import {
  type AgentTask,
  type CoordinationEvent,
  HarnessError,
  type NewTask,
  type SqlClient,
  TERMINAL_TASK_STATUSES,
  type TaskStore,
} from "@campus/contracts";
import { iso } from "../client";

type TaskRow = {
  id: string;
  owner_type: "user" | "group";
  owner_id: string;
  conversation_id: string | null;
  type: string;
  status: string;
  state_json: Record<string, unknown>;
  version: number;
  created_at: Date;
  updated_at: Date;
};

const toTask = <S>(r: TaskRow): AgentTask<S> => ({
  id: r.id,
  ownerType: r.owner_type,
  ownerId: r.owner_id,
  conversationId: r.conversation_id,
  type: r.type,
  status: r.status,
  state: r.state_json as S,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

/** core.agent_tasks + core.coordination_events with optimistic concurrency (version column). */
export class PgTaskStore implements TaskStore {
  constructor(private readonly sql: SqlClient) {}

  async create<S extends Record<string, unknown>>(task: NewTask<S>): Promise<AgentTask<S>> {
    const r = await this.sql.query<TaskRow>(
      `INSERT INTO core.agent_tasks (owner_type, owner_id, conversation_id, type, status, state_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *`,
      [task.ownerType, task.ownerId, task.conversationId, task.type, task.status, JSON.stringify(task.state)],
    );
    return toTask<S>(r.rows[0]!);
  }

  async get<S extends Record<string, unknown>>(taskId: string): Promise<AgentTask<S> | null> {
    const r = await this.sql.query<TaskRow>("SELECT * FROM core.agent_tasks WHERE id = $1", [taskId]);
    return r.rows[0] ? toTask<S>(r.rows[0]) : null;
  }

  async findActive<S extends Record<string, unknown>>(
    conversationId: string,
    type: string,
  ): Promise<AgentTask<S> | null> {
    const r = await this.sql.query<TaskRow>(
      `SELECT * FROM core.agent_tasks
       WHERE conversation_id = $1 AND type = $2 AND NOT (status = ANY($3::text[]))
       ORDER BY created_at DESC LIMIT 1`,
      [conversationId, type, [...TERMINAL_TASK_STATUSES]],
    );
    return r.rows[0] ? toTask<S>(r.rows[0]) : null;
  }

  async update<S extends Record<string, unknown>>(
    taskId: string,
    patch: { status?: string; state?: S },
    expectedVersion: number,
  ): Promise<AgentTask<S>> {
    const r = await this.sql.query<TaskRow>(
      `UPDATE core.agent_tasks
       SET status = COALESCE($2, status),
           state_json = COALESCE($3::jsonb, state_json),
           version = version + 1,
           updated_at = now()
       WHERE id = $1 AND version = $4
       RETURNING *`,
      [
        taskId,
        patch.status ?? null,
        patch.state === undefined ? null : JSON.stringify(patch.state),
        expectedVersion,
      ],
    );
    if (r.rows[0]) return toTask<S>(r.rows[0]);
    const exists = await this.sql.query("SELECT 1 FROM core.agent_tasks WHERE id = $1", [taskId]);
    if (!exists.rows.length) throw new HarnessError("task_not_found", `task ${taskId} not found`);
    throw new HarnessError("task_conflict", `task ${taskId} was modified concurrently`, { retryable: true });
  }

  async appendEvent(event: Omit<CoordinationEvent, "id" | "createdAt">): Promise<CoordinationEvent> {
    const r = await this.sql.query<{ id: string; created_at: Date }>(
      `INSERT INTO core.coordination_events (task_id, from_agent, to_agent, type, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id, created_at`,
      [event.taskId, event.fromAgent, event.toAgent, event.type, JSON.stringify(event.payload)],
    );
    return { ...event, id: r.rows[0]!.id, createdAt: iso(r.rows[0]!.created_at) };
  }

  async listEvents(taskId: string): Promise<CoordinationEvent[]> {
    const r = await this.sql.query<{
      id: string;
      task_id: string;
      from_agent: string;
      to_agent: string;
      type: string;
      payload: Record<string, unknown>;
      created_at: Date;
    }>("SELECT * FROM core.coordination_events WHERE task_id = $1 ORDER BY created_at, id", [taskId]);
    return r.rows.map((x) => ({
      id: x.id,
      taskId: x.task_id,
      fromAgent: x.from_agent,
      toAgent: x.to_agent,
      type: x.type,
      payload: x.payload,
      createdAt: iso(x.created_at),
    }));
  }
}
