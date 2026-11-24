import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Button, Stack } from '@mui/material';
import {
  ArrowClockwiseIcon,
  DownloadSimpleIcon,
  PlayIcon,
  StopIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import {
  canTerminateStartup,
  commandPermission,
  createOperationId,
  instanceTarget,
} from '@ark-control/common';
import type { Command, Instance } from '@ark-control/common';
import { request } from '@/api';
import { useWorkspaceStore } from '@/store';
import { useWorkspaceCan } from '@/store/workspace-selection';
import { FormDialog, StartupStatus, useMutation } from '@/components';

type Operation =
  'install' | 'start' | 'stop' | 'restart' | 'delete' | 'force-stop' | 'terminate-startup';
export default function InstanceActions({
  instance,
  showProgress = true,
}: {
  instance: Instance;
  showProgress?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const data = useWorkspaceStore((state) => state.data);
  const mutate = useMutation();
  const can = useWorkspaceCan();
  const available = (kind: Operation) =>
    can(
      commandPermission[kind === 'terminate-startup' ? 'force-stop' : kind],
      instanceTarget(instance),
    );
  const [operation, setOperation] = useState<Operation | null>(null);
  const operationId = useRef('');
  const handleClose = useCallback(() => setOperation(null), []);
  const handleOperation = useCallback((kind: Operation) => {
    operationId.current = createOperationId();
    setOperation(kind);
  }, []);
  const commands = data?.commands.filter((item) => item.instanceId === instance.id) ?? [];
  const active = commands.find((item) =>
    ['queued', 'leased', 'executing', 'cancelling'].includes(item.status),
  );
  const host = data?.hosts.find((item) => item.id === instance.hostId);
  const online = host?.status === 'online';
  const running = !!instance.pid || instance.status === 'running';
  const starting = canTerminateStartup(instance, active);
  const terminating = commands.some(
    (item) =>
      item.payload.terminateStartup === true &&
      ['queued', 'leased', 'executing', 'cancelling'].includes(item.status),
  );
  const lastInstall = commands
    .filter((item) => ['install', 'update'].includes(item.kind))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const failedInstall = lastInstall?.status === 'failed';
  const install = !instance.installed;
  const reinstall = failedInstall || (!instance.installed && !!instance.lastError);
  const primary: Operation = install ? 'install' : running ? 'restart' : 'start';
  const labels: Record<Operation, string> = {
    install: reinstall ? '重新安装' : '准备服务端',
    start: '启动',
    stop: '关闭',
    restart: '重启',
    delete: '删除地图',
    'force-stop': '强制关闭',
    'terminate-startup': '终止启动',
  };
  const handleSubmit = useCallback(
    async (values: Record<string, string | boolean>) => {
      if (!operation) return;
      await mutate(
        () =>
          request<Command>(`/instances/${instance.id}/commands`, 'POST', {
            kind: operation === 'terminate-startup' ? 'force-stop' : operation,
            ...(operation === 'terminate-startup' ? { terminateStartup: true } : {}),
            countdownSeconds: Number(values.countdownSeconds ?? 0),
            idempotencyKey: operationId.current,
          }),
        (result) =>
          operation === 'delete'
            ? result.payload.removedFromPanel
              ? '地图已删除。存档回收和文件保留进度可在主机管理查看。'
              : '已提交删除任务；将回收存档并保留下载文件。'
            : operation === 'terminate-startup'
              ? '终止启动任务已提交'
              : '任务已提交',
      );
      if (operation === 'delete') navigate('/instances');
    },
    [instance.id, mutate, navigate, operation],
  );
  return (
    <Stack gap={1.5}>
      <Stack direction="row" gap={1} flexWrap="wrap">
        {available(primary) && (
          <Button
            variant="contained"
            startIcon={
              install ? (
                <DownloadSimpleIcon size={18} />
              ) : running ? (
                <ArrowClockwiseIcon size={18} />
              ) : (
                <PlayIcon size={18} />
              )
            }
            disabled={!!active || !online || (install && running)}
            onClick={() => handleOperation(primary)}
          >
            {t(labels[primary])}
          </Button>
        )}
        {available('stop') && (
          <Button
            variant="outlined"
            color="inherit"
            startIcon={<StopIcon size={18} />}
            disabled={!!active || !online || !running}
            onClick={() => handleOperation('stop')}
          >
            {t('关闭')}
          </Button>
        )}
        {available('terminate-startup') && (starting || terminating) && (
          <Button
            variant="outlined"
            color="error"
            startIcon={<StopIcon size={18} />}
            disabled={terminating}
            onClick={() => handleOperation('terminate-startup')}
          >
            {t(terminating ? '正在终止启动' : '终止启动')}
          </Button>
        )}
        {available('delete') && (
          <Button
            variant="outlined"
            color="error"
            startIcon={<TrashIcon size={18} />}
            disabled={!!active || (!online && !instance.canDeleteDirectly)}
            onClick={() => handleOperation('delete')}
          >
            {t('删除地图')}
          </Button>
        )}
        {available('install') && instance.installed && failedInstall && !running && (
          <Button
            variant="outlined"
            startIcon={<DownloadSimpleIcon size={18} />}
            disabled={!!active || !online}
            onClick={() => handleOperation('install')}
          >
            {t('重新安装')}
          </Button>
        )}
        {available('force-stop') &&
          running &&
          instance.status === 'error' &&
          !starting &&
          !terminating && (
            <Button
              color="error"
              disabled={!!active || !online}
              onClick={() => handleOperation('force-stop')}
            >
              {t('强制关闭')}
            </Button>
          )}
      </Stack>
      {showProgress && <StartupStatus instance={instance} compact />}
      {active &&
        showProgress &&
        !(instance.status === 'starting' && ['start', 'restart'].includes(active.kind)) && (
          <Alert severity="info">{active.progress || t('任务执行中')}</Alert>
        )}
      {!active && instance.status === 'error' && instance.lastError && !instance.startup && (
        <Alert severity="warning" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {instance.lastError}
        </Alert>
      )}
      {!active && reinstall && !running && (
        <Alert severity="warning">
          {t('安装失败，可重新安装；原目录中的下载进度会继续使用。')}
        </Alert>
      )}
      {!online && (
        <Alert severity="info">
          {t(
            terminating || starting
              ? '主机助手当前未连接，恢复连接后会执行终止启动任务。'
              : instance.canDeleteDirectly
                ? '主机当前未连接；未运行的地图仍可删除，其他操作需恢复连接。'
                : '主机当前未连接，请先到主机管理恢复连接。',
          )}
        </Alert>
      )}
      {operation && (
        <FormDialog
          title={`${t(labels[operation])} · ${instance.name}`}
          description={
            operation === 'delete'
              ? instance.canDeleteDirectly
                ? t(
                    '此地图将立即移出列表。助手连接后回收本地图的配置和存档；共享文件、其他地图及已有备份继续保留。',
                  )
                : t(
                    '将先关闭这张地图，再回收它的配置和存档。共享文件、其他地图及已有备份继续保留。',
                  )
              : operation === 'terminate-startup'
                ? t('将取消启动任务并结束已启动的游戏进程。尚未保存的进度可能丢失。')
                : operation === 'force-stop'
                  ? t('将强制结束此地图进程，尚未保存的进度可能丢失。')
                  : operation === 'install'
                    ? t('按所选来源关联共享文件。同分支文件已存在时直接使用；没有时才下载。')
                    : ['stop', 'restart'].includes(operation)
                      ? t('倒计时结束后保存世界，再正常退出并释放进程资源。')
                      : undefined
          }
          fields={
            running && ['stop', 'restart', 'delete'].includes(operation)
              ? [
                  {
                    key: 'countdownSeconds',
                    label: '倒计时（秒）',
                    kind: 'number',
                    min: 0,
                    max: 3600,
                    required: true,
                  },
                ]
              : []
          }
          initial={{ countdownSeconds: running ? '30' : '0' }}
          onClose={handleClose}
          onSubmit={handleSubmit}
          submitLabel={labels[operation]}
        />
      )}
    </Stack>
  );
}
