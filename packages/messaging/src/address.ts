// iMessage handle addresses: a phone number (E.164) or an Apple ID email. Normalized the same way
// everywhere (the identity package has an identical copy) so one person maps to one identity row.

const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
