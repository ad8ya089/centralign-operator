import type { FastifyInstance } from 'fastify';
import { ErrorResponseSchema, isLoopbackHost } from '@centralign/shared';

function localAuthority(authority: string | undefined): boolean {
  if (!authority) return false;
  const match = /^(\[::1\]|localhost|127(?:\.\d{1,3}){3})(?::([1-9]\d{0,4}))?$/i.exec(authority);
  return !!match && isLoopbackHost(match[1]!) && (!match[2] || Number(match[2]) <= 65535);
}
function localOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true; // Non-browser local clients have no Origin header.
  try { const url = new URL(origin); return ['http:', 'https:'].includes(url.protocol) && localAuthority(url.host) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; }
  catch { return false; }
}

export function registerLocalBoundary(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    // Check the actual Host/Origin. Forwarded headers cannot extend local trust.
    if (!localAuthority(request.headers.host) || !localOrigin(request.headers.origin)) {
      return reply.code(403).send(ErrorResponseSchema.parse({ error: { code: 'FORBIDDEN', message: 'Only explicit loopback hosts and browser origins are permitted.', requestId: request.id, details: null }, timestamp: new Date().toISOString() }));
    }
  });
}
