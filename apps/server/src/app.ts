import Fastify, { LogController } from 'fastify';
import type Database from 'better-sqlite3';
import { ErrorResponseSchema } from '@centralign/shared';
import type { AppConfig } from './config/env.js';
import { openDatabase, closeDatabase } from './persistence/database.js';
import { registerHealthRoute } from './api/health.js';
import { registerRunRoutes } from './api/runs.js';
import { registerArtifactRoute } from './api/artifact-content.js';
import { registerLocalBoundary } from './api/local-boundary.js';
import { RunService } from './agent/run-service.js';
import type { RunServiceOptions } from './agent/run-service.js';
import { AgentFault } from './agent/contracts.js';
import { z } from 'zod';

export interface AppOptions {
  config: AppConfig;
  /** App owns and closes an injected connection, just as it owns a newly opened one. */
  database?: Database.Database;
  logging?: boolean;
  agent?: RunServiceOptions;
}

export function createApp({ config, database, logging = true, agent }: AppOptions) {
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
    const runs = new RunService(db, config, agent);
    registerLocalBoundary(app);
    app.decorate('runService', runs);
    app.addHook('onReady', async () => { if (db.open) await runs.recover(); });
    // Avoid recording URLs/query strings or request bodies, which may contain credentials.
    app.addHook('onResponse', async (request, reply) => {
      request.log.info({ method: request.method, route: request.routeOptions.url ?? 'unmatched', statusCode: reply.statusCode, responseTimeMs: reply.elapsedTime }, 'Request completed');
    });
    app.addHook('onClose', async () => { await runs.close(); closeDatabase(db); });
    app.setNotFoundHandler((request, reply) => reply.code(404).send(ErrorResponseSchema.parse({
      error: { code: 'NOT_FOUND', message: 'Route not found', requestId: request.id, details: null }, timestamp: new Date().toISOString(),
    })));
    app.setErrorHandler((error, request, reply) => {
      const validationError = error instanceof z.ZodError || error instanceof Error && 'validation' in error;
      const agentError = error instanceof AgentFault ? error : null;
      const knownNotFound = agentError && ['RUN_NOT_FOUND', 'APPROVAL_NOT_FOUND', 'ARTIFACT_NOT_FOUND'].includes(agentError.code);
      const nativeStatus = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : null;
      const status = knownNotFound ? 404 : agentError?.category === 'CONFIGURATION' ? 503 : agentError?.category === 'CONFLICT' ? 409 : validationError || agentError?.category === 'VALIDATION' ? 400 : nativeStatus ?? 500;
      const code = status === 404 ? 'NOT_FOUND' : status === 503 ? 'CONFIGURATION_ERROR' : status === 409 ? 'CONFLICT' : status < 500 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR';
      // Do not serialize arbitrary error objects, headers, paths, or configuration.
      request.log.error({ category: validationError ? 'validation' : 'internal' }, 'Request failed');
      return reply.code(status).send(ErrorResponseSchema.parse({
        error: { code, message: agentError && status < 500 || agentError?.category === 'CONFIGURATION' ? agentError!.message : status < 500 ? 'Request validation failed' : 'Internal server error', requestId: request.id, details: null },
        timestamp: new Date().toISOString(),
      }));
    });
    registerHealthRoute(app, db);
    registerRunRoutes(app, runs);
    registerArtifactRoute(app, db, config.ARTIFACT_WORKSPACE_PATH);
    return app;
  } catch (error) {
    closeDatabase(db);
    throw error;
  }
}
