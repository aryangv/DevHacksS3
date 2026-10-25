import type { Container } from "@campus/worker";
import Fastify, { type FastifyInstance } from "fastify";
import { registerApprovalRoutes } from "./routes/approvals";
import { registerHealthRoutes } from "./routes/health";
import { registerOAuthRoutes } from "./routes/oauth";
import { registerTraceRoutes } from "./routes/trace";
import { registerWebhookRoutes } from "./routes/webhooks";

// HTTP shell (P1). Route modules are owned per CODEOWNERS:
//   routes/webhooks.ts  → P2 (Sendblue receive + Verify webhooks)
//   routes/oauth.ts     → P4 (OAuth callbacks /oauth/callback/:slug)
//   routes/approvals.ts → P4 (approval API used by the web approval page)
//   routes/trace.ts, routes/health.ts → P1

declare module "fastify" {
  interface FastifyRequest {
    /** Exact request body as received; webhook signatures must be checked against this (spec 3.1). */
    rawBody?: string;
  }
}

export async function buildServer(c: Container): Promise<FastifyInstance> {
  // Fastify's own logger is off: our logger redacts secrets.
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    const raw = typeof body === "string" ? body : body.toString("utf8");
    req.rawBody = raw;
    if (!raw) return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.addHook("onResponse", async (req, reply) => {
    c.logger.info("http", {
      requestId: req.id,
      method: req.method,
      route: req.routeOptions.url,
      status: reply.statusCode,
    });
  });

  await registerHealthRoutes(app, c);
  await registerTraceRoutes(app, c);
  await registerWebhookRoutes(app, c);
  await registerOAuthRoutes(app, c);
  await registerApprovalRoutes(app, c);
  return app;
}
