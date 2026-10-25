import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** URL-safe random token (256 bits by default). Only its hash is ever stored. */
export const newToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// No 0/O/1/I/L: the code is read off a screen and typed into Messages.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Short human-typeable code for the line-code verification fallback. */
export function newHumanCode(length = 6): string {
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

// iMessage handles are phone numbers (E.164) or Apple ID emails. Identical to @campus/messaging's
// normalizeAddress (packages may not import each other); both must agree so one person = one identity.
const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalize user-typed input to an iMessage address. Bare 10-digit numbers (and 11 digits starting
 * with 1) are treated as North American (+1); other countries need a leading +. Emails are lowercased.
 */
export function normalizeAddress(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.includes("@")) {
    const email = trimmed.toLowerCase();
    return EMAIL.test(email) && email.length <= 254 ? email : null;
  }
  const digits = trimmed.replace(/\D/g, "");
  let candidate: string;
  if (trimmed.startsWith("+")) candidate = `+${digits}`;
  else if (digits.length === 10) candidate = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) candidate = `+${digits}`;
  else return null;
  return E164.test(candidate) ? candidate : null;
}

/** Postgres drivers return Date for timestamptz; normalize. */
export const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
