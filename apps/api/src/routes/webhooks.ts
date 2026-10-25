import type { InboundMessage } from "@campus/contracts";
import { WEBHOOK_TOKEN_HEADER } from "@campus/messaging";
import { frontDoor } from "@campus/web";
import type { Container } from "@campus/worker";
import type { FastifyInstance } from "fastify";

// Owner: P2 (front door). Inbound iMessage webhook from a BlueBubbles Server (spec 4.2 steps 1–2).
//
//   POST /webhooks/bluebubbles?token=<BLUEBUBBLES_WEBHOOK_SECRET>
//
//   1. Authenticate: BlueBubbles does not sign webhooks, so the URL registered in BlueBubbles carries
//      a secret; the adapter compares it in constant time (default deny).
//   2. Normalize (non-message events, our own echoes and tapbacks → 200 and ignore).
//   3. Sign-up codes texted to the bot are matched here and never reach the pipeline or memory.
//   4. pipeline.ingest() dedupes on (platform, message guid) and enqueues; we answer 200 quickly and
//      never do turn work in the request.

type WithLookup = { normalizeWithLookup(raw: unknown): Promise<InboundMessage | null> };
const hasLookup = (m: unknown): m is WithLookup =>
  typeof (m as Partial<WithLookup>)?.normalizeWithLookup === "function";

export async function registerWebhookRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.post<{ Querystring: { token?: string } }>("/webhooks/bluebubbles", async (req, reply) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === WEBHOOK_TOKEN_HEADER) continue; // only the URL token counts
      if (typeof v === "string") headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(",");
    }
    if (typeof req.query.token === "string") headers[WEBHOOK_TOKEN_HEADER] = req.query.token;

    if (!c.messaging.verifyWebhook(headers, req.rawBody ?? "")) {
      await c.audit.record({
        action: "webhook.rejected",
        policyResult: "deny",
        detail: { webhook: "bluebubbles", reason: "bad_token" },
      });
      return reply.code(401).send({ error: "unauthorized" });
    }

    const msg = hasLookup(c.messaging)
      ? await c.messaging.normalizeWithLookup(req.body)
      : c.messaging.normalize(req.body);
    if (!msg) return reply.code(200).send({ status: "ignored" });

    const fd = frontDoor(c);
    if (fd && (await fd.verification.tryCode(msg))) return reply.code(200).send({ status: "verification" });

    const result = await c.pipeline.ingest(msg);
    return reply.code(200).send({ status: result.status });
  });
}
