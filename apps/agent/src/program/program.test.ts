import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProgramFailure, runProgram, runSteamCmd } from './index';

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'ark-process-test-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (path) => {
      const target = resolve(path);
      const name = relative(resolve(tmpdir()), target);
      if (isAbsolute(name) || name.includes('..') || !name.startsWith('ark-process-test-'))
        throw new Error('拒绝清理不属于本次测试的目录。');
      await rm(target, { recursive: true, force: true });
    }),
  );
});

describe('SteamCMD execution diagnostics', () => {
  it('keeps the final split UTF-8 failure and stores it in the command log', async () => {
    const root = await directory();
    const logFile = join(root, 'logs', 'install.log');
    const output: string[] = [];
    const script = `const b=Buffer.from('ERROR! 磁盘写入失败\\n');process.stderr.write(b.subarray(0,9));setTimeout(()=>{process.stderr.write(b.subarray(9));process.exitCode=7},30);`;
    const error = await runProgram(
      process.execPath,
      ['-e', script],
      (text) => output.push(text),
      undefined,
      { label: 'SteamCMD 安装服务端', logFile },
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ProgramFailure);
    expect((error as ProgramFailure).exitCode).toBe(7);
    expect((error as Error).message).toContain('磁盘写入失败');
    expect((error as Error).message).toContain(logFile);
    expect(output.join('')).toContain('磁盘写入失败');
    expect(await readFile(logFile, 'utf8')).toContain('磁盘写入失败');
  });
  it('retains an early explicit failure even after a large progress stream', async () => {
    const root = await directory();
    const logFile = join(root, 'large.log');
    const script = `process.stdout.write('ERROR! Failed to install app 376030 (No subscription)\\n');process.stdout.write('progress\\n'.repeat(10000),()=>{process.exitCode=8;});`;
    await expect(
      runProgram(process.execPath, ['-e', script], () => undefined, undefined, {
        logFile,
        label: 'SteamCMD',
      }),
    ).rejects.toThrow('No subscription');
    const log = await readFile(logFile, 'utf8');
    expect(log).toContain('仅保留最近输出');
    expect(log.length).toBeLessThan(80000);
  });
  it('includes fresh native bootstrap logs when no console error is available', async () => {
    const root = await directory();
    const nativeLog = join(root, 'bootstrap_log.txt');
    await writeFile(nativeLog, 'ERROR: Steam needs to be online to update.');
    await expect(
      runProgram(process.execPath, ['-e', 'process.exitCode=7'], () => undefined, undefined, {
        label: 'SteamCMD',
        diagnosticFiles: [nativeLog],
      }),
    ).rejects.toThrow('Steam needs to be online');
  });
  it('reruns exit code 7 once and waits for the second process to succeed', async () => {
    const root = await directory();
    const counter = join(root, 'attempts');
    const output: string[] = [];
    const script = `const f=require('fs'),p=process.argv[1],n=f.existsSync(p)?Number(f.readFileSync(p))+1:1;f.writeFileSync(p,String(n));console.log(n===1?'Update complete, launching Steamcmd...':"Success! App '376030' fully installed.");process.exitCode=n===1?7:0;`;
    await runSteamCmd(process.execPath, ['-e', script, counter], (text) => output.push(text));
    expect(await readFile(counter, 'utf8')).toBe('2');
    expect(output.join('')).toContain('自动重试一次');
  });
  it('does not loop or mark success when retry also fails', async () => {
    const root = await directory();
    const counter = join(root, 'attempts');
    const script = `const f=require('fs'),p=process.argv[1];f.writeFileSync(p,String(f.existsSync(p)?Number(f.readFileSync(p))+1:1));console.error('ERROR! Download failed');process.exitCode=7;`;
    await expect(
      runSteamCmd(process.execPath, ['-e', script, counter], () => undefined),
    ).rejects.toThrow('已自动重试一次');
    expect(await readFile(counter, 'utf8')).toBe('2');
  });
  it('retries exit code 8 only for an explicit missing app configuration error', async () => {
    const root = await directory();
    const counter = join(root, 'attempts');
    const messages: string[] = [];
    const script = `const f=require('fs'),p=process.argv[1],n=f.existsSync(p)?Number(f.readFileSync(p))+1:1;f.writeFileSync(p,String(n));console.log(n===1?"ERROR! Failed to install app '376030' (Missing configuration)":"Success! App '376030' fully installed.");process.exitCode=n===1?8:0;`;
    await runSteamCmd(process.execPath, ['-e', script, counter], (text) => messages.push(text));
    expect(await readFile(counter, 'utf8')).toBe('2');
    expect(messages.join('')).toContain('Missing configuration）；正在自动重试一次');
  });
  it('bounds repeated missing configuration errors and preserves both attempts in the log', async () => {
    const root = await directory();
    const counter = join(root, 'attempts');
    const logFile = join(root, 'install.log');
    const script = `const f=require('fs'),p=process.argv[1];f.writeFileSync(p,String(f.existsSync(p)?Number(f.readFileSync(p))+1:1));console.error("ERROR! Failed to install app '376030' (Missing configuration)");process.exitCode=8;`;
    const error = await runSteamCmd(
      process.execPath,
      ['-e', script, counter],
      () => undefined,
      undefined,
      { logFile },
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ exitCode: 8 });
    expect((error as Error).message).toContain('已自动重试一次');
    expect((error as Error).message).toContain('Steam 应用安装信息');
    expect(await readFile(counter, 'utf8')).toBe('2');
    expect((await readFile(logFile, 'utf8')).match(/=== .*exit 8 ===/g)).toHaveLength(2);
  });
  it('keeps the actual installation error visible ahead of verbose native diagnostics', async () => {
    const root = await directory();
    const nativeLog = join(root, 'content_log.txt');
    const script = `require('fs').writeFileSync(process.argv[1],'Failed to refresh connection: '+('details '.repeat(40))+'\\n'.repeat(1)+('Failed retry\\n'.repeat(20)));console.error("ERROR! Failed to install app '376030' (Missing configuration)");process.exitCode=8;`;
    await expect(
      runProgram(process.execPath, ['-e', script, nativeLog], () => undefined, undefined, {
        diagnosticFiles: [nativeLog],
      }),
    ).rejects.toThrow("ERROR! Failed to install app '376030' (Missing configuration)");
  });
  it('does not retry other exit codes or an explicitly cancelled retry', async () => {
    const messages: string[] = [];
    await expect(
      runSteamCmd(process.execPath, ['-e', 'process.exitCode=8'], (text) => messages.push(text)),
    ).rejects.toMatchObject({ exitCode: 8 });
    expect(messages).toEqual([]);
    await expect(
      runSteamCmd(
        process.execPath,
        [
          '-e',
          `console.error("ERROR! Failed to install app '376030' (No subscription)");process.exitCode=8;`,
        ],
        (text) => messages.push(text),
      ),
    ).rejects.toThrow('No subscription');
    expect(messages.join('')).not.toContain('自动重试');
    const abort = new AbortController();
    await expect(
      runSteamCmd(
        process.execPath,
        ['-e', 'process.exitCode=7'],
        () => abort.abort(),
        abort.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('reports a missing executable without an unhandled process error', async () => {
    const root = await directory();
    await expect(
      runProgram(join(root, 'missing.exe'), [], () => undefined, undefined, { label: 'SteamCMD' }),
    ).rejects.toThrow('SteamCMD无法运行');
  });
  it('cancelling terminates the complete owned process tree', async () => {
    const root = await directory();
    const pidFile = join(root, 'pids.json');
    const abort = new AbortController();
    const script = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',windowsHide:true});require('fs').writeFileSync(process.argv[1],JSON.stringify([process.pid,c.pid]));console.log('READY');setInterval(()=>{},1000);`;
    await expect(
      runProgram(
        process.execPath,
        ['-e', script, pidFile],
        (text) => {
          if (text.includes('READY')) abort.abort();
        },
        abort.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const pids = JSON.parse(await readFile(pidFile, 'utf8')) as number[];
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  });
});
