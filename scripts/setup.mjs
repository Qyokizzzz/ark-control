import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { createSetupPrompt, envValue, SetupInputError } from './setup/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const production = process.argv.includes('--prod');
const envName = production ? '.env.prod' : '.env.dev';
const envFile = resolve(root, envName);
const legacy = resolve(root, '.env');
const startup = production ? 'pnpm build 后运行 pnpm start' : 'pnpm dev';
if (existsSync(envFile)) {
  console.log(`已有 ${envName}。可直接使用 ${startup} 启动，或编辑配置。`);
  process.exit(0);
}
if (existsSync(legacy)) {
  await writeFile(envFile, await readFile(legacy), { mode: 0o600, flag: 'wx' });
  console.log(`已从旧 .env 复制配置到 ${envName}。启动方式为 ${startup}。`);
  process.exit(0);
}
const prompt = createSetupPrompt();
const { ask } = prompt;
try {
  console.log('方舟控制台安装向导\n将建立独立数据库账号，并生成应用密钥。');
  console.log('请逐项输入并按回车；方括号内为默认值，可直接回车使用。');
  const host = await ask('MySQL 地址', '127.0.0.1');
  const port = Number(await ask('MySQL 端口', '3306'));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('MySQL 端口应为 1 至 65535 的整数。');
  const user = await ask('数据库管理账号', 'root');
  const password = await ask('数据库管理密码', '', true);
  const database = await ask('数据库名称', production ? 'ark_control' : 'ark_control_dev');
  if (!/^[a-zA-Z0-9_]{1,48}$/.test(database))
    throw new Error('数据库名称只能包含英文字母、数字和下划线，最多 48 字符。');
  const email = await ask('管理员邮箱', 'admin@ark.local');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('邮箱格式不正确。');
  const adminPassword =
    (await ask('管理员密码（留空自动生成）', '', true)) || randomBytes(18).toString('base64url');
  if (adminPassword.length < 12) throw new Error('管理员密码至少 12 个字符。');
  for (const input of [host, email, adminPassword]) envValue(input);
  prompt.close();
  console.log(`正在连接 MySQL（${host}:${port}），最多等待 8 秒……`);
  const connection = await mysql.createConnection({
    host,
    port,
    user,
    password,
    connectTimeout: 8000,
  });
  const appUser = `ark_${randomBytes(6).toString('hex')}`;
  const appPassword = randomBytes(30).toString('base64url');
  try {
    console.log('MySQL 已连接，正在建立数据库和应用账号……');
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS ${mysql.escapeId(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await connection.query('CREATE USER ?@? IDENTIFIED BY ?', [appUser, '%', appPassword]);
    await connection.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE,CREATE,ALTER,INDEX,REFERENCES ON ${mysql.escapeId(database)}.* TO ?@?`,
      [appUser, '%'],
    );
  } finally {
    await connection.end();
  }
  const values = {
    NODE_ENV: production ? 'production' : 'development',
    API_HOST: '127.0.0.1',
    API_PORT: '3000',
    APP_ORIGIN: production ? 'http://127.0.0.1:3000' : 'http://127.0.0.1:5173',
    DATABASE_HOST: host,
    DATABASE_PORT: String(port),
    DATABASE_NAME: database,
    DATABASE_USER: appUser,
    DATABASE_PASSWORD: appPassword,
    JWT_SECRET: randomBytes(48).toString('base64url'),
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    INITIAL_ADMIN_EMAIL: email,
    INITIAL_ADMIN_PASSWORD: adminPassword,
    DATA_DIR: '../../.data',
    WEB_DIST: '../web/dist',
    QQ_API_BASE: 'https://api.bot.qq.com',
    QQ_GATEWAY_ENABLED: 'true',
    MAX_BACKUP_GB: '100',
    DEMO_MODE: 'false',
  };
  await writeFile(
    envFile,
    Object.entries(values)
      .map(([key, value]) => `${key}=${envValue(value)}`)
      .join('\n') + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    `\n已生成 ${envName}。\n管理员：${email}\n管理员密码：${adminPassword}\n启动方式：${startup}\n请保管管理员密码；数据库管理密码未保存。`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : '安装失败。');
  process.exitCode = error instanceof SetupInputError ? error.exitCode : 1;
} finally {
  prompt.close();
}
