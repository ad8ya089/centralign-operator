import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorResponseSchema, HealthResponseSchema } from '@centralign/shared';
import { createApp } from '../src/app.js';
import { parseEnvironment } from '../src/config/env.js';
import { closeDatabase } from '../src/persistence/database.js';
import { testDatabase } from './helpers.js';

describe('health HTTP API', () => {
  let fixture: ReturnType<typeof testDatabase>;
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    fixture = testDatabase();
    app = createApp({ config: parseEnvironment({ NODE_ENV: 'test', DATABASE_PATH: fixture.path }), database: fixture.db, logging: false });
  });
  afterEach(async () => { await app.close(); fixture.cleanup(); });

  it('checks real SQLite connectivity and responds with the canonical schema', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(HealthResponseSchema.parse(response.json())).toMatchObject({ status: 'healthy', database: 'connected', service: 'centralign-operator' });
  });

  it('returns 503 and a consistent degraded response for an unavailable database', async () => {
    closeDatabase(fixture.db);
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(503);
    expect(HealthResponseSchema.parse(response.json())).toMatchObject({ status: 'degraded', database: 'unavailable' });
    expect(response.body).not.toContain(fixture.path);
  });

  it('returns a structured 404 without implementing future execution routes', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/runs' });
    expect(response.statusCode).toBe(404);
    expect(ErrorResponseSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });

  it('closes its database connection on application shutdown', async () => {
    await app.ready();
    await app.close();
    expect(fixture.db.open).toBe(false);
  });
});
