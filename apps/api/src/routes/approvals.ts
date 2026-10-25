import type { Container } from "@campus/worker";
import type { FastifyInstance } from "fastify";

// Owner: P4 (approval API/logic; the page UI is P2's apps/web). Spend approvals: authenticated payer,
// exact quote binding, one-time token, expiry (spec 4.2 step 10, 6.6, ARCHITECTURE §6).
export async function registerApprovalRoutes(_app: FastifyInstance, _c: Container): Promise<void> {
  // P4: register GET/POST /approvals/:approvalId here.
}
