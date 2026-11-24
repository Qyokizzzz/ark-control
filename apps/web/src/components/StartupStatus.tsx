import { Link } from 'react-router';
import { Alert, Box, Button, Chip, LinearProgress, Stack, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { Instance } from '@ark-control/common';
import { useWorkspaceStore } from '@/store';

export default function StartupStatus({
  instance,
  compact = false,
}: {
  instance: Instance;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const now = useWorkspaceStore((state) => state.updatedAt);
  const host = useWorkspaceStore((state) =>
    state.data?.hosts.find((item) => item.id === instance.hostId),
  );
  const progress = instance.startup;
  const waiting =
    instance.status === 'starting' ||
    (!!progress &&
      ['preparing', 'launching', 'loading'].includes(progress.stage) &&
      instance.status === 'unknown');
  const failed = progress?.stage === 'failed';
  const ready = progress?.stage === 'ready' && instance.status === 'running';
  if (!waiting && !failed && !ready) return null;
  const end =
    progress && ['ready', 'failed'].includes(progress.stage) ? Date.parse(progress.updatedAt) : now;
  const elapsed = progress
    ? Math.max(0, Math.floor((end - Date.parse(progress.startedAt)) / 1000))
    : null;
  const stale = waiting && (!host?.lastSeenAt || now - Date.parse(host.lastSeenAt) > 30000);
  const stages = {
    preparing: '检查配置',
    launching: '创建进程',
    loading: '等待地图就绪',
    ready: '启动检测通过',
    failed: '启动检测失败',
  };
  return (
    <Alert
      severity={stale || failed ? 'warning' : ready ? 'success' : 'info'}
      icon={false}
      sx={{ '& .MuiAlert-message': { width: '100%', minWidth: 0 }, mb: compact ? 0 : 3 }}
    >
      <Stack gap={1.25} aria-live="polite" aria-label={t('地图启动状态')}>
        <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
          <Typography fontWeight={600}>
            {t(progress ? stages[progress.stage] : '等待启动反馈')}
          </Typography>
          {elapsed !== null && (
            <Chip
              size="small"
              label={`${t(ready || failed ? '耗时' : '已等待')} ${Math.floor(elapsed / 60)} ${t('分')} ${elapsed % 60} ${t('秒')}`}
            />
          )}
        </Stack>
        {waiting && !stale && <LinearProgress aria-label={t('地图启动检测中')} />}
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          {stale
            ? t('主机反馈已中断，当前启动结果待确认；请检查主机助手连接。')
            : (progress?.message ??
              t('启动请求已提交，等待主机助手反馈；若长期无反馈，请确认助手已更新并保持连接。'))}
        </Typography>
        <Typography variant="body2">
          PID：{instance.pid ?? t(waiting ? '等待创建' : '无运行进程')} · RCON {instance.rconPort}：
          {t(ready ? '检测通过' : '尚未确认就绪')}
        </Typography>
        {(waiting || failed) && progress?.lastRconError && (
          <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
            {t('最后一次 RCON 检测错误')}：{progress.lastRconError}
          </Typography>
        )}
        {ready && (
          <Typography variant="caption">
            {t('这是主机本地的启动检测结果；朋友进服还取决于联机网络。')}
          </Typography>
        )}
        {progress?.logs.length ? (
          <Box
            component="pre"
            aria-label={t('最近启动日志')}
            sx={{
              m: 0,
              p: 1.25,
              bgcolor: 'action.hover',
              borderRadius: 1,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              fontSize: '0.75rem',
              maxHeight: compact ? 100 : 280,
              overflowY: 'auto',
            }}
          >
            {(compact ? progress.logs.slice(-2) : progress.logs).join('\n')}
          </Box>
        ) : (
          <Typography variant="caption">
            {t('尚未收到本次启动日志；进程存在不代表地图已经就绪。')}
          </Typography>
        )}
        {!compact && progress && (
          <Box>
            <Typography variant="caption" display="block">
              {t('最近检测')}：{new Date(progress.updatedAt).toLocaleTimeString()} · {t('最近日志')}
              ：{progress.logUpdatedAt ? new Date(progress.logUpdatedAt).toLocaleTimeString() : '—'}
            </Typography>
            {progress.logPaths.map((path) => (
              <Typography
                key={path}
                variant="caption"
                display="block"
                sx={{ overflowWrap: 'anywhere' }}
              >
                {path}
              </Typography>
            ))}
          </Box>
        )}
        {compact && (
          <Button
            component={Link}
            to={`/instances/${instance.id}`}
            size="small"
            color="inherit"
            sx={{ alignSelf: 'flex-start' }}
          >
            {t('查看启动日志')}
          </Button>
        )}
      </Stack>
    </Alert>
  );
}
