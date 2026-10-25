import type { MemoryCandidate, MemoryKind } from "@campus/contracts";

// Deterministic "is this memory-worthy?" rules (spec 5.3 item 1). The MemoryPolicy (P3) then applies
// consent settings; Supermemory never sees anything the policy rejects.

const PREFERENCE =
  /\b(i\s+(really\s+)?(like|love|hate|prefer|can'?t\s+eat|don'?t\s+eat|avoid|am\s+(vegetarian|vegan|allergic))|my\s+(budget|favorite|favourite|go-to)|i'?m\s+(vegetarian|vegan|allergic|gluten))/i;
const FACT = /\b(i\s+(am|have|study|major|live|work)|i'?m\s+(a|in|taking|studying))\b/i;
const SECRETISH = /\b(password|passcode|pin|ssn|social security|card number|cvv|routing number|api key)\b/i;

export function classifyMessageKind(text: string): MemoryKind {
  if (PREFERENCE.test(text)) return "preference";
  if (FACT.test(text)) return "fact";
  return "conversation";
}

/** Candidate from a verified user's own 1:1 message. Returns null for content we never remember. */
export function dmMemoryCandidate(input: {
  userId: string;
  conversationId: string;
  text: string;
  platform: string;
}): MemoryCandidate | null {
  const text = input.text.trim();
  if (text.length < 8 || SECRETISH.test(text)) return null;
  const kind = classifyMessageKind(text);
  return {
    principal: { kind: "user", userId: input.userId },
    authorUserId: input.userId,
    write: {
      content: text,
      kind,
      // Stable document id per conversation so new information appends (spec 5.2).
      customId: `conv_${input.conversationId}`,
      metadata: {
        source: input.platform === "imessage" ? "imessage" : input.platform,
        conversation_id: input.conversationId,
        kind,
        visibility: "private",
        author_user_id: input.userId,
        ingested_by: "harness",
      },
    },
  };
}
