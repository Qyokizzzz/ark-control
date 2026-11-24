import type { COMMAND_KINDS, INSTANCE_STATUSES, THEMES } from '@common/constants';
import type { IniFile } from '@common/game-config';
import type { PluginReport } from '@common/server-plugins';

export type InstanceStatus = (typeof INSTANCE_STATUSES)[number];
export type CommandKind = (typeof COMMAND_KINDS)[number];
export type ThemeName = (typeof THEMES)[number];
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ApiEnvelope<T> {
  code: string;
  message: string;
  data: T;
  requestId: string;
}
export interface Admin {
  id: string;
  email: string;
  name: string;
  platformAdmin?: boolean;
}
export interface ResourceMetrics {
  cpuPercent: number;
  cpuCores: number;
  cpuModel: string;
  totalMemoryMb: number;
  freeMemoryMb: number;
  diskFreeGb: number;
  diskTotalGb: number;
  gameDiskMeasured?: boolean;
  sampledAt: string;
}
export interface Host {
  branchBuilds?: BranchBuild[];
  features?: string[];
  id: string;
  name: string;
  address: string;
  platform: 'windows' | 'linux' | 'unknown';
  status: 'online' | 'offline' | 'unconfigured' | 'disconnecting' | 'disconnected';
  disconnectError?: string | null;
  pendingCleanups?: number;
  cleanupError?: string | null;
  agentWarnings?: string[];
  metrics: ResourceMetrics | null;
  lastSeenAt: string | null;
  createdAt: string;
  agentVersion: string | null;
  connections?: ConnectionReport[];
}
export interface GameConfig {
  sessionName: string;
  serverPassword: string;
  maxPlayers: number;
  pve: boolean;
  xp: number;
  harvest: number;
  taming: number;
  breeding: number;
  eggHatch: number;
  babyMature: number;
  difficulty: number;
  autoSaveMinutes: number;
  modIds: string[];
  advancedIni?: { settings: string; game: string };
  extraGameIni: string;
  extraSettingsIni: string;
}
export interface StartupProgress {
  stage: 'preparing' | 'launching' | 'loading' | 'ready' | 'failed';
  startedAt: string;
  updatedAt: string;
  message: string;
  rconReady: boolean;
  lastRconError: string | null;
  logUpdatedAt: string | null;
  logPaths: string[];
  logs: string[];
}
export interface Instance {
  plugins?: PluginReport;
  branch?: GameBranch;
  autoBranchUpdate?: boolean;
  serverFileSource?: string;
  serverFileId?: string | null;
  startup?: StartupProgress | null;
  canDeleteDirectly?: boolean;
  filesTouched?: boolean;
  configFilesTouched?: boolean;
  configSyncCommandId?: string;
  id: string;
  hostId: string;
  name: string;
  map: string;
  mapLabel: string;
  clusterId: string;
  gamePort: number;
  queryPort: number;
  rconPort: number;
  status: InstanceStatus;
  desiredState: 'running' | 'stopped';
  installed: boolean;
  config: GameConfig;
  autoRestart: boolean;
  cpuPercent: number;
  memoryMb: number;
  pid: number | null;
  startedAt: string | null;
  lastError: string | null;
  buildId: string | null;
  createdAt: string;
}
export interface Bot {
  platformManaged?: boolean;
  id: string;
  name: string;
  appId: string;
  owner: string;
  isDefault: boolean;
  enabled: boolean;
  certified: boolean;
  eventMode: 'webhook' | 'websocket';
  status: string;
  lastError: string | null;
  verifiedAt: string | null;
  createdAt: string;
  hasSecret: boolean;
}
export interface QqGroup {
  id: string;
  botId: string;
  openId: string;
  name: string;
  groupNumber: string;
  verifiedAt: string;
  createdAt: string;
}
export interface Tribe {
  id: string;
  instanceId: string;
  tribeId: string;
  name: string;
  lastSeenAt: string;
}
export interface Subscription {
  id: string;
  customer: string;
  instanceId: string;
  tribeId: string;
  tribeName: string;
  botId: string;
  groupId: string;
  botMode: 'default' | 'custom';
  enabled: boolean;
  expiresAt: string | null;
  createdAt: string;
}
export interface TribeEvent {
  id: string;
  sourceId: string;
  instanceId: string;
  tribeId: string;
  tribeName: string;
  text: string;
  normalizedText: string;
  occurredAt: string;
  receivedAt: string;
}
export interface Delivery {
  id: string;
  subscriptionId: string;
  botId: string;
  groupId: string;
  instanceId: string;
  tribeId: string;
  mapLabel: string;
  tribeName: string;
  body: string;
  count: number;
  firstAt: string;
  windowEndsAt: string;
  status: 'pending' | 'ready' | 'sending' | 'sent' | 'retry' | 'blocked' | 'uncertain' | 'skipped';
  attempts: number;
  nextAttemptAt: string;
  qqMessageId: string | null;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
}
export interface Command {
  id: string;
  hostId: string;
  instanceId: string;
  clusterId?: string;
  kind: CommandKind | 'sync-config' | 'install-plugins';
  payload: Record<string, Json>;
  status:
    | 'waiting-agent'
    | 'queued'
    | 'leased'
    | 'executing'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'cancelling';
  progress: string;
  result: Record<string, Json> | null;
  error: string | null;
  leaseUntil: string | null;
  idempotencyKey: string;
  createdAt: string;
  completedAt: string | null;
}
export interface Backup {
  id: string;
  instanceId: string;
  commandId: string;
  name: string;
  size: number;
  sha256: string;
  createdAt: string;
  status: 'ready' | 'uploading' | 'error';
}
export interface Schedule {
  id: string;
  instanceId: string;
  name: string;
  kind: 'restart' | 'backup' | 'update';
  cron: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  countdownSeconds: number;
  timezone: string;
  createdAt: string;
}
export interface AuditEntry {
  id: string;
  actor: string;
  actorId?: string;
  action: string;
  target: string;
  instanceId?: string;
  detail: string;
  createdAt: string;
  changeCount?: number;
}
export type ConfigChangeValue = string | number | boolean | string[] | null;
export type ConfigChangeTarget =
  | { source: 'instance' | 'basic'; key: string }
  | { source: 'advanced' | 'manual'; file: IniFile; section?: string; key?: string };
