import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchHealth } from './api.js';

const base = { service: 'centralign-operator', timestamp: '2026-10-25T10:00:00.000Z' };
afterEach(() => { vi.unstubAllGlobals(); });
describe('frontend health client', () => {
  it.each([
    { status: 200, body: { ...base, status: 'healthy', database: 'connected' } },
    { status: 503, body: { ...base, status: 'degraded', database: 'unavailable' } },
  ])('accepts a validated HTTP $status response', async ({ status, body }) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchHealth()).toEqual(body);
    expect(fetch).toHaveBeenCalledWith('/api/v1/health', expect.objectContaining({ cache: 'no-store' }));
  });
  it('rejects invalid or inconsistent health responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"status":"healthy"}')));
    await expect(fetchHealth()).rejects.toThrow('invalid health response');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...base, status: 'healthy', database: 'connected' }), { status: 503 })));
    await expect(fetchHealth()).rejects.toThrow('inconsistent health response');
  });
  it('propagates network failure and performs a fresh request on retry', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Network failed')).mockResolvedValueOnce(new Response(JSON.stringify({ ...base, status: 'healthy', database: 'connected' })));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchHealth()).rejects.toThrow('Network failed');
    expect((await fetchHealth()).status).toBe('healthy');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('reports unexpected HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Bad gateway', { status: 502 })));
    await expect(fetchHealth()).rejects.toThrow('HTTP 502');
  });
});
