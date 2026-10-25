// Secret redaction for logs, audit detail, prompts and tool results (spec 0.6, 6.4, 12).
//
// Two layers:
//  1. key-based: values under secret-looking keys are replaced wholesale;
//  2. value-based: any registered secret value (from config) and common token shapes are scrubbed
//     from every string, wherever it appears.

export const REDACTED = "[REDACTED]";

const SECRET_KEY_PATTERN =
  /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|signature|otp|^code$|verifier|ciphertext)/i;

const TOKEN_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

const registeredSecrets = new Set<string>();

/** Register secret values (e.g. every configured API key) so they are scrubbed from any string. */
export function registerSecretValues(values: Iterable<string | undefined | null>): void {
  for (const v of values) {
    if (typeof v === "string" && v.length >= 6) registeredSecrets.add(v);
  }
}

export function clearRegisteredSecretsForTests(): void {
  registeredSecrets.clear();
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function redactString(input: string): string {
  let out = input;
  for (const secret of registeredSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/** Deep-redact any JSON-like value. Cycles and very deep structures are cut off. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 12) return "[TRUNCATED]" as T;
  if (typeof value === "string") return redactString(value) as T;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) } as T;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Numbers/booleans under secret-looking keys (e.g. `inputTokens: 120`) are not secrets.
    const secretShaped = typeof v === "string" || (typeof v === "object" && v !== null);
    out[k] = isSecretKey(k) && secretShaped ? REDACTED : redact(v, depth + 1);
  }
  return out as T;
}

/** True if `text` contains any registered secret value. Used as a last-line check before prompts leave. */
export function containsRegisteredSecret(text: string): boolean {
  for (const secret of registeredSecrets) if (text.includes(secret)) return true;
  return false;
}
