import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, repositoryRoot, '');
  const port = Number(environment.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  const configuredHost = environment.HOST || '127.0.0.1';
  const host = configuredHost === '0.0.0.0' ? '127.0.0.1' : configuredHost === '::' ? '[::1]' : configuredHost.includes(':') && !configuredHost.startsWith('[') ? `[${configuredHost}]` : configuredHost;
  return {
    plugins: [react()],
    envDir: repositoryRoot,
    server: {
      host: '127.0.0.1', port: 5173, strictPort: true,
      proxy: { '/api': { target: `http://${host}:${port}` } },
    },
  };
});
