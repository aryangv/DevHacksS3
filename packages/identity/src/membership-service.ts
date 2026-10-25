import {
  type AuditLog,
  type Conversation,
  type ConversationMember,
  type ConversationType,
  HarnessError,
  type MembershipChange,
  type MembershipService,
  type Platform,
  type SqlClient,
} from "@campus/contracts";
import type { PgIdentityService } from "./identity-service";
import { UUID_RE, iso } from "./util";

// MembershipService over core.conversations + core.conversation_members (spec 4.2 step 4, 4.3).
//
// Leaves: a member is marked left (left_at) when they are missing from the provider's participant
// list. Some webhook payloads may omit participants; the pipeline then passes only the sender, which
// would wrongly "remove" everyone else. So leaves are applied only when the list names at least two
// people. (A 2-human group therefore can't detect a leave from the list alone — documented limit.)

type ConversationRow = {
  id: string;
  platform: Platform;
  provider_id: string;
  type: ConversationType;
  status: "inactive" | "active" | "archived";
  activated_by_user_id: string | null;
};

const toConversation = (r: ConversationRow): Conversation => ({
  id: r.id,
  platform: r.platform,
  providerId: r.provider_id,
  type: r.type,
  status: r.status,
  activatedByUserId: r.activated_by_user_id,
});

const MIN_LIST_FOR_LEAVES = 2;

export class PgMembershipService implements MembershipService {
  constructor(private readonly deps: { sql: SqlClient; audit: AuditLog; identity: PgIdentityService }) {}

  async ensureConversation(
    platform: Platform,
    providerConversationId: string,
    type: ConversationType,
  ): Promise<Conversation> {
    // A DM is between one person and their own agent: active from the start. A group becomes
    // active only when a verified member invokes the agent (activate()).
    const { rows } = await this.deps.sql.query<ConversationRow>(
      `INSERT INTO core.conversations (platform, provider_id, type, status)
       VALUES ($1, $2, $3, CASE WHEN $3 = 'dm' THEN 'active' ELSE 'inactive' END)
       ON CONFLICT (platform, provider_id) DO UPDATE SET platform = EXCLUDED.platform
       RETURNING id, platform, provider_id, type, status, activated_by_user_id`,
      [platform, providerConversationId, type],
    );
    const c = rows[0]!;
    if (c.type !== type) {
      // A provider id never changes kind; refuse rather than mixing DM and group state.
      throw new HarnessError("conversation_invalid", `conversation ${c.id} is a ${c.type}, not a ${type}`);
    }
    return toConversation(c);
  }

  async getConversation(conversationId: string): Promise<Conversation | null> {
    if (!UUID_RE.test(conversationId)) return null;
    const { rows } = await this.deps.sql.query<ConversationRow>(
      `SELECT id, platform, provider_id, type, status, activated_by_user_id FROM core.conversations WHERE id = $1`,
      [conversationId],
    );
    return rows[0] ? toConversation(rows[0]) : null;
  }

  async syncParticipants(
    conversationId: string,
    participantExternalIds: string[],
  ): Promise<MembershipChange> {
    const conv = await this.getConversation(conversationId);
    if (!conv) throw new HarnessError("conversation_invalid", `unknown conversation ${conversationId}`);
    const ids: string[] = [];
    for (const ext of new Set(participantExternalIds.filter(Boolean))) {
      ids.push((await this.deps.identity.ensureIdentity(conv.platform, ext)).externalIdentityId);
    }
    const change: MembershipChange = { joined: [], left: [] };

    await this.deps.sql.transaction(async (tx) => {
      for (const id of ids) {
        // New member, or a former member re-joining (clears left_at, resets joined_at).
        const { rows } = await tx.query<{ external_identity_id: string }>(
          `INSERT INTO core.conversation_members (conversation_id, external_identity_id)
           VALUES ($1, $2)
           ON CONFLICT (conversation_id, external_identity_id) DO UPDATE
             SET left_at = NULL, joined_at = now()
             WHERE core.conversation_members.left_at IS NOT NULL
           RETURNING external_identity_id`,
          [conversationId, id],
        );
        if (rows[0]) change.joined.push(id);
      }
      if (conv.type === "group" && ids.length >= MIN_LIST_FOR_LEAVES) {
        const { rows } = await tx.query<{ external_identity_id: string }>(
          `UPDATE core.conversation_members SET left_at = now()
           WHERE conversation_id = $1 AND left_at IS NULL AND NOT (external_identity_id = ANY($2::uuid[]))
           RETURNING external_identity_id`,
          [conversationId, ids],
        );
        change.left.push(...rows.map((r) => r.external_identity_id));
      }
    });

    for (const id of change.joined)
      await this.deps.audit.record({
        action: "membership.joined",
        conversationId,
        resource: `external_identity:${id}`,
        detail: { type: conv.type },
      });
    for (const id of change.left)
      await this.deps.audit.record({
        action: "membership.left",
        conversationId,
        resource: `external_identity:${id}`,
        detail: { type: conv.type },
      });
    return change;
  }

