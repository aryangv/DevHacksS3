import { z } from "zod";

/** "true"/"1"/"yes" → true; anything else (incl. unset) → false. */
export const flag = () =>
  z
    .string()
    .optional()
    .transform((v) => ["true", "1", "yes"].includes((v ?? "").trim().toLowerCase()));

/** Defaults to true unless explicitly "false"/"0"/"no". */
export const flagDefaultOn = () =>
  z
    .string()
    .optional()
    .transform((v) => v === undefined || !["false", "0", "no"].includes(v.trim().toLowerCase()));

export const int = (def: number) => z.coerce.number().int().nonnegative().default(def);

export const optionalString = () =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? undefined : v));

/**
 * One owner's config section. `schema` parses raw env; `required` returns env names that are missing
 * given the parsed values (e.g. a key required only when its USE_REAL_* flag is on); `secrets` names env
 * vars whose values are registered for redaction.
 */
export type ConfigSection<S extends z.ZodObject> = {
  owner: "P1" | "P2" | "P3" | "P4";
  schema: S;
  required: (cfg: z.infer<S>, all: Record<string, unknown>) => string[];
  secrets: string[];
};

export const missingIf = (cond: boolean, cfg: Record<string, unknown>, names: string[]): string[] =>
  cond ? names.filter((n) => cfg[n] === undefined || cfg[n] === "") : [];
