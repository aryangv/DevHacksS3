import type { ApprovalService } from "../interfaces/p4";
import type {
  ApprovalKind,
  ApprovalStatus,
  PermissionChangeOutcome,
  PermissionChangeRequest,
  SpendHandoff,
  SpendHandoffRequest,
  TextReplyResolution,
} from "../schemas/approvals";
import type { ToolManifest, ToolProposal } from "../schemas/tools";
import type { TurnContext } from "../schemas/turn";
import { type Clock, hashOf, newId, systemClock } from "../util/ids";

type Pending = {
  id: string;
  kind: ApprovalKind;
  userId: string;
  conversationId: string;
  proposalHash: string;
  code: string;
  status: ApprovalStatus;
  expiresAt: number;
  summary: string;
};

/**
 * Fake approvals: text codes bound to user + exact proposal, 1:1 only, expiring, one-time; spend goes to
 * a (fake) web page. Real implementation: @campus/approvals (P4).
 */
export class FakeApprovalService implements ApprovalService {
  readonly approvals: Pending[] = [];
  readonly appliedPermissionChanges: Array<{ userId: string; change: PermissionChangeRequest }> = [];
  private codeSeq = 4821;

  constructor(private readonly opts: { appOrigin?: string; ttlMs?: number; clock?: Clock } = {}) {}

  private get clock() {
    return this.opts.clock ?? systemClock;
  }

  private create(ctx: TurnContext, kind: ApprovalKind, proposal: unknown, summary: string): Pending {
    const p: Pending = {
      id: newId(),
      kind,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      proposalHash: hashOf(proposal),
      code: String(this.codeSeq++ % 10_000).padStart(4, "0"),
      status: "pending",
      expiresAt: this.clock.now().getTime() + (this.opts.ttlMs ?? 10 * 60_000),
      summary,
    };
    this.approvals.push(p);
    return p;
  }

  async createToolAsk(ctx: TurnContext, input: { proposal: ToolProposal; manifest: ToolManifest }) {
    const summary = `${input.manifest.server} ${input.manifest.name}`;
    const p = this.create(
      ctx,
      input.manifest.riskClass === "spend" ? "spend_handoff" : "tool_ask",
      input.proposal,
      summary,
    );
    const expiresAt = new Date(p.expiresAt).toISOString();
    if (input.manifest.riskClass === "spend") {
      const url = `${this.opts.appOrigin ?? "https://example.invalid"}/approve/${p.id}`;
      return {
        approvalId: p.id,
        channel: "web" as const,
        prompt: `Approve this payment privately here: ${url}`,
        url,
        expiresAt,
      };
    }
    return {
      approvalId: p.id,
      channel: "text" as const,
      prompt: `Reply YES ${p.code} to allow: ${summary}. Reply NO ${p.code} to cancel.`,
      expiresAt,
    };
  }

  /**
   * The payer approved a spend on the authenticated web page (P2's page; P4's real ApprovalService
   * replaces this). Only the payer, only while pending and unexpired.
   */
  approveFromWeb(approvalId: string, userId: string): boolean {
    const p = this.approvals.find((a) => a.id === approvalId);
    if (!p || p.userId !== userId || p.status !== "pending" || p.kind !== "spend_handoff") return false;
    if (this.clock.now().getTime() > p.expiresAt) {
      p.status = "expired";
      return false;
    }
    p.status = "approved";
    return true;
  }

  isApproved(approvalId: string, userId: string): boolean {
    const p = this.approvals.find((a) => a.id === approvalId);
    return !!p && p.userId === userId && p.status === "approved";
  }

  async resolveTextReply(ctx: TurnContext, text: string): Promise<TextReplyResolution> {
    const m = /^\s*(yes|no)\s+(\d{4})\s*[.!]?\s*$/i.exec(text);
    if (!m) return { matched: false };
    if (ctx.conversationType !== "dm") return { matched: false };
    const p = this.approvals.find(
      (a) => a.code === m[2] && a.userId === ctx.userId && a.status === "pending",
    );
    if (!p) return { matched: false };
    if (this.clock.now().getTime() > p.expiresAt) {
      p.status = "expired";
      return {
        matched: true,
        approvalId: p.id,
        kind: p.kind,
        decision: "expired",
        message: "That approval code expired. Ask me again.",
      };
    }
    if (p.kind === "spend_handoff") {
      return {
        matched: true,
        approvalId: p.id,
        kind: p.kind,
        decision: "invalid",
        message: "Payments can only be approved on the secure page I sent you.",
      };
    }
    p.status = m[1]!.toLowerCase() === "yes" ? "approved" : "declined";
    if (p.kind === "permission_change" && p.status === "approved") {
      const change = this.pendingChanges.get(p.id);
      if (change) this.appliedPermissionChanges.push({ userId: p.userId, change });
    }
    return {
      matched: true,
      approvalId: p.id,
      kind: p.kind,
      decision: p.status === "approved" ? "approved" : "declined",
      message: p.status === "approved" ? `Approved: ${p.summary}.` : `Cancelled: ${p.summary}.`,
    };
  }

  private readonly pendingChanges = new Map<string, PermissionChangeRequest>();

  async requestPermissionChange(
    ctx: TurnContext,
    change: PermissionChangeRequest,
  ): Promise<PermissionChangeOutcome> {
    if (ctx.provenance !== "user_dm" || ctx.conversationType !== "dm") {
      return {
        status: "rejected",
        reasonCode: "provenance_not_user_dm",
        message: "Permission changes can only be made in a 1:1 chat with me.",
      };
    }
    if (change.action === "list") return { status: "applied", message: "You have no custom tool rules yet." };
    const broad = change.target === null || !change.target.includes("__") || change.scope === "everywhere";
    if (broad) {
      const p = this.create(
        ctx,
        "permission_change",
        change,
        `${change.action} ${change.mode ?? ""} for ${change.target ?? "all tools"}`.trim(),
      );
      this.pendingChanges.set(p.id, change);
      return {
        status: "needs_confirmation",
        approvalId: p.id,
        prompt: `This changes ${change.target ?? "all tools"} ${change.scope === "everywhere" ? "everywhere" : "in this chat"}. Reply YES ${p.code} to confirm.`,
        expiresAt: new Date(p.expiresAt).toISOString(),
      };
    }
    this.appliedPermissionChanges.push({ userId: ctx.userId, change });
    return { status: "applied", message: `Done: ${change.target} is now ${change.mode ?? "reset"}.` };
  }

  async createSpendHandoff(ctx: TurnContext, request: SpendHandoffRequest): Promise<SpendHandoff> {
    const p = this.create({ ...ctx, userId: request.payerUserId }, "spend_handoff", request, request.summary);
    return {
      approvalId: p.id,
      url: `${this.opts.appOrigin ?? "https://example.invalid"}/approve/${p.id}`,
      expiresAt: new Date(p.expiresAt).toISOString(),
      sandbox: true,
    };
  }
}
