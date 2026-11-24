import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gameConfigSchema } from '../../common/src/index';
import type { AgentCommand, AgentInstance } from '../../common/src/index';
import { GameRuntime } from '../../apps/agent/src/runtime/runtime';
import { forceStop, pidInUse, processMatches } from '../../apps/agent/src/runtime/processes';
import { LogReader } from '../../apps/agent/src/logs/index';
import { rcon } from '../../apps/agent/src/rcon/index';
import type { AgentClient } from '../../apps/agent/src/client/index';
import { redactText } from '../../apps/agent/src/privacy/index';

const project = resolve('.');
const directory = join(project, '.data/rcon-launch', String(Date.now()));
const root = join(directory, 'host');
await mkdir(root, { recursive: true });
const secret = randomBytes(24).toString('base64url');
const checks: string[] = [];
function passed(text: string) {
  checks.push(text);
  console.log('PASS ' + text);
}
async function run(file: string, args: string[]) {
  return new Promise<string>((yes, no) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (part) => (output += part));
    child.stderr.on('data', (part) => (output += part));
    child.on('error', no);
    child.on('exit', (code) =>
      code === 0 ? yes(output) : no(new Error(redactText(output, [secret]))),
    );
  });
}
async function port() {
  const server = net.createServer();
  await new Promise<void>((yes) => server.listen(0, '127.0.0.1', yes));
  const value = (server.address() as net.AddressInfo).port;
  await new Promise<void>((yes, no) => server.close((error) => (error ? no(error) : yes())));
  return value;
}
const instance: AgentInstance = {
  id: randomUUID(),
  hostId: randomUUID(),
  name: 'RCON launch compatibility fixture',
  map: 'TheIsland',
  mapLabel: '孤岛',
  clusterId: '',
  branch: 'public',
  gamePort: 7777,
  queryPort: 27015,
  rconPort: await port(),
  rconPassword: secret,
  status: 'stopped',
  desiredState: 'stopped',
  installed: true,
  config: gameConfigSchema.parse({ maxPlayers: 1 }),
  autoRestart: false,
  cpuPercent: 0,
  memoryMb: 0,
  pid: null,
  startedAt: null,
  lastError: null,
  buildId: null,
  createdAt: new Date().toISOString(),
};
const executable = join(
  root,
  'instances',
  instance.id,
  'ShooterGame/Binaries/Win64/ShooterGameServer.exe',
);
await mkdir(dirname(executable), { recursive: true });
await writeFile(join(dirname(executable), '../../ShooterGame.uproject'), '{"FileVersion":3}');
const saved = join(root, 'instances', instance.id, 'ShooterGame/Saved');
await mkdir(saved, { recursive: true });
await writeFile(
  join(saved, 'require-url-admin.txt'),
  'Local simulation: startup rewrites INI and requires the launch password.',
);
const config = {
  root,
  apiUrl: 'http://127.0.0.1:9',
  hostId: instance.hostId,
  token: 'fixture-only',
};
const client = { request: async () => ({ cancelled: false }) } as unknown as AgentClient;
const streamed: string[] = [];
const runtime = new GameRuntime(config, client, (_id, line) => streamed.push(line));
const reader = new LogReader(
  root,
  () => undefined,
  (_id, line) => streamed.push(line),
);
await runtime.initialize();
await reader.initialize();
const command = (kind: AgentCommand['kind']): AgentCommand => ({
  id: randomUUID(),
  instanceId: instance.id,
  hostId: instance.hostId,
  kind,
  payload: { countdownSeconds: 0 },
  status: 'leased',
  progress: 'fixture',
  result: null,
  error: null,
  leaseUntil: null,
  createdAt: new Date().toISOString(),
  completedAt: null,
  idempotencyKey: randomUUID(),
  instance,
});
let gamePid: number | null = null;
try {
  const compiler = join(
    process.env.WINDIR ?? 'C:/Windows',
    'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  );
  await run(compiler, [
    '/nologo',
    '/target:exe',
    `/out:${executable}`,
    join(project, 'tests/fixtures/FakeArk.cs'),
  ]);
  const startupDelay = join(saved, 'startup-delay.txt');
  const abort = new AbortController();
  await writeFile(startupDelay, '45000');
  await assert.rejects(
    runtime.execute(command('start'), abort.signal, (text) => {
      if (text.includes('等待 RCON')) abort.abort();
    }),
  );
  assert.equal(abort.signal.aborted, true);
  const states = JSON.parse(await readFile(join(root, 'processes.json'), 'utf8'));
  const startingPid = Number(states[instance.id]?.pid);
  assert.ok(startingPid > 0 && (await processMatches(startingPid, executable)));
  const terminated = await runtime.execute(
    { ...command('force-stop'), payload: { terminateStartup: true } },
    AbortSignal.timeout(30000),
    () => undefined,
  );
  assert.equal(terminated.stopped, true);
  assert.equal(pidInUse(startingPid), false);
  assert.equal((await runtime.reports([instance]))[0]?.status, 'stopped');
  await unlink(startupDelay);
  passed('真实 Windows 游戏替身在 RCON 监听前结束进程，确认 PID 已释放');
  await runtime.execute(command('start'), AbortSignal.timeout(45000), (text) =>
    streamed.push(text),
  );
  const report = (await runtime.reports([instance]))[0]!;
  gamePid = report.pid;
  assert.equal(report.status, 'running');
  assert.equal(report.startup?.rconReady, true);
  passed('真实 Windows 子进程在启动配置被替身重写后，仍使用启动参数中的原管理密码就绪');
  const ini = await readFile(join(saved, 'Config/WindowsServer/GameUserSettings.ini'), 'utf8');
  assert.ok(!/^ServerAdminPassword=/im.test(ini));
  assert.ok(ini.includes('RCONEnabled=True'));
  assert.match(await rcon(instance.rconPort, secret, 'ListPlayers'), /76561198000000001/);
  passed('INI 无管理员密码时，分配的 TCP RCON 端口可认证并返回 ListPlayers');
  await reader.collect([instance]);
  assert.ok(streamed.some((line) => line.includes('ServerAdminPassword=[已隐藏]')));
  assert.ok(!streamed.join('\n').includes(secret));
  assert.ok(!(await readFile(join(root, 'processes.json'), 'utf8')).includes(secret));
  passed('启动状态、进程输出回传及持久化进度均隐藏管理密码');
  const raw = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(project, 'scripts/diagnose-startup.ps1'),
    '-GamePid',
    String(gamePid),
  ]);
  assert.ok(!raw.includes(secret));
  const diagnosis = JSON.parse(raw.replace(/^\uFEFF/, ''));
  assert.equal(diagnosis.IniAdminPasswordConfigured, false);
  assert.ok(
    diagnosis.TCPListeners.some(
      (row: { LocalPort: number; OwningProcess: number }) =>
        row.LocalPort === instance.rconPort && row.OwningProcess === gamePid,
    ),
  );
  if (diagnosis.LaunchOptions.Readable)
    assert.equal(diagnosis.LaunchOptions.AdminPasswordProvided, true);
  await writeFile(join(directory, 'diagnosis.json'), JSON.stringify(diagnosis, null, 2));
  passed('PowerShell 5.1 只读诊断明确区分 INI 密码与启动参数来源，报告不含密码');
  await runtime.execute(command('stop'), AbortSignal.timeout(20000), () => undefined);
  assert.equal((await runtime.reports([instance]))[0]?.pid, null);
  passed('同一管理密码正常保存停服，结束本次测试进程');
  await writeFile(
    join(directory, 'report.json'),
    JSON.stringify(
      {
        ok: true,
        checks,
        note: '真实 Windows 进程/TCP/RCON/PowerShell；INI 重写及 ARK 行为由替身模拟，未确认用户实际游戏恢复。',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ directory, checks: checks.length, ok: true }));
} catch (error) {
  await writeFile(
    join(directory, 'report.json'),
    JSON.stringify(
      {
        ok: false,
        checks,
        error: redactText(error instanceof Error ? error.message : String(error), [secret]),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  const states = JSON.parse(await readFile(join(root, 'processes.json'), 'utf8').catch(() => '{}'));
  gamePid = states[instance.id]?.pid ?? gamePid;
  if (gamePid && (await processMatches(gamePid, executable))) await forceStop(gamePid, executable);
}
