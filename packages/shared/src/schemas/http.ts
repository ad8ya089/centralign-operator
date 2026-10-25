import { z } from 'zod';
import { JsonObjectSchema, UtcTimestampSchema } from './primitives.js';

const commonHealth = { service: z.literal('centralign-operator'), timestamp: UtcTimestampSchema };
export const HealthResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...commonHealth, status: z.literal('healthy'), database: z.literal('connected') }),
  z.strictObject({ ...commonHealth, status: z.literal('degraded'), database: z.literal('unavailable') }),
]);
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(['VALIDATION_ERROR', 'NOT_FOUND', 'INTERNAL_ERROR', 'DEPENDENCY_UNAVAILABLE', 'CONFIGURATION_ERROR', 'CONFLICT']),
    message: z.string().min(1),
    requestId: z.string().min(1),
    details: JsonObjectSchema.nullable(),
  }),
  timestamp: UtcTimestampSchema,
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
