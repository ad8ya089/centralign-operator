import { HealthResponseSchema } from '@centralign/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkDatabase } from '../persistence/database.js';

export function registerHealthRoute(app: FastifyInstance, db: Database.Database): void {
  const jsonSchema = z.toJSONSchema(HealthResponseSchema, { target: 'draft-7' });
  app.get('/api/v1/health', { schema: { response: { 200: jsonSchema, 503: jsonSchema } } }, async (request, reply) => {
    let connected = false;
    try { connected = checkDatabase(db); }
    catch { request.log.warn({ dependency: 'sqlite' }, 'Health dependency check failed'); }
    const response = HealthResponseSchema.parse({
      service: 'centralign-operator',
      status: connected ? 'healthy' : 'degraded',
      database: connected ? 'connected' : 'unavailable',
      timestamp: new Date().toISOString(),
    });
    return reply.code(connected ? 200 : 503).header('Cache-Control', 'no-store').send(response);
  });
}
