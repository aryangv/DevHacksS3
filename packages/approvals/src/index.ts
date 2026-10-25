// @campus/approvals — owner: P4 (hands).
//
// Implements: ApprovalService (text-code approvals, permission-change confirmation, spend handoff to
// the web approval page) — see @campus/contracts interfaces/p4.ts and harness-spec 4.2 step 10, 6.6.
// Table: core.pending_approvals (created in the P1 initial migration; logic owned here).
//
// To plug into the pipeline, export:
//   export const createApprovalsModule: ApprovalsModuleFactory = (deps) => approvalService
// (loaded together with @campus/tools when USE_REAL_TOOLS=true).
//
// Import rule: only @campus/contracts and files inside this package.
export {};
