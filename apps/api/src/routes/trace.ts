import { timingSafeEqual } from "node:crypto";
import type { Container } from "@campus/worker";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// Trace API (owner: P1; spec 12 "trace view"): timeline of a turn or a conversation from the audit log.
// Audit detail is already redacted at write time; values are never private (projections, codes, counts).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function authorized(c: Container, req: FastifyRequest): boolean {
  const token = c.config.TRACE_API_TOKEN;
  if (!token) return c.config.NODE_ENV !== "production";
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function registerTraceRoutes(app: FastifyInstance, c: Container): Promise<void> {
  if (!c.config.TRACE_API_ENABLED) return;

  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(c, req)) return reply.code(401).send({ error: "unauthorized" });
  };

  app.get<{ Params: { turnId: string } }>(
    "/trace/turns/:turnId",
    { preHandler: guard },
    async (req, reply) => {
      if (!UUID.test(req.params.turnId)) return reply.code(400).send({ error: "invalid turnId" });
      const events = await c.audit.query({ turnId: req.params.turnId, limit: 1_000 });
      return { turnId: req.params.turnId, events };
    },
  );

  app.get<{ Params: { conversationId: string }; Querystring: { limit?: string } }>(
    "/trace/conversations/:conversationId",
    { preHandler: guard },
    async (req, reply) => {
      if (!UUID.test(req.params.conversationId))
        return reply.code(400).send({ error: "invalid conversationId" });
      const limit = Math.min(Number(req.query.limit ?? 200) || 200, 2_000);
      const events = await c.audit.query({ conversationId: req.params.conversationId, limit });
      return { conversationId: req.params.conversationId, events };
    },
  );
}
