import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';
import { ArrowRightIcon, GearSixIcon, LinkIcon, PlugIcon, PlusIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { effectiveGameConfig } from '@ark-control/common';
import { useWorkspaceStore } from '@/store';
import { useWorkspaceCan, useWorkspaceSelection } from '@/store/workspace-selection';
import {
  Empty,
  InstanceActions,
  MapArt,
  PageHeading,
  Status,
  Surface,
  matches,
} from '@/components';
import { NewInstanceDialog } from '@/components';

function publicEndpoint(address: string, queryPort: number) {
  const raw = address
    .trim()
    .replace(/^[a-z][a-z\d+.-]*:\/\//iu, '')
    .replace(/\/.*$/u, '');
  if (!raw) return null;
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/u.exec(raw);
  if (bracketed) return `[${bracketed[1]}]:${queryPort}`;
  const hostWithPort = /^([^:]+):\d{1,5}$/u.exec(raw);
  const host = hostWithPort?.[1] ?? raw;
  return host.includes(':') ? `[${host}]:${queryPort}` : `${host}:${queryPort}`;
}

export default function Instances() {
  const { t } = useTranslation();
  const data = useWorkspaceStore((state) => state.data);
  const query = useWorkspaceStore((state) => state.query);
  const can = useWorkspaceCan();
  const space = useWorkspaceSelection((state) => state.active);
  const canConfigureClusters =
    can('clusters.admin-password') ||
    space?.grants.some(
      ({ scope }) =>
        scope.kind === 'cluster' &&
        can('clusters.admin-password', { kind: 'cluster', clusterId: scope.id }),
    );
  const canCreate = data?.hosts.some((host) =>
    can('maps.create', { kind: 'host', hostId: host.id }),
  );
  const [create, setCreate] = useState(false);
  const [addressesOpen, setAddressesOpen] = useState(false);
  const handleCreateClick = useCallback(() => setCreate(true), []);
  const instances =
    data?.instances.filter((item) => matches(query, item.name, item.mapLabel, item.clusterId)) ??
    [];
  const runningInstances = data?.instances.filter((item) => item.status === 'running') ?? [];
  return (
    <>
      <PageHeading
        title={t('地图管理')}
        description="每个地图拥有独立的配置、端口、进程和存档。"
        action={
          <Stack direction="row" gap={1} flexWrap="wrap">
            {canConfigureClusters && (
              <Button
                component={Link}
                to="/instances/clusters"
                variant="outlined"
                color="inherit"
                startIcon={<GearSixIcon size={18} />}
              >
                {t('互通组设置')}
              </Button>
            )}
            <Button
              component={Link}
              to="/instances/plugins"
              variant="outlined"
              color="inherit"
              startIcon={<PlugIcon size={18} />}
            >
              {t('服务端插件')}
            </Button>
            <Button
              variant="outlined"
              color="inherit"
              startIcon={<LinkIcon size={18} />}
              onClick={() => setAddressesOpen(true)}
            >
              {t('查看地址')}
            </Button>
            {canCreate && (
              <Button
                variant="contained"
                startIcon={<PlusIcon size={18} />}
                onClick={handleCreateClick}
                disabled={!data?.hosts.length}
              >
                {t('新建地图')}
              </Button>
            )}
          </Stack>
        }
      />
      {instances.length ? (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr', xl: 'repeat(3, 1fr)' },
            gap: 3,
          }}
        >
          {instances.map((instance) => (
            <Surface
              key={instance.id}
              role="region"
              aria-label={`地图 ${instance.name}`}
              sx={{ p: 3 }}
            >
              <Stack direction="row" justifyContent="space-between" sx={{ mb: 3 }}>
                <MapArt map={instance.map} size={64} />
                <Status value={instance.status} />
              </Stack>
              <Typography variant="h4" sx={{ mb: 1 }}>
                {instance.name}
              </Typography>
              <Typography color="text.secondary" sx={{ mb: 3 }}>
                {instance.mapLabel} ·{' '}
                {data?.hosts.find((host) => host.id === instance.hostId)?.name}
              </Typography>
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, mb: 3 }}>
                {[
                  ['CPU', `${instance.cpuPercent.toFixed(1)}%`],
                  ['内存', `${(instance.memoryMb / 1024).toFixed(1)} GB`],
                  ['玩家上限', effectiveGameConfig(instance.config).maxPlayers],
                  ['游戏端口', instance.gamePort],
                ].map(([label, value]) => (
                  <Box key={label}>
                    <Typography variant="caption" color="text.secondary">
                      {t(String(label))}
                    </Typography>
                    <Typography sx={{ mt: 0.5 }}>{value}</Typography>
                  </Box>
                ))}
              </Box>
              <Box sx={{ mb: 2 }}>
                <InstanceActions instance={instance} />
              </Box>
              <Button
                fullWidth
                component={Link}
                to={`/instances/${instance.id}`}
                variant="outlined"
                color="inherit"
                endIcon={<ArrowRightIcon size={16} />}
              >
                管理地图
              </Button>
            </Surface>
          ))}
        </Box>
      ) : (
        <Surface>
          <Empty
            title={t(query ? '未找到匹配结果' : '尚无地图实例')}
            description={t('选择在线主机，创建你的第一张地图。')}
            action={
              !data?.hosts.length ? (
                <Button component={Link} to="/hosts" variant="contained">
                  {t('添加主机')}
                </Button>
              ) : (
                <Button variant="contained" onClick={handleCreateClick}>
                  {t('新建地图')}
                </Button>
              )
            }
          />
        </Surface>
      )}
      {create && <NewInstanceDialog onClose={() => setCreate(false)} />}
      <Dialog open={addressesOpen} onClose={() => setAddressesOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{t('已启动地图地址')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Typography color="text.secondary">
              {t('仅显示运行中的地图。地址取自主机管理填写的服务器 IP，端口为该地图的查询端口。')}
            </Typography>
            {runningInstances.length ? (
              runningInstances.map((instance) => {
                const config = effectiveGameConfig(instance.config);
                const host = data?.hosts.find((item) => item.id === instance.hostId);
                const endpoint = publicEndpoint(host?.address ?? '', instance.queryPort);
                return (
                  <Box
                    key={instance.id}
                    sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2 }}
                  >
                    <Stack spacing={0.75}>
                      <Typography variant="h6">{config.sessionName}</Typography>
                      <Typography color="text.secondary">
                        {instance.mapLabel} · {config.pve ? 'PVE' : 'PVP'} ·{' '}
                        {host?.name ?? t('已移除主机')}
                      </Typography>
                      <Typography sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
                        {endpoint ?? t('主机未填写服务器 IP')}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {t('查询端口')}：{instance.queryPort}
                      </Typography>
                    </Stack>
                  </Box>
                );
              })
            ) : (
              <Alert severity="info">{t('暂无正在运行的地图。')}</Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddressesOpen(false)}>{t('关闭')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
