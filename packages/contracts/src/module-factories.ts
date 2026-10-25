import type { AppConfig } from "./config";
import type { AuditLog } from "./interfaces/p1";
import type {
  AuthGate,
  IdentityService,
  MembershipService,
  MessagingAdapter,
  NudgeService,
} from "./interfaces/p2";
import type {
  BucketProvisioner,
  ConsentService,
  ContextBroker,
  MemoryMaintenance,
  MemoryPolicy,
  MemoryStore,
} from "./interfaces/p3";
import type {
  ApprovalService,
  ConnectionService,
  PermissionResolver,
  ToolGateway,
  VaultClient,
} from "./interfaces/p4";
import type { Clock } from "./util/ids";
import type { Logger } from "./util/logger";
import type { SqlClient } from "./util/sql";

// How a real implementation plugs into the DI container (spec 18.3 item 7).
// When a USE_REAL_* flag is on, the worker/api composition root dynamically imports the owner's package
// and calls the named factory export below. Until that export exists, keep the flag off.

export type ModuleDeps = {
  config: AppConfig;
  logger: Logger;
  /** General application role (no vault access). Null when no DATABASE_URL is configured. */
  sql: SqlClient | null;
  audit: AuditLog;
  clock: Clock;
};

// P2 — @campus/messaging
export type MessagingModuleFactory = (deps: ModuleDeps) => MessagingAdapter | Promise<MessagingAdapter>;

// P2 — @campus/identity
export type IdentityModule = {
  identity: IdentityService;
  membership: MembershipService;
  authGate: AuthGate;
  nudges: NudgeService;
};
export type IdentityModuleFactory = (
  deps: ModuleDeps & { messaging: MessagingAdapter },
) => IdentityModule | Promise<IdentityModule>;

// P3 — @campus/context
export type ContextModule = {
  memoryStore: MemoryStore;
  broker: ContextBroker;
  consent: ConsentService;
  buckets: BucketProvisioner;
  memoryPolicy: MemoryPolicy;
  /** Optional worker jobs; the worker schedules them when present. */
  maintenance?: MemoryMaintenance;
};
export type ContextModuleFactory = (
  deps: ModuleDeps & { membership: MembershipService },
) => ContextModule | Promise<ContextModule>;

// P4 — @campus/approvals
export type ApprovalsModuleFactory = (deps: ModuleDeps) => ApprovalService | Promise<ApprovalService>;

// P4 — @campus/tools
export type ToolsModule = {
  gateway: ToolGateway;
  permissions: PermissionResolver;
  connections: ConnectionService;
  vault?: VaultClient;
};
export type ToolsModuleFactory = (
  deps: ModuleDeps & {
    /** Restricted role for vault.* (DATABASE_URL_VAULT). Only the gateway may use it. */
    sqlVault: SqlClient | null;
    approvals: ApprovalService;
    broker: ContextBroker;
  },
) => ToolsModule | Promise<ToolsModule>;

/** Package + export name each flag loads. */
export const REAL_MODULES = {
  messaging: { flag: "USE_REAL_MESSAGING", pkg: "@campus/messaging", exportName: "createMessagingAdapter" },
  identity: { flag: "USE_REAL_IDENTITY", pkg: "@campus/identity", exportName: "createIdentityModule" },
  context: { flag: "USE_REAL_MEMORY", pkg: "@campus/context", exportName: "createContextModule" },
  approvals: { flag: "USE_REAL_TOOLS", pkg: "@campus/approvals", exportName: "createApprovalsModule" },
  tools: { flag: "USE_REAL_TOOLS", pkg: "@campus/tools", exportName: "createToolsModule" },
} as const;
