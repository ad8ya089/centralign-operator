import { HealthResponseSchema } from '@centralign/shared';
import type { HealthResponse } from '@centralign/shared';

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const timeout = AbortSignal.timeout(8_000);
  const response = await fetch('/api/v1/health', {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok && response.status !== 503) throw new Error(`Health request failed (HTTP ${response.status}).`);
  const body: unknown = await response.json();
  const parsed = HealthResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error('The service returned an invalid health response.');
  if ((response.status === 503) !== (parsed.data.status === 'degraded')) throw new Error('The service returned an inconsistent health response.');
  return parsed.data;
}
