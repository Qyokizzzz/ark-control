import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import mysql from 'mysql2/promise';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type {
  AuditEntry,
  Backup,
  Bot,
  Command,
  ConfigChange,
  ConsoleEntry,
  Delivery,
  Dashboard,
  Host,
  Instance,
  QqGroup,
  Schedule,
  Subscription,
  Tribe,
  TribeEvent,
  ConnectionNetwork,
  ConnectionInvite,
  ServerFiles,
  FileTask,
  ManagedPlayer,
  PlayerPresence,
  PlayerBan,
  ManagementTask,
  LedgerEntry,
  ShopDraft,
  EconomyLink,
  ManagementSettings,
  IndependentCatalog,
  IndependentWallet,
  ShopMode,
  ShopOrder,
  ShopOrderPage,
  BranchRollout,
  Workspace,
  WorkspaceGrant,
  PluginPackage,
} from '@ark-control/common';
import { config } from '@/infrastructure/config';
import { BusinessError } from '@/infrastructure/errors';
import { ensureResourceSchema } from '@/infrastructure/schema';
import { runInWorkspace, workspaceContext } from '@/workspaces/context';

export interface PrivateHost {
  id: string;
  tokenHash: string | null;
  codeHash: string;
  codeExpiresAt: string;
}
export interface PrivateInstance {
  id: string;
  rconPassword: string;
  clusterAdminRevision?: string;
  clusterAdminAppliedAt?: string | null;
}
export interface PrivateBot {
  id: string;
  secret: string;
}
export interface BindingCode {
  id: string;
  botId: string;
  codeHash: string;
  expiresAt: string;
  usedAt: string | null;
  groupId: string | null;
}
export interface Account {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  platformAdmin?: boolean;
  disabled?: boolean;
}
export interface Membership {
  id: string;
  accountId: string;
  workspaceId: string;
  grants: WorkspaceGrant[];
  createdAt: string;
  version: string;
}
export interface Invitation {
  id: string;
  workspaceId: string;
  email: string;
  codeHash: string;
  expiresAt: string;
  grants: WorkspaceGrant[];
}
export interface Session {
  id: string;
  userId: string;
  familyId: string;
  hash: string;
  expiresAt: string;
  revoked: boolean;
}
export interface RecordMap {
  'managed-players': ManagedPlayer;
  'player-presence': PlayerPresence & { id: string };
  'player-bans': PlayerBan;
  'management-tasks': ManagementTask;
  ledger: LedgerEntry;
  'shop-drafts': ShopDraft;
  'shop-history': ShopDraft & { operationId: string };
  'shop-modes': { id: string; mode: ShopMode };
  'independent-catalogs': IndependentCatalog;
  'independent-wallets': IndependentWallet;
  'shop-orders': ShopOrder;
  'shop-purchase-counts': { id: string; count: number };
  'economy-links': EconomyLink;
  'management-settings': ManagementSettings;
  'branch-rollouts': BranchRollout;
  'management-requests': { id: string; fingerprint: string; taskIds: string[] };
  'plugin-packages': PluginPackage;
  'plugin-requests': { id: string; fingerprint: string; commandIds: string[] };
  'server-files': ServerFiles;
  'file-tasks': FileTask;
  'instance-cleanups': {
    id: string;
    hostId: string;
    instance: Instance;
    rconPassword: string;
    commandId: string;
    lastError: string | null;
  };
  'connection-networks': ConnectionNetwork;
  'connection-invites': ConnectionInvite & { tokenHash: string; token: string };
  'connection-credentials': { id: string; secret: string };
  hosts: Host;
  instances: Instance;
  bots: Bot;
  groups: QqGroup;
  subscriptions: Subscription;
  tribes: Tribe;
  events: TribeEvent;
  deliveries: Delivery;
  commands: Command;
  backups: Backup;
  schedules: Schedule;
  audit: AuditEntry;
  'config-audit-details': { id: string; changes: ConfigChange[] };
  console: ConsoleEntry;
  'host-credentials': PrivateHost;
  'instance-credentials': PrivateInstance;
  'cluster-admin-passwords': {
    id: string;
    password: string;
    revision: string;
    updatedAt: string;
  };
  'bot-credentials': PrivateBot;
  'binding-codes': BindingCode;
  accounts: Account;
  sessions: Session;
  workspaces: Workspace;
  memberships: Membership;
  invitations: Invitation;
}
type Kind = keyof RecordMap;
export type Connection = PoolConnection;
const globalKinds = new Set<Kind>([
  'accounts',
  'sessions',
  'workspaces',
  'memberships',
  'invitations',
]);
const parseBody = <T>(row: RowDataPacket): T =>
  (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as T;
export const membershipId = (workspaceId: string, accountId: string) =>
  `${workspaceId}:${accountId}`;

/** Resource documents keep configuration versionable; event IDs, delivery membership and quotas have SQL constraints. */
@Injectable()
export class Database implements OnModuleInit, OnModuleDestroy {
  readonly pool = mysql.createPool({
    host: config.DATABASE_HOST,
    port: config.DATABASE_PORT,
    user: config.DATABASE_USER,
    password: config.DATABASE_PASSWORD,
    database: config.DATABASE_NAME,
    connectionLimit: 12,
    timezone: 'Z',
    charset: 'utf8mb4',
    multipleStatements: false,
  });
  private readonly ready: Promise<void>;
  constructor() {
    this.ready = this.initialize();
  }
  onModuleInit() {
    return this.ready;
  }
  get workspaceId() {
    const id = workspaceContext.getStore()?.workspaceId;
    if (!id) throw new Error('Workspace context is required for game resources');
    return id;
  }
  private scope(kind: Kind) {
    return globalKinds.has(kind) ? '' : this.workspaceId;
  }
  private async initialize() {
    await this.pool.execute(`CREATE TABLE IF NOT EXISTS resources (
      workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
      kind VARCHAR(32) NOT NULL, id VARCHAR(100) COLLATE utf8mb4_bin NOT NULL, body JSON NOT NULL,
      revision BIGINT NOT NULL DEFAULT 1, updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      state VARCHAR(24) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(body, '$.status'))) STORED,
      due_at VARCHAR(32) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(body, '$.nextAttemptAt'))) STORED,
      PRIMARY KEY(workspace_id,kind,id), INDEX idx_workspace_state(workspace_id,kind,state,due_at),
      INDEX idx_workspace_updated(workspace_id,kind,updated_at), INDEX idx_public_resource(kind,id)
    ) ENGINE=InnoDB`);
    await ensureResourceSchema(this.pool);
    await this.pool.execute(
      'CREATE TABLE IF NOT EXISTS workspace_event_keys (workspace_id CHAR(36) NOT NULL, instance_id VARCHAR(100) NOT NULL, source_id VARCHAR(200) NOT NULL, event_id VARCHAR(100) NOT NULL, PRIMARY KEY(workspace_id,instance_id,source_id)) ENGINE=InnoDB',
    );
    await this.pool.execute(
      'CREATE TABLE IF NOT EXISTS workspace_delivery_events (workspace_id CHAR(36) NOT NULL, event_id VARCHAR(100) NOT NULL, subscription_id VARCHAR(100) NOT NULL, delivery_id VARCHAR(100) NOT NULL, PRIMARY KEY(workspace_id,event_id,subscription_id), INDEX idx_delivery(workspace_id,delivery_id)) ENGINE=InnoDB',
    );
    await this.pool.execute(
      'CREATE TABLE IF NOT EXISTS quotas (scope_key VARCHAR(200) NOT NULL, period_key VARCHAR(40) NOT NULL, amount INT NOT NULL DEFAULT 0, PRIMARY KEY(scope_key,period_key)) ENGINE=InnoDB',
    );
  }
  async transaction<T>(operation: (connection: Connection) => Promise<T>): Promise<T> {
    await this.ready;
    const connection = await this.pool.getConnection();
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT GET_LOCK('ark-control-domain', 15) AS acquired",
      );
      if (rows[0]?.acquired !== 1) throw new Error('Database write lock timeout');
      await connection.beginTransaction();
      const context = workspaceContext.getStore();
      if (context?.workspaceId) {
        const workspace = await this.get('workspaces', context.workspaceId, connection);
        if (workspace?.status !== 'active')
          throw new BusinessError('WORKSPACE_UNAVAILABLE', '工作空间暂不可用。', 403);
        if (context.actor) {
          const account = await this.get('accounts', context.actor.id, connection);
          if (!account || account.disabled)
            throw new BusinessError('UNAUTHORIZED', '账号已停用或会话已过期。', 401);
          if (workspace.ownerId !== account.id) {
            const member = await this.get(
              'memberships',
              membershipId(workspace.id, account.id),
              connection,
            );
            if (!member || member.version !== context.membershipVersion)
              throw new BusinessError('WORKSPACE_SCOPE_CHANGED', '权限已更新，请刷新后重试。', 403);
          }
        }
        if (context.agentHostId) {
          const credential = await this.get('host-credentials', context.agentHostId, connection);
          if (credential?.tokenHash !== context.agentTokenHash)
            throw new BusinessError('AGENT_UNAUTHORIZED', '主机助手凭据已更换。', 401);
        }
      }
      const value = await operation(connection);
      await connection.commit();
      return value;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.query("SELECT RELEASE_LOCK('ark-control-domain')");
      connection.release();
    }
  }
  async list<K extends Kind>(
    kind: K,
    connection?: Connection,
    limit = 10000,
  ): Promise<RecordMap[K][]> {
    await this.ready;
    const [rows] = await (connection ?? this.pool).query<RowDataPacket[]>(
      'SELECT body FROM resources WHERE workspace_id=? AND kind=? ORDER BY updated_at DESC LIMIT ?',
      [this.scope(kind), kind, Math.min(limit, 100000)],
    );
    return rows.map(
      (row) => (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as RecordMap[K],
    );
  }
  async get<K extends Kind>(
    kind: K,
    id: string,
    connection?: Connection,
  ): Promise<RecordMap[K] | null> {
    await this.ready;
    const [rows] = await (connection ?? this.pool).execute<RowDataPacket[]>(
      'SELECT body FROM resources WHERE workspace_id=? AND kind=? AND id=?',
      [this.scope(kind), kind, id],
    );
    const row = rows[0];
    return row
      ? ((typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as RecordMap[K])
      : null;
  }
  async listBy<K extends Kind>(
    kind: K,
    field: keyof RecordMap[K] & string,
    value: string,
    connection?: Connection,
  ) {
    await this.ready;
    const [rows] = await (connection ?? this.pool).execute<RowDataPacket[]>(
      'SELECT body FROM resources WHERE workspace_id=? AND kind=? AND JSON_UNQUOTE(JSON_EXTRACT(body,?))=?',
      [this.scope(kind), kind, `$.${field}`, value],
    );
    return rows.map(parseBody<RecordMap[K]>);
  }
  // Public callbacks and Agent tokens use server-generated IDs to locate their tenant.
  async locate(kind: 'hosts' | 'bots' | 'connection-invites', id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    await this.ready;
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      "SELECT workspace_id FROM resources WHERE kind=? AND id=? AND workspace_id<>'' LIMIT 2",
      [kind, id],
    );
    return rows.length === 1 ? String(rows[0]!.workspace_id) : null;
  }
  async locateEnrollment(codeHash: string) {
    await this.ready;
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      "SELECT workspace_id,id FROM resources WHERE kind='host-credentials' AND workspace_id<>'' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.codeHash'))=? LIMIT 2",
      [codeHash],
    );
    if (rows.length !== 1) return null;
    return { workspaceId: String(rows[0]!.workspace_id), hostId: String(rows[0]!.id) };
  }
  async locateBindingWorkspace(botId: string, codeHash: string) {
    await this.ready;
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      "SELECT workspace_id FROM resources WHERE kind='binding-codes' AND workspace_id<>'' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.botId'))=? AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.codeHash'))=? LIMIT 2",
      [botId, codeHash],
    );
    return rows.length === 1 ? String(rows[0]!.workspace_id) : null;
  }
  async forEachActiveWorkspace(callback: (workspaceId: string) => Promise<void>) {
    const active = await this.inStates('workspaces', ['active']);
    for (let offset = 0; offset < active.length; offset += 4) {
      await Promise.all(
        active.slice(offset, offset + 4).map((workspace) =>
          runInWorkspace(workspace.id, () => callback(workspace.id)).catch((error: unknown) => {
            console.error(
              '工作空间维护失败',
              workspace.id,
              error instanceof Error ? error.name : 'UnknownError',
            );
          }),
        ),
      );
    }
  }
  async inStates<K extends Kind>(
    kind: K,
    states: readonly string[],
    connection?: Connection,
  ): Promise<RecordMap[K][]> {
    await this.ready;
    if (!states.length) return [];
    const [rows] = await (connection ?? this.pool).execute<RowDataPacket[]>(
      `SELECT body FROM resources WHERE workspace_id=? AND kind=? AND state IN (${states.map(() => '?').join(',')}) ORDER BY updated_at`,
      [this.scope(kind), kind, ...states],
    );
    return rows.map(
      (row) => (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as RecordMap[K],
    );
  }
  async findIdempotentCommand(key: string, connection: Connection): Promise<Command | null> {
    await this.ready;
    const [rows] = await connection.execute<RowDataPacket[]>(
      "SELECT body FROM resources WHERE workspace_id=? AND kind='commands' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.idempotencyKey'))=? LIMIT 1",
      [this.workspaceId, key],
    );
    const row = rows[0];
    return row
      ? ((typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as Command)
      : null;
  }
  async commandsByIds(ids: string[]): Promise<Command[]> {
    if (!ids.length) return [];
    await this.ready;
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT body FROM resources WHERE workspace_id=? AND kind='commands' AND id IN (?) ORDER BY updated_at DESC",
      [this.workspaceId, ids],
    );
    return rows.map((row) => (typeof row.body === 'string' ? JSON.parse(row.body) : row.body));
  }
  async ledgerPage(
    scopeId: string,
    page: number,
    steamId: string,
    source: string,
    before: string,
    adminKinds?: readonly string[],
  ) {
    await this.ready;
    const where =
      "workspace_id=? AND kind='ledger' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.scopeId'))=? AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.createdAt'))<=?" +
      (steamId ? " AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.steamId'))=?" : '') +
      (source ? " AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.source'))=?" : '') +
      (adminKinds?.length
        ? ` AND (JSON_UNQUOTE(JSON_EXTRACT(body,'$.source'))='game' OR JSON_UNQUOTE(JSON_EXTRACT(body,'$.kind')) IN (${adminKinds.map(() => '?').join(',')}))`
        : '');
    const values = [
      this.workspaceId,
      scopeId,
      before,
      ...(steamId ? [steamId] : []),
      ...(source ? [source] : []),
      ...(adminKinds ?? []),
    ];
    const [counts] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM resources WHERE ${where}`,
      values,
    );
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT body FROM resources WHERE ${where} ORDER BY JSON_UNQUOTE(JSON_EXTRACT(body,'$.createdAt')) DESC,id DESC LIMIT 100 OFFSET ?`,
      [...values, (page - 1) * 100],
    );
    return {
      entries: rows.map(
        (row) => (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as LedgerEntry,
      ),
      total: Number(counts[0]?.total ?? 0),
      page,
      before,
    };
  }
  async shopOrderPage(scopeId: string, page: number): Promise<ShopOrderPage> {
    await this.ready;
    const size = 25;
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      "SELECT body FROM resources WHERE workspace_id=? AND kind='shop-orders' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.scopeId'))=? ORDER BY JSON_UNQUOTE(JSON_EXTRACT(body,'$.createdAt')) DESC,id DESC LIMIT ? OFFSET ?",
      [this.workspaceId, scopeId, size + 1, (page - 1) * size],
    );
    return {
      entries: rows
        .slice(0, size)
        .map((row) => (typeof row.body === 'string' ? JSON.parse(row.body) : row.body)),
      page,
      hasMore: rows.length > size,
    };
  }
  async put<K extends Kind>(
    kind: K,
    item: RecordMap[K],
    connection?: Connection,
  ): Promise<RecordMap[K]> {
    await this.ready;
    await (connection ?? this.pool).execute(
      'INSERT INTO resources(workspace_id,kind,id,body) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE body=VALUES(body), revision=revision+1, updated_at=CURRENT_TIMESTAMP(3)',
      [this.scope(kind), kind, item.id, JSON.stringify(item)],
    );
    return item;
  }
  async remove(kind: Kind, id: string, connection?: Connection) {
    await this.ready;
    await (connection ?? this.pool).execute(
      'DELETE FROM resources WHERE workspace_id=? AND kind=? AND id=?',
      [this.scope(kind), kind, id],
    );
  }
  async dueDeliveries() {
    await this.ready;
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      "SELECT body FROM resources WHERE workspace_id=? AND kind='deliveries' AND state IN ('pending','ready','retry') AND due_at<=? ORDER BY due_at LIMIT 20",
      [this.workspaceId, new Date().toISOString()],
    );
    return rows.map(
      (row) => (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as Delivery,
    );
  }
  async deliverySummary(): Promise<Pick<Dashboard['summary'], 'sentToday' | 'pending' | 'errors'>> {
    await this.ready;
    const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const start = new Date(`${date}T00:00:00+08:00`);
    const end = new Date(start.getTime() + 86400000);
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COALESCE(SUM(state='sent' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.sentAt'))>=? AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.sentAt'))<?),0) AS sentToday,
      COALESCE(SUM(state IN ('pending','ready','retry','sending')),0) AS pending,
      COALESCE(SUM(state IN ('blocked','uncertain')),0) AS errors FROM resources WHERE workspace_id=? AND kind='deliveries'`,
      [start.toISOString(), end.toISOString(), this.workspaceId],
    );
    return {
      sentToday: Number(rows[0]?.sentToday ?? 0),
      pending: Number(rows[0]?.pending ?? 0),
      errors: Number(rows[0]?.errors ?? 0),
    };
  }
  async onModuleDestroy() {
    await this.pool.end();
  }
}
