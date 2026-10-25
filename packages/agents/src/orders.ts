import {
  type AgentTask,
  type AuditLog,
  type Clock,
  type GroupMealState,
  type Logger,
  type MessagingAdapter,
  type Platform,
  type TaskStore,
  type ToolGateway,
  type TurnContext,
  groupAgentId,
  newId,
} from "@campus/contracts";
import { z } from "zod";
import { formatMoney } from "./prompts";

// Real group orders after the payer approves (P2 contribution; P4's approval logic will replace the
// fake approval call). Everything goes through the tool gateway:
//   - approveAndPlace: the payer approved the exact quote on the authenticated web page → the gateway
//     runs exactly the approved submit_order (it re-checks the provider total) → post to the group.
//   - trackOrders: poll the provider's delivery status and post changes to the same group.
// Honesty rule: only say "ordered" when the provider returned an order id; unknown outcomes are
// marked needs_reconciliation (never retried blindly).

type Task = AgentTask<GroupMealState>;
type Order = NonNullable<GroupMealState["order"]>;

export type WebApprovals = { approveFromWeb?(approvalId: string, userId: string): boolean };

export type OrderServiceDeps = {
  tasks: TaskStore;
  gateway: ToolGateway;
  messaging: MessagingAdapter;
  /** Marks a spend approval approved from the web page (fake today; P4's ApprovalService later). */
  approvals: WebApprovals;
  audit: AuditLog;
  clock: Clock;
  logger: Logger;
  /** Namespaced tools, e.g. "dining__order_status". */
  statusTool: string;
};

const TASK_TYPE = "group_meal";
const SubmitResultSchema = z.object({
  placed: z.boolean(),
  orderId: z.string().optional(),
  reason: z.string().optional(),
  currentTotalMinor: z.number().nullable().optional(),
  outcomeUnknown: z.boolean().optional(),
});
const StatusSchema = z.object({
  status: z.enum(["placed", "preparing", "on_the_way", "delivered", "cancelled", "unknown"]),
  etaMinutes: z.number().nullable().optional(),
});

export type PlaceResult =
  | { status: "placed"; orderId: string; message: string }
  | { status: "not_found" | "forbidden" | "failed" | "unknown_outcome"; message: string };

export class OrderService {
  constructor(private readonly deps: OrderServiceDeps) {}

  /** The open order waiting on this approval (for the approval page). */
  async findByApproval(approvalId: string): Promise<Task | null> {
    const open = await this.deps.tasks.listByStatus<GroupMealState>(TASK_TYPE, ["awaiting_payment"]);
    return open.find((t) => t.state.order?.approvalId === approvalId) ?? null;
  }

  async approveAndPlace(approvalId: string, userId: string): Promise<PlaceResult> {
    const d = this.deps;
    const task = await this.findByApproval(approvalId);
    const order = task?.state.order;
    if (!task || !order?.quote || !order.delivery)
      return { status: "not_found", message: "This order isn't waiting for payment." };
    if (order.payerUserId !== userId)
      return { status: "forbidden", message: "Only the payer can approve this order." };
    if (d.approvals.approveFromWeb && !d.approvals.approveFromWeb(approvalId, userId))
      return {
        status: "failed",
        message: "This approval expired or was already used. Ask in the group to plan again.",
      };

    const ctx = this.systemContext(task, order, userId);
    const outcome = await d.gateway.executeApproved(ctx, approvalId);
    if (outcome.status === "error") {
      await this.update(task, "needs_reconciliation", order);
      await this.post(
        order,
        `I sent the order to ${order.restaurant}, but couldn't confirm it went through. Check the app before trying again.`,
      );
      await this.audit(task, "order.failed", { reason: "outcome_unknown" });
      return {
        status: "unknown_outcome",
        message: "Couldn't confirm the order. Check the ordering app before trying again.",
      };
    }
    if (outcome.status !== "executed" || !outcome.result.ok) {
      const reason =
        outcome.status === "executed"
          ? (outcome.result.errorCode ?? "provider_error")
          : "reasonCode" in outcome
            ? outcome.reasonCode
            : outcome.status;
      await this.audit(task, "order.failed", { reason });
      return { status: "failed", message: `The order wasn't placed (${reason}). Nothing was charged.` };
    }
    const r = SubmitResultSchema.safeParse(outcome.result.data); // provider output is untrusted data
    if (!r.success || !r.data.placed || !r.data.orderId) {
      const changed = r.success && r.data.reason === "total_changed";
      if (r.success && r.data.outcomeUnknown) {
        await this.update(task, "needs_reconciliation", order);
        return {
          status: "unknown_outcome",
          message: "Couldn't confirm the order. Check the ordering app before trying again.",
        };
      }
      await this.update(task, "failed", order);
      const msg = changed
        ? `${order.restaurant} changed the total${r.data.currentTotalMinor ? ` to ${formatMoney(r.data.currentTotalMinor, order.currency)}` : ""}, so I didn't place the order. Ask me to plan again for a fresh quote.`
        : `The order at ${order.restaurant} wasn't placed. Nothing was charged.`;
      await this.post(order, msg);
      await this.audit(task, "order.failed", {
        reason: r.success ? (r.data.reason ?? "not_placed") : "invalid_result",
      });
      return { status: "failed", message: msg };
    }

    const placedAt = d.clock.now().toISOString();
    const next: Order = { ...order, providerOrderId: r.data.orderId, trackingStatus: "placed", placedAt };
    await this.update(task, "ordered", next);
    await this.audit(task, "order.placed", {
      totalMinor: order.quote.totalMinor,
      provider: order.quote.provider,
    });
    await this.post(
      next,
      `Order placed with ${order.restaurant} on ${providerName(order.quote.provider)}: ${formatMoney(order.quote.totalMinor, order.currency)}, paid by ${this.payerName(order)}. I'll post updates here.`,
    );
    return {
      status: "placed",
      orderId: r.data.orderId,
      message: "Order placed. Updates will show up in the group chat.",
    };
  }

