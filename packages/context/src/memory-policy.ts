import {
  type Clock,
  type ConsentService,
  type MemoryCandidate,
  type MemoryMetadata,
  type MemoryPolicy,
  type MemoryPolicyDecision,
  redactString,
} from "@campus/contracts";
import type { Directory } from "./directory";
import { NO_EXPIRY } from "./read-path";

// Write-path rules (spec 5.3/5.4). The harness proposes candidates; this decides. Deterministic.

const MAX_CONTENT = 4000;

/** Beyond contracts' redactString: payment data, codes and credentials (spec 5.3 rule 3). */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["api_key", /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g],
  ["api_key", /\bsm_[A-Za-z0-9_]{16,}\b/g],
  ["api_key", /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g],
  ["api_key", /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g],
  ["api_key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["token", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ["password", /\b(pass(?:word|code)?|pwd|pin)\s*(?:is|=|:)\s*\S+/gi],
  ["verification_code", /\b(code|otp)\s*(?:is|=|:)\s*\d{4,8}\b/gi],
  ["ssn", /\b\d{3}-\d{2}-\d{4}\b/g],
  ["card_security_code", /\b(cvv|cvc|security code)\s*(?:is|=|:)?\s*\d{3,4}\b/gi],
  ["bank_number", /\b(routing|account)\s*(?:number|no\.?|#)?\s*(?:is|=|:)?\s*\d{6,17}\b/gi],
];
const CARD_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function redactSecrets(text: string): { content: string; redactions: string[] } {
  const redactions: string[] = [];
  let content = redactString(text).replace(CARD_CANDIDATE, (m) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length >= 13 && luhn(digits)) {
      redactions.push("card_number");
      return "[REDACTED:card_number]";
    }
    return m;
  });
  for (const [label, pattern] of SECRET_PATTERNS) {
    content = content.replace(pattern, () => {
      redactions.push(label);
      return `[REDACTED:${label}]`;
    });
  }
  return { content, redactions };
}

/**
 * Health, finances, relationships, values: not stored unless the user enabled sensitive buckets
 * (spec 5.6). Food allergies are dietary information and stay allowed.
 */
const SENSITIVE =
  /\b(diagnos\w*|medication\w*|prescri\w*|therap(?:y|ist)\w*|depress\w*|anxiety|adhd|autis\w*|bipolar|pregnan\w*|hiv|chemo\w*|surger\w*|disorder\w*|salary|my debts?|student loans?|credit score|income|bank account|religio\w*|my (?:boyfriend|girlfriend|partner|ex)\b)/i;

/** Keys this policy sets; callers cannot override them. */
const RESERVED = ["kind", "author_user_id", "visibility", "expires_at", "ingested_by"];

export class DefaultMemoryPolicy implements MemoryPolicy {
  constructor(private readonly deps: { consent: ConsentService; directory: Directory; clock: Clock }) {}

  async evaluate(candidate: MemoryCandidate): Promise<MemoryPolicyDecision> {
    const { principal, authorUserId, write } = candidate;
    if (!(await this.deps.directory.isVerifiedUser(authorUserId)))
      return { ingest: false, reason: "author_unverified" };

    let visibility: "private" | "group";
    if (principal.kind === "user") {
      // Only the owner's own words go in their namespace — never someone else's message about them.
      if (principal.userId !== authorUserId) return { ingest: false, reason: "author_not_principal" };
      visibility = "private";
    } else {
      // Group namespaces hold confirmed decisions (spec 5.2), not chatter or members' private facts.
      if (write.kind !== "decision") return { ingest: false, reason: "group_non_decision" };
      const members = await this.deps.directory.verifiedMembers(principal.conversationId);
      if (!members.has(authorUserId)) return { ingest: false, reason: "author_not_member" };
      visibility = "group";
    }

    const text = write.content.trim();
    if (!text) return { ingest: false, reason: "empty" };

    let expiresAt = NO_EXPIRY;
    if (principal.kind === "user") {
      const settings = await this.deps.consent.getMemorySettings(authorUserId);
      if (!settings.rememberEnabled) return { ingest: false, reason: "remember_disabled" };
      if (!settings.allowedKinds.includes(write.kind))
        return { ingest: false, reason: `kind_not_allowed:${write.kind}` };
      if (!settings.sensitiveBucketsEnabled && SENSITIVE.test(text))
        return { ingest: false, reason: "sensitive_disabled" };
      if (settings.retentionDays)
        expiresAt = this.deps.clock.now().getTime() + settings.retentionDays * 24 * 60 * 60 * 1000;
    }

    const { content } = redactSecrets(text.slice(0, MAX_CONTENT));
    const metadata: MemoryMetadata = {};
    for (const [k, v] of Object.entries(write.metadata)) if (!RESERVED.includes(k)) metadata[k] = v;
    Object.assign(metadata, {
      kind: write.kind,
      author_user_id: authorUserId,
      visibility,
      expires_at: expiresAt,
      ingested_by: "p3_memory_policy",
    });
    return { ingest: true, write: { ...write, content, metadata } };
  }
}
