import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  activeBan,
  activeManagement,
  defaultShopMode,
  emptyPlayer,
  independentShopFeature,
  playerKey,
  playerScope,
  shopReceiptGraceMs,
  shopRequestLifetimeMs,
} from '@ark-control/common';
import type {
  ChatShopReceipt,
  ChatShopReply,
  ChatShopRequest,
  IndependentProduct,
  IndependentWallet,
  Instance,
  LedgerEntry,
  ManagementSettings,
  ManagementTask,
  ShopMode,
  ShopOrder,
} from '@ark-control/common';
import { ControlService, nowIso } from '@/control';
import { BusinessError, Database } from '@/infrastructure';
import type { Connection } from '@/infrastructure';
import { allowed, gameTarget, requireGameAccess } from '@/workspaces/access';
import { workspaceContext } from '@/workspaces/context';
import type { ManagementAction } from './management.service';

const notice = (...lines: string[]): ChatShopReply => ({ lines });
const countId = (order: Pick<ShopOrder, 'scopeId' | 'steamId' | 'productId'>) =>
  createHash('sha256')
    .update(`${playerKey(order.scopeId, order.steamId)}:${order.productId}`)
    .digest('hex');
const isVip = (wallet: IndependentWallet) =>
  wallet.vip.some(({ expiresAt }) => expiresAt === null || Date.parse(expiresAt) > Date.now());
const pendingExpired = (order: ShopOrder) => Date.now() > order.expiresAt + shopReceiptGraceMs;

