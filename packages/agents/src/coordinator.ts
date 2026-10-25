import {
  type Coordinator,
  type CoordinatorDecision,
  EvaluateOptionsAnswerSchema,
  type MealOption,
  type OptionVerdicts,
  PRICE_BAND_CEILING_MINOR,
  PriceBandSchema,
} from "@campus/contracts";

// Deterministic coordinator (spec 4.6; open decision 16.6 default):
//   1. hard-constraint filter (group budget; every responding agent must accept),
//   2. rank by (acceptance count desc, price asc, distance asc, id asc),
//   3. counteroffers if nothing is feasible,
//   4. hand the decision to humans (confirm), spending approval separate.

export const TIMEOUT_REASON = "timeout";

function compare(
  a: { option: MealOption; acceptCount: number },
  b: { option: MealOption; acceptCount: number },
): number {
  return (
    b.acceptCount - a.acceptCount ||
    a.option.pricePerPersonMinor - b.option.pricePerPersonMinor ||
    (a.option.distanceMeters ?? Number.POSITIVE_INFINITY) -
      (b.option.distanceMeters ?? Number.POSITIVE_INFINITY) ||
    (a.option.id < b.option.id ? -1 : a.option.id > b.option.id ? 1 : 0)
  );
}

export class DeterministicCoordinator implements Coordinator {
  decide(input: {
    options: MealOption[];
    verdicts: OptionVerdicts;
    groupBudgetPerPersonMinor: number | null;
  }): CoordinatorDecision {
    const budget = input.groupBudgetPerPersonMinor;
    const options = input.options.filter((o) => budget === null || o.pricePerPersonMinor <= budget);
    if (options.length === 0) return { kind: "no_options" };

    const accepted = new Map<string, Set<string>>(); // agentId → accepted option ids
    const pending: string[] = [];
    for (const { agentId, response } of input.verdicts) {
      if (
        (response.status === "accepted" || response.status === "rejected") &&
        response.reasonCode !== TIMEOUT_REASON
      ) {
        const parsed = EvaluateOptionsAnswerSchema.safeParse(response.payload);
        if (parsed.success) {
          accepted.set(agentId, new Set(parsed.data.acceptedOptionIds));
          continue;
        }
      }
      pending.push(agentId);
    }

    const respondents = accepted.size;
    const ranked = options
      .map((option) => ({
        option,
        acceptCount: [...accepted.values()].filter((s) => s.has(option.id)).length,
      }))
      .sort(compare);
    const ranking = ranked.map((r) => ({ optionId: r.option.id, acceptCount: r.acceptCount }));

    const best = ranked.find((r) => respondents > 0 && r.acceptCount === respondents);
    if (best)
      return {
        kind: "propose",
        option: best.option,
        acceptCount: best.acceptCount,
        respondents,
        pending,
        ranking,
      };

    const partial =
      ranked[0] && ranked[0].acceptCount > 0
        ? { option: ranked[0].option, acceptCount: ranked[0].acceptCount }
        : null;
    return { kind: "counteroffer_needed", bestPartial: partial, respondents, pending };
  }

  /** Keep options under the tightest coarse price band any counteroffer shared. */
  applyCounteroffers(options: MealOption[], counteroffers: OptionVerdicts): MealOption[] {
    const ceiling = counterofferCeiling(counteroffers);
    return ceiling === null ? options : options.filter((o) => o.pricePerPersonMinor <= ceiling);
  }
}

/** Tightest price ceiling (minor units) from counteroffer price bands, or null if none was shared. */
export function counterofferCeiling(counteroffers: OptionVerdicts): number | null {
  let ceiling: number | null = null;
  for (const { response } of counteroffers) {
    if (response.status !== "counteroffer") continue;
    const band = PriceBandSchema.safeParse(response.payload["meal.price_band"]);
    if (!band.success) continue;
    const c = PRICE_BAND_CEILING_MINOR[band.data];
    if (c !== null) ceiling = ceiling === null ? c : Math.min(ceiling, c);
  }
  return ceiling;
}
