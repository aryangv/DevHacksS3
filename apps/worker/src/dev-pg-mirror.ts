import type {
  Conversation,
  ConversationType,
  IdentityService,
  MembershipChange,
  MembershipService,
  Platform,
  ResolvedIdentity,
  SqlClient,
} from "@campus/contracts";
import type { FakeIdentityService, FakeMembershipService } from "@campus/contracts/fakes";

// DEV-ONLY glue (P1): when identity is still the in-memory fake but the runtime store is Postgres,
// mirror fake users/identities/conversations into the P2 tables so foreign keys on core.messages and
// core.agent_tasks hold. Removed from the wiring automatically when USE_REAL_IDENTITY=true.

async function mirrorIdentity(sql: SqlClient, r: ResolvedIdentity): Promise<void> {
  if (r.userId) {
    await sql.query(
      "INSERT INTO core.users (id, display_name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name",
      [r.userId, r.displayName],
    );
  }
  await sql.query(
    `INSERT INTO core.external_identities (id, user_id, platform, external_id, status, verified_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'verified' THEN now() END)
     ON CONFLICT (platform, external_id) DO UPDATE SET user_id = EXCLUDED.user_id, status = EXCLUDED.status`,
    [r.externalIdentityId, r.userId, r.platform, r.externalId, r.status],
  );
}

export class MirroringIdentityService implements IdentityService {
  constructor(
    private readonly inner: FakeIdentityService,
    private readonly sql: SqlClient,
  ) {}

  async resolveSender(platform: Platform, externalId: string): Promise<ResolvedIdentity> {
    const r = await this.inner.resolveSender(platform, externalId);
    await mirrorIdentity(this.sql, r);
    return r;
  }
  getUser(userId: string) {
    return this.inner.getUser(userId);
  }
  getPrimaryExternalId(userId: string, platform: Platform) {
    return this.inner.getPrimaryExternalId(userId, platform);
  }
}

export class MirroringMembershipService implements MembershipService {
  constructor(
    private readonly inner: FakeMembershipService,
    private readonly identity: FakeIdentityService,
    private readonly sql: SqlClient,
  ) {}

  async ensureConversation(
    platform: Platform,
    providerConversationId: string,
    type: ConversationType,
  ): Promise<Conversation> {
    const c = await this.inner.ensureConversation(platform, providerConversationId, type);
    await this.sql.query(
      `INSERT INTO core.conversations (id, platform, provider_id, type, status) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (platform, provider_id) DO NOTHING`,
      [c.id, c.platform, c.providerId, c.type, c.status],
    );
    return c;
  }

  async syncParticipants(
    conversationId: string,
    participantExternalIds: string[],
  ): Promise<MembershipChange> {
    const change = await this.inner.syncParticipants(conversationId, participantExternalIds);
    for (const id of change.joined) {
      const rec = this.identity.byExternalIdentityId(id);
      if (rec) await mirrorIdentity(this.sql, rec);
    }
    return change;
  }

  isActiveMember(conversationId: string, externalIdentityId: string) {
    return this.inner.isActiveMember(conversationId, externalIdentityId);
  }
  listActiveMembers(conversationId: string) {
    return this.inner.listActiveMembers(conversationId);
  }

  async activate(conversationId: string, byUserId: string): Promise<Conversation> {
    const c = await this.inner.activate(conversationId, byUserId);
    await this.sql.query(
      "UPDATE core.conversations SET status = $2, activated_by_user_id = $3 WHERE id = $1",
      [conversationId, c.status, c.activatedByUserId],
    );
    return c;
  }
}
