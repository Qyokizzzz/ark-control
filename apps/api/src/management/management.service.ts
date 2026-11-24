import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import {
  activeBan,
  activeManagement,
  emptyPlayer,
  isHostOnline,
  playerKey,
  playerScope,
  playerScopes,
  managementPermission,
  workspacePermissions,
  publicShopConfig,
  validateShopConfig,
  CONNECT_CONTROLLER_IP,
  CONNECT_GAME_IP,
} from '@ark-control/common';
import type {
  AgentManagementTask,
  GameCommerceEvent,
  Instance,
  Json,
  ManagementKind,
  ManagementState,
  ManagementTask,
  PlayerPresence,
  ShopPublishPreview,
  ShopSectionChange,
} from '@ark-control/common';
import { BusinessError, Database, decryptSecret } from '@/infrastructure';
import type { Connection } from '@/infrastructure';
import { ControlService, activeCommand, nowIso } from '@/control';
import { allowed, gameTarget, requireGameAccess } from '@/workspaces/access';
import { workspaceContext } from '@/workspaces/context';
import { IndependentShopService } from './independent-shop.service';

export interface ManagementAction {
  scopeId: string;
  instanceId?: string;
  steamId?: string;
  kind: ManagementKind;
  idempotencyKey: string;
  reason: string;
  amount?: number;
  group?: string;
  hours?: number;
  ips?: string[];
  devices?: string[];
  allowSharedIp?: boolean;
  expiresAt?: string | null;
  banId?: string;
  revision?: number;
  preflightRevision?: number;
  preflightId?: string;
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const initialShop = { General: {}, ShopItems: {}, Kits: {}, SellItems: {} };
const gameActions = workspacePermissions
  .filter(([, , area]) => area === 'game')
  .map(([action]) => action);
const ledgerKinds = ['sync', 'coins', 'vip-grant', 'vip-revoke'] as const;

function shopChanges(current: Record<string, Json>, draft: Record<string, Json>) {
  const fields = (value: Json | undefined) =>
    value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const changes: ShopSectionChange[] = [];
  for (const section of new Set([...Object.keys(current), ...Object.keys(draft)])) {
    const previous = Object.hasOwn(current, section) ? current[section] : undefined;
    const next = Object.hasOwn(draft, section) ? draft[section] : undefined;
    if (isDeepStrictEqual(previous, next)) continue;
    const change = { section, added: 0, modified: 0, removed: 0 };
    const before = fields(previous);
    const after = fields(next);
    if (previous === undefined) change.added = Math.max(1, Object.keys(after ?? {}).length);
    else if (next === undefined) change.removed = Math.max(1, Object.keys(before ?? {}).length);
    else if (!before || !after) change.modified = 1;
    else
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (!Object.hasOwn(before, key)) change.added++;
        else if (!Object.hasOwn(after, key)) change.removed++;
        else if (!isDeepStrictEqual(before[key], after[key])) change.modified++;
      }
    changes.push(change);
  }
  return changes;
}
export function banAddressAllowed(address: string) {
  return (
    isIP(address) === 4 &&
    !/^(0\.|127\.|169\.254\.|22[4-9]\.|23\d\.|24\d\.|25[0-5]\.)/.test(address)
  );
}
@Injectable()
export class ManagementService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ControlService) private readonly control: ControlService,
    @Inject(IndependentShopService) private readonly independent: IndependentShopService,
  ) {}
  private async scope(scopeId: string, connection?: Connection) {
    const instances = (await this.db.list('instances', connection)).filter(
      (item) => playerScope(item) === scopeId,
    );
    if (!instances.length)
      throw new BusinessError('SCOPE_NOT_FOUND', '请选择有效的互通组或独立服。', 404);
    return instances;
  }
  async state(scopeId = '', query = '', page = 1, filter = 'all'): Promise<ManagementState> {
    const instances = await this.db.list('instances');
    const targets = new Map(
      instances.map((instance) => [playerScope(instance), gameTarget(instance)]),
    );
    const scopes = playerScopes(instances).filter(({ id }) =>
      gameActions.some((action) => allowed(action, targets.get(id))),
    );
    const scope = scopes.find(({ id }) => id === scopeId) ?? scopes[0];
    const selected = scope?.id ?? '';
    const target = targets.get(selected);
    const playerDetails =
      !!target &&
      (allowed('players.read', target) ||
        allowed('players.write', target) ||
        allowed('players.ban', target));
    const commerce =
      !!target && (allowed('commerce.read', target) || allowed('commerce.write', target));
    const shopRead = !!target && (allowed('shop.read', target) || allowed('shop.write', target));
    const shopMode = commerce || shopRead ? await this.independent.mode(selected) : null;
    const wallets = new Map(
      (commerce && shopMode === 'independent'
        ? await this.db.listBy('independent-wallets', 'scopeId', selected)
        : []
      ).map((wallet) => [wallet.id, wallet]),
    );
    const canReadRollout = instances
      .filter((instance) => scope?.instanceIds.includes(instance.id))
      .some(
        (instance) =>
          allowed('branches.read', gameTarget(instance)) ||
          allowed('branches.retry', gameTarget(instance)),
      );
    const presence = (await this.db.list('player-presence')).filter(
      (item) =>
        Date.now() - Date.parse(item.sampledAt) < 60000 &&
        scopes.find((scope) => scope.id === selected)?.instanceIds.includes(item.instanceId),
    );
    const bans = playerDetails ? await this.db.listBy('player-bans', 'scopeId', selected) : [];
    const needle = query.trim().toLowerCase();
    const all = (
      playerDetails || commerce ? await this.db.listBy('managed-players', 'scopeId', selected) : []
    )
      .map((item) => ({
        ...item,
        ...(!playerDetails
          ? { names: [], tribeId: null, tribeName: null, addresses: [], devices: [], note: '' }
          : {}),
        ...(!commerce
          ? {
              balance: null,
              balanceUpdatedAt: null,
              vip: [],
              vipUpdatedAt: null,
              permissionGroups: undefined,
            }
          : {}),
        ...(commerce && shopMode === 'independent'
          ? {
              balance: wallets.get(item.id)?.balance ?? 0,
              balanceUpdatedAt: wallets.get(item.id)?.updatedAt ?? null,
              vip: wallets.get(item.id)?.vip ?? [],
              vipUpdatedAt: wallets.get(item.id)?.updatedAt ?? null,
              permissionGroups: undefined,
            }
          : {}),
        onlineMaps: presence
          .filter((sample) => sample.players.some((p) => p.steamId === item.steamId))
          .map((sample) => sample.instanceId),
      }))
      .filter(
        (item) =>
          (!needle ||
            [
              item.name,
              item.steamId,
              item.note,
              item.tribeName ?? '',
              ...item.names,
              ...item.addresses.map((address) => address.address),
              ...item.devices.map((device) => device.id),
            ].some((value) => value.toLowerCase().includes(needle))) &&
          (filter !== 'online' || item.onlineMaps.length) &&
          (filter !== 'banned' ||
            bans.some((ban) => ban.steamId === item.steamId && activeBan(ban))) &&
          (filter !== 'vip' ||
            item.vip.some((vip) => !vip.expiresAt || Date.parse(vip.expiresAt) > Date.now())),
      )
      .sort(
        (a, b) =>
          b.onlineMaps.length - a.onlineMaps.length || b.lastSeenAt.localeCompare(a.lastSeenAt),
      );
    const size = 25;
    const current = Math.max(1, Math.min(page, Math.ceil(all.length / size) || 1));
    return {
      scopes,
      players: all.slice((current - 1) * size, current * size),
      page: current,
      total: all.length,
      bans,
      tasks: (target ? await this.db.listBy('management-tasks', 'scopeId', selected) : [])
        .filter(
          (item) =>
            target &&
            (allowed(managementPermission[item.kind], target) ||
              (playerDetails && ['ban', 'unban'].includes(item.kind)) ||
              (commerce && ledgerKinds.some((kind) => kind === item.kind)) ||
              (shopRead && ['shop-read', 'shop-publish'].includes(item.kind))),
        )
        .slice(0, 100)
        .map((task) => ({
          ...task,
          payload: Object.fromEntries(
            Object.entries(task.payload).filter(([key]) => key !== 'config'),
          ),
        })),
      ledger: commerce ? (await this.ledger(selected, 1, '', '', nowIso())).entries : [],
      shop: shopRead && shopMode === 'arkshop' ? await this.db.get('shop-drafts', selected) : null,
      shopMode,
      independentCatalog:
        shopRead && shopMode === 'independent'
          ? await this.db.get('independent-catalogs', selected)
          : null,
      links: (commerce || shopRead ? await this.db.list('economy-links') : []).filter((link) =>
        scope?.instanceIds.includes(link.id),
      ),
      settings: commerce ? await this.db.get('management-settings', selected) : null,
      rollouts: (canReadRollout ? await this.db.list('branch-rollouts') : [])
        .filter(
          (item) =>
            scope?.instanceIds.some((id) => item.instanceIds.includes(id)) &&
            item.instanceIds.every((id) => {
              const instance = instances.find((map) => map.id === id);
              return (
                !!instance &&
                (allowed('branches.read', gameTarget(instance)) ||
                  allowed('branches.retry', gameTarget(instance)))
              );
            }),
        )
        .slice(0, 20),
    };
  }
  async ledger(scopeId: string, page: number, steamId: string, source: string, before: string) {
    const instance = (await this.scope(scopeId))[0]!;
    const target = gameTarget(instance);
    if (!allowed('commerce.write', target))
      await requireGameAccess(this.db, 'commerce.read', scopeId);
    return this.db.ledgerPage(
      scopeId,
      page,
      steamId,
      source,
      before,
      workspaceContext.getStore()?.workspace?.role === 'owner' ? undefined : ledgerKinds,
    );
  }
  async player(input: { scopeId: string; steamId: string; name: string; note: string }) {
    return this.db.transaction(async (connection) => {
      await requireGameAccess(this.db, 'players.write', input.scopeId, connection);
      await this.scope(input.scopeId, connection);
      const player =
        (await this.db.get(
          'managed-players',
          playerKey(input.scopeId, input.steamId),
          connection,
        )) ?? emptyPlayer(input.scopeId, input.steamId, input.name || input.steamId);
      await this.db.put(
        'managed-players',
        { ...player, note: input.note, name: input.name || player.name },
        connection,
      );
      await this.control.audit('编辑用户', input.steamId, input.scopeId, connection);
      return { saved: true };
    });
  }
  async settings(scopeId: string, vipGroups: string[]) {
    return this.db.transaction(async (connection) => {
      await requireGameAccess(this.db, 'commerce.write', scopeId, connection);
      await this.scope(scopeId, connection);
      if (vipGroups.some((group) => /admin|default|everyone|\*/i.test(group)))
        throw new BusinessError('VIP_GROUP_FORBIDDEN', 'VIP 不得使用管理员或默认权限组。');
      await this.db.put(
        'management-settings',
        { id: scopeId, vipGroups: [...new Set(vipGroups)] },
        connection,
      );
      await this.control.audit('修改 VIP 组', scopeId, vipGroups.join(', '), connection);
      return { saved: true };
    });
  }
  async saveShop(scopeId: string, revision: number, config: Record<string, Json>) {
    return this.db.transaction(async (connection) => {
      await requireGameAccess(this.db, 'shop.write', scopeId, connection);
      await this.scope(scopeId, connection);
      if ((await this.independent.mode(scopeId, connection)) !== 'arkshop')
        throw new BusinessError('SHOP_MODE', '此互通组使用独立商店。', 409);
      const safe = publicShopConfig(config);
      const errors = validateShopConfig(safe);
      if (errors.length) throw new BusinessError('SHOP_INVALID', errors.join('\n'));
      const previous = await this.db.get('shop-drafts', scopeId, connection);
      if ((previous?.revision ?? 0) !== revision)
        throw new BusinessError('REVISION_CONFLICT', '商店已被其他页面修改，请刷新后重试。');
      const draft = {
        id: scopeId,
        scopeId,
        revision: revision + 1,
        config: safe,
        updatedAt: nowIso(),
        publishedRevision: previous?.publishedRevision ?? null,
      };
      await this.db.put('shop-drafts', draft, connection);
      await this.control.audit('保存商店草稿', scopeId, `版本 ${draft.revision}`, connection);
      return draft;
    });
  }
  async enqueue(input: ManagementAction) {
    return this.db.transaction(async (connection) => {
      if (workspaceContext.getStore()?.actor)
        await requireGameAccess(
          this.db,
          managementPermission[input.kind],
          input.scopeId,
          connection,
        );
      const fingerprint = digest(JSON.stringify(input));
      const request = await this.db.get('management-requests', input.idempotencyKey, connection);
      if (request) {
        if (request.fingerprint !== fingerprint)
          throw new BusinessError('IDEMPOTENCY_CONFLICT', '此请求编号已经用于其他操作。');
        return Promise.all(
          request.taskIds.map((id) => this.db.get('management-tasks', id, connection)),
        );
      }
      const instances = await this.scope(input.scopeId, connection);
      if (input.preflightRevision !== undefined) {
        const draft = await this.db.get('shop-drafts', input.scopeId, connection);
        if ((draft?.revision ?? 0) !== input.preflightRevision)
          throw new BusinessError('REVISION_CONFLICT', '商店草稿已变化，请刷新后重新预检。', 409);
      }
      const settings = await this.db.get('management-settings', input.scopeId, connection);
      const independentMode =
        (await this.independent.mode(input.scopeId, connection)) === 'independent';
      if (independentMode && (input.kind === 'shop-read' || input.kind === 'shop-publish'))
        throw new BusinessError('SHOP_MODE', '此互通组使用独立商店。', 409);
      let player = input.steamId
        ? await this.db.get('managed-players', playerKey(input.scopeId, input.steamId), connection)
        : null;
      if (!['shop-read', 'shop-publish'].includes(input.kind) && !player)
        throw new BusinessError('PLAYER_REQUIRED', '请先添加或同步这名玩家。');
      if (independentMode && ledgerKinds.some((kind) => kind === input.kind)) {
        const task = await this.independent.playerAction(
          input,
          instances[0]!,
          settings,
          connection,
        );
        await this.db.put(
          'management-requests',
          { id: input.idempotencyKey, fingerprint, taskIds: [task.id] },
          connection,
        );
        await this.control.audit(
          '独立商店用户操作',
          input.steamId!,
          `${input.kind} · ${input.reason}`,
          connection,
        );
        return [task];
      }
      const tasks = await this.db.listBy('management-tasks', 'scopeId', input.scopeId, connection);
      if (
        input.kind !== 'sync' &&
        tasks.some(
          (task) =>
            (activeManagement(task) || task.status === 'uncertain') &&
            ((input.steamId && task.steamId === input.steamId) ||
              (input.kind === 'shop-publish' && task.kind !== 'shop-read')),
        )
      )
        throw new BusinessError(
          'MANAGEMENT_BUSY',
          '此玩家或商店有待处理任务，请等待完成或核实未知结果。',
        );
      const payload: Record<string, Json> = { reason: input.reason };
      if (input.preflightRevision !== undefined)
        payload.preflightRevision = input.preflightRevision;
      if (input.kind === 'coins' || input.kind.startsWith('vip-')) {
        const links = await Promise.all(
          instances.map((instance) => this.db.get('economy-links', instance.id, connection)),
        );
        const field = input.kind === 'coins' ? 'shopDatabase' : 'permissionsDatabase';
        const signatures = new Set(links.map((link) => link?.[field]).filter(Boolean));
        const otherMaps = (await this.db.list('instances', connection)).filter(
          (instance) => playerScope(instance) !== input.scopeId,
        );
        if (
          (await this.db.list('economy-links', connection)).some(
            (link) => otherMaps.some((map) => map.id === link.id) && signatures.has(link[field]),
          )
        )
          throw new BusinessError(
            'DATABASE_SCOPE_CONFLICT',
            '另一个互通组也使用了同一插件数据库；请为不同服分配独立数据库后重新读取配置。',
          );
        if (
          instances.length > 1 &&
          (links.some(
            (link) => !link?.[field] || Date.now() - Date.parse(link.checkedAt) > 86400000,
          ) ||
            new Set(links.map((link) => link?.[field])).size !== 1)
        )
          throw new BusinessError(
            'SHARED_DATABASE_REQUIRED',
            '请先读取组内每张地图的插件配置，确认它们使用同一 MySQL 数据库；多地图不能各用独立 SQLite。',
          );
        if (input.kind === 'coins') {
          if (
            !input.amount ||
            !Number.isSafeInteger(input.amount) ||
            Math.abs(input.amount) > 100000000
          )
            throw new BusinessError('AMOUNT_INVALID', '金币变动必须是非零整数，单次最多一亿。');
          payload.amount = input.amount;
        } else {
          if (!input.group || !(settings?.vipGroups ?? ['VIP']).includes(input.group))
            throw new BusinessError('VIP_GROUP_INVALID', '请选择后台已配置的 VIP 权限组。');
          payload.group = input.group;
          if (input.kind === 'vip-grant') {
            const existing = player?.vip.find((vip) => vip.group === input.group);
            if (existing && !existing.expiresAt)
              throw new BusinessError('PERMANENT_VIP', '此玩家已有永久 VIP，请先核实或撤销。');
            const hours = Math.max(1, input.hours ?? 24);
            const base = Math.max(Date.now(), Date.parse(existing?.expiresAt ?? '') || 0);
            payload.hours = Math.ceil((base - Date.now()) / 3600000) + hours;
            payload.expiresAt = new Date(
              Date.now() + Number(payload.hours) * 3600000,
            ).toISOString();
          }
        }
      }
      let targets = instances.filter((instance) =>
        input.instanceId ? instance.id === input.instanceId : true,
      );
      if (!['ban', 'unban', 'shop-read', 'shop-publish'].includes(input.kind))
        targets = targets.filter((instance) => instance.status === 'running').slice(0, 1);
      if (!targets.length)
        throw new BusinessError(
          'RUNNING_REQUIRED',
          '请选择组内运行中的地图；插件操作需要 RCON 就绪。',
        );
      if (input.kind === 'ban') {
        if (
          (await this.db.list('player-bans', connection)).some(
            (ban) =>
              ban.scopeId === input.scopeId && ban.steamId === input.steamId && activeBan(ban),
          )
        )
          throw new BusinessError('ALREADY_BANNED', '此玩家已有生效中的封禁，请先处理原记录。');
        const ips = input.ips ?? [];
        const devices = input.devices ?? [];
        const networks = await this.db.list('connection-networks', connection);
        const protectedIps = new Set(
          networks.length ? [CONNECT_CONTROLLER_IP, CONNECT_GAME_IP] : [],
        );
        if (
          ips.some(
            (ip) =>
              !banAddressAllowed(ip) ||
              protectedIps.has(ip) ||
              !player?.addresses.some(
                (address) => address.address === ip && address.source === 'game',
              ),
          )
        )
          throw new BusinessError(
            'IP_UNVERIFIED',
            'IP 必须是游戏实测地址，不能封禁回环、转发网关或未验证地址。',
          );
        const shared = (await this.db.list('managed-players', connection)).some(
          (other) =>
            other.scopeId === input.scopeId &&
            other.steamId !== input.steamId &&
            other.addresses.some((address) => ips.includes(address.address)),
        );
        if (shared && !input.allowSharedIp)
          throw new BusinessError(
            'SHARED_IP',
            '此 IP 也被其他玩家使用；请确认共享 IP 封禁后重试。',
          );
        if (devices.some((id) => !player?.devices.some((device) => device.id === id)))
          throw new BusinessError('DEVICE_UNVERIFIED', '只能封禁该玩家已经报告的客户端设备。');
        const ban = {
          id: randomUUID(),
          scopeId: input.scopeId,
          steamId: input.steamId!,
          targets: { steam: true, ips, devices },
          reason: input.reason,
          expiresAt: input.expiresAt ?? null,
          revokedAt: null,
          createdAt: nowIso(),
        };
        await this.db.put('player-bans', ban, connection);
        payload.banId = ban.id;
        payload.ips = ips;
        payload.devices = devices;
      }
      if (input.kind === 'unban') {
        const ban = await this.db.get('player-bans', input.banId ?? '', connection);
        if (!ban || ban.scopeId !== input.scopeId || ban.steamId !== input.steamId)
          throw new BusinessError('BAN_NOT_FOUND', '封禁记录不存在。');
        await this.db.put('player-bans', { ...ban, revokedAt: nowIso() }, connection);
        payload.banId = ban.id;
        payload.ips = ban.targets.ips;
        payload.devices = ban.targets.devices;
      }
      let reviewed: Map<string, string> | undefined;
      if (input.kind === 'shop-publish') {
        const draft = await this.db.get('shop-drafts', input.scopeId, connection);
        if (!draft || draft.revision !== input.revision)
          throw new BusinessError('REVISION_CONFLICT', '请先保存并核对当前商店草稿。');
        if (validateShopConfig(draft.config).length)
          throw new BusinessError('SHOP_INVALID', '商店配置无效。');
        if (input.preflightId) {
          const check = await this.readShopPreview(
            input.scopeId,
            instances,
            input.preflightId,
            connection,
          );
          if (!check.view.ready || targets.length !== instances.length)
            throw new BusinessError(
              'SHOP_PREFLIGHT_CHANGED',
              '发布预检已失效，请重新预检后确认发布。',
              409,
            );
          reviewed = check.hashes;
          payload.preflightId = input.preflightId;
        }
        payload.config = draft.config;
        payload.revision = draft.revision;
        await this.db.put(
          'shop-history',
          { ...draft, id: input.idempotencyKey, operationId: input.idempotencyKey },
          connection,
        );
      }
      const created: ManagementTask[] = [];
      for (const instance of targets) {
        const host = await this.db.get('hosts', instance.hostId, connection);
        const capable = host?.features?.includes('management-v1');
        if (!capable && input.preflightRevision === undefined)
          throw new BusinessError(
            'AGENT_UPDATE_REQUIRED',
            '请更新并重启游戏电脑的主机助手，再使用用户与商店管理。',
          );
        const expectedHash = reviewed
          ? reviewed.get(instance.id)
          : input.kind === 'shop-publish'
            ? (await this.db.get('economy-links', instance.id, connection))?.shopHash
            : undefined;
        if (input.kind === 'shop-publish' && !expectedHash)
          throw new BusinessError(
            'SHOP_READ_REQUIRED',
            `请先读取「${instance.name}」现有商店配置，再发布。`,
          );
        const preflightError =
          input.preflightRevision === undefined
            ? null
            : !isHostOnline(host)
              ? '主机离线，请连接后重新预检。'
              : !capable
                ? '请更新并重启主机助手后重新预检。'
                : null;
        const task: ManagementTask = {
          id: randomUUID(),
          scopeId: input.scopeId,
          hostId: instance.hostId,
          instanceId: instance.id,
          steamId: input.steamId ?? null,
          kind: input.kind,
          payload: { ...payload, ...(expectedHash ? { expectedHash } : {}) },
          status: preflightError ? 'failed' : 'queued',
          idempotencyKey: input.idempotencyKey,
          progress: preflightError
            ? '预检失败'
            : input.preflightRevision !== undefined
              ? '等待主机助手读取配置'
              : '等待主机助手；RCON 操作等待地图就绪',
          result: null,
          error: preflightError,
          leaseUntil: null,
          createdAt: nowIso(),
          completedAt: preflightError ? nowIso() : null,
        };
        await this.db.put('management-tasks', task, connection);
        await this.db.put(
          'ledger',
          {
            id: task.id,
            scopeId: input.scopeId,
            steamId: task.steamId,
            instanceId: task.instanceId,
            kind: task.kind,
            source: 'admin',
            operationId: task.id,
            createdAt: task.createdAt,
            detail: Object.fromEntries(
              Object.entries(task.payload).filter(([key]) => key !== 'config'),
            ),
            status: preflightError ? 'failed' : 'pending',
          },
          connection,
        );
        created.push(task);
      }
      await this.db.put(
        'management-requests',
        { id: input.idempotencyKey, fingerprint, taskIds: created.map((item) => item.id) },
        connection,
      );
      await this.control.audit(
        '用户与商店操作',
        input.steamId || input.scopeId,
        `${input.kind} · ${input.reason}`,
        connection,
      );
      player = null;
      return created;
    });
  }
  async shopPreview(scopeId: string, id: string): Promise<ShopPublishPreview> {
    await requireGameAccess(this.db, 'shop.write', scopeId);
    const instances = await this.scope(scopeId);
    return (await this.readShopPreview(scopeId, instances, id)).view;
  }
  private async readShopPreview(
    scopeId: string,
    instances: Instance[],
    id: string,
    connection?: Connection,
  ) {
    const [draft, tasks, mode] = await Promise.all([
      this.db.get('shop-drafts', scopeId, connection),
      this.db.listBy('management-tasks', 'idempotencyKey', id, connection),
      this.independent.mode(scopeId, connection),
    ]);
    const revision = tasks[0]?.payload.preflightRevision;
    if (
      typeof revision !== 'number' ||
      tasks.some(
        (task) =>
          task.scopeId !== scopeId ||
          task.kind !== 'shop-read' ||
          task.payload.preflightRevision !== revision,
      )
    )
      throw new BusinessError('SHOP_PREFLIGHT_NOT_FOUND', '未找到这次发布预检。', 404);
    const byInstance = new Map(tasks.map((task) => [task.instanceId, task]));
    const current =
      mode === 'arkshop' &&
      revision === (draft?.revision ?? 0) &&
      tasks.length === instances.length &&
      instances.every((instance) => byInstance.has(instance.id));
    const hashes = new Map<string, string>();
    let pending = false;
    const maps = await Promise.all(
      instances.map(async (instance) => {
        const task = byInstance.get(instance.id);
        const result = {
          id: instance.id,
          name: instance.name,
          progress: task?.progress ?? '等待预检',
          error: task?.error ?? null,
          changes: null as ShopSectionChange[] | null,
        };
        if (!current || !task || result.error) return result;
        const host = await this.db.get('hosts', instance.hostId, connection);
        if (!isHostOnline(host)) return { ...result, error: '主机离线，请连接后重新预检。' };
        if (!host?.features?.includes('management-v1'))
          return { ...result, error: '请更新并重启主机助手后重新预检。' };
        if (activeManagement(task)) {
          pending = true;
          return result;
        }
        if (task.status !== 'succeeded')
          return { ...result, error: '此次读取未完成，请重新预检。' };
        const hash = task.result?.shopHash;
        const link = await this.db.get('economy-links', instance.id, connection);
        if (typeof hash !== 'string' || !link || link.shopHash !== hash)
          return { ...result, error: '主机配置已有更新，请重新预检。' };
        hashes.set(instance.id, hash);
        return { ...result, changes: draft ? shopChanges(link.config, draft.config) : [] };
      }),
    );
    const view: ShopPublishPreview = {
      current,
      pending,
      maps,
      ready: current && !!draft && hashes.size === instances.length,
    };
    return { view, hashes };
  }
  async poll(hostId: string): Promise<AgentManagementTask[]> {
    return this.db.transaction(async (connection) => {
      const host = await this.db.get('hosts', hostId, connection);
      if (!host || ['disconnected', 'disconnecting'].includes(host.status)) return [];
      const all = (await this.db.list('management-tasks', connection)).filter(
        (task) => task.hostId === hostId,
      );
      for (const task of all.filter(
        (task) =>
          ['leased', 'executing'].includes(task.status) &&
          task.leaseUntil &&
          task.leaseUntil < nowIso(),
      )) {
        if (task.status === 'leased') {
          task.status = 'queued';
          task.leaseUntil = null;
          await this.db.put('management-tasks', task, connection);
        } else
          await this.finish(
            task,
            task.kind === 'shop-read'
              ? { status: 'failed', error: '读取回执丢失，请重新预检。' }
              : { status: 'uncertain', error: '执行回执丢失，禁止自动重发；请核实游戏结果。' },
            connection,
          );
      }
      if (all.some((task) => ['leased', 'executing'].includes(task.status))) return [];
      for (const task of all
        .filter((item) => item.status === 'queued')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        const instance = await this.db.get('instances', task.instanceId, connection);
        if (!instance) {
          await this.finish(
            task,
            { status: 'failed', error: '地图已删除，任务未执行。' },
            connection,
          );
          continue;
        }
        if (playerScope(instance) !== task.scopeId) {
          await this.finish(
            task,
            { status: 'failed', error: '地图互通组已变更，任务未执行。' },
            connection,
          );
          continue;
        }
        if (!['shop-read', 'shop-publish'].includes(task.kind) && instance.status !== 'running')
          continue;
        if (
          (await this.db.list('commands', connection)).some(
            (command) => command.instanceId === instance.id && activeCommand(command),
          )
        )
          continue;
        const credential = await this.db.get('instance-credentials', instance.id, connection);
        if (!credential) continue;
        const leased = {
          ...task,
          status: 'leased' as const,
          leaseUntil: new Date(Date.now() + 60000).toISOString(),
        };
        await this.db.put('management-tasks', leased, connection);
        return [
          {
            ...leased,
            instance: { ...instance, rconPassword: decryptSecret(credential.rconPassword) },
          },
        ];
      }
      return [];
    });
  }
  async acknowledge(
    hostId: string,
    id: string,
    input: {
      status: 'executing' | 'succeeded' | 'failed' | 'uncertain';
      result?: Record<string, Json> | null;
      error?: string | null;
      progress?: string;
    },
  ) {
    return this.db.transaction(async (connection) => {
      const task = await this.db.get('management-tasks', id, connection);
      if (!task || task.hostId !== hostId)
        throw new BusinessError('TASK_FORBIDDEN', '任务不属于此主机。', 403);
      if (!['leased', 'executing'].includes(task.status)) {
        if (task.status === 'uncertain' && input.status !== 'executing')
          return this.finish(
            task,
            { ...input, status: input.status, result: { ...input.result, lateReceipt: true } },
            connection,
          );
        return task;
      }
      if (input.status === 'executing') {
        const next = {
          ...task,
          status: 'executing' as const,
          leaseUntil: new Date(Date.now() + 120000).toISOString(),
          progress: input.progress || '主机正在执行',
        };
        await this.db.put('management-tasks', next, connection);
        return next;
      }
      return this.finish(task, { ...input, status: input.status }, connection);
    });
  }
  private async finish(
    task: ManagementTask,
    input: {
      status: 'succeeded' | 'failed' | 'uncertain';
      result?: Record<string, Json> | null;
      error?: string | null;
    },
    connection: Connection,
  ) {
    const result = input.result ?? null;
    const summary = result
      ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'config'))
      : null;
    const next = {
      ...task,
      status: input.status,
      result: summary,
      error: input.error ?? null,
      progress:
        input.status === 'succeeded'
          ? '已完成'
          : input.status === 'uncertain'
            ? '结果未知，待核实'
            : '执行失败',
      leaseUntil: null,
      completedAt: nowIso(),
    };
    await this.db.put('management-tasks', next, connection);
    const entry = await this.db.get('ledger', task.id, connection);
    if (entry)
      await this.db.put(
        'ledger',
        {
          ...entry,
          status: input.status,
          detail: { ...entry.detail, result: summary, error: next.error },
        },
        connection,
      );
    const player = task.steamId
      ? await this.db.get('managed-players', playerKey(task.scopeId, task.steamId), connection)
      : null;
    if (player && result)
      await this.db.put(
        'managed-players',
        {
          ...player,
          ...(typeof result.balance === 'number' && Number.isSafeInteger(result.balance)
            ? { balance: result.balance, balanceUpdatedAt: nowIso() }
            : {}),
          ...(Array.isArray(result.groups)
            ? {
                vipUpdatedAt: nowIso(),
                permissionGroups: result.groups.filter(
                  (value): value is string => typeof value === 'string',
                ),
              }
            : {}),
          ...(input.status === 'succeeded' && task.kind === 'vip-grant'
            ? {
                vip: [
                  ...player.vip.filter((vip) => vip.group !== task.payload.group),
                  {
                    group: String(task.payload.group),
                    expiresAt: String(result.expiresAt ?? task.payload.expiresAt),
                  },
                ],
              }
            : {}),
          ...(input.status === 'succeeded' && task.kind === 'vip-revoke'
            ? { vip: player.vip.filter((vip) => vip.group !== task.payload.group) }
            : {}),
        },
        connection,
      );
    if (
      result &&
      input.status === 'succeeded' &&
      ['shop-read', 'shop-publish'].includes(task.kind) &&
      typeof result.shopHash === 'string' &&
      result.config &&
      typeof result.config === 'object' &&
      !Array.isArray(result.config)
    ) {
      const safe = publicShopConfig(result.config as Record<string, Json>);
      await this.db.put(
        'economy-links',
        {
          id: task.instanceId,
          shopDatabase: typeof result.shopDatabase === 'string' ? result.shopDatabase : null,
          permissionsDatabase:
            typeof result.permissionsDatabase === 'string' ? result.permissionsDatabase : null,
          shopHash: result.shopHash,
          checkedAt: nowIso(),
          config: safe,
        },
        connection,
      );
      const draft = await this.db.get('shop-drafts', task.scopeId, connection);
      if (!draft && task.kind === 'shop-read' && task.payload.preflightRevision === undefined)
        await this.db.put(
          'shop-drafts',
          {
            id: task.scopeId,
            scopeId: task.scopeId,
            revision: 1,
            config: safe || initialShop,
            updatedAt: nowIso(),
            publishedRevision: null,
          },
          connection,
        );
      if (draft && task.kind === 'shop-publish' && draft.revision === task.payload.revision) {
        const peers = (await this.db.list('management-tasks', connection)).filter(
          (item) => item.idempotencyKey === task.idempotencyKey,
        );
        if (peers.every((item) => item.status === 'succeeded'))
          await this.db.put(
            'shop-drafts',
            { ...draft, publishedRevision: draft.revision },
            connection,
          );
      }
    }
    return next;
  }
  async resolve(id: string, outcome: 'succeeded' | 'failed', evidence: string) {
    return this.db.transaction(async (connection) => {
      const task = await this.db.get('management-tasks', id, connection);
      if (!task || task.status !== 'uncertain')
        throw new BusinessError('TASK_STATE', '只能核实结果未知的任务。');
      await requireGameAccess(this.db, managementPermission[task.kind], task.scopeId, connection);
      const result = await this.finish(
        task,
        {
          status: outcome,
          result: { ...task.result, manualResolution: evidence },
          error: `管理员核实：${evidence}`,
        },
        connection,
      );
      await this.control.audit('核实未知结果', id, `${outcome} · ${evidence}`, connection);
      return result;
    });
  }
  async cancel(id: string) {
    return this.db.transaction(async (connection) => {
      const task = await this.db.get('management-tasks', id, connection);
      if (!task || task.status !== 'queued' || ['ban', 'unban'].includes(task.kind))
        throw new BusinessError('TASK_STATE', '只能取消尚未领取的普通管理任务；封禁请使用解封。');
      await requireGameAccess(this.db, managementPermission[task.kind], task.scopeId, connection);
      await this.db.put(
        'management-tasks',
        { ...task, status: 'cancelled', completedAt: nowIso() },
        connection,
      );
      const entry = await this.db.get('ledger', task.id, connection);
      if (entry)
        await this.db.put(
          'ledger',
          { ...entry, status: 'failed', detail: { ...entry.detail, cancelled: true } },
          connection,
        );
      return { cancelled: true };
    });
  }
  async presence(hostId: string, samples: PlayerPresence[]) {
    return this.db.transaction(async (connection) => {
      for (const sample of samples) {
        const instance = await this.db.get('instances', sample.instanceId, connection);
        if (!instance || instance.hostId !== hostId)
          throw new BusinessError('INSTANCE_FORBIDDEN', '主机不能上报其他地图的玩家。', 403);
        if (Math.abs(Date.now() - Date.parse(sample.sampledAt)) > 120000) continue;
        const prior = await this.db.get('player-presence', sample.instanceId, connection);
        if (prior && prior.sampledAt >= sample.sampledAt) continue;
        const scopeId = playerScope(instance);
        for (const observed of sample.players) {
          const player =
            (await this.db.get(
              'managed-players',
              playerKey(scopeId, observed.steamId),
              connection,
            )) ?? emptyPlayer(scopeId, observed.steamId, observed.name);
          const gap = Math.max(
            0,
            (Date.parse(sample.sampledAt) - Date.parse(player.lastSeenAt)) / 1000,
          );
          const seconds =
            prior?.players.some((p) => p.steamId === observed.steamId) && gap < 90
              ? Math.floor(gap)
              : 0;
          await this.db.put(
            'managed-players',
            {
              ...player,
              name: observed.name,
              names: [...new Set([...player.names, observed.name])].slice(-30),
              lastSeenAt: sample.sampledAt,
              lastMapId: instance.id,
              onlineSeconds: player.onlineSeconds + seconds,
              tribeId: observed.tribeId ?? player.tribeId,
              tribeName: observed.tribeName ?? player.tribeName,
              addresses:
                observed.ip && sample.source === 'bridge' && isIP(observed.ip)
                  ? [
                      ...player.addresses.filter((address) => address.address !== observed.ip),
                      { address: observed.ip, source: 'game' as const, seenAt: sample.sampledAt },
                    ].slice(-30)
                  : player.addresses,
            },
            connection,
          );
        }
        await this.db.put('player-presence', { ...sample, id: sample.instanceId }, connection);
      }
      return { accepted: true };
    });
  }
  async commerce(hostId: string, events: GameCommerceEvent[]) {
    return this.db.transaction(async (connection) => {
      for (const event of events) {
        const instance = await this.db.get('instances', event.instanceId, connection);
        if (!instance || instance.hostId !== hostId)
          throw new BusinessError('INSTANCE_FORBIDDEN', '主机不能上报其他地图的消费。', 403);
        const id = digest(`${event.instanceId}:${event.eventId}`);
        if (await this.db.get('ledger', id, connection)) continue;
        const scopeId = playerScope(instance);
        if (!(await this.db.get('managed-players', playerKey(scopeId, event.steamId), connection)))
          await this.db.put('managed-players', emptyPlayer(scopeId, event.steamId), connection);
        await this.db.put(
          'ledger',
          {
            id,
            scopeId,
            steamId: event.steamId,
            instanceId: instance.id,
            kind: event.kind,
            source: 'game',
            operationId: event.eventId,
            createdAt: event.occurredAt,
            detail: event.detail,
            status: 'succeeded',
          },
          connection,
        );
      }
      return { accepted: true };
    });
  }
  async recoverLeases() {
    await this.db.transaction(async (connection) => {
      for (const task of await this.db.inStates(
        'management-tasks',
        ['leased', 'executing'],
        connection,
      )) {
        if (!task.leaseUntil || task.leaseUntil >= nowIso()) continue;
        if (task.status === 'leased')
          await this.db.put(
            'management-tasks',
            { ...task, status: 'queued', leaseUntil: null },
            connection,
          );
        else
          await this.finish(
            task,
            { status: 'uncertain', error: '主机执行回执已超时；实际结果需要核实，未自动重发。' },
            connection,
          );
      }
    });
  }
  async expireBans() {
    for (const ban of await this.db.list('player-bans'))
      if (!ban.revokedAt && ban.expiresAt && ban.expiresAt < nowIso()) {
        const key = digest(`expire:${ban.id}`);
        await this.enqueue({
          scopeId: ban.scopeId,
          steamId: ban.steamId,
          kind: 'unban',
          idempotencyKey: key,
          reason: '定时封禁到期',
          banId: ban.id,
        });
      }
  }
}