export type ConfigChange = ConfigChangeTarget & {
  before: ConfigChangeValue;
  after: ConfigChangeValue;
  redacted?: true;
};
export interface ConfigAuditEntry extends AuditEntry {
  changes: ConfigChange[];
}
export interface ConfigSaveSummary {
  auditId: string | null;
  total: number;
  changes: ConfigChange[];
}
export type InstanceUpdateResult = Instance & { configSave: ConfigSaveSummary };
export interface ConsoleEntry {
  id: string;
  instanceId: string;
  level: 'info' | 'warn' | 'error';
  text: string;
  createdAt: string;
}
export interface Player {
  id: string;
  name: string;
  steamId: string;
}
export interface CapacityEstimate {
  verdict: 'sufficient' | 'tight' | 'insufficient' | 'unknown';
  availableMemoryMb: number;
  estimatedMemoryMb: number;
  reserveMemoryMb: number;
  blockingReasons: string[];
  explanation: string[];
}
export interface Dashboard {
  serverFiles?: ServerFiles[];
  fileTasks?: FileTask[];
  demo: boolean;
  hosts: Host[];
  instances: Instance[];
  bots: Bot[];
  groups: QqGroup[];
  subscriptions: Subscription[];
  tribes: Tribe[];
  deliveries: Delivery[];
  events: TribeEvent[];
  commands: Command[];
  backups: Backup[];
  schedules: Schedule[];
  audit: AuditEntry[];
  console: ConsoleEntry[];
  summary: { running: number; total: number; sentToday: number; pending: number; errors: number };
}
export interface AgentInstance extends Instance {
  shopMode?: import('@common/management').ShopMode;
  rconPassword: string;
  useClusterAdminPassword?: boolean;
  clusterAdminRevision?: string;
  runtimeClusterId?: string;
  credentialError?: string;
}
export interface AgentCommand extends Command {
  instance: AgentInstance;
}
export interface AgentPoll {
  managementTasks?: AgentManagementTask[];
  fileTasks?: AgentFileTask[];
  warnings?: string[];
  disconnectRequested?: boolean;
  commands: AgentCommand[];
  cancellations: string[];
  instances: AgentInstance[];
  connections?: HostConnectionConfig[];
}

