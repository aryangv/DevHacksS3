import type { InboundMessage } from "@campus/contracts";

// Routing + invocation rules (spec 4.2 step 6, 4.5). Deterministic, no model involved.

export type ProactiveRule = {
  id: string;
  /** Only rules the group explicitly enabled are passed in. */
  matches(message: InboundMessage): boolean;
};

export type RouteDecision =
  | { target: "personal"; addressed: true; reason: "dm" }
  | { target: "group"; addressed: true; reason: "mention" | "proactive_rule"; ruleId?: string; text: string }
  | { target: "none"; addressed: false; reason: "not_addressed" | "empty" };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A group message addresses the agent when it starts with an invocation name ("agent, …", "@agent …")
 * or contains an @-mention of one. Returns the text with the invocation stripped.
 */
export function detectInvocation(text: string, names: string[]): { addressed: boolean; text: string } {
  const trimmed = text.trim();
  for (const raw of names) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    const bare = name.replace(/^@/, "");
    const lead = new RegExp(`^@?${escapeRe(bare)}\\b[\\s,:;!.-]*`, "i");
    if (lead.test(trimmed)) return { addressed: true, text: trimmed.replace(lead, "").trim() || trimmed };
    const mention = new RegExp(`(^|\\s)@${escapeRe(bare)}\\b`, "i");
    if (mention.test(trimmed)) return { addressed: true, text: trimmed.replace(mention, " ").trim() };
  }
  return { addressed: false, text: trimmed };
}

export function route(
  message: InboundMessage,
  opts: { invocationNames: string[]; proactiveRules?: ProactiveRule[] },
): RouteDecision {
  if (!message.text.trim()) return { target: "none", addressed: false, reason: "empty" };
  if (!message.isGroup) return { target: "personal", addressed: true, reason: "dm" };
  const inv = detectInvocation(message.text, opts.invocationNames);
  if (inv.addressed) return { target: "group", addressed: true, reason: "mention", text: inv.text };
  const rule = opts.proactiveRules?.find((r) => r.matches(message));
  if (rule)
    return {
      target: "group",
      addressed: true,
      reason: "proactive_rule",
      ruleId: rule.id,
      text: message.text.trim(),
    };
  return { target: "none", addressed: false, reason: "not_addressed" };
}
