import Fastify, { LogController } from 'fastify';
import type Database from 'better-sqlite3';
import { ErrorResponseSchema } from '@centralign/shared';
import type { AppConfig } from './config/env.js';
import { openDatabase, closeDatabase } from './persistence/database.js';
import { registerHealthRoute } from './api/health.js';

export interface AppOptions {
  config: AppConfig;
  /** App owns and closes an injected connection, just as it owns a newly opened one. */
  database?: Database.Database;
  logging?: boolean;
}

export function createApp({ config, database, logging = true }: AppOptions) {
  const db = database ?? openDatabase(config.DATABASE_PATH);
  try {
    const app = Fastify({
      logger: logging ? {
        level: config.LOG_LEVEL,
        redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      } : false,
      logController: new LogController({ disableRequestLogging: true }),
      requestIdHeader: false,
    });
    // Avoid recording URLs/query strings or request bodies, which may contain credentials.
    app.addHook('onResponse', async (request, reply) => {
      request.log.info({ method: request.method, route: request.routeOptions.url ?? 'unmatched', statusCode: reply.statusCode, responseTimeMs: reply.elapsedTime }, 'Request completed');
    });
    app.addHook('onClose', async () => { closeDatabase(db); });
    app.setNotFoundHandler((request, reply) => reply.code(404).send(ErrorResponseSchema.parse({
      error: { code: 'NOT_FOUND', message: 'Route not found', requestId: request.id, details: null }, timestamp: new Date().toISOString(),
    })));
    app.setErrorHandler((error, request, reply) => {
      const validationError = error instanceof Error && 'validation' in error;
      // Do not serialize arbitrary error objects, headers, paths, or configuration.
      request.log.error({ category: validationError ? 'validation' : 'internal' }, 'Request failed');
      return reply.code(validationError ? 400 : 500).send(ErrorResponseSchema.parse({
        error: { code: validationError ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR', message: validationError ? 'Request validation failed' : 'Internal server error', requestId: request.id, details: null },
        timestamp: new Date().toISOString(),
      }));
    });
    registerHealthRoute(app, db);
    return app;
  } catch (error) {
    closeDatabase(db);
    throw error;
  }
}
