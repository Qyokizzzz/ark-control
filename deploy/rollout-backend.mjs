import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout } from 'node:timers/promises';
import { parseEnv, promisify } from 'node:util';

const run = promisify(execFile);
const releasePattern = /^[a-f0-9]{40}-\d+-\d+$/;
const app = 'ark-control-api';
const [directory, id, digest] = process.argv.slice(-3);
const [major, minor] = process.versions.node.split('.').map(Number);

function optional(promise) {
  return promise.catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
}

async function pm2(args, env = process.env) {
  try {
    return (await run('pm2', args, { env, timeout: 20000, maxBuffer: 8 * 1024 ** 2 })).stdout;
  } catch {
    throw new Error(`PM2 ${args[0]} 执行失败，请检查部署用户的 PM2 环境。`);
  }
}

async function waitForRelease(url, release, signal) {
  for (let attempt = 0; attempt < 25; attempt++) {
    signal?.throwIfAborted();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) {
        const { data } = await response.json();
        if (data?.status === 'ok' && data.release === release) return;
      }
    } catch {
      // PM2 may still be starting the API or connecting to MySQL.
    }
    await setTimeout(1000, undefined, { signal });
  }
  throw new Error(`后端未通过健康检查，请在服务器查看 pm2 logs ${app}。`);
}

async function deploy(signal) {
  if (major < 22 || (major === 22 && minor < 18))
    throw new Error('服务器需要 Node.js 22.18 或以上版本。');
  if (
    !directory ||
    !isAbsolute(directory) ||
    !releasePattern.test(id) ||
    !/^[a-f0-9]{64}$/.test(digest)
  )
    throw new Error('部署目录、发布标识或校验值无效。');
  const root = await realpath(directory);
  if (join(root, '..') === root) throw new Error('请选择应用目录。');
  const shared = join(root, 'shared');
  const cwd = join(shared, 'apps', 'api');
  const productionEnv = join(shared, '.env.prod');
  const productionEnvText = await optional(readFile(productionEnv, 'utf8'));
  const envFile = productionEnvText === null ? join(shared, '.env') : productionEnv;
  const envText = productionEnvText ?? (await optional(readFile(envFile, 'utf8')));
  if (envText === null) throw new Error('请先在部署目录的 shared/.env.prod 配置 API 和 MySQL。');
  const env = parseEnv(envText);
  const configured = process.env.API_HOST ?? env.API_HOST ?? '127.0.0.1';
  const host = configured === '0.0.0.0' ? '127.0.0.1' : configured === '::' ? '::1' : configured;
  const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const port = Number(process.env.API_PORT ?? env.API_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('API_PORT 必须是 1 至 65535 的端口。');
  const health = new URL(`http://${address}:${port}/api/health`);
  const releases = join(root, 'releases');
  const marker = join(root, 'current-release');
  await Promise.all(
    [releases, cwd, join(shared, '.data'), join(shared, 'artifacts')].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  if ((await realpath(releases)) !== releases)
    throw new Error('releases 需要是部署目录下的本地目录。');

  const entry = (revision) => join(releases, revision, 'apps', 'api', 'dist', 'main.js');
  const previous = (await optional(readFile(marker, 'utf8')))?.trim() ?? '';
  if (
    previous &&
    (!releasePattern.test(previous) || !(await optional(stat(entry(previous))))?.isFile())
  )
    throw new Error('current-release 记录无效，请核对已发布的版本目录。');
  await pm2(['ping']);
  const listing = await pm2(['jlist']);
  let registered;
  try {
    registered = JSON.parse(listing).filter((item) => item.name === app);
  } catch {
    throw new Error('无法读取 PM2 进程清单，请检查部署用户的 PM2 环境。');
  }
  if (registered.length) {
    const running = registered[0].pm2_env?.pm_exec_path;
    const [revision, ...parts] = running ? relative(releases, running).split(sep) : [];
    if (
      registered.length !== 1 ||
      !releasePattern.test(revision) ||
      parts.join('/') !== 'apps/api/dist/main.js'
    )
      throw new Error(`PM2 进程 ${app} 已被其他部署占用，请先处理旧进程。`);
    if (id === previous && id === revision) {
      await waitForRelease(health, id, signal);
      console.log('此版本已经运行。');
      return;
    }
  }

  const release = join(releases, id);
  if (await optional(stat(release)))
    throw new Error('发布目录已存在，请重新运行 Actions 生成新的发布标识。');
  const stage = await mkdtemp(join(releases, '.upload-'));
  const start = (revision) =>
    pm2(
      [
        'start',
        entry(revision),
        '--name',
        app,
        '--cwd',
        cwd,
        '--interpreter',
        process.execPath,
        '--time',
      ],
      { ...process.env, NODE_ENV: 'production', ARK_ENV_FILE: envFile, ARK_RELEASE_ID: revision },
    );
  let changed = false;
  let unpacked = false;
  try {
    const archive = join(stage, 'release.tar.gz');
    await pipeline(process.stdin, createWriteStream(archive, { flags: 'wx', mode: 0o600 }), {
      signal,
    });
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (hash.digest('hex') !== digest) throw new Error('后端发布包的 SHA-256 校验失败。');
    await mkdir(release);
    unpacked = true;
    await run('tar', ['-xzf', archive, '-C', release, '--no-same-owner'], { signal });
    const api = join(release, 'apps', 'api');
    const [manifest, dependencies, main] = await Promise.all(
      ['package.json', 'node_modules', 'dist/main.js'].map((path) =>
        optional(stat(join(api, path))),
      ),
    );
    if (!manifest?.isFile() || !dependencies?.isDirectory() || !main?.isFile())
      throw new Error('发布包缺少 API 入口或运行依赖。');
    await run(process.execPath, ['--check', join(api, 'dist', 'main.js')], { signal });
    const next = join(stage, 'next-release');
    await writeFile(next, `${id}\n`, { mode: 0o600 });
    signal.throwIfAborted();

    changed = true;
    if (registered.length) await pm2(['delete', app]);
    await start(id);
    await waitForRelease(health, id, signal);
    await pm2(['save']);
    await rename(next, marker);
    console.log('后端已部署并通过健康检查。');
  } catch (error) {
    if (changed) {
      console.error('新版本未通过部署检查，正在恢复。');
      await pm2(['delete', app]).catch(() => {});
      if (previous) {
        try {
          await start(previous);
          await waitForRelease(health, previous);
          await pm2(['save']);
          console.error('已恢复上一个版本。');
        } catch {
          console.error(`上一个版本未恢复健康，请在服务器查看 pm2 logs ${app}。`);
        }
      }
    } else if (unpacked) {
      await rm(release, { recursive: true, force: true }).catch(() =>
        console.error('无法清理本次解包目录。'),
      );
    }
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() =>
      console.error('无法清理本次上传目录。'),
    );
  }
  for (const item of await readdir(releases, { withFileTypes: true })) {
    if (
      item.isDirectory() &&
      releasePattern.test(item.name) &&
      item.name !== id &&
      item.name !== previous
    )
      await rm(join(releases, item.name), { recursive: true }).catch(() =>
        console.error('无法清理一个旧版本。'),
      );
  }
}

const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.once(signal, () => abort.abort(new Error(`部署收到 ${signal}。`)));
try {
  process.umask(0o077);
  await deploy(abort.signal);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
