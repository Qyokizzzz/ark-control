import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function closingBrace(text, start) {
  let depth = 0,
    state = 'code';
  for (let index = start; index < text.length; index++) {
    const char = text[index],
      next = text[index + 1];
    if (state === 'line') {
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'comment') {
      if (char === '*' && next === '/') {
        state = 'code';
        index++;
      }
      continue;
    }
    if (state === 'string' || state === 'char') {
      if (char === '\\') {
        index++;
        continue;
      }
      if (char === (state === 'string' ? '"' : "'")) state = 'code';
      continue;
    }
    if (char === '/' && next === '/') {
      state = 'line';
      index++;
      continue;
    }
    if (char === '/' && next === '*') {
      state = 'comment';
      index++;
      continue;
    }
    if (char === '"') {
      state = 'string';
      continue;
    }
    if (char === "'") {
      state = 'char';
      continue;
    }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return index;
  }
  throw new Error('无法识别 Points.cpp 函数边界。');
}
export function instrumentPoints(source) {
  if (source.includes('ArkControlCommerce::Record'))
    throw new Error('此文件已插入审计，请勿重复处理。');
  let output = source;
  for (const [name, delta, kind] of [
    ['AddPoints', 'amount', 'points-credit'],
    ['SpendPoints', '-static_cast<long long>(amount)', 'points-debit'],
    ['SetPoints', 'static_cast<long long>(new_amount) - ark_control_before', 'points-set'],
  ]) {
    const expression = new RegExp(`bool\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g');
    const matches = [...output.matchAll(expression)];
    if (matches.length !== 1) throw new Error(`ArkShop 源码版本未适配：${name} 签名不唯一。`);
    const begin = matches[0].index;
    const open = output.indexOf('{', begin);
    const close = closingBrace(output, open);
    let body = output.slice(open + 1, close);
    if (!body.includes('database->') || (body.match(/return true\s*;/g) ?? []).length !== 1)
      throw new Error(`ArkShop 源码版本未适配：${name} 的成功路径未知。`);
    const mutation = body.search(/const\s+bool\s+\w+\s*=\s*database->/);
    if (mutation < 0) throw new Error(`ArkShop 源码版本未适配：${name} 的写入路径未知。`);
    body =
      body.slice(0, mutation) +
      'const int ark_control_before = GetPoints(steam_id);\n\t\t' +
      body.slice(mutation);
    body = body.replace(
      /return true\s*;/,
      `ArkControlCommerce::Record("${kind}", steam_id, ${delta}, ark_control_before, GetPoints(steam_id));\n\t\treturn true;`,
    );
    output = output.slice(0, open + 1) + body + output.slice(close);
  }
  return '#include "ArkControlCommerce.h"\n' + output;
}
async function main() {
  const [source, directory] = process.argv.slice(2);
  if (!source || !directory)
    throw new Error(
      '用法：node native/ArkShopAudit/instrument.mjs <Points.cpp 完整路径> <新的输出文件夹>',
    );
  const target = resolve(directory);
  const input = await readFile(resolve(source), 'utf8');
  const output = instrumentPoints(input);
  await mkdir(target, { recursive: false });
  await writeFile(join(target, 'Points.cpp'), output);
  await copyFile(
    join(dirname(fileURLToPath(import.meta.url)), 'ArkControlCommerce.h'),
    join(target, 'ArkControlCommerce.h'),
  );
  console.log(
    '已生成可审阅的 ArkShop 源码补丁；原文件未改动。请使用对应 ASE SDK 编译并在测试服验证。',
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
