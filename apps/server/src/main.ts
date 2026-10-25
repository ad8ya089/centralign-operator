import { createApp } from './app.js';
import { loadConfig } from './config/env.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = createApp({ config });
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    app.log.info('Shutting down');
    try { await app.close(); }
    catch { process.exitCode = 1; }
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  try { await app.listen({ host: config.HOST, port: config.PORT }); }
  catch {
    app.log.error('Server failed to start; check configuration, port availability, and database access');
    process.exitCode = 1;
    await shutdown();
  }
}

main().catch(() => {
  // Zod errors can include input values; keep the public startup error generic.
  console.error('CentrAlign startup failed. Check .env values and database access.');
  process.exitCode = 1;
});
