import { z } from 'zod';
import type { ShopMode } from '@common/management';
import type { Command, GameBranch, PlayerScope } from '@common/types';

export const SERVER_PLUGINS_FEATURE = 'server-plugins-v1';
export const ARKSHOP_UI_PLUGIN_FEATURE = 'arkshop-ui-plugin-v1';
export const ARKSHOP_UI_WORKSHOP_ID = '2693727499';
export const PLUGIN_ARCHIVE_LIMIT = 64 * 1024 ** 2;
export const pluginIdSchema = z.enum([
  'arkapi',
  'permissions',
  'arkshop',
  'arkshop-ui',
  'ark-control-shop',
]);
export const pluginBranchSchema = z.enum(['public', 'preaquatica']);
export type ServerPluginId = z.infer<typeof pluginIdSchema>;

export const serverPlugins: Record<
  ServerPluginId,
  { name: string; folder: string; dll: string; officialUrl?: string }
> = {
  arkapi: {
    name: 'ASE ArkApi',
    folder: 'ArkApi',
    dll: 'version.dll',
    officialUrl: 'https://forum.ark-server-api.com/resources/ase-server-api.32/',
  },
  permissions: {
    name: 'Permissions',
    folder: 'Permissions',
    dll: 'Permissions.dll',
    officialUrl: 'https://forum.ark-server-api.com/resources/ase-permissions.35/',
  },
  arkshop: {
    name: 'ArkShop',
    folder: 'ArkShop',
    dll: 'ArkShop.dll',
    officialUrl: 'https://forum.ark-server-api.com/resources/ase-arkshop.36/',
  },
  'arkshop-ui': {
    name: 'ArkShopUI',
    folder: 'ArkShopUI',
    dll: 'ArkShopUI.dll',
    officialUrl: 'https://forum.ark-server-api.com/resources/arkshopui.28/',
  },
  'ark-control-shop': {
    name: '独立商店插件',
    folder: 'ArkControlShop',
    dll: 'ArkControlShop.dll',
  },
};

export const shopPluginIds = (mode: ShopMode): ServerPluginId[] =>
  mode === 'arkshop' ? ['arkapi', 'permissions', 'arkshop'] : ['arkapi', 'ark-control-shop'];

export function requiredPlugins(selection: readonly ServerPluginId[]) {
  const ids = new Set(selection);
  if (ids.has('arkshop-ui')) ids.add('arkshop');
  if (ids.has('arkshop')) ids.add('permissions');
  if (ids.size) ids.add('arkapi');
  return pluginIdSchema.options.filter((id) => ids.has(id));
}

export const pluginReportSchema = z.object({
  checkedAt: z.string().datetime(),
  pid: z.number().int().positive().nullable(),
  installed: z.array(pluginIdSchema).max(pluginIdSchema.options.length),
  loaded: z.array(pluginIdSchema).max(pluginIdSchema.options.length).nullable(),
});
export type PluginReport = z.infer<typeof pluginReportSchema>;

export const pluginArchiveSchema = z.object({
  id: z.union([z.uuid(), z.literal('builtin')]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive().max(PLUGIN_ARCHIVE_LIMIT),
});
export type PluginArchive = z.infer<typeof pluginArchiveSchema>;
export type PluginPackage = {
  id: string;
  pluginId: ServerPluginId;
  branch: GameBranch;
  name: string;
  uploadedAt: string;
  archive: PluginArchive;
};

const pluginIdsSchema = z.array(pluginIdSchema).min(1).max(pluginIdSchema.options.length);
export const pluginInstallSchema = z.object({
  scopeId: z.string().min(1).max(112),
  mapIds: z.array(z.uuid()).min(1).max(200),
  pluginIds: pluginIdsSchema,
  idempotencyKey: z.uuid(),
});
export type PluginInstallRequest = z.infer<typeof pluginInstallSchema>;

export const pluginPlanSchema = z.object({
  branch: pluginBranchSchema,
  items: z
    .array(z.object({ pluginId: pluginIdSchema, archive: pluginArchiveSchema.nullable() }))
    .min(1)
    .max(pluginIdSchema.options.length),
});
export type PluginPlan = z.infer<typeof pluginPlanSchema>;

export interface PluginMap {
  id: string;
  scopeId: string;
  name: string;
  hostName: string;
  branch: GameBranch;
  running: boolean;
  blocked: string | null;
  arkShopUiSupported?: boolean;
  report: PluginReport | null;
  task: Pick<Command, 'id' | 'status' | 'progress' | 'error' | 'createdAt'> | null;
}

export interface ServerPluginsView {
  scopes: (PlayerScope & { mode: ShopMode })[];
  maps: PluginMap[];
  packages: Pick<PluginPackage, 'pluginId' | 'branch' | 'name' | 'uploadedAt'>[];
  builtinShop: boolean;
  canUpload: boolean;
}
