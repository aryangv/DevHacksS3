import { z } from "zod";

// harness-spec 5.7 (Context Broker contract) plus the named-field registry that the broker (P3) and
// the agents (P1) agree on. Fields are named projections, never free-form queries.

export const ContextPurposeSchema = z.enum(["group_meal", "campus_match", "scheduling", "other"]);
export type ContextPurpose = z.infer<typeof ContextPurposeSchema>;

export const AudienceSchema = z.strictObject({
  kind: z.enum(["agent", "group"]),
  id: z.string().min(1),
});
export type Audience = z.infer<typeof AudienceSchema>;

export const ContextRequestSchema = z.strictObject({
  taskId: z.string().min(1),
  requesterAgentId: z.string().min(1),
  subjectUserId: z.string().min(1),
  purpose: ContextPurposeSchema,
  fields: z.array(z.string().min(1)).min(1),
  audience: AudienceSchema,
});
export type ContextRequest = z.infer<typeof ContextRequestSchema>;

export const ContextResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("approved"),
    fields: z.record(z.string(), z.unknown()),
    expiresAt: z.string(),
  }),
  z.strictObject({ status: z.literal("needs_consent"), consentRequestId: z.string() }),
  z.strictObject({ status: z.literal("denied"), reasonCode: z.string() }),
]);
export type ContextResult = z.infer<typeof ContextResultSchema>;

/** Disclose check (spec 5.7, 6.5 step 10): may this data reach this audience? */
export const DiscloseRequestSchema = z.strictObject({
  subjectUserId: z.string().min(1),
  purpose: ContextPurposeSchema,
  audience: AudienceSchema,
  /** What kind of data is about to be disclosed, e.g. "tool:canvas__list_grades" or a context field name. */
  dataClasses: z.array(z.string().min(1)).min(1),
  taskId: z.string().optional(),
});
export type DiscloseRequest = z.infer<typeof DiscloseRequestSchema>;
export type DiscloseResult = { allowed: true } | { allowed: false; reasonCode: string };

// ---------------------------------------------------------------------------------------------
// Named context fields. Each field has a value schema so a broker answer is validated before use.
// Projections only: coarse values, booleans, bands. Never raw memory text.
// ---------------------------------------------------------------------------------------------

export const PriceBandSchema = z.enum(["under_10", "under_15", "under_20", "under_30", "any"]);
export type PriceBand = z.infer<typeof PriceBandSchema>;

export const PRICE_BAND_CEILING_MINOR: Record<PriceBand, number | null> = {
  under_10: 1000,
  under_15: 1500,
  under_20: 2000,
  under_30: 3000,
  any: null,
};

export const CONTEXT_FIELDS = {
  /** Personal ceiling per meal, minor units. Audience must be the subject's own personal agent. */
  "meal.max_price_per_person_minor": z.number().int().nonnegative(),
  /** Option tags the subject requires, e.g. "vegetarian_friendly", "halal", "gluten_free". */
  "meal.required_tags": z.array(z.string()),
  /** Cuisines the subject avoids. */
  "meal.avoid_cuisines": z.array(z.string()),
  /** Coarse band; the only budget signal that may be shared with a group agent (counteroffers). */
  "meal.price_band": PriceBandSchema,
  /** Coarse availability projection for scheduling. */
  "availability.free_slots": z.array(z.strictObject({ start: z.string(), end: z.string() })),
} as const;
export type ContextFieldName = keyof typeof CONTEXT_FIELDS;

export const CONTEXT_FIELDS_BY_PURPOSE: Record<ContextPurpose, readonly ContextFieldName[]> = {
  group_meal: [
    "meal.max_price_per_person_minor",
    "meal.required_tags",
    "meal.avoid_cuisines",
    "meal.price_band",
  ],
  scheduling: ["availability.free_slots"],
  campus_match: [],
  other: [],
};

/** Fields that may be disclosed to an audience other than the subject's own personal agent. */
export const SHAREABLE_CONTEXT_FIELDS: readonly ContextFieldName[] = [
  "meal.price_band",
  "availability.free_slots",
];

export function isContextFieldName(name: string): name is ContextFieldName {
  return Object.prototype.hasOwnProperty.call(CONTEXT_FIELDS, name);
}

/**
 * Validate an approved broker answer against the field registry. Unknown fields and values that fail
 * their schema are dropped (and reported), never passed through.
 */
export function parseContextFields(fields: Record<string, unknown>): {
  values: Partial<{ [K in ContextFieldName]: z.infer<(typeof CONTEXT_FIELDS)[K]> }>;
  rejected: string[];
} {
  const values: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (!isContextFieldName(name)) {
      rejected.push(name);
      continue;
    }
    const parsed = CONTEXT_FIELDS[name].safeParse(value);
    if (parsed.success) values[name] = parsed.data;
    else rejected.push(name);
  }
  return { values: values as never, rejected };
}
