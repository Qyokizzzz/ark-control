import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

// Vite bundles this file into a temporary module for `vite dev`, so import.meta.url
// cannot reliably identify the original config directory there.
const workspaceRoot = (() => {
  const current = process.cwd();
  return existsSync(resolve(current, 'pnpm-workspace.yaml')) ? current : resolve(current, '../..');
})();

function apiProxyTarget(env: Record<string, string | undefined>) {
  const configuredHost = env.API_HOST?.trim() || '127.0.0.1';
  const port = Number(env.API_PORT?.trim() || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('API_PORT 必须是 1 到 65535 之间的端口号。');
  const host = ['0.0.0.0', '::'].includes(configuredHost) ? '127.0.0.1' : configuredHost;
  const escapedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${escapedHost}:${port}`;
}

function pagesApiOrigin(value: string | undefined) {
  const url = URL.parse(value?.trim() ?? '');
  if (
    url?.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.href !== `${url.origin}/`
  )
    throw new Error(
      '请将 VITE_API_ORIGIN 设为管理 API 的 HTTPS 来源，例如 https://api.example.com。',
    );
  return url.origin;
}

export default defineConfig(({ mode }) => {
  const pages = mode === 'github-pages';
  const envName = mode === 'development' || mode === 'dev' ? '.env.dev' : '.env.prod';
  const envFile =
    process.env.ARK_ENV_FILE ??
    [resolve(workspaceRoot, envName), resolve(workspaceRoot, '.env')].find(existsSync);
  const env = { ...(envFile ? parseEnv(readFileSync(envFile, 'utf8')) : {}), ...process.env };
  const publicEnv = Object.fromEntries(
    Object.entries(env)
      .filter(([key, value]) => /^VITE_[A-Za-z0-9_]+$/.test(key) && value !== undefined)
      .map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]),
  );
  return {
    base: pages ? './' : '/',
    envDir: false,
    define: {
      ...publicEnv,
      'import.meta.env.VITE_API_ORIGIN': JSON.stringify(
        pages ? pagesApiOrigin(env.VITE_API_ORIGIN) : '',
      ),
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@common': fileURLToPath(new URL('../../common/src', import.meta.url)),
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: { port: 5173, proxy: { '/api': { target: apiProxyTarget(env), changeOrigin: true } } },
    build: {
      sourcemap: !pages,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('/node_modules/')) return;
            if (/\/node_modules\/(react|react-dom|scheduler|react-is)\//.test(id)) return 'react';
            if (/\/node_modules\/(@mui|@emotion|@popperjs)\//.test(id)) return 'mui';
            if (id.includes('/node_modules/zod/')) return 'validation';
            if (id.includes('/node_modules/@phosphor-icons/')) return 'icons';
            return 'vendor';
          },
        },
      },
    },
  };
});
