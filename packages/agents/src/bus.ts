import {
  type AuditLog,
  type Clock,
  type CoordinationBus,
  type CoordinationRequest,
  CoordinationRequestSchema,
  type CoordinationResponse,
  CoordinationResponseSchema,
  type Logger,
  type PersonalAgentFactory,
  type TaskStore,
  parseAgentId,
} from "@campus/contracts";
import { TIMEOUT_REASON } from "./coordinator";

// In-process typed coordination bus (spec 4.6: in-process first; durable queue where needed).
// Agents never chat free text: requests/responses are schema-validated and persisted to
// core.coordination_events, and audited without private values.

export class InProcessCoordinationBus implements CoordinationBus {
  constructor(
    private readonly deps: {
      personalAgents: PersonalAgentFactory;
      tasks: TaskStore;
      audit: AuditLog;
      logger: Logger;
      clock: Clock;
      timeoutMs: number;
    },
  ) {}

  async request(
    raw: CoordinationRequest,
    trace?: { turnId: string; conversationId: string },
  ): Promise<CoordinationResponse> {
    const req = CoordinationRequestSchema.parse(raw);
    const target = parseAgentId(req.targetAgentId);
    const link = { turnId: trace?.turnId ?? null, conversationId: trace?.conversationId ?? null };
    await this.deps.tasks.appendEvent({
      taskId: req.taskId,
      fromAgent: req.requesterAgentId,
      toAgent: req.targetAgentId,
      type: `request.${req.requestType}`,
      payload: req.payload,
    });
    await this.deps.audit.record({
      action: "coordination.request",
      ...link,
      resource: `task:${req.taskId}`,
      detail: { requestType: req.requestType, from: req.requesterAgentId, to: req.targetAgentId },
    });

    let response: CoordinationResponse;
    if (!target || target.kind !== "personal") {
      response = { taskId: req.taskId, status: "rejected", payload: {}, reasonCode: "unknown_target" };
    } else if (new Date(req.expiresAt).getTime() <= this.deps.clock.now().getTime()) {
      response = { taskId: req.taskId, status: "rejected", payload: {}, reasonCode: "expired" };
    } else {
      response = await this.callWithTimeout(req, target.id);
    }

    const valid = CoordinationResponseSchema.safeParse(response);
    if (!valid.success || valid.data.taskId !== req.taskId) {
      response = { taskId: req.taskId, status: "rejected", payload: {}, reasonCode: "invalid_response" };
    }
    await this.deps.tasks.appendEvent({
      taskId: req.taskId,
      fromAgent: req.targetAgentId,
      toAgent: req.requesterAgentId,
      type: `response.${response.status}`,
      payload: response.payload,
    });
    await this.deps.audit.record({
      action: "coordination.response",
      ...link,
      resource: `task:${req.taskId}`,
      policyResult: response.status,
      detail: {
        from: req.targetAgentId,
        status: response.status,
        reasonCode: response.reasonCode ?? null,
        payloadKeys: Object.keys(response.payload),
      },
    });
    return response;
  }

  private async callWithTimeout(req: CoordinationRequest, userId: string): Promise<CoordinationResponse> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.deps.personalAgents.forUser(userId).evaluate(req),
        new Promise<CoordinationResponse>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({ taskId: req.taskId, status: "rejected", payload: {}, reasonCode: TIMEOUT_REASON }),
            this.deps.timeoutMs,
          );
        }),
      ]);
    } catch (err) {
      this.deps.logger.warn("personal agent evaluate failed", { taskId: req.taskId, err });
      return { taskId: req.taskId, status: "rejected", payload: {}, reasonCode: TIMEOUT_REASON };
    } finally {
      clearTimeout(timer);
    }
  }
}
