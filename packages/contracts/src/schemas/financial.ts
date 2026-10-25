import { z } from "zod";

// harness-spec Section 9 financial types. Payments are owned by P4 (stretch); shapes frozen here.

export const QuoteSchema = z.strictObject({
  id: z.string().min(1),
  connectorId: z.string().min(1),
  merchantId: z.string().min(1),
  currency: z.string().length(3),
  totalMinor: z.number().int().nonnegative(),
  expiresAt: z.string(),
  items: z.array(z.strictObject({ sku: z.string(), quantity: z.number().int().positive() })),
});
export type Quote = z.infer<typeof QuoteSchema>;

export const VerifiedAuthorizationSchema = z.strictObject({
  approvalId: z.string().min(1),
  userId: z.string().min(1),
  quoteId: z.string().min(1),
  maxTotalMinor: z.number().int().nonnegative(),
  expiresAt: z.string(),
});
export type VerifiedAuthorization = z.infer<typeof VerifiedAuthorizationSchema>;

export const TransactionStateSchema = z.enum([
  "DRAFT",
  "QUOTED",
  "AWAITING_APPROVAL",
  "AUTHORIZED",
  "EXECUTING",
  "CONFIRMED",
  "NEEDS_RECONCILIATION",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
]);
export type TransactionState = z.infer<typeof TransactionStateSchema>;
