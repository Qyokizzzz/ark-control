import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { appendFile, mkdir, open, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';

export interface ProgramOptions {
  onOutput?: (text: string) => void;
  label?: string;
  logFile?: string;
  diagnosticFiles?: string[];
}
async function stopProgramTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32')
    await new Promise<void>((yes) => {
      execFile(
        'taskkill.exe',
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 15000 },
        () => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          yes();
        },
      );
    });
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}
export class ProgramFailure extends Error {
  constructor(
    readonly exitCode: number | null,
    label: string,
    readonly output: string,
    logFile?: string,
    signal?: NodeJS.Signals | null,
  ) {
    const lines = output
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const relevant = lines.filter((line) =>
      /error|fail|fatal|unable|denied|permission|no subscription|错误|失败|拒绝|磁盘/i.test(line),
    );
    const installationError = lines.find((line) => /ERROR!\s*Failed to install app\b/i.test(line));
    const explanation = [
      ...new Set([
        ...(installationError ? [installationError] : []),
        ...relevant.slice(-4),
        ...lines.slice(-4),
      ]),
    ]
      .join('\n')
      .slice(0, 1900);
    super(
      `${label}执行失败，${signal ? `终止信号 ${signal}` : `退出码 ${exitCode ?? '未知'}`}。${explanation ? `\n${explanation}` : '\n程序未返回错误输出。'}${logFile ? `\n安装日志（主机助手所在电脑）：${logFile}` : ''}`,
    );
    this.name = 'ProgramFailure';
  }
}
async function diagnosticTail(paths: string[], startedAt: number) {
  const output: string[] = [];
  for (const path of paths) {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.mtimeMs < startedAt - 2000) continue;
      const file = await open(path, 'r');
      try {
        const bytes = Buffer.alloc(Math.min(8192, info.size));
        const result = await file.read(
          bytes,
          0,
          bytes.length,
          Math.max(0, info.size - bytes.length),
        );
        output.push(
          `\n--- ${basename(path)} ---\n${stripVTControlCharacters(bytes.subarray(0, result.bytesRead).toString('utf8'))}`,
        );
      } finally {
        await file.close();
      }
    } catch {
      /* Native SteamCMD logs may not exist on a failed bootstrap. */
    }
  }
  return output.join('');
}
export async function runProgram(
  executable: string,
  args: string[],
  report: (text: string) => void,
  signal?: AbortSignal,
  options: ProgramOptions = {},
): Promise<void> {
  signal?.throwIfAborted();
  if (options.logFile) await mkdir(dirname(options.logFile), { recursive: true });
  signal?.throwIfAborted();
  const startedAt = Date.now();
  const label = options.label ?? basename(executable);
  await new Promise<void>((yes, no) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      cwd: dirname(executable),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const pending = { stdout: '', stderr: '' };
    let tail = '',
      total = 0;
    const important: string[] = [];
    let spawnError: Error | null = null;
    let terminating: Promise<void> | null = null;
    const terminate = () => {
      terminating ??= stopProgramTree(child);
    };
    signal?.addEventListener('abort', terminate, { once: true });
    if (signal?.aborted) terminate();
    function capture(text: string, stream: 'stdout' | 'stderr') {
      if (!text) return;
      const clean = stripVTControlCharacters(text);
      options.onOutput?.(clean);
      tail = (tail + clean).slice(-65536);
      total += clean.length;
      const lines = (pending[stream] + clean).split(/\r\n|\r|\n/);
      pending[stream] = (lines.pop() ?? '').slice(-2000);
      for (const line of lines)
        if (
          /error|fail|fatal|unable|denied|permission|no subscription|错误|失败|拒绝|磁盘/i.test(
            line,
          )
        ) {
          important.push(line.slice(0, 1000));
          if (important.length > 12) important.shift();
        }
      try {
        report(clean.slice(-3000));
      } catch (error) {
        spawnError = error instanceof Error ? error : new Error('进度上报失败。');
        terminate();
      }
    }
    child.stdout.on('data', (part: Buffer) => capture(decoders.stdout.write(part), 'stdout'));
    child.stderr.on('data', (part: Buffer) => capture(decoders.stderr.write(part), 'stderr'));
    child.on('error', (error) => {
      spawnError = error;
    });
    // close follows stdout/stderr, including the final chunk containing the actual failure reason.
    child.once('close', (code, termination) => {
      void (async () => {
        signal?.removeEventListener('abort', terminate);
        await terminating;
        capture(decoders.stdout.end(), 'stdout');
        capture(decoders.stderr.end(), 'stderr');
        for (const text of Object.values(pending))
          if (/error|fail|fatal|unable|denied|错误|失败|拒绝/i.test(text)) important.push(text);
        const native =
          code !== 0 || spawnError
            ? await diagnosticTail(options.diagnosticFiles ?? [], startedAt)
            : '';
        const output = `${important.length ? important.slice(-12).join('\n') + '\n' : ''}${tail}${native}`;
        let logNote = '';
        if (options.logFile)
          try {
            await appendFile(
              options.logFile,
              `\n=== ${new Date(startedAt).toISOString()} · ${label} · exit ${code ?? termination ?? 'unknown'} ===\n${total > 65536 ? '[仅保留最近输出及关键错误行]\n' : ''}${output}\n`,
              { mode: 0o600 },
            );
          } catch {
            logNote = '\n诊断日志未能写入，请检查主机助手工作目录的磁盘空间和写入权限。';
          }
        if (signal?.aborted || spawnError?.name === 'AbortError')
          throw new DOMException('任务已取消。', 'AbortError');
        if (spawnError) throw new Error(`${label}无法运行：${spawnError.message}${logNote}`);
        if (code !== 0) {
          const error = new ProgramFailure(code, label, output, options.logFile, termination);
          error.message += logNote;
          throw error;
        }
        if (logNote) report(logNote.trim());
      })().then(yes, no);
    });
  });
}
export async function runSteamCmd(
  executable: string,
  args: string[],
  report: (text: string) => void,
  signal?: AbortSignal,
  options: ProgramOptions = {},
): Promise<void> {
  try {
    await runProgram(executable, args, report, signal, options);
  } catch (error) {
    if (!(error instanceof ProgramFailure) || signal?.aborted) throw error;
    const missingConfiguration =
      error.exitCode === 8 &&
      /ERROR!\s*Failed to install app\s+'?\d+'?\s*\(Missing configuration\)/i.test(error.output);
    if (error.exitCode !== 7 && !missingConfiguration) throw error;
    report(
      missingConfiguration
        ? 'SteamCMD 未取得应用安装信息（Missing configuration）；正在自动重试一次。'
        : 'SteamCMD 返回退出码 7，可能涉及首次自更新；正在自动重试一次。',
    );
    await delay(1500, undefined, { signal });
    try {
      await runProgram(executable, args, report, signal, options);
    } catch (retryError) {
      if (retryError instanceof ProgramFailure) {
        retryError.message += '\n已自动重试一次，仍未成功；请查看上述 SteamCMD 输出。';
        if (/\(Missing configuration\)/i.test(retryError.output))
          retryError.message +=
            '\n此处缺少的是 Steam 应用安装信息。请检查本次安装日志中的 content_log.txt、connection_log.txt；无需新建 Game.ini。';
      }
      throw retryError;
    }
  }
}
