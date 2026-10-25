import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { IdentifierSchema } from '@centralign/shared';
import type { RunService } from '../agent/run-service.js';

const RunParams = z.strictObject({ runId: IdentifierSchema.max(200) });
export function registerRunRoutes(app: FastifyInstance, service: RunService): void {
  app.post('/api/v1/runs', { bodyLimit: 16000 }, async (request, reply) => reply.code(202).send(service.create(request.body)));
  app.get('/api/v1/runs/:runId', async (request) => service.snapshot(RunParams.parse(request.params).runId));
  app.get('/api/v1/runs/:runId/events', async (request) => {
    const params = RunParams.parse(request.params); const query = z.strictObject({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    return service.events(params.runId, query.after, query.limit);
  });
  app.post('/api/v1/runs/:runId/input', { bodyLimit: 20000 }, async (request, reply) => reply.code(202).send(service.input(RunParams.parse(request.params).runId, request.body)));
  app.post('/api/v1/runs/:runId/approvals/:approvalId/decision', { bodyLimit: 4000 }, async (request, reply) => {
    const params = z.strictObject({ runId: IdentifierSchema.max(200), approvalId: IdentifierSchema.max(200) }).parse(request.params);
    const result = service.decision(params.runId, params.approvalId, request.body); return reply.code(result.repeated ? 200 : 202).send(result);
  });
  app.post('/api/v1/runs/:runId/cancel', { bodyLimit: 1000 }, async (request, reply) => { z.strictObject({}).parse(request.body ?? {}); return reply.code(202).send(service.cancel(RunParams.parse(request.params).runId)); });
}