@Injectable()
export class IndependentShopService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ControlService) private readonly control: ControlService,
  ) {}

  async mode(scopeId: string, connection?: Connection): Promise<ShopMode> {
    return (await this.db.get('shop-modes', scopeId, connection))?.mode ?? defaultShopMode;
  }

  async setMode(scopeId: string, mode: ShopMode) {
    return this.db.transaction(async (connection) => {
      await requireGameAccess(this.db, 'shop.write', scopeId, connection);
      if (mode === (await this.mode(scopeId, connection))) return { mode };
      const maps = (await this.db.list('instances', connection)).filter(
        (map) => playerScope(map) === scopeId,
      );
      if (maps.some(({ status, pid }) => pid || !['stopped', 'error'].includes(status)))
        throw new BusinessError(
          'SHOP_MAPS_RUNNING',
          '请先停止此互通组的地图，再切换商店模式。',
          409,
        );
      const mapIds = new Set(maps.map(({ id }) => id));
      const commands = await this.db.inStates(
        'commands',
        ['queued', 'leased', 'executing', 'cancelling'],
        connection,
      );
      if (
        commands.some(
          (command) =>
            mapIds.has(command.instanceId) &&
            (['start', 'restart', 'install-plugins'].includes(command.kind) ||
              command.payload.maintenance === true),
        )
      )
        throw new BusinessError('SHOP_MAPS_RUNNING', '还有地图任务正在执行，请等待任务结束。', 409);
      const tasks = await this.db.listBy('management-tasks', 'scopeId', scopeId, connection);
      if (tasks.some((task) => !['ban', 'unban'].includes(task.kind) && activeManagement(task)))
        throw new BusinessError('SHOP_TASKS_ACTIVE', '此互通组还有商店或金币任务正在执行。', 409);
      if (mode === 'independent') {
        const hosts = await Promise.all(
          [...new Set(maps.map(({ hostId }) => hostId))].map((id) =>
            this.db.get('hosts', id, connection),
          ),
        );
        if (hosts.some((host) => host?.platform !== 'windows'))
          throw new BusinessError('SHOP_WINDOWS_REQUIRED', '独立商店需要 Windows ASE 游戏主机。');
      }
      await this.db.put('shop-modes', { id: scopeId, mode }, connection);
      await this.control.audit(
        '切换商店模式',
        scopeId,
        mode === 'independent' ? '独立商店' : 'ArkShop',
        connection,
      );
      return { mode };
    });
  }

  async saveCatalog(scopeId: string, revision: number, products: IndependentProduct[]) {
    return this.db.transaction(async (connection) => {
      await requireGameAccess(this.db, 'shop.write', scopeId, connection);
      if ((await this.mode(scopeId, connection)) !== 'independent')
        throw new BusinessError('SHOP_MODE', '此互通组选用 ArkShop，请先切换商店模式。', 409);
      const current = await this.db.get('independent-catalogs', scopeId, connection);
      if (revision !== (current?.revision ?? 0))
        throw new BusinessError('REVISION_CONFLICT', '商品已被其他页面修改，请刷新后重试。', 409);
      const saved = await this.db.put(
        'independent-catalogs',
        { id: scopeId, revision: revision + 1, products },
        connection,
      );
      await this.control.audit(
        '保存独立商店',
        scopeId,
        `版本 ${saved.revision} · ${products.length} 项商品`,
        connection,
      );
      return saved;
    });
  }

  private async wallet(
    scopeId: string,
    steamId: string,
    connection?: Connection,
  ): Promise<IndependentWallet> {
    const id = playerKey(scopeId, steamId);
    return (
      (await this.db.get('independent-wallets', id, connection)) ?? {
        id,
        scopeId,
        steamId,
        balance: 0,
        reserved: 0,
        vip: [],
        updatedAt: null,
      }
    );
  }

  async playerAction(
    input: ManagementAction,
    instance: Instance,
    settings: ManagementSettings | null,
    connection: Connection,
  ) {
    const steamId = input.steamId!;
    const wallet = await this.wallet(input.scopeId, steamId, connection);
    const before = wallet.balance;
    const now = Date.now();
    if (input.kind === 'coins') {
      const amount = input.amount ?? 0;
      if (!Number.isSafeInteger(amount) || !amount || Math.abs(amount) > 100_000_000)
        throw new BusinessError('AMOUNT_INVALID', '金币变动必须是非零整数，单次最多一亿。');
      if (before + amount < 0 || !Number.isSafeInteger(before + wallet.reserved + amount))
        throw new BusinessError('AMOUNT_INVALID', '金币余额不足或超出支持范围。');
      wallet.balance += amount;
    }
    if (input.kind === 'vip-grant' || input.kind === 'vip-revoke') {
      if (!input.group || !(settings?.vipGroups ?? ['VIP']).includes(input.group))
        throw new BusinessError('VIP_GROUP_INVALID', '请选择后台已配置的 VIP 组。');
      const group = input.group;
      const existing = wallet.vip.find((entry) => entry.group === group);
      if (input.kind === 'vip-grant' && existing?.expiresAt === null)
        throw new BusinessError('PERMANENT_VIP', '此玩家已有永久 VIP。');
      wallet.vip = wallet.vip.filter((entry) => entry.group !== group);
      if (input.kind === 'vip-grant') {
        const base = Math.max(now, Date.parse(existing?.expiresAt ?? '') || 0);
        wallet.vip.push({
          group,
          expiresAt: new Date(base + (input.hours ?? 24) * 3_600_000).toISOString(),
        });
      }
    }
    const createdAt = nowIso();
    wallet.updatedAt = createdAt;
    await this.db.put('independent-wallets', wallet, connection);
    const result = {
      before,
      balance: wallet.balance,
      amount: wallet.balance - before,
      group: input.group ?? null,
      expiresAt: wallet.vip.find(({ group }) => group === input.group)?.expiresAt ?? null,
      mode: 'independent',
    };
    const task: ManagementTask = {
      id: randomUUID(),
      scopeId: input.scopeId,
      hostId: instance.hostId,
      instanceId: instance.id,
      steamId,
      kind: input.kind,
      payload: { reason: input.reason },
      status: 'succeeded',
      idempotencyKey: input.idempotencyKey,
      progress: '独立商店数据已更新',
      result,
      error: null,
      leaseUntil: null,
      createdAt,
      completedAt: createdAt,
    };
    await this.db.put('management-tasks', task, connection);
    await this.db.put(
      'ledger',
      {
        id: task.id,
        scopeId: task.scopeId,
        instanceId: instance.id,
        steamId,
        kind: task.kind,
        source: 'admin',
        operationId: task.id,
        createdAt,
        status: 'succeeded',
        detail: {
          ...result,
          reason: input.reason,
          actorId: workspaceContext.getStore()?.actor?.id ?? null,
        },
      },
      connection,
    );
    return task;
  }

  async message(
    hostId: string,
    instanceId: string,
    request: ChatShopRequest,
  ): Promise<ChatShopReply> {
    const instance = await this.db.get('instances', instanceId);
    if (!instance || instance.hostId !== hostId)
      throw new BusinessError('INSTANCE_FORBIDDEN', '主机不能访问其他地图的商店。', 403);
    const scopeId = playerScope(instance);
    if ((await this.mode(scopeId)) !== 'independent')
      return notice('此服使用 ArkShop。输入 /shop 查看商品。');
    if (instance.status !== 'running') return notice('地图尚未就绪，请稍后再试。');
    if (
      Date.now() - request.createdAt >= shopRequestLifetimeMs ||
      request.createdAt - Date.now() > 15_000
    )
      return notice('此请求已过期，请重新输入指令。');
    if (request.kind === 'buy') return this.purchase(hostId, instanceId, request);
    const wallet = await this.wallet(scopeId, request.steamId);
    if (request.kind === 'points')
      return notice(`当前余额 ${wallet.balance} 金币${isVip(wallet) ? ' · VIP' : ''}`);
    const catalog = await this.db.get('independent-catalogs', scopeId);
    const products = catalog?.products.filter(({ enabled }) => enabled) ?? [];
    if (products.length === 0) return notice('商店暂无上架商品。');
    const pageSize = 6;
    const pages = Math.ceil(products.length / pageSize);
    if (request.page > pages) return notice(`共有 ${pages} 页。输入 /as shop 页码 查看。`);
    return notice(
      `商店 ${request.page}/${pages} · 余额 ${wallet.balance} · /as buy 商品编号 数量`,
      ...products
        .slice((request.page - 1) * pageSize, request.page * pageSize)
        .map((product) => `${product.id} · ${product.name} · ${this.price(product, wallet)} 金币`),
    );
  }

  private price(product: IndependentProduct, wallet: IndependentWallet) {
    return isVip(wallet) ? (product.vipPrice ?? product.price) : product.price;
  }

  private async purchase(
    hostId: string,
    instanceId: string,
    request: Extract<ChatShopRequest, { kind: 'buy' }>,
  ): Promise<ChatShopReply> {
    return this.db.transaction(async (connection) => {
      const instance = await this.db.get('instances', instanceId, connection);
      const host = await this.db.get('hosts', hostId, connection);
      if (
        !instance ||
        instance.hostId !== hostId ||
        !host ||
        host.status !== 'online' ||
        !host.features?.includes(independentShopFeature)
      )
        return notice('游戏主机暂不能接单，请稍后再试。');
      const scopeId = playerScope(instance);
      if (instance.status !== 'running' || (await this.mode(scopeId, connection)) !== 'independent')
        return notice('当前地图的独立商店未开启。');
      const expiresAt = request.createdAt + shopRequestLifetimeMs;
      if (Date.now() >= expiresAt) return notice('此请求已过期，请重新下单。');
      const previous = await this.db.get('shop-orders', request.id, connection);
      if (previous) {
        if (
          previous.instanceId !== instanceId ||
          previous.steamId !== request.steamId ||
          previous.productId !== request.productId ||
          previous.quantity !== request.quantity ||
          previous.expiresAt !== expiresAt
        )
          throw new BusinessError('SHOP_REQUEST_CONFLICT', '订单编号与已有订单冲突。', 409);
        return previous.status === 'pending'
          ? { delivery: previous.delivery, quantity: previous.quantity, expiresAt }
          : notice('此订单已处理。');
      }
      const bans = await this.db.listBy('player-bans', 'scopeId', scopeId, connection);
      if (bans.some((ban) => ban.steamId === request.steamId && activeBan(ban)))
        return notice('当前账号不能下单。');
      const catalog = await this.db.get('independent-catalogs', scopeId, connection);
      const product = catalog?.products.find(
        ({ id, enabled }) => enabled && id === request.productId,
      );
      if (!product) return notice('找不到该商品。输入 /as shop 查看在售商品。');
      if (product.delivery[0]?.kind === 'dino' && request.quantity !== 1)
        return notice('恐龙商品每单购买一只。');
      const items = product.delivery.reduce(
        (sum, line) => sum + (line.kind === 'item' ? line.amount : 1),
        0,
      );
      if (items * request.quantity > 10_000) return notice('发货数量超限，请减少购买数量。');
      const wallet = await this.wallet(scopeId, request.steamId, connection);
      const total = this.price(product, wallet) * request.quantity;
      if (wallet.balance < total)
        return notice(`余额不足。需 ${total} 金币，当前 ${wallet.balance} 金币。`);
      const createdAt = nowIso();
      const order: ShopOrder = {
        id: request.id,
        scopeId,
        instanceId,
        hostId,
        steamId: request.steamId,
        productId: product.id,
        name: product.name,
        quantity: request.quantity,
        total,
        delivery: product.delivery,
        status: 'pending',
        reason: '',
        createdAt,
        expiresAt,
        completedAt: null,
      };
      const id = countId(order);
      const count = (await this.db.get('shop-purchase-counts', id, connection))?.count ?? 0;
      if (product.limitPerPlayer !== null && count + order.quantity > product.limitPerPlayer)
        return notice(`该商品每人限购 ${product.limitPerPlayer} 份，已购或待发货 ${count} 份。`);
      wallet.balance -= total;
      wallet.reserved += total;
      wallet.updatedAt = createdAt;
      if (!(await this.db.get('managed-players', wallet.id, connection)))
        await this.db.put('managed-players', emptyPlayer(scopeId, request.steamId), connection);
      await this.db.put('independent-wallets', wallet, connection);
      await this.db.put('shop-purchase-counts', { id, count: count + order.quantity }, connection);
      await this.db.put('shop-orders', order, connection);
      await this.record(order, wallet.balance, connection);
      return { delivery: order.delivery, quantity: order.quantity, expiresAt };
    });
  }

  async receipt(hostId: string, instanceId: string, receipt: ChatShopReceipt) {
    return this.db.transaction(async (connection) => {
      const order = await this.db.get('shop-orders', receipt.id, connection);
      if (
        !order ||
        order.hostId !== hostId ||
        order.instanceId !== instanceId ||
        order.steamId !== receipt.steamId
      )
        throw new BusinessError('SHOP_ORDER_NOT_FOUND', '此地图没有对应订单。', 404);
      if (
        order.status === 'pending' ||
        (order.status === 'uncertain' && receipt.outcome !== 'uncertain')
      )
        await this.finish(order, receipt.outcome, receipt.reason, connection);
      return { status: order.status };
    });
  }

  async orders(scopeId: string, page: number) {
    const representative = scopeId.startsWith('cluster:')
      ? (await this.db.listBy('instances', 'clusterId', scopeId.slice('cluster:'.length)))[0]
      : await this.db.get('instances', scopeId.slice('instance:'.length));
    if (!representative || playerScope(representative) !== scopeId)
      throw new BusinessError('SCOPE_NOT_FOUND', '请选择有效的互通组或独立服。', 404);
    if (!allowed('commerce.write', gameTarget(representative)))
      await requireGameAccess(this.db, 'commerce.read', scopeId);
    const result = await this.db.shopOrderPage(scopeId, page);
    return {
      ...result,
      entries: result.entries.map((order) =>
        order.status === 'pending' && pendingExpired(order)
          ? { ...order, status: 'uncertain' as const, reason: '等待游戏发货回执超时。' }
          : order,
      ),
    };
  }

  async resolve(id: string, outcome: 'delivered' | 'failed', evidence: string) {
    return this.db.transaction(async (connection) => {
      const order = await this.db.get('shop-orders', id, connection);
      if (!order) throw new BusinessError('SHOP_ORDER_NOT_FOUND', '订单不存在。', 404);
      await requireGameAccess(this.db, 'commerce.write', order.scopeId, connection);
      if (order.status !== 'uncertain' && !(order.status === 'pending' && pendingExpired(order)))
        throw new BusinessError('SHOP_ORDER_STATE', '只有结果未知的订单可以核实。', 409);
      await this.finish(order, outcome, evidence, connection);
      await this.control.audit(
        '核实独立商店订单',
        order.id,
        `${outcome} · ${evidence}`,
        connection,
      );
      return order;
    });
  }

  private async finish(
    order: ShopOrder,
    outcome: ChatShopReceipt['outcome'],
    reason: string,
    connection: Connection,
  ) {
    const wallet = await this.wallet(order.scopeId, order.steamId, connection);
    order.status = outcome === 'failed' ? 'refunded' : outcome;
    order.completedAt = outcome === 'uncertain' ? null : nowIso();
    order.reason = reason;
    if (order.completedAt) wallet.reserved -= order.total;
    if (outcome === 'failed') {
      wallet.balance += order.total;
      wallet.updatedAt = order.completedAt;
      const id = countId(order);
      const count = (await this.db.get('shop-purchase-counts', id, connection))?.count ?? 0;
      await this.db.put(
        'shop-purchase-counts',
        { id, count: Math.max(0, count - order.quantity) },
        connection,
      );
    }
    if (order.completedAt) await this.db.put('independent-wallets', wallet, connection);
    await this.db.put('shop-orders', order, connection);
    await this.record(order, wallet.balance, connection);
  }

  private record(order: ShopOrder, balance: number, connection: Connection) {
    const statuses = {
      pending: 'pending',
      delivered: 'succeeded',
      refunded: 'failed',
      uncertain: 'uncertain',
    } as const;
    const entry: LedgerEntry = {
      id: order.id,
      scopeId: order.scopeId,
      steamId: order.steamId,
      instanceId: order.instanceId,
      kind: 'independent-shop-purchase',
      source: 'game',
      operationId: order.id,
      createdAt: order.createdAt,
      status: statuses[order.status],
      detail: {
        mode: 'independent',
        productId: order.productId,
        name: order.name,
        quantity: order.quantity,
        price: order.total,
        amount: order.status === 'refunded' ? 0 : -order.total,
        balance,
        orderStatus: order.status,
        reason: order.reason,
        completedAt: order.completedAt,
        actorId: workspaceContext.getStore()?.actor?.id ?? null,
      },
    };
    return this.db.put('ledger', entry, connection);
  }
}
