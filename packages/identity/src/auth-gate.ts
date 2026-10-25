import type {
  AuthDecision,
  AuthGate,
  Conversation,
  IdentityService,
  ResolvedIdentity,
} from "@campus/contracts";

// Default deny (spec 2.2, 4.3). Allowed only when the external identity is verified AND linked to an
// active user. Everyone else is blocked before any model call or memory write; unverified senders
// who addressed the agent get a (rate-limited) nudge. Revoked/suspended users are not nudged.
export class DefaultAuthGate implements AuthGate {
  constructor(private readonly deps: { identity: IdentityService }) {}

  async check(input: {
    identity: ResolvedIdentity;
    conversation: Conversation;
    addressed: boolean;
  }): Promise<AuthDecision> {
    const { identity } = input;
    if (identity.status === "revoked") return { kind: "block", reason: "revoked", nudge: false };
    if (identity.status !== "verified" || !identity.userId)
      return { kind: "block", reason: "unverified", nudge: input.addressed };
    const user = await this.deps.identity.getUser(identity.userId);
    if (!user || user.status !== "active") return { kind: "block", reason: "revoked", nudge: false };
    return { kind: "allow" };
  }
}
