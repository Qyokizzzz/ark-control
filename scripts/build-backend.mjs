import { build } from 'tsup';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [target, mode] = process.argv.slice(2);
if (!['api', 'agent'].includes(target)) throw new Error('Expected api or agent');
const directory = resolve(root, 'apps', target);
const rconFixture = target === 'agent' && mode === '--rcon-fixture';
async function sourceFile(path) {
  for (const candidate of [
    path,
    `${path}.ts`,
    `${path}.tsx`,
    `${path}.js`,
    resolve(path, 'index.ts'),
    resolve(path, 'index.tsx'),
  ]) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      /* Try a supported source extension. */
    }
  }
  throw new Error(`Source module not found: ${path}`);
}
// Resolve only our own source files through Node. This also supports restricted
// Windows directory traversal; npm and Node built-ins remain normal externals.
const workspaceSources = {
  name: 'workspace-sources',
  setup(builder) {
    builder.onResolve({ filter: /.*/ }, async (args) => {
      let path;
      if (args.path === '@ark-control/common') path = resolve(root, 'common/src/index.ts');
      else if (args.path.startsWith('@common/'))
        path = resolve(root, 'common/src', args.path.slice(8));
      else if (args.path.startsWith('@/')) path = resolve(directory, 'src', args.path.slice(2));
      else if (args.kind === 'entry-point') path = resolve(directory, args.path);
      else if (args.path.startsWith('.') || isAbsolute(args.path))
        path = resolve(args.importer ? dirname(args.importer) : directory, args.path);
      else return { path: args.path, external: true };
      if (!path.startsWith(root + (process.platform === 'win32' ? '\\' : '/')))
        throw new Error('Source path leaves the workspace');
      return { path: await sourceFile(path), namespace: 'ark-source' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'ark-source' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: extname(args.path) === '.tsx' ? 'tsx' : 'ts',
      resolveDir: dirname(args.path),
    }));
  },
};
await build({
  config: false,
  entry: {
    main: rconFixture
      ? resolve(root, 'tests/fixtures/rcon-launch-check.ts')
      : resolve(directory, 'src/main.ts'),
  },
  outDir: resolve(directory, rconFixture ? '.data/rcon-launch-built' : 'dist'),
  format: [rconFixture ? 'esm' : 'cjs'],
  outExtension: () => ({ js: rconFixture ? '.mjs' : '.js' }),
  target: 'node22',
  sourcemap: true,
  clean: true,
  noExternal: ['@ark-control/common'],
  esbuildPlugins: [workspaceSources],
  esbuildOptions(options) {
    delete options.tsconfig;
    options.tsconfigRaw = { compilerOptions: { experimentalDecorators: true } };
  },
});
