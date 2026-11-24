export const APP_NAME = '方舟控制台';
export const AGGREGATION_WINDOW_MS = 30_000;
export const STEAM_APP_ID = '376030';
export const STEAM_WORKSHOP_APP_ID = '346110';
export const SHARED_MAP_FILES_FEATURE = 'shared-map-files-v1';
export const CONFIG_SYNC_FEATURE = 'config-sync-v1';
export const CLUSTER_ADMIN_PASSWORD_FEATURE = 'cluster-admin-password-v1';
export const CONFIG_CHANGE_PREVIEW_LIMIT = 3;
export const MAPS = [
  { value: 'TheIsland', label: '孤岛' },
  { value: 'ScorchedEarth_P', label: '焦土' },
  { value: 'TheCenter', label: '中心岛' },
  { value: 'Ragnarok', label: '仙境' },
  { value: 'Aberration_P', label: '畸变' },
  { value: 'Extinction', label: '灭绝' },
  { value: 'Valguero_P', label: '瓦尔盖罗' },
  { value: 'Genesis', label: '创世纪一' },
  { value: 'Gen2', label: '创世纪二' },
  { value: 'CrystalIsles', label: '水晶岛' },
  { value: 'LostIsland', label: '失落之岛' },
  { value: 'Fjordur', label: '维京湾' },
] as const;
export const INSTANCE_STATUSES = [
  'stopped',
  'installing',
  'starting',
  'running',
  'stopping',
  'updating',
  'restoring',
  'deleting',
  'error',
  'unknown',
] as const;
export const COMMAND_KINDS = [
  'install',
  'start',
  'stop',
  'restart',
  'force-stop',
  'delete',
  'update',
  'save',
  'backup',
  'restore',
  'players',
  'broadcast',
  'kick',
  'ban',
  'unban',
  'mods-update',
] as const;
export const THEMES = ['light', 'dark', 'blue', 'pink', 'yellow'] as const;
export const STATUS_LABELS: Record<string, string> = {
  stopped: '未启动',
  installing: '安装中',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  updating: '更新中',
  restoring: '恢复中',
  deleting: '删除中',
  error: '异常',
  unknown: '待确认',
  queued: '等待执行',
  'waiting-agent': '等待主机写入',
  leased: '等待接收',
  executing: '执行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  cancelling: '正在取消',
  pending: '合并中',
  ready: '待发送',
  sending: '发送中',
  sent: '已提交 QQ',
  retry: '等待重试',
  blocked: '需要处理',
  uncertain: '发送结果待确认',
  skipped: '已跳过',
  online: '在线',
  offline: '离线',
  unconfigured: '待配置',
  disconnecting: '正在断开',
  disconnected: '已断开',
  verified: '凭据有效',
};
