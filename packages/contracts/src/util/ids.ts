import { createHash, randomUUID } from "node:crypto";

export const newId = (): string => randomUUID();

export const sha256Hex = (input: string): string => createHash("sha256").update(input).digest("hex");

/** Deterministic JSON (sorted keys) for hashing proposals/args. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export const hashOf = (value: unknown): string => sha256Hex(stableStringify(value));

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(
  start: Date | string,
): Clock & { advance(ms: number): void; set(d: Date | string): void } {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance: (ms) => {
      t += ms;
    },
    set: (d) => {
      t = new Date(d).getTime();
    },
  };
}
