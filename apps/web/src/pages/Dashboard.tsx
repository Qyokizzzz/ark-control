import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Box, Button, Chip, LinearProgress, Stack, Typography } from '@mui/material';
import {
  ArrowDownRightIcon,
  ArrowRightIcon,
  ChatCircleDotsIcon,
  CheckCircleIcon,
  ClockIcon,
  HardDrivesIcon,
  PlusIcon,
  SquaresFourIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { effectiveGameConfig } from '@ark-control/common';
import { useWorkspaceStore } from '@/store';
import { useWorkspaceCan } from '@/store/workspace-selection';
import { Empty, MapArt, PageHeading, Status, Surface, formatDate, matches } from '@/components';
import { NewInstanceDialog } from '@/components';

export default function Dashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const data = useWorkspaceStore((state) => state.data);
  const query = useWorkspaceStore((state) => state.query);
  const can = useWorkspaceCan();
  const canCreateMap = data?.hosts.some((host) =>
    can('maps.create', { kind: 'host', hostId: host.id }),
  );
  const [create, setCreate] = useState(false);
  const handleCreateClick = useCallback(() => {
    if (!canCreateMap) navigate('/hosts');
    else setCreate(true);
  }, [canCreateMap, navigate]);
  const tiles = [
    {
      label: '正在运行',
      value: data?.summary.running ?? 0,
      unit: `/ ${data?.summary.total ?? 0}`,
      icon: SquaresFourIcon,
      note: '地图实例',
    },
    {
      label: '已提交推送',
      value: data?.summary.sentToday ?? 0,
      unit: '',
      icon: ChatCircleDotsIcon,
      note: '今日 · QQ 已接受的消息',
    },
    {
      label: '等待推送',
      value: data?.summary.pending ?? 0,
      unit: '',
      icon: ClockIcon,
      note: '含合并中与等待重试',
    },
    {
      label: '需要处理',
      value: data?.summary.errors ?? 0,
      unit: '',
      icon: CheckCircleIcon,
      note: '权限异常或结果待确认',
    },
  ];
  const instances =
    data?.instances.filter((item) => matches(query, item.name, item.mapLabel)).slice(0, 4) ?? [];
  return (
    <>
      <PageHeading
        title={t('运行概况')}
        description={t('所有地图与部落的运行状态，尽在这里。')}
        action={
          (canCreateMap || can('hosts.create')) && (
            <Button
              variant="contained"
              startIcon={<PlusIcon size={18} />}
              onClick={handleCreateClick}
            >
              {t('新建地图')}
            </Button>
          )
        }
      />
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr 1fr', lg: 'repeat(4, 1fr)' },
          gap: 2,
          mb: 4,
        }}
      >
        {tiles.map(({ label, value, unit, icon: Icon, note }) => (
          <Surface key={label} sx={{ p: { xs: 2, md: 3 } }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography color="text.secondary">{t(label)}</Typography>
              <Icon size={18} color="currentColor" />
            </Stack>
            <Stack direction="row" alignItems="baseline" gap={1} sx={{ my: 2 }}>
              <Typography
                sx={{ fontSize: 36, fontWeight: 500, lineHeight: '40px', letterSpacing: '-.04em' }}
              >
                {value}
              </Typography>
              <Typography color="text.secondary">{unit}</Typography>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {t(note)}
            </Typography>
          </Surface>
        ))}
      </Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) 320px' },
          gap: 3,
        }}
      >
        <Stack gap={3}>
          <Surface>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 3 }}>
              <Stack direction="row" gap={1.5} alignItems="center">
                <Typography variant="h4">{t('地图实例')}</Typography>
                <Chip label={data?.instances.length ?? 0} />
              </Stack>
              <Button
                component={Link}
                to="/instances"
                endIcon={<ArrowRightIcon size={16} />}
                size="small"
                color="inherit"
              >
                {t('查看全部')}
              </Button>
            </Stack>
            {!data?.instances.length ? (
              <Empty
                title={t('连接你的第一台主机')}
                description={t('接入主机后，即可安装服务端、创建地图并管理部落日志。')}
                action={
                  <Button
                    component={Link}
                    to="/hosts"
                    variant="outlined"
                    startIcon={<PlusIcon size={16} />}
                  >
                    {t('立即接入')}
                  </Button>
                }
              />
            ) : (
              instances.map((instance) => (
                <Box
                  key={instance.id}
                  component={Link}
                  to={`/instances/${instance.id}`}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    p: 3,
                    gap: 2,
                    textDecoration: 'none',
                    color: 'inherit',
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  <MapArt map={instance.map} />
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Stack
                      direction="row"
                      alignItems="center"
                      gap={1.5}
                      sx={{ mb: 1, flexWrap: 'wrap' }}
                    >
                      <Typography variant="h6">{instance.name}</Typography>
                      <Status value={instance.status} />
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      {instance.mapLabel} ·{' '}
                      {data.hosts.find((host) => host.id === instance.hostId)?.name} ·{' '}
                      {effectiveGameConfig(instance.config).maxPlayers} 人
                    </Typography>
                  </Box>
                  <Box sx={{ minWidth: 80, display: { xs: 'none', sm: 'block' } }}>
                    <Typography variant="caption" color="text.secondary">
                      {t('内存')}
                    </Typography>
                    <Typography sx={{ mt: 0.5 }}>
                      {(instance.memoryMb / 1024).toFixed(1)} GB
                    </Typography>
                  </Box>
                  <ArrowDownRightIcon size={20} />
                </Box>
              ))
            )}
          </Surface>
          <Surface>
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ p: 3 }}>
              <Typography variant="h4">{t('最近活动')}</Typography>
              <Button
                component={Link}
                to="/logs?tab=audit"
                color="inherit"
                size="small"
                endIcon={<ArrowRightIcon size={16} />}
              >
                {t('查看全部')}
              </Button>
            </Stack>
            {!data?.audit.length ? (
              <Box sx={{ px: 3, pb: 4 }}>
                <Typography color="text.secondary">操作记录将在这里显示。</Typography>
              </Box>
            ) : (
              data.audit.slice(0, 5).map((entry) => (
                <Stack
                  key={entry.id}
                  direction="row"
                  alignItems="flex-start"
                  gap={2}
                  sx={{ px: 3, py: 2 }}
                >
                  <Box
                    sx={{
                      mt: 0.5,
                      width: 8,
                      height: 8,
                      flexShrink: 0,
                      borderRadius: '50%',
                      bgcolor: 'primary.main',
                      opacity: 0.7,
                    }}
                  />
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography>
                      {entry.action} · {entry.target}
                    </Typography>
                    <Typography
                      color="text.secondary"
                      variant="caption"
                      sx={{ mt: 0.5, display: 'block', overflowWrap: 'anywhere' }}
                    >
                      {entry.detail}
                    </Typography>
                  </Box>
                  <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                    {formatDate(entry.createdAt)}
                  </Typography>
                </Stack>
              ))
            )}
          </Surface>
        </Stack>
        <Stack gap={3}>
          <Surface sx={{ p: 3 }}>
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              sx={{ mb: 3 }}
            >
              <Typography variant="h4">{t('资源概览')}</Typography>
              <HardDrivesIcon size={20} />
            </Stack>
            {!data?.hosts.length ? (
              <Typography color="text.secondary">{t('尚未接入主机')}</Typography>
            ) : (
              data.hosts.slice(0, 3).map((host) => (
                <Box key={host.id} sx={{ mb: 3 }}>
                  <Stack direction="row" justifyContent="space-between" gap={1} sx={{ mb: 2 }}>
                    <Typography>{host.name}</Typography>
                    <Status value={host.status} />
                  </Stack>
                  <Stack direction="row" justifyContent="space-between" sx={{ mb: 1 }}>
                    <Typography variant="caption" color="text.secondary">
                      CPU
                    </Typography>
                    <Typography variant="caption">
                      {host.metrics ? `${host.metrics.cpuPercent.toFixed(1)}%` : '—'}
                    </Typography>
                  </Stack>
                  <LinearProgress
                    variant="determinate"
                    value={host.metrics?.cpuPercent ?? 0}
                    sx={{ mb: 2 }}
                  />
                  <Stack direction="row" justifyContent="space-between" sx={{ mb: 1 }}>
                    <Typography variant="caption" color="text.secondary">
                      {t('内存')}
                    </Typography>
                    <Typography variant="caption">
                      {host.metrics
                        ? `${((host.metrics.totalMemoryMb - host.metrics.freeMemoryMb) / 1024).toFixed(1)} / ${(host.metrics.totalMemoryMb / 1024).toFixed(0)} GB`
                        : '—'}
                    </Typography>
                  </Stack>
                  <LinearProgress
                    color="secondary"
                    variant="determinate"
                    value={
                      host.metrics
                        ? Math.min(
                            100,
                            (1 - host.metrics.freeMemoryMb / host.metrics.totalMemoryMb) * 100,
                          )
                        : 0
                    }
                  />
                </Box>
              ))
            )}
          </Surface>
          <Surface sx={{ p: 3 }}>
            <Chip label="QQ LOG RELAY" sx={{ mb: 3, fontSize: 12, letterSpacing: '.05em' }} />
            <Typography variant="h4" sx={{ mb: 2 }}>
              部落动态
              <br />
              送达指定群。
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 3, lineHeight: 1.8 }}>
              所有部落日志按同名内容合并，30 秒固定窗口，到时提交推送。
            </Typography>
            <Stack direction="row" justifyContent="space-between" sx={{ mb: 2 }}>
              <Typography variant="caption" color="text.secondary">
                {t('合并窗口')}
              </Typography>
              <Typography variant="caption">30s</Typography>
            </Stack>
            <Stack direction="row" justifyContent="space-between" sx={{ mb: 3 }}>
              <Typography variant="caption" color="text.secondary">
                {t('管理员手动配置')}
              </Typography>
              <Typography variant="caption">
                {data?.subscriptions.filter((item) => item.enabled).length ?? 0} 条
              </Typography>
            </Stack>
            <Button
              fullWidth
              component={Link}
              to="/subscriptions"
              variant="outlined"
              endIcon={<ArrowRightIcon size={16} />}
            >
              管理订阅
            </Button>
          </Surface>
        </Stack>
      </Box>
      {create && <NewInstanceDialog onClose={() => setCreate(false)} />}
    </>
  );
}
