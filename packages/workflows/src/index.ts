// @campus/workflows — order/payments workflows: owner P4 (stretch goal, do not start before M3).
//
// Task state persistence is P1's TaskStore (@campus/contracts interfaces/p1.ts). Transaction states and
// Quote/VerifiedAuthorization shapes are frozen in @campus/contracts schemas/financial.ts.
// Honesty rule: sandbox transactions are always labelled as simulated, never as real orders.
//
// Import rule: only @campus/contracts and files inside this package.
export {};
