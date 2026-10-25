import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type {
  Approval,
  ApprovalRequest,
  ApprovalStore,
  AuditLog,
  DecisionContext,
  WebSession,
} from "./ports.ts";

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return Array.isArray(value)
    ? `[${value.map(stable).join(",")}]`
    : `{${Object.keys(value)
        .sort()
        .map(
          (k) =>
            `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`,
        )
        .join(",")}}`;
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function redact(value: unknown): unknown {
  if (typeof value === "string")
    return value
      .replace(/Bearer\s+[^\s"<>]+/gi, "Bearer [REDACTED]")
      .replace(
        /\b(?:gh[pousr]_[\w]+|github_pat_[\w]+|sk-[\w-]+)\b/g,
        "[REDACTED]",
      );
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /secret|token|password|authorization|credential|api.?key|verifier/i.test(
          k,
        )
          ? "[REDACTED]"
          : redact(v),
      ]),
    );
  return value;
}
export class ApprovalService {
  private store: ApprovalStore;
  private audit: AuditLog;
  private key: Buffer;
  private now: () => number;
  private ttlMs: number;
  constructor(
    store: ApprovalStore,
    audit: AuditLog,
    key: Buffer,
    options: { now?: () => number; ttlMs?: number } = {},
  ) {
    check(key.length >= 32, "approval_key_missing");
    this.store = store;
    this.audit = audit;
    this.key = Buffer.from(key);
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 300000;
    check(this.ttlMs > 0 && this.ttlMs <= 600000, "invalid_approval_ttl");
  }
  private digest(value: unknown): string {
    return createHmac("sha256", this.key).update(stable(value)).digest("hex");
  }
  async create(
    request: ApprovalRequest,
  ): Promise<{ id: string; code?: string; token?: string; expiresAt: string }> {
    check(request.userId && request.conversationId, "approval_context_missing");
    check(
      request.channel === "web" ||
        (request.kind !== "spend_handoff" && !request.sensitive),
      "web_approval_required",
    );
    const id = randomUUID(),
      secret =
        request.channel === "text"
          ? String(randomInt(100000, 1000000))
          : randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    const approval: Approval = {
      id,
      userId: request.userId,
      conversationId: request.conversationId,
      kind: request.kind,
      proposal: redact(request.proposal),
      proposalHash: this.digest(request.proposal),
      codeHash: this.digest({ id, secret }),
      channel: request.channel,
      status: "pending",
      expiresAt,
      attempts: 0,
    };
    await this.audit.record({
      actorUserId: request.userId,
      action: "approval.create",
      resource: id,
      policyResult: "ask",
      detail: { kind: request.kind, channel: request.channel },
    });
    await this.store.insert(approval);
    return {
      id,
      ...(request.channel === "text" ? { code: secret } : { token: secret }),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
  private async decide(
    id: string,
    userId: string,
    conversationId: string | undefined,
    channel: "text" | "web",
    secret: string,
    approve: boolean,
  ): Promise<boolean> {
    const allowed = await this.store.mutate(id, async (a) => {
      if (
        !a ||
        a.userId !== userId ||
        (conversationId && a.conversationId !== conversationId) ||
        a.channel !== channel ||
        a.status !== "pending"
      )
        return false;
      if (a.expiresAt <= this.now()) {
        a.status = "expired";
        return false;
      }
      if (a.attempts >= 5) return false;
      a.attempts++;
      const actual = Buffer.from(this.digest({ id, secret })),
        expected = Buffer.from(a.codeHash);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        return false;
      await this.audit.record({
        actorUserId: userId,
        action: "approval.decide",
        resource: id,
        policyResult: approve ? "allow" : "deny",
        detail: { channel },
      });
      a.status = approve ? "approved" : "declined";
      return true;
    });
    if (!allowed)
      await this.audit.record({
        actorUserId: userId,
        action: "approval.rejected",
        resource: id,
        policyResult: "deny",
      });
    return allowed;
  }
  async decideText(id: string, ctx: DecisionContext): Promise<boolean> {
    const valid =
      ctx.verified &&
      !ctx.isGroup &&
      ctx.instruction?.source === "user_dm" &&
      ctx.instruction.senderUserId === ctx.userId &&
      ctx.instruction.messageId;
    if (!valid) {
      await this.audit.record({
        actorUserId: ctx.userId,
        action: "approval.rejected",
        resource: id,
        policyResult: "deny",
      });
      return false;
    }
    const match = /^(YES|NO) ([0-9]{6})$/.exec(ctx.instruction!.text.trim());
    if (!match) {
      await this.audit.record({
        actorUserId: ctx.userId,
        action: "approval.rejected",
        resource: id,
        policyResult: "deny",
      });
      return false;
    }
    return this.decide(
      id,
      ctx.userId,
      ctx.conversationId,
      "text",
      match[2],
      match[1] === "YES",
    );
  }
  async decideWeb(
    id: string,
    session: WebSession,
    token: string,
    approve: boolean,
    proposal: unknown,
  ): Promise<boolean> {
    if (!session.authenticated || !session.sessionId) {
      await this.audit.record({
        action: "approval.rejected",
        resource: id,
        policyResult: "deny",
      });
      return false;
    }
    const matches = await this.store.mutate(id, (a) =>
      Boolean(
        a &&
          a.userId === session.userId &&
          a.proposalHash === this.digest(proposal),
      ),
    );
    if (!matches) {
      await this.audit.record({
        actorUserId: session.userId,
        action: "approval.rejected",
        resource: id,
        policyResult: "deny",
      });
      return false;
    }
    return this.decide(id, session.userId, undefined, "web", token, approve);
  }
  async consume(
    id: string,
    userId: string,
    conversationId: string,
    proposal: unknown,
  ): Promise<boolean> {
    const consumed = await this.store.mutate(id, async (a) => {
      if (
        !a ||
        a.userId !== userId ||
        a.conversationId !== conversationId ||
        a.status !== "approved" ||
        a.consumedAt !== undefined ||
        a.expiresAt <= this.now() ||
        a.proposalHash !== this.digest(proposal)
      )
        return false;
      await this.audit.record({
        actorUserId: userId,
        action: "approval.consume",
        resource: id,
        policyResult: "allow",
      });
      a.consumedAt = this.now();
      return true;
    });
    if (!consumed)
      await this.audit.record({
        actorUserId: userId,
        action: "approval.consume_rejected",
        resource: id,
        policyResult: "deny",
      });
    return consumed;
  }
  async pending(session: WebSession): Promise<
    Array<
      Pick<Approval, "id" | "kind" | "proposal" | "status"> & {
        expiresAt: string;
      }
    >
  > {
    check(
      session.authenticated && session.sessionId,
      "authentication_required",
    );
    return (await this.store.list(session.userId))
      .filter((a) => a.expiresAt > this.now() && a.status === "pending")
      .map((a) => ({
        id: a.id,
        kind: a.kind,
        proposal: a.proposal,
        status: a.status,
        expiresAt: new Date(a.expiresAt).toISOString(),
      }));
  }
}
