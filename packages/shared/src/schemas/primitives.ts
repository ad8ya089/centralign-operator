import { z } from 'zod';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema),
]));
export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), JsonValueSchema);
export const IdentifierSchema = z.string().min(1).refine((value) => value.trim() === value, 'Identifiers must not have surrounding whitespace');
export const UtcTimestampSchema = z.iso.datetime();
export const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Expected a lowercase SHA-256 hash');
// Portable stored paths use forward slashes. Resolve and enforce containment again before file IO.
export const RelativePathSchema = z.string().min(1).refine((value) =>
  !/[\\:\x00]/.test(value) && !value.startsWith('/') &&
  value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
'Expected a portable workspace-relative path without traversal');

export const ExecutionErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  details: JsonObjectSchema.nullable(),
});
export type ExecutionError = z.infer<typeof ExecutionErrorSchema>;

/** Validate persisted JSON again at the boundary; JSON.parse alone does not establish a contract. */
export function parseStoredJson<T>(text: string, schema: z.ZodType<T>): T {
  const value: unknown = JSON.parse(text);
  return schema.parse(value);
}
