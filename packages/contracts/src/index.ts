// @campus/contracts — the only workspace package other packages may import (spec 18.1).
// Contract changes: PR labelled `contract-change`, reviewed by all four, merged by P1 (spec 18.6).

export * from "./schemas/messaging";
export * from "./schemas/context";
export * from "./schemas/coordination";
export * from "./schemas/financial";
export * from "./schemas/tools";
export * from "./schemas/model";
export * from "./schemas/turn";
export * from "./schemas/identity";
export * from "./schemas/memory";
export * from "./schemas/approvals";
export * from "./schemas/tasks";
export * from "./schemas/audit";

export * from "./interfaces/p1";
export * from "./interfaces/p2";
export * from "./interfaces/p3";
export * from "./interfaces/p4";

export * from "./audit";
export * from "./errors";
export * from "./events";
export * from "./config";
export * from "./module-factories";

export * from "./util/redact";
export * from "./util/logger";
export * from "./util/keyed-mutex";
export * from "./util/sql";
export * from "./util/ids";
