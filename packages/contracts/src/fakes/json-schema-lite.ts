// Tiny JSON-Schema subset validator used by the fake gateway: type, properties, required,
// additionalProperties:false, enum, minimum. P4's real gateway should use a full validator.

type Schema = Record<string, unknown>;

export function validateArgs(schema: Schema, value: unknown, path = "args"): string[] {
  const errors: string[] = [];
  const type = schema.type as string | undefined;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path} must be an object`];
    const obj = value as Record<string, unknown>;
    const props = (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!(req in obj)) errors.push(`${path}.${req} is required`);
    }
    for (const [k, v] of Object.entries(obj)) {
      const sub = props[k];
      if (!sub) {
        if (schema.additionalProperties === false) errors.push(`${path}.${k} is not allowed`);
        continue;
      }
      errors.push(...validateArgs(sub, v, `${path}.${k}`));
    }
    return errors;
  }
  if (type === "string" && typeof value !== "string") errors.push(`${path} must be a string`);
  if (type === "integer" && !(typeof value === "number" && Number.isInteger(value)))
    errors.push(`${path} must be an integer`);
  if (type === "number" && typeof value !== "number") errors.push(`${path} must be a number`);
  if (type === "boolean" && typeof value !== "boolean") errors.push(`${path} must be a boolean`);
  if (type === "array" && !Array.isArray(value)) errors.push(`${path} must be an array`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    errors.push(`${path} must be one of ${schema.enum.join(", ")}`);
  if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum)
    errors.push(`${path} must be >= ${schema.minimum}`);
  return errors;
}
