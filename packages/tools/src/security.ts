import { createHash, timingSafeEqual } from 'node:crypto';

export class SecurityError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export function requireThat(value: unknown, code: string): asserts value {
  if (!value) throw new SecurityError(code);
}
export function canonical(value: unknown): string {
  const seen = new Set<unknown>();
  function visit(v: unknown, depth: number): unknown {
    requireThat(depth < 40, 'invalid_json');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    requireThat(typeof v === 'object' && !seen.has(v), 'invalid_json');
    seen.add(v);
    const out = Array.isArray(v)
      ? v.map((x) => visit(x, depth + 1))
      : Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, visit(x, depth + 1)]),
        );
    seen.delete(v);
    return out;
  }
  return JSON.stringify(visit(value, 0));
}
export const hash = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');
export function equal(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function redact(value: unknown, secrets: string[] = []): unknown {
  function clean(text: string): string {
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
      for (const representation of new Set([
        secret,
        encodeURIComponent(secret),
        Buffer.from(secret).toString('base64'),
      ]))
        text = text.split(representation).join('[REDACTED]');
    }
    return text
      .replace(/(?:Bearer\s+)[^\s"<>]+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:gh[pousr]_[\w]+|github_pat_[\w]+|sk-[\w-]+)\b/g, '[REDACTED]')
      .replace(
        /((?:access_token|refresh_token|api_key|client_secret|authorization|password|code_verifier)\s*["']?\s*[:=]\s*["']?)[^\s,"'<>}]+/gi,
        '$1[REDACTED]',
      );
  }
  function visit(v: unknown, depth: number): unknown {
    if (depth > 30) return '[TRUNCATED]';
    if (typeof v === 'string') return clean(v);
    if (Array.isArray(v)) return v.slice(0, 1000).map((x) => visit(x, depth + 1));
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .slice(0, 1000)
          .map(([k, x]) => [
            clean(k),
            /token|secret|password|authorization|credential|api.?key|verifier|^code$/i.test(k)
              ? '[REDACTED]'
              : visit(x, depth + 1),
          ]),
      );
    return v;
  }
  return visit(value, 0);
}
export function safeData(value: unknown, secrets: string[], maxBytes = 16000): unknown {
  const cleaned = redact(value, secrets),
    serialized = JSON.stringify(cleaned);
  if (Buffer.byteLength(serialized ?? '') > maxBytes)
    return {
      truncated: true,
      text: Buffer.from(serialized).subarray(0, maxBytes).toString('utf8'),
    };
  return cleaned;
}
export function httpsUrl(value: string): URL {
  const url = new URL(value);
  requireThat(
    url.protocol === 'https:' && !url.username && !url.password && !url.hash,
    'unsafe_url',
  );
  return url;
}