export interface ServerFiles {
  branch?: GameBranch | 'unknown';
  id: string;
  hostId: string;
  name: string;
  path: string;
  platform: 'windows' | 'linux';
  status: 'ready' | 'in-use' | 'partial' | 'missing' | 'busy' | 'error' | 'deleted';
  instanceId: string | null;
  instanceIds?: string[];
  sizeBytes: number;
  fileCount: number;
  buildId: string | null;
  origin: 'download' | 'map' | 'import' | 'copy';
  sourceId: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
export type FileOperation =
  'scan' | 'download' | 'import' | 'clone' | 'verify' | 'update' | 'delete' | 'open' | 'rename';
export interface FileTask {
  id: string;
  hostId: string;
  assetId: string | null;
  kind: FileOperation;
  payload: Record<string, Json>;
  status: Exclude<Command['status'], 'waiting-agent'>;
  progress: string;
  error: string | null;
  result: Record<string, Json> | null;
  idempotencyKey: string;
  leaseUntil: string | null;
  createdAt: string;
  completedAt: string | null;
}
export interface AgentFileTask extends FileTask {
  asset: ServerFiles | null;
  source: ServerFiles | null;
}
export interface InstanceReport {
  plugins?: PluginReport;
  verifiedClusterAdminRevision?: string;
  serverFileId?: string | null;
  startup?: StartupProgress | null;
  id: string;
  status: InstanceStatus;
  installed: boolean;
  cpuPercent: number;
  memoryMb: number;
  pid: number | null;
  startedAt: string | null;
  lastError: string | null;
  buildId: string | null;
}

export interface ConnectionNetwork {
  id: string;
  name: string;
  controllerHostId: string;
  instanceId: string;
  peers: string[];
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface ConnectionInvite {
  steamId?: string;
  id: string;
  networkId: string;
  name: string;
  enabled: boolean;
  autoLaunch: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}
export interface ConnectionReport {
  networkId: string;
  status: 'starting' | 'started' | 'error';
  message: string;
}
export interface HostConnectionConfig {
  networkId: string;
  networkName: string;
  networkSecret: string;
  ipv4: string;
  peers: string[];
  tcpPorts: number[];
  udpPorts: number[];
}
export interface ConnectionState {
  networks: ConnectionNetwork[];
  invites: ConnectionInvite[];
  launcherReady: boolean;
}
export interface ConnectionBootstrap {
  manifestOrigin?: string;
  deviceScope?: string;
  steamId?: string;
  version: 1;
  networkId: string;
  inviteId: string;
  inviteToken: string;
  networkName: string;
  networkSecret: string;
  controllerIp: string;
  controllerPort: number;
  peers: string[];
  publicKey: { n: string; e: string };
  autoLaunch: boolean;
}
export interface ConnectionManifest {
  deviceBlocked?: boolean;
  networkId: string;
  inviteId: string;
  revision: number;
  issuedAt: number;
  expiresAt: number;
  enabled: boolean;
  peers: string[];
  game: {
    ipv4: string;
    gamePort: number;
    queryPort: number;
    name: string;
    mapLabel: string;
    running: boolean;
  };
}

export type GameBranch = 'public' | 'preaquatica';
export interface BranchBuild {
  branch: GameBranch;
  buildId: string;
  checkedAt: string;
}
export interface PlayerPresence {
  instanceId: string;
  sampledAt: string;
  source: 'rcon' | 'bridge';
  players: { steamId: string; name: string; ip?: string; tribeId?: string; tribeName?: string }[];
}
export interface ManagedPlayer {
  permissionGroups?: string[];
  id: string;
  scopeId: string;
  steamId: string;
  name: string;
  names: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  onlineMaps: string[];
  lastMapId: string | null;
  onlineSeconds: number;
  tribeId: string | null;
  tribeName: string | null;
  addresses: { address: string; source: 'game' | 'client'; seenAt: string }[];
  devices: { id: string; source: 'client'; seenAt: string }[];
  note: string;
  balance: number | null;
  balanceUpdatedAt: string | null;
  vip: { group: string; expiresAt: string | null }[];
  vipUpdatedAt: string | null;
}
export interface PlayerBan {
  id: string;
  scopeId: string;
  steamId: string;
  targets: { steam: boolean; ips: string[]; devices: string[] };
  reason: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}
export type ManagementKind =
  'sync' | 'coins' | 'vip-grant' | 'vip-revoke' | 'ban' | 'unban' | 'shop-read' | 'shop-publish';
export interface ManagementTask {
  id: string;
  scopeId: string;
  hostId: string;
  instanceId: string;
  steamId: string | null;
  kind: ManagementKind;
  payload: Record<string, Json>;
  status: 'queued' | 'leased' | 'executing' | 'succeeded' | 'failed' | 'uncertain' | 'cancelled';
  idempotencyKey: string;
  progress: string;
  result: Record<string, Json> | null;
  error: string | null;
  leaseUntil: string | null;
  createdAt: string;
  completedAt: string | null;
}
export interface LedgerEntry {
  id: string;
  scopeId: string;
  steamId: string | null;
  instanceId: string;
  kind: string;
  source: 'admin' | 'game';
  operationId: string;
  createdAt: string;
  detail: Record<string, Json>;
  status: 'pending' | 'succeeded' | 'failed' | 'uncertain';
}
export interface ShopDraft {
  id: string;
  scopeId: string;
  revision: number;
  config: Record<string, Json>;
  updatedAt: string;
  publishedRevision: number | null;
}
export interface ShopSectionChange {
  section: string;
  added: number;
  modified: number;
  removed: number;
}
export interface ShopPublishPreview {
  current: boolean;
  pending: boolean;
  ready: boolean;
  maps: {
    id: string;
    name: string;
    progress: string;
    error: string | null;
    changes: ShopSectionChange[] | null;
  }[];
}
export interface PlayerScope {
  id: string;
  name: string;
  instanceIds: string[];
  branch: GameBranch;
}
export interface ClusterAdminSettings {
  id: string;
  updatedAt: string | null;
  maps: {
    id: string;
    name: string;
    status: 'individual' | 'restart' | 'verifying' | 'failed' | 'applied' | 'update-agent';
  }[];
}
export interface ManagementState {
  scopes: PlayerScope[];
  players: ManagedPlayer[];
  total: number;
  page: number;
  bans: PlayerBan[];
  tasks: ManagementTask[];
  ledger: LedgerEntry[];
  shop: ShopDraft | null;
  shopMode: import('@common/management').ShopMode | null;
  independentCatalog: import('@common/management').IndependentCatalog | null;
  links: EconomyLink[];
  settings: ManagementSettings | null;
  rollouts: BranchRollout[];
}
export interface ManagementSettings {
  id: string;
  vipGroups: string[];
}
export interface EconomyLink {
  id: string;
  shopDatabase: string | null;
  permissionsDatabase: string | null;
  shopHash: string;
  checkedAt: string;
  config: Record<string, Json>;
}
export interface AgentManagementTask extends ManagementTask {
  instance: AgentInstance;
}
export interface BranchRollout {
  id: string;
  scopeId: string;
  buildId: string;
  phase: 'stopping' | 'updating' | 'starting' | 'succeeded' | 'failed';
  instanceIds: string[];
  resumeIds: string[];
  commands: string[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface GameCommerceEvent {
  eventId: string;
  instanceId: string;
  steamId: string;
  kind: string;
  occurredAt: string;
  detail: Record<string, Json>;
}
