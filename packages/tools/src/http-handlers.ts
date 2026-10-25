import { z } from 'zod';
import type { ConnectionService } from './connections.ts';
import type { WebSession } from './ports.ts';

/** Framework-neutral backend handlers. P2 owns authentication, CSRF, route
 * registration, and access-log query redaction; do not pass client-chosen sessions.
 */
export function connectionHandlers(service: ConnectionService) {
  const callbackSchema = z.object({
    state: z.string().min(1).max(256),
    code: z.string().max(4096).optional(),
    error: z.string().max(256).optional(),
    connected_account_id: z.string().max(256).optional(),
    status: z.string().max(32).optional(),
  });
  return {
    list: (session: WebSession) => service.list(session),
    start: async (session: WebSession, serverId: string) => {
      try {
        return { statusCode: 200, body: await service.initiate(session, serverId) };
      } catch {
        return { statusCode: 400, body: { error: 'connection_start_failed' } };
      }
    },
    revoke: (session: WebSession, serverId: string) => service.revoke(session, serverId),
    callback: async (session: WebSession, slug: string, query: unknown) => {
      const parsed = callbackSchema.safeParse(query);
      if (!parsed.success) return { statusCode: 400, body: { error: 'oauth_callback_invalid' } };
      try {
        return { statusCode: 200, body: await service.callback(session, slug, parsed.data) };
      } catch {
        return { statusCode: 400, body: { error: 'oauth_callback_failed' } };
      }
    },
  };
}
