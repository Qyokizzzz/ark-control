import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { parseEnv } from 'node:util';

export class SetupInputError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'SetupInputError';
    this.exitCode = exitCode;
  }
}

export function createSetupPrompt({ input = process.stdin, output = process.stdout } = {}) {
  const inputHelp =
    '请在可输入的 PowerShell / Windows Terminal 中进入项目目录，运行 node scripts/setup.mjs；请勿在只读输出面板中运行安装向导。';
  let muted = false;
  let interrupted = false;
  let failed = false;
  const terminalOutput = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) output.write(chunk);
      callback();
    },
  });
  Object.defineProperty(terminalOutput, 'columns', { get: () => output.columns });
  const readline = createInterface({
    input,
    output: terminalOutput,
    // A runner may pipe stdout while leaving an interactive stdin attached.
    // Keep raw input mode in that case so the console cannot echo passwords.
    terminal: !!input.isTTY,
    crlfDelay: Infinity,
    historySize: 0,
    prompt: '',
  });
  // Register the iterator before accepting input, retaining pasted / piped lines
  // for later questions and resolving pending reads when stdin reaches EOF.
  const answers = readline[Symbol.asyncIterator]();
  const handleInputError = () => {
    failed = true;
    readline.close();
  };
  input.on('error', handleInputError);
  readline.on('SIGINT', () => {
    interrupted = true;
    readline.close();
  });
  return {
    async ask(label, fallback = '', secret = false) {
      // Complete the line so package runners that buffer output by line can
      // display the question immediately, before the user presses Enter.
      output.write(`${label}${fallback ? ` [${fallback}]` : ''}：\n`);
      muted = secret;
      try {
        const answer = await answers.next();
        if (answer.done) {
          if (interrupted) throw new SetupInputError('安装已取消。', 130);
          throw new SetupInputError(
            `${failed ? '无法读取终端输入' : '终端输入已关闭'}。${inputHelp}`,
          );
        }
        const value = secret ? answer.value : answer.value.trim();
        return value || fallback;
      } catch (error) {
        if (failed) throw new SetupInputError(`无法读取终端输入。${inputHelp}`);
        throw error;
      } finally {
        muted = false;
        if (secret) output.write('\n');
      }
    },
    close() {
      readline.close();
      input.off('error', handleInputError);
    },
  };
}

export function envValue(value) {
  for (const delimiter of ["'", '"', '`']) {
    if (value.includes(delimiter)) continue;
    const encoded = `${delimiter}${value}${delimiter}`;
    if (parseEnv(`VALUE=${encoded}`).VALUE === value) return encoded;
  }
  throw new Error('配置同时包含多种引号，无法原样写入 .env；请调整该项输入。');
}
