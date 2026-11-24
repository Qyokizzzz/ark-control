import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, readlink } from 'node:fs/promises';
import pidusage from 'pidusage';

const execute = promisify(execFile);
export const delay = (milliseconds: number, signal?: AbortSignal) =>
  new Promise<void>((yes, no) => {
    if (signal?.aborted) {
      no(new Error('任务已取消。'));
      return;
    }
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener('abort', abort);
      yes();
    }
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      no(new Error('任务已取消。'));
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
export async function processMatches(pid: number, executable: string): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    let actual: string;
    if (process.platform === 'win32') {
      const { stdout } = await execute(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).Path`,
        ],
        { windowsHide: true, timeout: 10000 },
      );
      actual = stdout.trim();
    } else actual = await readlink(`/proc/${pid}/exe`);
    const [left, right] = await Promise.all([realpath(actual), realpath(executable)]);
    return process.platform === 'win32'
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
  } catch {
    return false;
  }
}
export async function processMetrics(pid: number) {
  try {
    const value = await pidusage(pid);
    return { cpuPercent: Math.max(0, value.cpu), memoryMb: value.memory / 1024 ** 2 };
  } catch {
    return { cpuPercent: 0, memoryMb: 0 };
  }
}
export function pidInUse(pid: number) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
export async function forceStop(pid: number, executable: string) {
  if (!(await processMatches(pid, executable)))
    throw new Error('进程身份已变化，已拒绝结束不匹配的进程。');
  if (process.platform === 'win32') {
    try {
      await execute('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 15000,
      });
    } catch (error) {
      if (!pidInUse(pid)) return;
      if (!(await processMatches(pid, executable))) throw error;
      process.kill(pid, 'SIGKILL');
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      process.kill(pid, 'SIGKILL');
    }
  }
}
export { runProgram } from '@/program';
