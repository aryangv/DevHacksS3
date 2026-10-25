// @campus/identity — owner: P2 (front door).
//
// Implements IdentityService, MembershipService, AuthGate and NudgeService (@campus/contracts
// interfaces/p2.ts) over Postgres — harness-spec 4.3 (auth model, onboarding, nudge rules, group
// activation, join/leave). Also: iMessage-code verification and web sessions for the onboarding and
// settings pages (apps/web). Plugged into the pipeline by `createIdentityModule` (USE_REAL_IDENTITY=true).
//
// Tables (P2-owned): core.users, core.external_identities, core.auth_challenges, core.nudges,
// core.conversations, core.conversation_members (p1 initial migration) plus core.verification_sessions
// and core.web_sessions (db/migrations/p2).
//
// Import rule: only @campus/contracts and files inside this package.
import {
  HarnessError,
  type IdentityModule,
  type IdentityModuleFactory,
  type ModuleDeps,
  type MessagingAdapter,
} from "@campus/contracts";
import { DefaultAuthGate } from "./auth-gate";
import { PgIdentityService } from "./identity-service";
import { PgMembershipService } from "./membership-service";
import { DefaultNudgeService } from "./nudge-service";
import { WebSessionService } from "./sessions";
import { VerificationService } from "./verification/service";

export { DefaultAuthGate } from "./auth-gate";
export { PgIdentityService, toResolved } from "./identity-service";
export { PgMembershipService } from "./membership-service";
export { CHALLENGE_TTL_MS, DefaultNudgeService } from "./nudge-service";
export { SESSION_TTL_MS, WebSessionService, type WebSession } from "./sessions";
export { normalizeAddress, hashToken } from "./util";
export { CODE_TTL_MS, VerificationService, type PollResult, type StartResult } from "./verification/service";

/**
 * Everything P2's identity layer provides, including the surface beyond the contract interfaces
 * (verification + sessions for the web pages and the inbound webhook). All state lives in Postgres,
 * so building it twice (pipeline and web routes) is safe.
 */
export function createIdentityServices(deps: ModuleDeps & { messaging: MessagingAdapter }) {
  if (!deps.sql)
    throw new HarnessError(
      "config_invalid",
      "USE_REAL_IDENTITY needs DATABASE_URL (identities live in Postgres)",
    );
  const c = deps.config;
  if (!c.APP_ORIGIN || !c.BLUEBUBBLES_BOT_ADDRESS)
    throw new HarnessError(
      "config_invalid",
      "USE_REAL_IDENTITY needs APP_ORIGIN and BLUEBUBBLES_BOT_ADDRESS",
    );
  const { sql, audit, clock, logger, messaging } = deps;
  const identity = new PgIdentityService({ sql, audit });
  const membership = new PgMembershipService({ sql, audit, identity });
  const sessions = new WebSessionService({ sql, audit, clock });
  return {
    identity,
    membership,
    sessions,
    authGate: new DefaultAuthGate({ identity }),
    nudges: new DefaultNudgeService({
      sql,
      messaging,
      audit,
      clock,
      logger,
      appOrigin: c.APP_ORIGIN,
      intervalHours: c.NUDGE_INTERVAL_HOURS,
      agentName: c.AGENT_DISPLAY_NAME,
    }),
    verification: new VerificationService({
      sql,
      audit,
      clock,
      logger,
      identity,
      sessions,
      messaging,
      botAddress: c.BLUEBUBBLES_BOT_ADDRESS,
      agentName: c.AGENT_DISPLAY_NAME,
    }),
  };
}

export type IdentityServices = ReturnType<typeof createIdentityServices>;

/** DI entry point (REAL_MODULES.identity): loaded by the container when USE_REAL_IDENTITY=true. */
export const createIdentityModule: IdentityModuleFactory = (deps): IdentityModule => {
  const s = createIdentityServices(deps);
  return { identity: s.identity, membership: s.membership, authGate: s.authGate, nudges: s.nudges };
};
