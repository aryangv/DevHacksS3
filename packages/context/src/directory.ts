import { type MembershipService, type SqlClient, TERMINAL_TASK_STATUSES } from "@campus/contracts";
import { isUuid } from "./supermemory/namespaces";

// Read-only view of P1/P2 state the broker must check (spec 5.7: verified requester, current
// membership, task). Membership goes through P2's MembershipService; tasks, conversation status and
// verification are read from their tables (core.agent_tasks / core.conversations / core.external_identities).
// The ContextModule factory gets no TaskStore/IdentityService — if one is added, swap these reads for it.

export type TaskInfo = {
  id: string;
  ownerType: "user" | "group";
  ownerId: string;
  conversationId: string | null;
  type: string;
  status: string;
  active: boolean;
};

const TERMINAL = new Set<string>(TERMINAL_TASK_STATUSES);

export class Directory {
  constructor(
    private readonly sql: SqlClient,
    private readonly membership: MembershipService,
  ) {}

  async task(taskId: string): Promise<TaskInfo | null> {
    if (!isUuid(taskId)) return null;
    const { rows } = await this.sql.query<{
      id: string;
      owner_type: "user" | "group";
      owner_id: string;
      conversation_id: string | null;
      type: string;
      status: string;
    }>(`SELECT id, owner_type, owner_id, conversation_id, type, status FROM core.agent_tasks WHERE id = $1`, [
      taskId,
    ]);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      ownerType: r.owner_type,
      ownerId: r.owner_id,
      conversationId: r.conversation_id,
      type: r.type,
      status: r.status,
      active: !TERMINAL.has(r.status),
    };
  }

  async conversation(conversationId: string): Promise<{ status: string; type: string } | null> {
    if (!isUuid(conversationId)) return null;
    const { rows } = await this.sql.query<{ status: string; type: string }>(
      `SELECT status, type FROM core.conversations WHERE id = $1`,
      [conversationId],
    );
    return rows[0] ?? null;
  }

  /** Verified = an active user with at least one `verified` external identity (spec 4.3). */
  async isVerifiedUser(userId: string): Promise<boolean> {
    if (!isUuid(userId)) return false;
    const { rows } = await this.sql.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM core.users u JOIN core.external_identities e ON e.user_id = u.id
         WHERE u.id = $1 AND u.status = 'active' AND e.status = 'verified'
       ) AS ok`,
      [userId],
    );
    return rows[0]?.ok === true;
  }

  /** User ids of current, verified members (left_at IS NULL is P2's concern). */
  async verifiedMembers(conversationId: string): Promise<Set<string>> {
    const members = await this.membership.listActiveMembers(conversationId);
    return new Set(members.filter((m) => m.status === "verified" && m.userId).map((m) => m.userId!));
  }
}
