import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@common': fileURLToPath(new URL('./common/src', import.meta.url)),
      '@/files': fileURLToPath(new URL('./apps/agent/src/files/index.ts', import.meta.url)),
      '@/runtime': fileURLToPath(new URL('./apps/agent/src/runtime', import.meta.url)),
      '@/client': fileURLToPath(new URL('./apps/agent/src/client/index.ts', import.meta.url)),
      '@/program': fileURLToPath(new URL('./apps/agent/src/program/index.ts', import.meta.url)),
      '@/rcon': fileURLToPath(new URL('./apps/agent/src/rcon/index.ts', import.meta.url)),
      '@/privacy': fileURLToPath(new URL('./apps/agent/src/privacy/index.ts', import.meta.url)),
      '@/backups': fileURLToPath(new URL('./apps/agent/src/backups/index.ts', import.meta.url)),
      '@/server-plugins': fileURLToPath(
        new URL('./apps/agent/src/server-plugins/index.ts', import.meta.url),
      ),
      '@/management': fileURLToPath(
        new URL('./apps/agent/src/management/index.ts', import.meta.url),
      ),
      '@ark-control/common': fileURLToPath(new URL('./common/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['common/**/*.test.ts', 'apps/**/*.test.ts', 'scripts/**/*.test.mjs'],
    testTimeout: 15000,
  },
});
