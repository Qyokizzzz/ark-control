import { z } from 'zod';
import {
  CLUSTER_SERVER_NAME_PREFIX_LIMIT,
  COMMAND_KINDS,
  MAPS,
  STEAM_SERVER_NAME_LIMIT,
} from '@common/constants';
import { gameIniIssue } from '@common/game-config';

const name = z.string().trim().min(1).max(80);
const port = z.number().int().min(1024).max(65534);
const steamServerName = z.string().trim().min(1).max(STEAM_SERVER_NAME_LIMIT);
const gameConfigFields = z.object({
  sessionName: steamServerName.default('ARK Community'),
  serverPassword: z.string().max(80).default(''),
  maxPlayers: z.number().int().min(1).max(200).default(20),
  pve: z.boolean().default(true),
  xp: z.number().min(0.1).max(100).default(2),
  harvest: z.number().min(0.1).max(100).default(2),
  taming: z.number().min(0.1).max(100).default(3),
  breeding: z.number().min(0.01).max(100).default(0.5),
  eggHatch: z.number().min(0.1).max(1000).default(5),
  babyMature: z.number().min(0.1).max(1000).default(5),
  difficulty: z.number().min(0.1).max(20).default(5),
  autoSaveMinutes: z.number().int().min(5).max(60).default(15),
  modIds: z
    .array(z.string().regex(/^\d{1,20}$/))
    .max(60)
    .default([]),
  advancedIni: z
    .object({ settings: z.string().max(50000), game: z.string().max(50000) })
    .optional(),
  extraGameIni: z.string().max(50000).default(''),
  extraSettingsIni: z.string().max(50000).default(''),
});
export const gameConfigSchema = gameConfigFields.superRefine((config, context) => {
  const message = gameIniIssue(config);
  if (message) context.addIssue({ code: 'custom', message });
});
const clusterPresetFields = {
  name,
  overwrite: z.object({ id: z.uuid(), revision: z.uuid() }).optional(),
  updateMaps: z.boolean().default(false),
};
export const saveClusterPresetSchema = z.discriminatedUnion('kind', [
  z.object({ ...clusterPresetFields, kind: z.literal('game'), config: gameConfigSchema }),
  z.object({
    ...clusterPresetFields,
    kind: z.literal('mods'),
    modIds: gameConfigSchema.shape.modIds,
  }),
]);
export type SaveClusterPresetInput = z.infer<typeof saveClusterPresetSchema>;
export const createHostSchema = z.object({ name, address: z.string().trim().max(200).default('') });
export const gameAdminPasswordSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, '游戏管理员密码需为 1–128 位字母、数字、短横线或下划线。');
export const clusterIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{0,48}$/);
export const clusterSettingsSchema = z.object({
  serverNamePrefix: z
    .string()
    .trim()
    .max(CLUSTER_SERVER_NAME_PREFIX_LIMIT)
    .refine((value) => !/[\r\n]/.test(value) && !value.includes('\0'), '公共前缀请填写一行文本。'),
});
const instanceFields = z.object({
  branch: z.enum(['public', 'preaquatica']).default('public'),
  autoBranchUpdate: z.boolean().default(true),
  serverFileSource: z
    .union([z.literal('auto'), z.literal('download'), z.string().uuid()])
    .default('auto'),
  hostId: z.string().uuid(),
  name,
  map: z.enum(MAPS.map((item) => item.value)),
  clusterId: clusterIdSchema.default(''),
  gamePort: port.default(7777),
  queryPort: port.default(27015),
  rconPort: port.default(27020),
  autoRestart: z.boolean().default(true),
  config: gameConfigSchema.default(() => gameConfigSchema.parse({})),
});
export const createInstanceSchema = instanceFields.extend({
  name: name.optional(),
  config: gameConfigFields.extend({ sessionName: steamServerName.optional() }).prefault({}),
});
export const fileTaskSchema = z.object({
  branch: z.enum(['public', 'preaquatica']).optional(),
  hostId: z.string().uuid(),
  assetId: z.string().uuid().optional(),
  kind: z.enum([
    'scan',
    'download',
    'import',
    'clone',
    'verify',
    'update',
    'delete',
    'open',
    'rename',
  ]),
  name: z.string().trim().min(1).max(100).optional(),
  sourcePath: z.string().trim().min(1).max(1000).optional(),
  idempotencyKey: z.string().uuid(),
});
export const serverFilesReportSchema = z.object({
  branch: z.enum(['public', 'preaquatica', 'unknown']).optional(),
  id: z.string().uuid(),
  hostId: z.string().uuid(),
  name: z.string().min(1).max(100),
  path: z.string().min(1).max(1000),
  platform: z.enum(['windows', 'linux']),
  status: z.enum(['ready', 'in-use', 'partial', 'missing', 'busy', 'error']),
  instanceId: z.string().uuid().nullable(),
  instanceIds: z.array(z.string().uuid()).max(2000).optional(),
  sizeBytes: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
  fileCount: z.number().int().nonnegative(),
  buildId: z.string().max(100).nullable(),
  origin: z.enum(['download', 'map', 'import', 'copy']),
  sourceId: z.string().uuid().nullable(),
  verifiedAt: z.string().datetime().nullable(),
  lastError: z.string().max(3000).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export const updateInstanceSchema = instanceFields.omit({ hostId: true }).partial();
export const botSchema = z.object({
  name,
  appId: z
    .string()
    .trim()
    .regex(/^\d{5,30}$/),
  appSecret: z.string().min(8).max(256),
  owner: z.string().trim().max(80).default(''),
  enabled: z.boolean().default(true),
  certified: z.boolean().default(false),
  eventMode: z.enum(['webhook', 'websocket']).default('webhook'),
  isDefault: z.boolean().default(false),
});
export const subscriptionSchema = z.object({
  customer: name,
  instanceId: z.string().uuid(),
  tribeId: z.string().regex(/^\d{1,20}$/),
  tribeName: name,
  botMode: z.enum(['default', 'custom']).default('default'),
  botId: z.string().uuid(),
  groupId: z.string().uuid(),
  enabled: z.boolean().default(true),
  expiresAt: z.string().datetime().nullable().default(null),
});
export const commandSchema = z.object({
  kind: z.enum(COMMAND_KINDS),
  countdownSeconds: z.number().int().min(0).max(3600).default(30),
  message: z.string().trim().max(500).optional(),
  playerId: z
    .string()
    .regex(/^\d{1,24}$/)
    .optional(),
  backupId: z.string().uuid().optional(),
  idempotencyKey: z.string().uuid(),
  maintenance: z.boolean().default(false),
  terminateStartup: z.boolean().optional(),
});
export const tribeEventSchema = z.object({
  sourceId: z.string().min(1).max(200),
  instanceId: z.string().uuid(),
  tribeId: z.string().regex(/^\d{1,20}$/),
  tribeName: z.string().trim().min(1).max(100),
  text: z.string().min(1).max(64000),
  occurredAt: z.string().datetime(),
});
export const scheduleSchema = z.object({
  instanceId: z.string().uuid(),
  name,
  kind: z.enum(['restart', 'backup', 'update']),
  cron: z.string().trim().min(5).max(100),
  enabled: z.boolean().default(true),
  countdownSeconds: z.number().int().min(0).max(3600).default(30),
  timezone: z.string().default('Asia/Shanghai'),
});
export const loginSchema = z.object({ email: z.email(), password: z.string().min(1).max(200) });
export const registerSchema = z.object({
  name: z.string().trim().min(1, '请输入显示名称。').max(80, '显示名称最多 80 个字符。'),
  email: z.email('请输入有效的邮箱地址。').max(254, '邮箱地址过长。'),
  password: z
    .string()
    .min(12, '密码至少 12 个字符。')
    .max(72, '密码最多 72 字节。')
    .refine((password) => new TextEncoder().encode(password).length <= 72, '密码最多 72 字节。'),
});
export const enrollSchema = z.object({
  code: z.string().min(16).max(200),
  platform: z.enum(['windows', 'linux']),
  agentVersion: z.string().max(30),
});
const connectionPeer = z
  .string()
  .trim()
  .max(250)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['tcp:', 'udp:', 'ws:', 'wss:'].includes(url.protocol) &&
        !!url.hostname &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, '请填写有效的 EasyTier 节点地址，例如 tcp://node.example.com:11010');
export const connectionNetworkSchema = z.object({
  name,
  controllerHostId: z.string().uuid(),
  instanceId: z.string().uuid(),
  peers: z.array(connectionPeer).min(1).max(8),
  enabled: z.boolean().default(true),
});
export const connectionInviteSchema = z.object({
  steamId: z
    .string()
    .regex(/^\d{17}$/)
    .optional(),
  name,
  autoLaunch: z.boolean().default(false),
});
export type ConnectionNetworkInput = z.infer<typeof connectionNetworkSchema>;
export type CreateInstanceInput = z.infer<typeof createInstanceSchema>;
export type UpdateInstanceInput = z.infer<typeof updateInstanceSchema>;
export type BotInput = z.infer<typeof botSchema>;
export type SubscriptionInput = z.infer<typeof subscriptionSchema>;
export type CommandInput = z.infer<typeof commandSchema>;
export type TribeEventInput = z.infer<typeof tribeEventSchema>;
