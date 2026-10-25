import type { Container } from "@campus/worker";
import type { FastifyInstance } from "fastify";

// Owner: P4 (hands). Slot for OAuth callbacks: one route per server, /oauth/callback/:slug (spec 6.2–6.3).
// Validate state (single-use, unexpired, bound to the user's session), exchange code with PKCE, encrypt
// tokens into vault.credentials via the restricted role, set mcp.user_connections.status = 'connected'.
export async function registerOAuthRoutes(_app: FastifyInstance, _c: Container): Promise<void> {
  // P4: register GET /oauth/callback/:slug here.
}
