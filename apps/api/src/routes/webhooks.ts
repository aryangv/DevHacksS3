import type { Container } from "@campus/worker";
import type { FastifyInstance } from "fastify";

// Owner: P2 (front door). Slot for the Sendblue receive webhook and the Verify webhook.
//
// Contract with the pipeline (spec 4.2 steps 1–2, Section 7):
//   1. c.messaging.verifyWebhook(headers, req.rawBody)  — against the RAW body; reject on failure.
//   2. const msg = c.messaging.normalize(req.body)        — null → 200 and ignore (e.g. outbound echoes).
//   3. await c.pipeline.ingest(msg)                       — dedupes + enqueues; returns fast.
//   4. reply 200 quickly; never do turn work in the request (Sendblue redelivers on non-2xx).
// Verify webhook (spec 4.3 step 5): HMAC check on raw body, ≤5 min timestamp, SID matches the issued
// verification → mark identity verified (IdentityService implementation, P2).
export async function registerWebhookRoutes(_app: FastifyInstance, _c: Container): Promise<void> {
  // P2: register POST /webhooks/sendblue and POST /webhooks/sendblue/verify here.
}