  /** Worker job: post delivery updates for placed orders. Never throws. */
  async trackOrders(): Promise<{ checked: number; updated: number }> {
    const d = this.deps;
    const open = await d.tasks.listByStatus<GroupMealState>(TASK_TYPE, ["ordered"]);
    let updated = 0;
    for (const task of open) {
      const order = task.state.order;
      if (!order?.providerOrderId || !order.delivery) continue;
      try {
        const [server, tool] = d.statusTool.split("__") as [string, string];
        const outcome = await d.gateway.propose(this.systemContext(task, order, order.payerUserId), {
          proposalId: newId(),
          server,
          tool,
          args: { orderId: order.providerOrderId },
        });
        if (outcome.status !== "executed" || !outcome.result.ok) continue;
        const s = StatusSchema.safeParse(outcome.result.data);
        if (!s.success || s.data.status === "unknown" || s.data.status === order.trackingStatus) continue;
        const next: Order = { ...order, trackingStatus: s.data.status };
        const done = s.data.status === "delivered" || s.data.status === "cancelled";
        await this.update(task, done ? "completed" : "ordered", next);
        await this.post(
          next,
          statusLine(next, s.data.status, s.data.etaMinutes ?? null, this.payerName(order)),
        );
        await this.audit(task, "order.status", { status: s.data.status });
        updated += 1;
      } catch (err) {
        d.logger.warn("order tracking failed", { taskId: task.id, err });
      }
    }
    return { checked: open.length, updated };
  }

  private payerName(order: Order): string {
    return order.lines.find((l) => l.userId === order.payerUserId)?.name ?? "the payer";
  }

  /** A turn context for work started outside a chat turn (the payer's web approval, the tracker). */
  private systemContext(task: Task, order: Order, userId: string): TurnContext {
    const now = this.deps.clock.now();
    return {
      turnId: newId(),
      platform: order.delivery!.platform as Platform,
      conversationId: task.conversationId!,
      conversationType: "group",
      providerConversationId: order.delivery!.providerConversationId,
      providerMessageId: "",
      userId,
      externalIdentityId: "",
      agent: { kind: "group", id: groupAgentId(task.conversationId!) },
      // Least authority: never "user_dm" (that alone may change permissions).
      provenance: "group_message",
      receivedAt: now.toISOString(),
      deadlineMs: now.getTime() + 60_000,
    };
  }

  private async update(task: Task, status: string, order: Order): Promise<void> {
    const fresh = (await this.deps.tasks.get<GroupMealState>(task.id))!;
    await this.deps.tasks.update(task.id, { status, state: { ...fresh.state, order } }, fresh.version);
  }

  private async post(order: Order, text: string): Promise<void> {
    if (!order.delivery) return;
    await this.deps.messaging
      .sendGroup(order.delivery.providerConversationId, text)
      .catch((err) => this.deps.logger.warn("order update send failed", { err }));
  }

  private audit(
    task: Task,
    action: "order.placed" | "order.failed" | "order.status",
    detail: Record<string, unknown>,
  ) {
    return this.deps.audit.record({
      action,
      conversationId: task.conversationId,
      actorUserId: task.state.order?.payerUserId ?? null,
      detail: { taskId: task.id, ...detail },
    });
  }
}

const providerName = (p: string) => (p === "grubhub" ? "Grubhub" : p);

function statusLine(order: Order, status: string, eta: number | null, payer: string): string {
  switch (status) {
    case "preparing":
      return `${order.restaurant} is preparing the order.`;
    case "on_the_way":
      return `The food is on the way${eta ? ` (about ${eta} min)` : ""}.`;
    case "delivered": {
      const split = order.splits.length
        ? ` Split: ${order.splits.map((s) => `${s.name ?? "someone"} owes ${payer} ${formatMoney(s.owesMinor, order.currency)}`).join(", ")}.`
        : "";
      return `Delivered. Enjoy!${split}`;
    }
    case "cancelled":
      return `${order.restaurant} cancelled the order. Check the app for the refund.`;
    default:
      return `Order update: ${status}.`;
  }
}
