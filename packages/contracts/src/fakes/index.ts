// In-memory fakes for every interface (spec 18.3 item 6). Import from "@campus/contracts/fakes".
// Fakes are for the simulator and tests; never wire them in production.
export * from "./messaging";
export * from "./identity";
export * from "./memory";
export * from "./tools";
export * from "./approvals";
export * from "./model";
export * from "./runtime-stores";
export * from "./json-schema-lite";
