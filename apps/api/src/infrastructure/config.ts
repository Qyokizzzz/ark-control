import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { z } from 'zod';

const envFile =
  process.env.ARK_ENV_FILE ?? [resolve('.env'), resolve('../../.env')].find(existsSync);
if (envFile) loadEnvFile(envFile);

const webOrigin = z
  .string()
  .trim()
  .refine((value) => {
    if (!value) return true;
    const url = URL.parse(value);
    return url?.protocol === 'https:' && url.href === `${url.origin}/`;
  }, 'WEB_ORIGIN 请填写页面的 HTTPS 来源，例如 https://your-account.github.io。')
  .transform((value) => (value ? new URL(value).origin : ''));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ARK_RELEASE_ID: z
    .string()
    .regex(/^[a-f0-9]{40}-\d+-\d+$/)
    .optional(),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().default(3000),
  APP_ORIGIN: z.url().default('http://127.0.0.1:5173'),
  WEB_ORIGIN: webOrigin.default(''),
  AGENT_WINDOWS_PACKAGE_PATH: z.string().default('../../artifacts/ArkHostAgent-Windows-x64.zip'),
  DATABASE_HOST: z.string().default('127.0.0.1'),
  DATABASE_PORT: z.coerce.number().default(3306),
  DATABASE_NAME: z
    .string()
    .regex(/^[a-zA-Z0-9_]+$/)
    .default('ark_control'),
  DATABASE_USER: z.string().min(1),
  DATABASE_PASSWORD: z.string().default(''),
  JWT_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  INITIAL_ADMIN_EMAIL: z.email().default('admin@ark.local'),
  INITIAL_ADMIN_PASSWORD: z.string().min(12).optional(),
  DATA_DIR: z.string().default('../../.data'),
  WEB_DIST: z.string().default('../web/dist'),
  QQ_API_BASE: z.url().default('https://api.bot.qq.com'),
  QQ_GATEWAY_ENABLED: z.enum(['true', 'false']).default('true'),
  PLATFORM_QQ_APP_ID: z.union([z.literal(''), z.string().regex(/^\d{5,30}$/)]).default(''),
  PLATFORM_QQ_APP_SECRET: z.union([z.literal(''), z.string().min(8).max(256)]).default(''),
  PLATFORM_QQ_CERTIFIED: z.enum(['true', 'false']).default('false'),
  DEMO_MODE: z.enum(['true', 'false']).default('false'),
  MAX_BACKUP_GB: z.coerce.number().min(1).max(1024).default(100),
  CONNECT_LAUNCHER_PATH: z.string().default('../../native/ArkConnect/dist/ArkConnect.exe'),
  CONNECT_VENDOR_DIR: z.string().default('../../native/ArkConnect/vendor'),
});
export const config = schema
  .refine(
    (env) => Boolean(env.PLATFORM_QQ_APP_ID) === Boolean(env.PLATFORM_QQ_APP_SECRET),
    '平台 QQ 机器人需要同时填写 AppID 与 AppSecret。',
  )
  .refine(
    (env) => !env.WEB_ORIGIN || URL.parse(env.APP_ORIGIN)?.protocol === 'https:',
    '使用 WEB_ORIGIN 时，APP_ORIGIN 需要填写管理 API 的公网 HTTPS 地址。',
  )
  .parse(process.env);
export const appOrigin = new URL(config.APP_ORIGIN).origin;
export const separateWebOrigin = config.WEB_ORIGIN !== appOrigin ? config.WEB_ORIGIN : '';
export const browserOrigins = separateWebOrigin ? [appOrigin, separateWebOrigin] : [appOrigin];
export const dataDir = resolve(config.DATA_DIR);
