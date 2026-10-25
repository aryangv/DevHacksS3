import type { ContextFieldName } from "../schemas/context";

// Demo cast for the dinner vertical slice (spec 4.6.1). Fictional people and 555 numbers only.

export type DemoUser = {
  userId: string;
  externalId: string;
  displayName: string;
  verified: boolean;
  /** Private facts only the fake broker knows; the group must never see these values. */
  private: Partial<Record<ContextFieldName, unknown>>;
};

export const demoUsers: DemoUser[] = [
  {
    userId: "00000000-0000-4000-8000-000000000001",
    externalId: "+15550001001",
    displayName: "Avery",
    verified: true,
    private: {
      "meal.max_price_per_person_minor": 2000,
      "meal.required_tags": [],
      "meal.avoid_cuisines": [],
      "meal.price_band": "under_20",
    },
  },
  {
    userId: "00000000-0000-4000-8000-000000000002",
    externalId: "+15550001002",
    displayName: "Blake",
    verified: true,
    private: {
      "meal.max_price_per_person_minor": 1500,
      "meal.required_tags": ["vegetarian_friendly"],
      "meal.avoid_cuisines": [],
      "meal.price_band": "under_15",
    },
  },
  {
    userId: "00000000-0000-4000-8000-000000000003",
    externalId: "+15550001003",
    displayName: "Casey",
    verified: true,
    private: {
      "meal.max_price_per_person_minor": 1800,
      "meal.required_tags": [],
      "meal.avoid_cuisines": ["mexican"],
      "meal.price_band": "under_20",
    },
  },
  {
    userId: "00000000-0000-4000-8000-000000000004",
    externalId: "+15550001004",
    displayName: "Devon",
    verified: false,
    private: {},
  },
];

export const demoGroupProviderId = "fixture-group-id-abc123";
