import { Inject, Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  CONNECT_CONTROLLER_IP,
  CONNECT_GAME_IP,
  isHostOnline,
  activeBan,
  emptyPlayer,
  playerKey,
  playerScope,
  instanceTarget,
} from '@ark-control/common';
import type {
  ConnectionBootstrap,
  ConnectionInvite,
  ConnectionManifest,
  ConnectionNetwork,
  ConnectionNetworkInput,
  ConnectionState,
  HostConnectionConfig,
} from '@ark-control/common';
import {
  BusinessError,
  Database,
  config,
  decryptSecret,
  encryptSecret,
  hashToken,
  newToken,
  tokensEqual,
} from '@/infrastructure';
import type { Connection, RecordMap } from '@/infrastructure';
import { ControlService, nowIso } from '@/control';
import { createSigningKeys, signManifest } from '@/connections/protocol';
import { runInWorkspace } from '@/workspaces/context';
import { allowed, hostTarget, requireAccess, requireMapAccess } from '@/workspaces/access';

interface Secrets {
  networkName: string;
  networkSecret: string;
  privateKey: string;
  publicKey: { n: string; e: string };
}
const appOrigin = new URL(config.APP_ORIGIN);
const manifestOrigin = appOrigin.protocol === 'https:' ? appOrigin.origin : undefined;
function publicInvite(item: RecordMap['connection-invites']): ConnectionInvite {
  return {
    id: item.id,
    networkId: item.networkId,
    name: item.name,
    enabled: item.enabled,
    autoLaunch: item.autoLaunch,
    createdAt: item.createdAt,
    lastSeenAt: item.lastSeenAt,
    ...(item.steamId ? { steamId: item.steamId } : {}),
  };
}
@Injectable()
export class ConnectionsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ControlService) private readonly control: ControlService,
  ) {}
  async state(): Promise<ConnectionState> {
    const [allNetworks, invites, instances] = await Promise.all([
      this.db.list('connection-networks'),
      this.db.list('connection-invites'),
      this.db.list('instances'),
    ]);
    const visible = new Set(
      instances
        .filter((instance) => {
          const target = instanceTarget(instance);
          return allowed('connections.read', target) || allowed('connections.write', target);
        })
        .map((instance) => instance.id),
    );
    const networks = allNetworks.filter((network) => visible.has(network.instanceId));
    const networkIds = new Set(networks.map((network) => network.id));
    return {
      networks,
      invites: invites.filter((entry) => networkIds.has(entry.networkId)).map(publicInvite),
      launcherReady: existsSync(resolve(config.CONNECT_LAUNCHER_PATH)),
    };
  }
  private async requireNetwork(id: string, connection?: Connection) {
    const network = await this.db.get('connection-networks', id, connection);
    if (!network) throw new BusinessError('NOT_FOUND', '联机入口不存在。', 404);
    return network;
  }
  private async secrets(id: string, connection?: Connection): Promise<Secrets> {
    const record = await this.db.get('connection-credentials', id, connection);
    if (!record) throw new BusinessError('CONFIG_MISSING', '联机密钥缺失，请重新创建入口。');
    return JSON.parse(decryptSecret(record.secret)) as Secrets;
  }
  async save(input: ConnectionNetworkInput, id?: string) {
    return this.db.transaction(async (connection) => {
      const previous = id ? await this.requireNetwork(id, connection) : null;
      if (previous)
        await requireMapAccess(this.db, 'connections.write', previous.instanceId, connection);
      if (previous && previous.controllerHostId !== input.controllerHostId)
        throw new BusinessError('CONTROLLER_FIXED', '后台所在主机不能直接迁移，请新建联机入口。');
      const controller = await this.db.get('hosts', input.controllerHostId, connection);
      const instance = await requireMapAccess(
        this.db,
        'connections.write',
        input.instanceId,
        connection,
      );
      if (!controller) throw new BusinessError('NOT_FOUND', '请选择已接入的主机和地图。', 404);
      if (controller.id !== instance.hostId)
        requireAccess('hosts.connections', hostTarget(controller.id));
      const target = await this.db.get('hosts', instance.hostId, connection);
      if (controller.platform === 'linux' || target?.platform === 'linux')
        throw new BusinessError(
          'PLATFORM_UNSUPPORTED',
          '此版免安装联机支持 Windows 主机；Linux 游戏管理功能可继续使用。',
        );
      const network: ConnectionNetwork = {
        ...input,
        id: previous?.id ?? randomUUID(),
        revision: (previous?.revision ?? 0) + 1,
        createdAt: previous?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
      };
      if (!previous) {
        const secret: Secrets = {
          networkName: `ark-${randomUUID()}`,
          networkSecret: newToken(),
          ...createSigningKeys(),
        };
        await this.db.put(
          'connection-credentials',
          { id: network.id, secret: encryptSecret(JSON.stringify(secret)) },
          connection,
        );
      }
      await this.db.put('connection-networks', network, connection);
      await this.control.audit(
        previous ? '更新联机入口' : '创建联机入口',
        network.name,
        `目标地图：${instance.name}；版本 ${network.revision}`,
        connection,
      );
      return network;
    });
  }
  async invite(networkId: string, name: string, autoLaunch: boolean, steamId?: string) {
    return this.db.transaction(async (connection) => {
      const network = await this.requireNetwork(networkId, connection);
      await requireMapAccess(this.db, 'connections.write', network.instanceId, connection);
      const token = newToken();
      const invite: RecordMap['connection-invites'] = {
        id: randomUUID(),
        networkId,
        name,
        autoLaunch,
        ...(steamId ? { steamId } : {}),
        enabled: true,
        createdAt: nowIso(),
        lastSeenAt: null,
        tokenHash: hashToken(token),
        token: encryptSecret(token),
      };
      await this.db.put('connection-invites', invite, connection);
      await this.control.audit('创建联机包', network.name, name, connection);
      return publicInvite(invite);
    });
  }
  async setInviteEnabled(id: string, enabled: boolean) {
    return this.db.transaction(async (connection) => {
      const invite = await this.db.get('connection-invites', id, connection);
      if (!invite) throw new BusinessError('NOT_FOUND', '联机包不存在。', 404);
      const network = await this.requireNetwork(invite.networkId, connection);
      await requireMapAccess(this.db, 'connections.write', network.instanceId, connection);
      await this.db.put('connection-invites', { ...invite, enabled }, connection);
      await this.control.audit(enabled ? '启用联机包' : '停用联机包', invite.name, '', connection);
      return null;
    });
  }
  async remove(id: string) {
    return this.db.transaction(async (connection) => {
      const network = await this.requireNetwork(id, connection);
      await requireMapAccess(this.db, 'connections.write', network.instanceId, connection);
      for (const invite of await this.db.list('connection-invites', connection))
        if (invite.networkId === id)
          await this.db.remove('connection-invites', invite.id, connection);
      await this.db.remove('connection-networks', id, connection);
      await this.db.remove('connection-credentials', id, connection);
      await this.control.audit(
        '删除联机入口',
        network.name,
        '已撤销此入口下的全部联机包。',
        connection,
      );
      return null;
    });
  }
  async bootstrap(id: string): Promise<ConnectionBootstrap> {
    const invite = await this.db.get('connection-invites', id);
    if (!invite?.enabled) throw new BusinessError('INVITE_DISABLED', '联机包不存在或已停用。', 404);
    const network = await this.requireNetwork(invite.networkId);
    const target = await requireMapAccess(this.db, 'connections.read', network.instanceId);
    const secret = await this.secrets(network.id);
    return {
      version: 1,
      networkId: network.id,
      inviteId: invite.id,
      inviteToken: decryptSecret(invite.token),
      networkName: secret.networkName,
      networkSecret: secret.networkSecret,
      publicKey: secret.publicKey,
      controllerIp: CONNECT_CONTROLLER_IP,
      controllerPort: config.API_PORT,
      ...(manifestOrigin ? { manifestOrigin } : {}),
      peers: network.peers,
      autoLaunch: invite.autoLaunch,
      ...(invite.steamId ? { steamId: invite.steamId } : {}),
      ...(target ? { deviceScope: playerScope(target) } : {}),
    };
  }
  async manifest(id: string, token: string, deviceId?: string, consent?: string) {
    const workspaceId = await this.db.locate('connection-invites', id);
    if (!workspaceId || (await this.db.get('workspaces', workspaceId))?.status !== 'active')
      throw new BusinessError('INVITE_INVALID', '联机凭据已停用或无效，请联系服主。', 401);
    return runInWorkspace(workspaceId, () =>
      this.manifestForWorkspace(id, token, deviceId, consent),
    );
  }
  private async manifestForWorkspace(
    id: string,
    token: string,
    deviceId?: string,
    consent?: string,
  ) {
    const invite = await this.db.get('connection-invites', id);
    if (!invite?.enabled || !tokensEqual(token, invite.tokenHash))
      throw new BusinessError('INVITE_INVALID', '联机凭据已停用或无效，请联系服主。', 401);
    const network = await this.requireNetwork(invite.networkId);
    const instance = await this.db.get('instances', network.instanceId);
    if (!instance)
      throw new BusinessError('MAP_MISSING', '目标地图已移除，请联系服主更新联机入口。', 404);
    const now = Date.now();
    if (invite.steamId && (!deviceId || !/^[a-f0-9]{64}$/.test(deviceId) || consent !== 'v1'))
      throw new BusinessError(
        'DEVICE_CONSENT_REQUIRED',
        '此联机包需要使用新版客户端，并同意向服主绑定设备标识。',
        403,
      );
    const scopeId = playerScope(instance);
    const deviceBlocked =
      !!invite.steamId &&
      (await this.db.list('player-bans')).some(
        (ban) =>
          ban.scopeId === scopeId &&
          activeBan(ban) &&
          (ban.targets.devices.includes(deviceId ?? '') || ban.steamId === invite.steamId),
      );
    const host = await this.db.get('hosts', instance.hostId);
    const controllerHost = await this.db.get('hosts', network.controllerHostId);
    const manifest: ConnectionManifest = {
      networkId: network.id,
      inviteId: invite.id,
      revision: network.revision,
      issuedAt: now,
      expiresAt: now + 120000,
      enabled:
        !deviceBlocked &&
        network.enabled &&
        isHostOnline(host) &&
        (!!manifestOrigin || isHostOnline(controllerHost)),
      ...(invite.steamId ? { deviceBlocked } : {}),
      peers: network.peers,
      game: {
        ipv4:
          instance.hostId === network.controllerHostId ? CONNECT_CONTROLLER_IP : CONNECT_GAME_IP,
        gamePort: instance.gamePort,
        queryPort: instance.queryPort,
        name: instance.name,
        mapLabel: instance.mapLabel,
        running: instance.status === 'running',
      },
    };
    // A single transaction avoids overwriting a simultaneous disable with a stale last-seen write.
    if (!invite.lastSeenAt || now - Date.parse(invite.lastSeenAt) > 30000)
      await this.db.transaction(async (connection) => {
        const latest = await this.db.get('connection-invites', id, connection);
        if (latest)
          await this.db.put('connection-invites', { ...latest, lastSeenAt: nowIso() }, connection);
        if (invite.steamId && deviceId && !deviceBlocked) {
          const key = playerKey(scopeId, invite.steamId);
          const player =
            (await this.db.get('managed-players', key, connection)) ??
            emptyPlayer(scopeId, invite.steamId, invite.name);
          await this.db.put(
            'managed-players',
            {
              ...player,
              devices: [
                ...player.devices.filter((device) => device.id !== deviceId),
                { id: deviceId, source: 'client' as const, seenAt: nowIso() },
              ].slice(-30),
            },
            connection,
          );
        }
      });
    return signManifest(manifest, (await this.secrets(network.id)).privateKey);
  }
  async agentConfigurations(
    hostId: string,
    connection: Connection,
    warnings: string[] = [],
  ): Promise<HostConnectionConfig[]> {
    const results: HostConnectionConfig[] = [];
    const host = await this.db.get('hosts', hostId, connection);
    if (!isHostOnline(host)) return results;
    for (const network of await this.db.list('connection-networks', connection)) {
      const instance = await this.db.get('instances', network.instanceId, connection);
      const controller = network.controllerHostId === hostId;
      const target = network.enabled && instance?.hostId === hostId;
      if (!target && (!controller || manifestOrigin)) continue;
      let secret: Secrets;
      try {
        secret = await this.secrets(network.id, connection);
      } catch {
        warnings.push(
          `好友联机「${network.name}」的密钥缺失或无法解密，请检查原 ENCRYPTION_KEY；主机管理仍可使用。`,
        );
        continue;
      }
      results.push({
        networkId: network.id,
        networkName: secret.networkName,
        networkSecret: secret.networkSecret,
        ipv4: controller ? CONNECT_CONTROLLER_IP : CONNECT_GAME_IP,
        peers: network.peers,
        tcpPorts: controller && !manifestOrigin ? [config.API_PORT] : [],
        udpPorts:
          target && instance
            ? [...new Set([instance.gamePort, instance.gamePort + 1, instance.queryPort])]
            : [],
      });
    }
    return results;
  }
}
