import { PassThrough, Writable } from 'node:stream';
import { parseEnv, stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createSetupPrompt, envValue } from './index.mjs';

const prompts = [];
function fixture(terminal = false, outputIsTTY = terminal) {
  const input = new PassThrough();
  const rawModes = [];
  let text = '';
  const output = new Writable({
    write(chunk, _encoding, done) {
      text += chunk;
      done();
    },
  });
  if (terminal) {
    input.isTTY = true;
    input.setRawMode = (value) => rawModes.push(value);
    output.isTTY = outputIsTTY;
    output.columns = 80;
  }
  const prompt = createSetupPrompt({ input, output });
  prompts.push(prompt);
  return { input, prompt, rawModes, text: () => stripVTControlCharacters(text) };
}
afterEach(() => {
  for (const prompt of prompts.splice(0)) prompt.close();
});

describe('安装向导终端输入', () => {
  it('收到输入前就完整输出提示行，回车使用默认值', async () => {
    const { input, prompt, text } = fixture();
    const answer = prompt.ask('MySQL 地址', '127.0.0.1');
    expect(text()).toBe('MySQL 地址 [127.0.0.1]：\n');
    input.write('\n');
    expect(await answer).toBe('127.0.0.1');
  });
  it('保留一次性粘贴或管道提供的后续答案', async () => {
    const { input, prompt } = fixture();
    input.end('  localhost  \r\n3306\r\nroot\r\n');
    expect(await prompt.ask('地址')).toBe('localhost');
    expect(await prompt.ask('端口')).toBe('3306');
    expect(await prompt.ask('账号')).toBe('root');
  });
  it('密码不回显，保留密码首尾空格', async () => {
    const { input, prompt, text } = fixture(true);
    const answer = prompt.ask('数据库管理密码', '', true);
    input.write(' secret-value \r');
    expect(await answer).toBe(' secret-value ');
    expect(text()).toBe('数据库管理密码：\n\n');
  });
  it('启动器转发输出时仍禁用终端对密码的回显', async () => {
    const { input, prompt, rawModes, text } = fixture(true, false);
    const answer = prompt.ask('数据库管理密码', '', true);
    expect(rawModes[0]).toBe(true);
    input.write('private-value\r');
    expect(await answer).toBe('private-value');
    expect(text()).toBe('数据库管理密码：\n\n');
  });
  it('输入结束时返回明确错误，避免未完成 await 直接退出', async () => {
    const { input, prompt } = fixture();
    const answer = prompt.ask('MySQL 地址');
    const rejected = expect(answer).rejects.toMatchObject({
      name: 'SetupInputError',
      exitCode: 1,
      message: expect.stringContaining('终端输入已关闭'),
    });
    input.end();
    await rejected;
  });
  it('Ctrl+C 正常取消正在等待的输入', async () => {
    const { input, prompt } = fixture(true);
    const answer = prompt.ask('MySQL 地址');
    const rejected = expect(answer).rejects.toMatchObject({
      exitCode: 130,
      message: '安装已取消。',
    });
    input.write('\u0003');
    await rejected;
  });
  it('输入流出错时不会永远等待', async () => {
    const { input, prompt } = fixture();
    const answer = prompt.ask('MySQL 地址');
    const rejected = expect(answer).rejects.toThrow('无法读取终端输入');
    input.emit('error', new Error('input closed'));
    await rejected;
  });
});
describe('安装配置原样保存', () => {
  it('含反斜杠、空格和引号的密码可以原样读回', () => {
    for (const value of [
      ' password#with space ',
      'password\\with\\slashes',
      `password'with"quotes`,
    ]) {
      expect(parseEnv(`VALUE=${envValue(value)}`).VALUE).toBe(value);
    }
  });
  it('不能安全写入的值会明确失败', () => {
    expect(() => envValue('all\'"`quotes')).toThrow('无法原样写入');
  });
});
