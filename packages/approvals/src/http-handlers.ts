import type { ApprovalService } from "./service.ts";
import type { WebSession } from "./ports.ts";

/** P2 authenticates session and enforces CSRF before calling these handlers. */
export function approvalHandlers(service: ApprovalService) {
  return {
    pending: (session: WebSession) => service.pending(session),
    decide: async (session: WebSession, id: string, body: unknown) => {
      if (!body || typeof body !== "object")
        return { statusCode: 400, body: { error: "invalid_approval" } };
      const b = body as Record<string, unknown>;
      if (
        typeof b.token !== "string" ||
        b.token.length > 256 ||
        typeof b.approve !== "boolean" ||
        !Object.hasOwn(b, "proposal")
      )
        return { statusCode: 400, body: { error: "invalid_approval" } };
      try {
        const accepted = await service.decideWeb(
          id,
          session,
          b.token,
          b.approve,
          b.proposal,
        );
        return accepted
          ? { statusCode: 200, body: { accepted: true } }
          : { statusCode: 403, body: { error: "approval_denied" } };
      } catch {
        return { statusCode: 400, body: { error: "invalid_approval" } };
      }
    },
  };
}
