import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, Divider, Stack, Typography } from '@mui/material';
import { DownloadSimpleIcon, PlusIcon, UsersThreeIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { CONNECT_DEFAULT_PEERS } from '@ark-control/common';
import type { ConnectionInvite, ConnectionNetwork } from '@ark-control/common';
import { request, downloadConnection } from '@/api';
import { useConnectionsStore, useUiStore, useWorkspaceStore } from '@/store';
import {
  ConfirmDialog,
  Empty,
  FormDialog,
  PageHeading,
  Surface,
  formatDate,
  matches,
} from '@/components';
import type { FormValues } from '@/components';

export default function Connections() {
  const { t } = useTranslation();
  const workspace = useWorkspaceStore((state) => state.data);
  const query = useWorkspaceStore((state) => state.query);
  const { data, error, load } = useConnectionsStore();
  const notify = useUiStore((state) => state.notify);
  const [edit, setEdit] = useState<ConnectionNetwork | 'new' | null>(null);
  const [inviting, setInviting] = useState<ConnectionNetwork | null>(null);
  const [removing, setRemoving] = useState<ConnectionNetwork | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  const handleCreateClick = useCallback(() => setEdit('new'), []);
  const handleCloseEdit = useCallback(() => setEdit(null), []);
  const handleCloseInvite = useCallback(() => setInviting(null), []);
  const handleCloseRemove = useCallback(() => setRemoving(null), []);
  const handleRemove = useCallback(async () => {
    if (!removing) return;
    await request(`/connections/${removing.id}`, 'DELETE');
    await load();
    notify(t('联机入口已删除。'));
  }, [removing, load, notify, t]);
  const handleSave = useCallback(
    async (values: FormValues) => {
      const id = edit && edit !== 'new' ? edit.id : null;
      await request(id ? `/connections/${id}` : '/connections', id ? 'PATCH' : 'POST', {
        name: values.name,
        controllerHostId: values.controllerHostId,
        instanceId: values.instanceId,
        peers: String(values.peers)
          .split(/[\n,]+/)
          .map((item) => item.trim())
          .filter(Boolean),
        enabled: !!values.enabled,
      });
      await load();
      notify(t('联机入口已更新，好友客户端会自动获取。'));
    },
    [edit, load, notify, t],
  );
  const handleInvite = useCallback(
    async (values: FormValues) => {
      if (!inviting) return;
      await request(`/connections/${inviting.id}/invites`, 'POST', {
        name: values.name,
        autoLaunch: !!values.autoLaunch,
        ...(values.steamId ? { steamId: String(values.steamId).trim() } : {}),
      });
      await load();
      notify(t('联机包已创建，可下载发给好友。'));
    },
    [inviting, load, notify, t],
  );
  const handleDownload = useCallback(
    async (id: string) => {
      setDownloading(id);
      try {
        await downloadConnection(id);
      } catch (failure) {
        notify(failure instanceof Error ? failure.message : '下载失败。', 'error');
      } finally {
        setDownloading(null);
      }
    },
    [notify],
  );
  const handleToggleInvite = useCallback(
    async (invite: ConnectionInvite) => {
      try {
        await request(`/connections/invites/${invite.id}`, 'PATCH', { enabled: !invite.enabled });
        await load();
      } catch (failure) {
        notify(failure instanceof Error ? failure.message : '保存失败。', 'error');
      }
    },
    [load, notify],
  );
  const previous = edit && edit !== 'new' ? edit : null;
  const networks = data?.networks.filter((item) => matches(query, item.name)) ?? [];
  return (
    <>
      <PageHeading
        title="好友联机"
        description="发一个客户端给朋友，服务器地址由你统一更新。"
        action={
          <Button
            variant="contained"
            startIcon={<PlusIcon />}
            onClick={handleCreateClick}
            disabled={!workspace?.hosts.length || !workspace.instances.length}
          >
            {t('新建联机入口')}
          </Button>
        }
      />
      <Stack spacing={3}>
        {error && <Alert severity="error">{error}</Alert>}
        {data && !data.launcherReady && (
          <Alert severity="info">
            {t('请在 Windows 后台主机运行 pnpm run build:connect，生成免安装客户端。')}
          </Alert>
        )}
        <Surface sx={{ p: 3 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <UsersThreeIcon size={32} />
            <Box>
              <Typography variant="h6">{t('下载、打开、进入游戏')}</Typography>
              <Typography color="text.secondary" sx={{ mt: 1 }}>
                {t(
                  'Steam 版好友双击联机包即可连接，无需填写 IP、安装虚拟网卡。后台切换目标地图后自动更新；正在游戏中的玩家需重新进服。',
                )}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                {t(
                  '没有公网节点时使用 EasyTier 社区共享节点协助连接。能否直连及延迟取决于双方网络，共享节点不提供稳定性保证。',
                )}
              </Typography>
              <Button
                component="a"
                href="https://uptime.easytier.cn/"
                target="_blank"
                rel="noopener noreferrer"
                size="small"
                sx={{ mt: 1 }}
              >
                {t('查找社区共享节点')}
              </Button>
            </Box>
          </Stack>
        </Surface>
        {!networks.length && (
          <Empty
            title="尚未创建联机入口"
            description="先添加本机主机和地图，再创建入口并下载好友联机包。"
          />
        )}
        {networks.map((network) => {
          const instance = workspace?.instances.find((item) => item.id === network.instanceId);
          const controllerHost = workspace?.hosts.find(
            (item) => item.id === network.controllerHostId,
          );
          const gameHost = workspace?.hosts.find((item) => item.id === instance?.hostId);
          const controllerReport = controllerHost?.connections?.find(
            (item) => item.networkId === network.id,
          );
          const gameReport = gameHost?.connections?.find((item) => item.networkId === network.id);
          return (
            <Surface key={network.id} sx={{ p: { xs: 2, md: 3 } }}>
              <Stack spacing={2.5}>
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={2}
                  justifyContent="space-between"
                  alignItems={{ sm: 'center' }}
                >
                  <Box>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="h6">{network.name}</Typography>
                      <Chip
                        size="small"
                        label={t(network.enabled ? '已开放' : '已暂停')}
                        color={network.enabled ? 'success' : 'default'}
                      />
                    </Stack>
                    <Typography color="text.secondary" sx={{ mt: 1 }}>
                      {instance?.name ?? t('目标地图已移除')} · {instance?.mapLabel} · {t('版本')}{' '}
                      {network.revision}
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={1}>
                    <Button onClick={() => setEdit(network)}>{t('切换地图 / 设置')}</Button>
                    <Button
                      variant="outlined"
                      onClick={() => setInviting(network)}
                      disabled={!data?.launcherReady}
                    >
                      {t('创建联机包')}
                    </Button>
                  </Stack>
                </Stack>
                <Typography
                  variant="body2"
                  color={controllerReport?.status === 'error' ? 'error' : 'text.secondary'}
                >
                  {t('后台所在主机')}：{controllerHost?.name} ·{' '}
                  {controllerHost?.status === 'online'
                    ? controllerReport
                      ? controllerReport.message
                      : t('等待主机助手接收配置')
                    : t('主机助手离线')}
                </Typography>
                <Typography
                  variant="body2"
                  color={gameReport?.status === 'error' ? 'error' : 'text.secondary'}
                >
                  {t('游戏所在主机')}：{gameHost?.name} ·{' '}
                  {gameHost?.status === 'online'
                    ? gameReport
                      ? gameReport.message
                      : t('等待主机助手接收配置')
                    : t('主机助手离线')}
                </Typography>
                <Divider />
                <Button
                  color="error"
                  size="small"
                  sx={{ alignSelf: 'flex-start' }}
                  onClick={() => setRemoving(network)}
                >
                  {t('删除联机入口')}
                </Button>
                {data?.invites
                  .filter((invite) => invite.networkId === network.id)
                  .map((invite) => (
                    <Stack
                      key={invite.id}
                      direction={{ xs: 'column', sm: 'row' }}
                      justifyContent="space-between"
                      spacing={1}
                    >
                      <Box>
                        <Typography>
                          {invite.name} {!invite.enabled && `· ${t('已停用')}`}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {t('最近连接')}：{formatDate(invite.lastSeenAt)}
                        </Typography>
                      </Box>
                      <Stack direction="row" spacing={1}>
                        <Button
                          size="small"
                          startIcon={<DownloadSimpleIcon />}
                          onClick={() => void handleDownload(invite.id)}
                          disabled={!invite.enabled || downloading === invite.id}
                        >
                          {t(downloading === invite.id ? '正在下载…' : '下载联机包')}
                        </Button>
                        <Button
                          size="small"
                          color={invite.enabled ? 'warning' : 'primary'}
                          onClick={() => void handleToggleInvite(invite)}
                        >
                          {t(invite.enabled ? '停用' : '启用')}
                        </Button>
                      </Stack>
                    </Stack>
                  ))}
              </Stack>
            </Surface>
          );
        })}
      </Stack>
      {edit && (
        <FormDialog
          title={previous ? '更新联机入口' : '新建联机入口'}
          onClose={handleCloseEdit}
          onSubmit={handleSave}
          description="后台所在主机必须是运行本管理后台的电脑，且主机助手持续在线。游戏地图可位于另一台已接入的 Windows 主机。"
          initial={{
            name: previous?.name ?? '好友联机',
            controllerHostId: previous?.controllerHostId ?? workspace?.hosts[0]?.id ?? '',
            instanceId: previous?.instanceId ?? workspace?.instances[0]?.id ?? '',
            peers: (previous?.peers ?? CONNECT_DEFAULT_PEERS).join('\n'),
            enabled: previous?.enabled ?? true,
          }}
          fields={[
            { key: 'name', label: '名称', required: true },
            {
              key: 'controllerHostId',
              label: '后台所在主机',
              kind: 'select',
              required: true,
              disabled: !!previous,
              options: workspace?.hosts
                .filter((item) => item.platform !== 'linux')
                .map((item) => ({ value: item.id, label: item.name })),
            },
            {
              key: 'instanceId',
              label: '目标地图',
              kind: 'select',
              required: true,
              options: workspace?.instances.map((item) => ({
                value: item.id,
                label: `${item.name} · ${workspace.hosts.find((host) => host.id === item.hostId)?.name}`,
              })),
            },
            { key: 'enabled', label: '开放好友联机', kind: 'switch' },
            {
              key: 'peers',
              label: '连接引导节点',
              kind: 'textarea',
              required: true,
              helper: '从社区共享节点目录复制可用地址，每行一个；更换时保留至少一个旧节点。',
            },
          ]}
        />
      )}
      {removing && (
        <ConfirmDialog
          title="删除联机入口"
          message="此入口下的全部联机包将失效，朋友需要使用新入口的联机包重新连接。游戏地图和存档保持保留。"
          destructive
          onClose={handleCloseRemove}
          onConfirm={handleRemove}
        />
      )}
      {inviting && (
        <FormDialog
          title="创建联机包"
          onClose={handleCloseInvite}
          onSubmit={handleInvite}
          description="联机包包含此入口的连接凭据，请只发给受信任的朋友。停用会使标准客户端断开；游戏密码仍由地图管理设置。"
          initial={{ name: '好友测试', autoLaunch: false, steamId: '' }}
          fields={[
            { key: 'name', label: '联机包名称', required: true },
            {
              key: 'steamId',
              label: '绑定 SteamID64（可选）',
              helper:
                '填写后，客户端首次运行会请求设备绑定同意；此关联由管理员提供，不代表已验证 Steam 登录。',
            },
            { key: 'autoLaunch', label: '连接成功后自动打开 Steam 进服', kind: 'switch' },
          ]}
        />
      )}
    </>
  );
}
