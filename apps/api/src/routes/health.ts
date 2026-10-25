import type { Container } from "@campus/worker";
import type { FastifyInstance } from "fastify";

// Owner: P1.
export async function registerHealthRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/healthz", async () => ({ ok: true, wiring: c.wiring, queue: await c.queue.counts() }));
}
