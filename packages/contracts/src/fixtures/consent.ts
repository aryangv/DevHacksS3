// Sample consent grants (core.consent_grants rows) for P3's broker tests and the fake broker.

export const sampleConsentGrants = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000001",
    purpose: "group_meal",
    audienceKind: "agent",
    audienceId: "personal:00000000-0000-4000-8000-000000000001",
    allowedFields: ["meal.max_price_per_person_minor", "meal.required_tags", "meal.avoid_cuisines"],
    expiresAt: null,
    revokedAt: null,
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    userId: "00000000-0000-4000-8000-000000000002",
    purpose: "group_meal",
    audienceKind: "group",
    audienceId: "group:*",
    allowedFields: ["meal.price_band"],
    expiresAt: "2026-12-31T00:00:00.000Z",
    revokedAt: null,
  },
  {
    id: "10000000-0000-4000-8000-000000000003",
    userId: "00000000-0000-4000-8000-000000000003",
    purpose: "group_meal",
    audienceKind: "agent",
    audienceId: "personal:00000000-0000-4000-8000-000000000003",
    allowedFields: ["meal.max_price_per_person_minor"],
    expiresAt: null,
    revokedAt: "2026-10-20T00:00:00.000Z",
  },
] as const;
