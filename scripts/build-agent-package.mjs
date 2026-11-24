import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, posix, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agent = join(root, 'apps', 'agent');
const name = 'ArkHostAgent-Windows-x64.zip';
const target = resolve(process.argv[2] ?? join(root, 'artifacts', name));
const fromAgent = createRequire(join(agent, 'package.json'));
const archiver = fromAgent('archiver');
if (
  process.platform !== 'win32' ||
  process.arch !== 'x64' ||
  Number(process.versions.node.split('.')[0]) < 22
)
  throw new Error('请在安装了 Node.js 22 或以上版本的 Windows x64 电脑上构建。');
const nodeLicense = join(dirname(process.execPath), 'LICENSE');
await access(nodeLicense);

const packages = new Map();
async function locate(name, parent) {
  const require = createRequire(join(parent, 'package.json'));
  for (const candidate of require.resolve.paths(`${name}/package.json`) ?? []) {
    const path = join(candidate, ...name.split('/'));
    const manifest = await readFile(join(path, 'package.json'), 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (manifest) return { path: await realpath(path), manifest: JSON.parse(manifest) };
  }
  return null;
}
function nodeModulePaths(installedAt) {
  const paths = [];
  for (let current = installedAt; current !== '.'; current = posix.dirname(current)) {
    if (posix.basename(current) !== 'node_modules') paths.push(posix.join(current, 'node_modules'));
  }
  return paths;
}

async function collect(manifest, directory, installedAt) {
  const optional = manifest.optionalDependencies ?? {};
  const dependencies = { ...manifest.dependencies, ...optional };
  const paths = nodeModulePaths(installedAt);
  const added = [];
  for (const name of Object.keys(dependencies).sort()) {
    if (name === '@ark-control/common') continue; // Built into the Agent entry point.
    const found = await locate(name, directory);
    if (!found && Object.hasOwn(optional, name)) continue;
    if (!found) throw new Error(`主机助手缺少依赖 ${name}。`);
    const prior = paths.map((path) => packages.get(posix.join(path, name))).find(Boolean);
    if (prior?.path === found.path) continue;
    const location = posix.join(prior ? paths[0] : 'agent/node_modules', name);
    packages.set(location, found);
    added.push({ ...found, location });
  }
  for (const { manifest, path, location } of added) await collect(manifest, path, location);
}
await collect(JSON.parse(await readFile(join(agent, 'package.json'), 'utf8')), agent, 'agent');
const entry = join(agent, 'dist', 'main.js');
await access(entry);
await mkdir(dirname(target), { recursive: true });
const temporary = `${target}.${randomUUID()}.tmp`;
const stream = createWriteStream(temporary, { flags: 'wx' });
const zip = archiver('zip', { zlib: { level: 8 } });
zip.on('warning', (error) => stream.destroy(error));
zip.on('error', (error) => stream.destroy(error));
zip.pipe(stream);
try {
  zip.file(process.execPath, { name: 'runtime/node.exe' });
  zip.file(nodeLicense, { name: 'runtime/LICENSE.txt' });
  zip.file(entry, { name: 'agent/main.cjs' });
  for (const [location, { path }] of packages) {
    zip.glob(
      '**/*',
      { cwd: path, dot: true, ignore: ['node_modules/**', '**/node_modules/**'] },
      { prefix: location },
    );
  }
  const kit = join(root, 'deploy', 'agent-windows');
  const script = await readFile(join(kit, 'ArkHostAgent.ps1'), 'utf8');
  zip.append('\uFEFF' + script.replace(/^\uFEFF/, ''), { name: 'ArkHostAgent.ps1' });
  for (const file of ['ArkHostAgent.cmd', 'README.txt']) zip.file(join(kit, file), { name: file });
  const completed = finished(stream);
  await Promise.all([zip.finalize(), completed]);
  await rename(temporary, target);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(target)) digest.update(chunk);
  const hash = digest.digest('hex');
  await writeFile(`${target}.sha256`, `${hash}  ${name}\n`);
  console.log(`已生成 ${target}\nSHA-256 ${hash}`);
} finally {
  await rm(temporary, { force: true });
}
