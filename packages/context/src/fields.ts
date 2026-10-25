import {
  CONTEXT_FIELDS,
  type ContextFieldName,
  type ContextPurpose,
  PRICE_BAND_CEILING_MINOR,
  type PriceBand,
  SHAREABLE_CONTEXT_FIELDS,
  isContextFieldName,
} from "@campus/contracts";

// Resolvers and policy for the named-field registry in @campus/contracts (schemas/context.ts).
// Every value is a projection (number, tag list, band) derived from the subject's OWN memory by
// deterministic rules; memory text never leaves. Values are validated against CONTEXT_FIELDS.

export type DataClass =
  | "finances"
  | "dietary"
  | "food_preference"
  | "budget_band"
  | "calendar_availability"
  | "connected_account_data";

export type ClassPolicy = {
  /** `task_only` = "ask for each use": standing grants are ignored even if one exists. */
  grantScope: "standing_or_task" | "task_only";
  /** May the broker raise a consent prompt (vs. deny until the user grants it in settings)? */
  promptable: boolean;
  maxGrantTtlMs: number;
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const CLASS_POLICIES: Record<DataClass, ClassPolicy> = {
  finances: { grantScope: "standing_or_task", promptable: true, maxGrantTtlMs: 180 * DAY },
  dietary: { grantScope: "standing_or_task", promptable: true, maxGrantTtlMs: 180 * DAY },
  food_preference: { grantScope: "standing_or_task", promptable: true, maxGrantTtlMs: 180 * DAY },
  budget_band: { grantScope: "standing_or_task", promptable: true, maxGrantTtlMs: 180 * DAY },
  calendar_availability: { grantScope: "standing_or_task", promptable: true, maxGrantTtlMs: 90 * DAY },
  // A user's tool result (e.g. Canvas grades) shown in a group (spec 6.5 step 10).
  connected_account_data: { grantScope: "standing_or_task", promptable: true, maxGrantTtlMs: 30 * DAY },
};

const FIELD_CLASS: Record<ContextFieldName, DataClass> = {
  "meal.max_price_per_person_minor": "finances",
  "meal.required_tags": "dietary",
  "meal.avoid_cuisines": "food_preference",
  "meal.price_band": "budget_band",
  "availability.free_slots": "calendar_availability",
};

/** `tool:<server>__<tool>` — data class for a tool result from the subject's own connection. */
const TOOL_CLASS = /^tool:[a-z][a-z0-9_-]{0,40}__[a-z][a-z0-9_-]{0,60}$/;

export type DataClassInfo = {
  name: string;
  dataClass: DataClass;
  shareable: boolean;
  field: ContextFieldName | null;
};

/** Registry fields and `tool:*` classes; anything else is unknown (denied). */
export function classify(name: string): DataClassInfo | null {
  if (isContextFieldName(name)) {
    return {
      name,
      dataClass: FIELD_CLASS[name],
      shareable: SHAREABLE_CONTEXT_FIELDS.includes(name),
      field: name,
    };
  }
  if (TOOL_CLASS.test(name))
    return { name, dataClass: "connected_account_data", shareable: true, field: null };
  return null;
}

export const PURPOSE_TEXT: Record<ContextPurpose, string> = {
  group_meal: "planning a group meal",
  campus_match: "matching you with someone on campus",
  scheduling: "scheduling",
  other: "a group conversation",
};

export const FIELD_TEXT: Record<ContextFieldName, string> = {
  "meal.max_price_per_person_minor": "your exact per-meal budget (used privately by your own assistant)",
  "meal.required_tags": "your dietary requirements (used privately by your own assistant)",
  "meal.avoid_cuisines": "cuisines you avoid (used privately by your own assistant)",
  "meal.price_band": 'a rough price range, like "under $20"',
  "availability.free_slots": "when you're free (times only, no event details)",
};

// ---------------------------------------------------------------------------------------------
// Deterministic extraction over untrusted evidence (the subject's own memories)
// ---------------------------------------------------------------------------------------------

/** Sentences about other people ("my roommate is vegan") must not be attributed to the subject. */
const OTHER_PERSON =
  /\b(friend|roommate|mom|mother|dad|father|sister|brother|partner|boyfriend|girlfriend|wife|husband|cousin|classmate|teammate|they|he|she)\b/i;

function selfSentences(evidence: string[]): string[] {
  return evidence
    .flatMap((e) => e.split(/(?<=[.!?\n])\s+/))
    .map((s) => s.trim())
    .filter((s) => s && !OTHER_PERSON.test(s));
}

/** Diet → the option tags the dining connector uses (see contracts fixtures/tools.ts). */
const DIET_RULES: Array<[string, RegExp]> = [
  ["vegan_options", /\bvegan\b|\bno animal products\b/i],
  [
    "vegetarian_friendly",
    /\bvegetarian\b|\bvegan\b|\b(?:never|don'?t|do not|doesn'?t|does not|won'?t|can'?t) eats? (?:any )?meat\b/i,
  ],
  ["pescatarian_friendly", /\bpescatarian\b/i],
  ["halal", /\bhalal\b/i],
  ["kosher", /\bkosher\b/i],
  ["gluten_free", /\bgluten[- ]free\b|\bceliac\b|\bno gluten\b|\bgluten intoleran/i],
  [
    "dairy_free",
    /\bdairy[- ]free\b|\blactose[- ]intoleran|\bno dairy\b|\b(?:avoids?|don'?t eat|never eats?) dairy\b/i,
  ],
  ["nut_free", /\b(?:tree )?(?:pea)?nut allerg|\ballergic to (?:tree |pea)?nuts\b|\bnut[- ]free\b/i],
  ["shellfish_free", /\bshellfish allerg|\ballergic to shellfish\b/i],
];
const NO_RESTRICTIONS = /\b(?:no dietary restrictions|(?:i )?eats? (?:pretty much )?anything)\b/i;

export function requiredTagsFromEvidence(evidence: string[]): string[] | null {
  const sentences = selfSentences(evidence);
  const tags = new Set<string>();
  for (const s of sentences) for (const [tag, re] of DIET_RULES) if (re.test(s)) tags.add(tag);
  if (tags.size) return [...tags].sort();
  return sentences.some((s) => NO_RESTRICTIONS.test(s)) ? [] : null;
}

const BUDGET =
  /(?:under|below|less than|at most|max(?:imum)?|up to|no more than|budget(?: is| of)?|keep (?:it|dinner|lunch|meals?)(?: cost)? (?:under|below))\s*\$\s?(\d{1,4}(?:\.\d{1,2})?)|\$\s?(\d{1,4}(?:\.\d{1,2})?)\s*(?:max|budget|or less|tops)/i;

export function maxPriceFromEvidence(evidence: string[]): number | null {
  let best: number | null = null;
  for (const s of selfSentences(evidence)) {
    const m = BUDGET.exec(s);
    const raw = m?.[1] ?? m?.[2];
    if (!raw) continue;
    const minor = Math.round(Number(raw) * 100);
    best = best === null ? minor : Math.min(best, minor); // conservative: the tightest stated limit
  }
  return best;
}

/** Coarse band for a ceiling: the smallest band whose ceiling covers it. */
export function priceBandFor(maxMinor: number): PriceBand {
  const bands = (Object.entries(PRICE_BAND_CEILING_MINOR) as Array<[PriceBand, number | null]>)
    .filter(([, c]) => c !== null)
    .sort((a, b) => a[1]! - b[1]!);
  return bands.find(([, c]) => maxMinor <= c!)?.[0] ?? "any";
}

const CUISINES = [
  "thai",
  "indian",
  "mexican",
  "italian",
  "chinese",
  "japanese",
  "korean",
  "vietnamese",
  "mediterranean",
  "ethiopian",
  "greek",
  "lebanese",
  "american",
  "french",
  "spanish",
  "caribbean",
  "middle eastern",
];
const AVOID =
  /\b(hate|hates|dislike|dislikes|don'?t like|do not like|can'?t stand|avoid|avoids|not a fan of|don'?t eat|never eat|no more)\b/i;

export function avoidCuisinesFromEvidence(evidence: string[]): string[] | null {
  const found = new Set<string>();
  let sawFood = false;
  for (const s of selfSentences(evidence)) {
    const mentioned = CUISINES.filter((c) => new RegExp(`\\b${c}\\b`, "i").test(s));
    if (mentioned.length) sawFood = true;
    if (AVOID.test(s)) for (const c of mentioned) found.add(c);
  }
  if (found.size) return [...found].sort();
  return sawFood ? [] : null;
}

export type Resolution = { value: unknown; source: "memory" | "seeded" | "none" };

export type FieldResolver = {
  /** Profile buckets and a search query that gather evidence for this field. */
  buckets: string[];
  query: string;
  fromEvidence(evidence: string[]): unknown;
};

export const RESOLVERS: Record<ContextFieldName, FieldResolver | null> = {
  "meal.max_price_per_person_minor": {
    buckets: ["budget"],
    query: "the user's spending limit or budget for meals",
    fromEvidence: maxPriceFromEvidence,
  },
  "meal.required_tags": {
    buckets: ["food_preferences"],
    query: "dietary restrictions, foods the user never eats, food allergies",
    fromEvidence: requiredTagsFromEvidence,
  },
  "meal.avoid_cuisines": {
    buckets: ["food_preferences"],
    query: "cuisines or foods the user dislikes or avoids",
    fromEvidence: avoidCuisinesFromEvidence,
  },
  "meal.price_band": {
    buckets: ["budget"],
    query: "the user's spending limit or budget for meals",
    fromEvidence: (evidence) => {
      const max = maxPriceFromEvidence(evidence);
      return max === null ? null : priceBandFor(max);
    },
  },
  // Needs a calendar connector (P4); never derived from memory.
  "availability.free_slots": null,
};

/** True if `value` fits the registry schema for `field`. */
export function validValue(field: ContextFieldName, value: unknown): boolean {
  return value !== null && value !== undefined && CONTEXT_FIELDS[field].safeParse(value).success;
}
