// @campus/identity — owner: P2 (front door).
//
// Implements: IdentityService, MembershipService, AuthGate, NudgeService — see
// @campus/contracts interfaces/p2.ts and harness-spec 4.3 (auth model, Verify onboarding, nudge rules).
// Tables (P2-owned, created in db/migrations/p1 initial): core.external_identities, core.auth_challenges,
// core.nudges, core.conversations, core.conversation_members. New columns → db/migrations/p2/.
//
// To plug into the pipeline, export:
//   export const createIdentityModule: IdentityModuleFactory = (deps) => ({ identity, membership, authGate, nudges })
// then flip USE_REAL_IDENTITY=true at integration point I2.
//
// Import rule: only @campus/contracts and files inside this package.
export {};
