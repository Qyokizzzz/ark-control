import { useCallback, useState } from 'react';
import type { FocusEvent } from 'react';
import { Link } from 'react-router';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { CopyIcon, HardDrivesIcon, PlusIcon, PlugsIcon, TrashIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { useUiStore, useWorkspaceStore } from '@/store';
import { downloadAgent, request } from '@/api';
import { useWorkspaceCan } from '@/store/workspace-selection';
import {
  Empty,
  ConfirmDialog,
  copyText,
  FormDialog,
  PageHeading,
  Status,
  Surface,
  formatDate,
  matches,
  useMutation,
} from '@/components';

export default function Hosts() {
  const { t } = useTranslation();
  const data = useWorkspaceStore((state) => state.data);
  const query = useWorkspaceStore((state) => state.query);
  const mutate = useMutation();
  const notify = useUiStore((state) => state.notify);
  const can = useWorkspaceCan();
  const canCreate = can('hosts.create');
  const hostTarget = (id: string) => ({ kind: 'host' as const, hostId: id });
  const [create, setCreate] = useState(false);
  const [enrollment, setEnrollment] = useState<{
    name: string;
    code: string;
    reconnect?: boolean;
  } | null>(null);
  const [operation, setOperation] = useState<{
    id: string;
    name: string;
    kind: 'disconnect' | 'delete';
  } | null>(null);
  const handleOperation = useCallback(
    (id: string, name: string, kind: 'disconnect' | 'delete') => setOperation({ id, name, kind }),
    [],
  );
  const handleCloseOperation = useCallback(() => setOperation(null), []);
  const handleConfirmOperation = useCallback(async () => {
    if (!operation) return;
    await mutate(
      () =>
        request(
          operation.kind === 'disconnect'
            ? `/hosts/${operation.id}/disconnect`
            : `/hosts/${operation.id}`,
          operation.kind === 'disconnect' ? 'POST' : 'DELETE',
        ),
      operation.kind === 'disconnect' ? '已请求关闭地图并断开主机。' : '主机已删除。',
    );
  }, [mutate, operation]);
  const handleCreateClick = useCallback(() => setCreate(true), []);
  const handleRenewClick = useCallback(
    async (id: string, name: string) => {
      try {
        const result = await request<{ code: string }>(`/hosts/${id}/enrollment`, 'POST');
        setEnrollment({ name, code: result.code, reconnect: true });
      } catch (error) {
        notify((error as Error).message, 'error');
      }
    },
    [notify],
  );
  const handleRetryCleanup = useCallback(
    async (id: string) => {
      try {
        await mutate(
          () => request(`/hosts/${id}/cleanup-retry`, 'POST'),
          '已安排继续清理，主机助手连接后执行。',
        );
      } catch (error) {
        notify((error as Error).message, 'error');
      }
    },
    [mutate, notify],
  );
  const handleDownload = () =>
    void downloadAgent().catch((error: Error) => notify(error.message, 'error'));
  const hosts =
    data?.hosts.filter((host) => {
      const target = hostTarget(host.id);
      return (
        (can('hosts.read', target) ||
          can('hosts.enroll', target) ||
          can('hosts.disconnect', target) ||
          can('hosts.delete', target)) &&
        matches(query, host.name, host.address, host.platform)
      );
    }) ?? [];
  return (
    <>
      <PageHeading
        title={t('主机管理')}
        description="接入 Windows 或 Linux 主机，统一管理资源、游戏实例与任务。"
        action={
          <Stack direction="row" gap={1} flexWrap="wrap">
            {(canCreate ||
              data?.hosts.some((host) => can('hosts.enroll', hostTarget(host.id)))) && (
              <Button variant="outlined" onClick={handleDownload}>
                下载 Windows 主机助手
              </Button>
            )}
            {canCreate && (
              <Button
                variant="contained"
                startIcon={<PlusIcon size={18} />}
                onClick={handleCreateClick}
              >
                {t('添加主机')}
              </Button>
            )}
          </Stack>
        }
      />
      {hosts.length ? (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 3 }}>
          {hosts.map((host) => (
            <Surface key={host.id} role="region" aria-label={`主机 ${host.name}`} sx={{ p: 3 }}>
              <Stack
                direction="row"
                alignItems="center"
                justifyContent="space-between"
                sx={{ mb: 3 }}
              >
                <Stack direction="row" alignItems="center" gap={2}>
                  <HardDrivesIcon size={28} weight="duotone" />
                  <Box>
                    <Typography variant="h4">{host.name}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {host.address || '地址由你在后台维护'} · {host.platform}
                    </Typography>
                  </Box>
                </Stack>
                <Status value={host.status} />
              </Stack>
              {host.metrics ? (
                <>
                  <Typography variant="caption" color="text.secondary">
                    {host.metrics.cpuModel} · {host.metrics.cpuCores} 核心
                  </Typography>
                  <Stack direction="row" justifyContent="space-between" sx={{ mt: 3, mb: 1 }}>
                    <Typography>CPU</Typography>
                    <Typography>{host.metrics.cpuPercent.toFixed(1)}%</Typography>
                  </Stack>
                  <LinearProgress variant="determinate" value={host.metrics.cpuPercent} />
                  <Stack direction="row" justifyContent="space-between" sx={{ mt: 3, mb: 1 }}>
                    <Typography>可用内存</Typography>
                    <Typography>
                      {(host.metrics.freeMemoryMb / 1024).toFixed(1)} /{' '}
                      {(host.metrics.totalMemoryMb / 1024).toFixed(0)} GB
                    </Typography>
                  </Stack>
                  <LinearProgress
                    variant="determinate"
                    value={Math.min(
                      100,
                      (1 - host.metrics.freeMemoryMb / host.metrics.totalMemoryMb) * 100,
                    )}
                    color="secondary"
                  />
                  <Stack direction="row" justifyContent="space-between" sx={{ mt: 3 }}>
                    <Typography color="text.secondary">{t('游戏工作盘可用')}</Typography>
                    <Typography>
                      {host.metrics.gameDiskMeasured
                        ? `${host.metrics.diskFreeGb.toFixed(1)} GB`
                        : t('未采集')}
                    </Typography>
                  </Stack>
                </>
              ) : (
                <Alert severity="info">主机助手接入并上报后，这里会显示真实资源数据。</Alert>
              )}
              <Stack
                direction="row"
                justifyContent="space-between"
                alignItems="center"
                gap={2}
                sx={{ mt: 3 }}
              >
                <Typography variant="caption" color="text.secondary">
                  最近连接：{formatDate(host.lastSeenAt)}
                </Typography>
                {can('hosts.enroll', hostTarget(host.id)) && (
                  <Button
                    size="small"
                    variant="outlined"
                    color="inherit"
                    onClick={() => void handleRenewClick(host.id, host.name)}
                  >
                    {t(host.status === 'online' ? '重新生成接入码' : '重新连接')}
                  </Button>
                )}
              </Stack>
              <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 2 }}>
                {can('hosts.disconnect', hostTarget(host.id)) && (
                  <Button
                    variant="outlined"
                    color="inherit"
                    startIcon={<PlugsIcon size={17} />}
                    disabled={['disconnecting', 'disconnected'].includes(host.status)}
                    onClick={() => handleOperation(host.id, host.name, 'disconnect')}
                  >
                    {t('断开主机')}
                  </Button>
                )}
                {can('hosts.delete', hostTarget(host.id)) && (
                  <Button
                    variant="outlined"
                    color="error"
                    startIcon={<TrashIcon size={17} />}
                    disabled={
                      data?.instances.some((item) => item.hostId === host.id) ||
                      !!host.pendingCleanups ||
                      ['online', 'disconnecting'].includes(host.status)
                    }
                    onClick={() => handleOperation(host.id, host.name, 'delete')}
                  >
                    {t('删除主机')}
                  </Button>
                )}
              </Stack>
              {!!data?.instances.some((item) => item.hostId === host.id) && (
                <Typography
                  color="text.secondary"
                  variant="caption"
                  sx={{ display: 'block', mt: 1.5 }}
                >
                  {t('删除主机前，请先处理其下的地图。')}{' '}
                  <Link to="/instances">{t('地图管理')}</Link>
                </Typography>
              )}
              {host.status === 'online' &&
                !data?.instances.some((item) => item.hostId === host.id) && (
                  <Typography
                    color="text.secondary"
                    variant="caption"
                    sx={{ display: 'block', mt: 1.5 }}
                  >
                    {t('先断开主机，释放联机资源后即可删除。')}
                  </Typography>
                )}
              {host.status === 'disconnecting' && (
                <Alert severity="info" sx={{ mt: 2 }}>
                  {t('正在关闭地图并释放联机资源；离线助手将在重新上线后完成断开。')}
                </Alert>
              )}
              {host.status === 'disconnected' && (
                <Alert severity="info" sx={{ mt: 2 }}>
                  {t('已断开；地图配置和存档保留，恢复连接需要重新生成接入码并接入。')}
                </Alert>
              )}
              {host.disconnectError && (
                <Alert severity="error" sx={{ mt: 2 }}>
                  {host.disconnectError}
                </Alert>
              )}
              {!!host.pendingCleanups && (
                <Alert
                  severity={host.cleanupError ? 'warning' : 'info'}
                  sx={{ mt: 2 }}
                  action={
                    host.cleanupError && can('hosts.disconnect', hostTarget(host.id)) ? (
                      <Button color="inherit" onClick={() => void handleRetryCleanup(host.id)}>
                        {t('重试清理')}
                      </Button>
                    ) : undefined
                  }
                >
                  {t('已删除地图等待存档回收及文件保留')}：{host.pendingCleanups}。
                  {t('助手连接后会回收存档，并将下载文件保留到文件库。')}
                  {host.cleanupError ? ` ${host.cleanupError}` : ''}
                </Alert>
              )}
              {host.agentWarnings?.map((warning) => (
                <Alert severity="warning" key={warning} sx={{ mt: 2 }}>
                  {warning}
                </Alert>
              ))}
            </Surface>
          ))}
        </Box>
      ) : (
        <Surface>
          <Empty
            title={t('尚未接入主机')}
            description={
              canCreate
                ? '添加主机后，在游戏电脑上运行助手并填入接入码。'
                : '这里显示你获授权的主机。'
            }
            action={
              canCreate && (
                <Button variant="contained" onClick={handleCreateClick}>
                  {t('添加主机')}
                </Button>
              )
            }
          />
        </Surface>
      )}
      {create && (
        <FormDialog
          title={t('添加主机')}
          fields={[
            { key: 'name', label: '主机名称', required: true },
            { key: 'address', label: '服务器 IP 或备注' },
          ]}
          initial={{ name: '', address: '' }}
          onClose={() => setCreate(false)}
          onSubmit={async (values) => {
            const result = await mutate(() => request<{ code: string }>('/hosts', 'POST', values));
            setEnrollment({ name: String(values.name), code: result.code });
          }}
          submitLabel="生成接入码"
        />
      )}
      {operation && (
        <ConfirmDialog
          title={`${t(operation.kind === 'disconnect' ? '断开主机' : '删除主机')} · ${operation.name}`}
          message={
            operation.kind === 'disconnect'
              ? '将先正常关闭此主机上的全部地图，退出好友联机组件，再断开助手。地图配置和存档保留；之后需要重新接入。'
              : '将移除该主机记录和接入凭据；已有备份及回收存档保留。'
          }
          destructive
          onClose={handleCloseOperation}
          onConfirm={handleConfirmOperation}
        />
      )}
      {enrollment && (
        <Dialog open fullWidth maxWidth="sm" onClose={() => setEnrollment(null)}>
          <DialogTitle>
            {t(enrollment.reconnect ? '重新连接主机' : '主机接入码')} · {enrollment.name}
          </DialogTitle>
          <DialogContent>
            <Stack gap={3}>
              <Alert severity="info">
                下载并解压助手，在游戏主机上运行
                ArkHostAgent.cmd，按提示输入接入码。接入码一小时内有效，只能使用一次。
                {enrollment.reconnect && '重连时用新版助手覆盖原目录，沿用原游戏工作目录。'}
              </Alert>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1}>
                <TextField
                  fullWidth
                  label="一次性接入码"
                  value={enrollment.code}
                  slotProps={{
                    input: { readOnly: true },
                    htmlInput: {
                      onFocus: (event: FocusEvent<HTMLInputElement>) =>
                        event.currentTarget.select(),
                    },
                  }}
                />
                <Button
                  onClick={(event) =>
                    void copyText(
                      enrollment.code,
                      event.currentTarget.closest('[role="dialog"]'),
                    ).then(
                      () => notify('已复制接入码。'),
                      () => notify('请手动复制接入码。', 'info'),
                    )
                  }
                  startIcon={<CopyIcon size={16} />}
                  sx={{ whiteSpace: 'nowrap' }}
                >
                  复制接入码
                </Button>
              </Stack>
              <Button onClick={handleDownload} variant="outlined" sx={{ alignSelf: 'start' }}>
                下载 Windows 主机助手
              </Button>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setEnrollment(null)}>{t('关闭')}</Button>
          </DialogActions>
        </Dialog>
      )}
    </>
  );
}
