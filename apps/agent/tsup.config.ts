import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['cjs'],
  target: 'node22',
  sourcemap: true,
  clean: true,
  noExternal: ['@ark-control/common'],
});