  async isActiveMember(conversationId: string, externalIdentityId: string): Promise<boolean> {
    if (!UUID_RE.test(conversationId) || !UUID_RE.test(externalIdentityId)) return false;
    const { rows } = await this.deps.sql.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM core.conversation_members
         WHERE conversation_id = $1 AND external_identity_id = $2 AND left_at IS NULL) AS ok`,
      [conversationId, externalIdentityId],
    );
    return rows[0]?.ok === true;
  }

  async listActiveMembers(conversationId: string): Promise<ConversationMember[]> {
    if (!UUID_RE.test(conversationId)) return [];
    const { rows } = await this.deps.sql.query<{
      external_identity_id: string;
      user_id: string | null;
      status: "unverified" | "verified" | "revoked";
      user_status: string | null;
      display_name: string | null;
      joined_at: Date | string;
    }>(
      `SELECT m.external_identity_id, ei.user_id, ei.status, u.status AS user_status, u.display_name, m.joined_at
       FROM core.conversation_members m
       JOIN core.external_identities ei ON ei.id = m.external_identity_id
       LEFT JOIN core.users u ON u.id = ei.user_id
       WHERE m.conversation_id = $1 AND m.left_at IS NULL
       ORDER BY m.joined_at, m.external_identity_id`,
      [conversationId],
    );
    return rows.map((r) => {
      const verified = r.status === "verified" && r.user_id !== null && r.user_status === "active";
      return {
        externalIdentityId: r.external_identity_id,
        userId: verified ? r.user_id : null,
        status: verified ? "verified" : r.status === "revoked" ? "revoked" : "unverified",
        displayName: verified ? r.display_name : null,
        joinedAt: iso(r.joined_at),
      };
    });
  }

  async activate(conversationId: string, byUserId: string): Promise<Conversation> {
    const { rows } = await this.deps.sql.query<ConversationRow & { changed: boolean }>(
      `UPDATE core.conversations SET status = 'active', activated_by_user_id = $2
       WHERE id = $1 AND status = 'inactive'
       RETURNING id, platform, provider_id, type, status, activated_by_user_id`,
      [conversationId, byUserId],
    );
    if (rows[0]) {
      await this.deps.audit.record({
        action: "conversation.activated",
        conversationId,
        actorUserId: byUserId,
        detail: { type: rows[0].type },
      });
      return toConversation(rows[0]);
    }
    const c = await this.getConversation(conversationId);
    if (!c) throw new HarnessError("conversation_invalid", `unknown conversation ${conversationId}`);
    return c;
  }

  /** Groups (active memberships) a user is currently in, for the settings pages. */
  async groupsForUser(userId: string): Promise<Array<{ conversationId: string; status: string }>> {
    if (!UUID_RE.test(userId)) return [];
    const { rows } = await this.deps.sql.query<{ id: string; status: string }>(
      `SELECT DISTINCT c.id, c.status FROM core.conversations c
       JOIN core.conversation_members m ON m.conversation_id = c.id AND m.left_at IS NULL
       JOIN core.external_identities ei ON ei.id = m.external_identity_id
       WHERE ei.user_id = $1 AND ei.status = 'verified' AND c.type = 'group'`,
      [userId],
    );
    return rows.map((r) => ({ conversationId: r.id, status: r.status }));
  }
}
