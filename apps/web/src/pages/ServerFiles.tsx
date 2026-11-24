import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  LinearProgress,
  Link as MuiLink,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  ArrowSquareOutIcon,
  CopyIcon,
  DownloadSimpleIcon,
  FolderOpenIcon,
  MagnifyingGlassIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import {
  createOperationId,
  GAME_BRANCHES,
  reservesServerFiles,
  SHARED_MAP_FILES_FEATURE,
  shareableServerFiles,
  usesServerFiles,
} from '@ark-control/common';
import type { FileOperation, FileTask, ServerFiles } from '@ark-control/common';
import { request } from '@/api';
import { useUiStore, useWorkspaceStore } from '@/store';
import {
  Empty,
  FormDialog,
  NewInstanceDialog,
  PageHeading,
  Status,
  Surface,
  copyText,
  formatDate,
  formatSize,
  matches,
  useMutation,
} from '@/components';
import type { Field, FormValues } from '@/components';

const operationLabels: Record<FileOperation, string> = {
  scan: '扫描主机文件',
  download: '下载服务端',
  import: '导入已有服务端',
  clone: '创建本机副本',
  verify: '校验 / 修复',
  update: '更新文件',
  delete: '删除下载文件',
  open: '打开文件位置',
  rename: '重命名',
};
const fileStatuses: Record<ServerFiles['status'], string> = {
  ready: '可复用',
  'in-use': '共享使用中',
  partial: '未完成 / 需修复',
  missing: '文件缺失',
  busy: '操作中',
  error: '需要处理',
  deleted: '已删除',
};
const active = (task: FileTask) =>
  ['queued', 'leased', 'executing', 'cancelling'].includes(task.status);
export default function ServerFilesPage() {
  const { t } = useTranslation();
  const data = useWorkspaceStore((state) => state.data);
  const query = useWorkspaceStore((state) => state.query);
  const notify = useUiStore((state) => state.notify);
  const mutate = useMutation();
  const [hostId, setHostId] = useState('');
  const [dialog, setDialog] = useState<{ kind: FileOperation; asset?: ServerFiles } | null>(null);
  const [reuse, setReuse] = useState<ServerFiles | null>(null);
  const files = data?.serverFiles ?? [];
  const tasks = data?.fileTasks ?? [];
  const visible = files.filter(
    (file) =>
      (!hostId || file.hostId === hostId) &&
      matches(
        query,
        file.name,
        file.path,
        file.buildId,
        data?.hosts.find((host) => host.id === file.hostId)?.name,
      ),
  );
  const handleClose = useCallback(() => setDialog(null), []);
  const handleReuseClose = useCallback(() => setReuse(null), []);
  const handleCopyClick = useCallback(
    async (path: string) => {
      try {
        await copyText(path);
        notify('路径已复制');
      } catch (error) {
        notify(error instanceof Error ? error.message : '复制失败，请手动复制路径。', 'error');
      }
    },
    [notify],
  );
  const handleActionClick = useCallback(
    async (kind: FileOperation, asset?: ServerFiles) => {
      if (kind !== 'open' || !asset) {
        setDialog({ kind, asset });
        return;
      }
      try {
        await mutate(
          () =>
            request('/server-files/tasks', 'POST', {
              kind,
              hostId: asset.hostId,
              assetId: asset.id,
              idempotencyKey: createOperationId(),
            }),
          '已向游戏主机发送打开目录请求。',
        );
      } catch (error) {
        notify((error as Error).message, 'error');
      }
    },
    [mutate, notify],
  );
  const handleTaskClick = useCallback(
    async (taskId: string, operation: 'cancel' | 'retry') => {
      try {
        await mutate(
          () => request(`/server-files/tasks/${taskId}/${operation}`, 'POST'),
          operation === 'retry' ? '已安排重试' : '取消请求已提交',
        );
      } catch (error) {
        notify((error as Error).message, 'error');
      }
    },
    [mutate, notify],
  );
  const handleSubmit = useCallback(
    async (values: FormValues) => {
      if (!dialog) return;
      await mutate(
        () =>
          request('/server-files/tasks', 'POST', {
            kind: dialog.kind,
            hostId: dialog.asset?.hostId ?? values.hostId,
            ...(dialog.asset ? { assetId: dialog.asset.id } : {}),
            ...(values.name ? { name: values.name } : {}),
            ...(values.sourcePath ? { sourcePath: values.sourcePath } : {}),
            ...(values.branch ? { branch: values.branch } : {}),
            idempotencyKey: createOperationId(),
          }),
        '文件任务已提交，可在下方查看进度。',
      );
    },
    [dialog, mutate],
  );
  const fields: Field[] = [];
  if (dialog && !dialog.asset)
    fields.push({
      key: 'hostId',
      label: '文件所在主机',
      kind: 'select',
      required: true,
      options:
        data?.hosts
          .filter(
            (host) => host.status === 'online' && host.features?.includes(SHARED_MAP_FILES_FEATURE),
          )
          .map((host) => ({ value: host.id, label: host.name })) ?? [],
    });
  if (dialog && ['download', 'import', 'clone', 'rename'].includes(dialog.kind))
    fields.push({ key: 'name', label: '文件名称', required: true });
  if (dialog && ['download', 'verify', 'update'].includes(dialog.kind))
    fields.push({
      key: 'branch',
      label: 'Steam 版本分支',
      kind: 'select',
      required: true,
      options: [...GAME_BRANCHES],
      helper: '将按所选分支下载或校验，并记录真实安装来源。',
    });
  if (dialog?.kind === 'import')
    fields.push({
      key: 'sourcePath',
      label: '已有服务端根目录',
      required: true,
      helper:
        '填写游戏主机上的完整路径，例如 D:\\ArkServer。导入只复制程序和模组，原目录及 Saved 不修改。Steam 游戏客户端不能导入。',
    });
  const descriptions: Record<FileOperation, string> = {
    scan: '扫描 maps 文件库，并迁移已停服的旧安装。其他位置的专用服务端可通过导入添加。',
    download: '在所选主机的 maps 目录下载一套专用服务端，多张地图可共用这一套文件。',
    import:
      '将已有专用服务端复制到文件库，原文件不修改，存档和地图配置不复制。请先结束原目录的更新操作。',
    clone:
      '在同一主机复制一份独立文件，不重复下载，不复制 Saved 存档和地图配置。磁盘仍需容纳新副本。',
    verify:
      '使用 SteamCMD 校验并修复空闲服务端，可能下载缺失文件或同步 Steam 当前版本。已关联文件请到地图管理执行更新。',
    update: '将空闲文件更新到 Steam 当前版本。已关联文件请到地图管理执行更新，会先备份存档。',
    delete:
      '此操作会真正删除这份已下载程序和模组，并释放磁盘空间。存档回收目录和后台备份保留；仍关联地图或被预留的文件不能删除。',
    open: '会在文件所在游戏主机的登录桌面打开目录。',
    rename: '只修改管理页面中的文件名称，磁盘目录和关联地图不变。',
  };
  return (
    <>
      <PageHeading
        title={t('服务端文件')}
        description={t(
          '一套服务端可供多张地图同时使用。这里管理 maps 中的公共文件；每张地图的配置和存档独立保存。',
        )}
        action={
          <Button
            variant="contained"
            startIcon={<DownloadSimpleIcon size={18} />}
            onClick={() => void handleActionClick('download')}
            disabled={
              !data?.hosts.some(
                (host) =>
                  host.status === 'online' && host.features?.includes(SHARED_MAP_FILES_FEATURE),
              )
            }
          >
            {t('下载服务端')}
          </Button>
        }
      />
      <Alert severity="info" sx={{ mb: 3 }}>
        {t('文件保存在对应游戏主机上。“打开文件位置”会在那台电脑执行；远程浏览器也可复制路径。')}
      </Alert>
      <Stack direction="row" gap={1.5} flexWrap="wrap" sx={{ mb: 3 }}>
        <TextField
          select
          size="small"
          label={t('主机筛选')}
          value={hostId}
          onChange={(event) => setHostId(event.target.value)}
          sx={{ minWidth: 180 }}
        >
          <MenuItem value="">{t('全部主机')}</MenuItem>
          {data?.hosts.map((host) => (
            <MenuItem key={host.id} value={host.id}>
              {host.name}
            </MenuItem>
          ))}
        </TextField>
        <Button
          variant="outlined"
          color="inherit"
          startIcon={<MagnifyingGlassIcon size={18} />}
          onClick={() => void handleActionClick('scan')}
        >
          {t('扫描主机文件')}
        </Button>
        <Button
          variant="outlined"
          color="inherit"
          startIcon={<FolderOpenIcon size={18} />}
          onClick={() => void handleActionClick('import')}
        >
          {t('导入已有服务端')}
        </Button>
      </Stack>
      {data?.hosts.some((host) => !host.features?.includes(SHARED_MAP_FILES_FEATURE)) && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          {t('部分主机助手还不支持共享地图文件，请在对应游戏电脑更新并重启助手。')}
        </Alert>
      )}
      {visible.length ? (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: '1fr 1fr' }, gap: 3 }}>
          {visible.map((file) => {
            const host = data?.hosts.find((item) => item.id === file.hostId);
            const bound = (data?.instances ?? []).filter((item) => usesServerFiles(item, file));
            const associated = bound.length > 0 || !!file.instanceId || !!file.instanceIds?.length;
            const reserved = (data?.instances ?? []).filter((item) =>
              reservesServerFiles(item, file),
            );
            const current = tasks.find(
              (task) =>
                active(task) && (task.assetId === file.id || task.payload.sourceId === file.id),
            );
            const gameBusy = bound.some((item) =>
              data?.commands.some(
                (command) =>
                  command.instanceId === item.id &&
                  ['queued', 'leased', 'executing', 'cancelling'].includes(command.status),
              ),
            );
            const connected =
              host?.status === 'online' && host.features?.includes(SHARED_MAP_FILES_FEATURE);
            const usable = connected && !current && !!file.instanceIds;
            const writable =
              usable &&
              !gameBusy &&
              bound.every((item) => !item.pid && ['stopped', 'error'].includes(item.status));
            return (
              <Surface
                key={file.id}
                data-file-id={file.id}
                role="region"
                aria-label={`服务端文件 ${file.name}`}
                sx={{ p: 3 }}
              >
                <Stack
                  direction="row"
                  justifyContent="space-between"
                  gap={2}
                  alignItems="flex-start"
                >
                  <Typography variant="h4" sx={{ overflowWrap: 'anywhere' }}>
                    {file.name}
                  </Typography>
                  <Chip
                    size="small"
                    label={t(fileStatuses[file.status])}
                    color={
                      file.status === 'ready'
                        ? 'success'
                        : ['error', 'partial', 'missing'].includes(file.status)
                          ? 'warning'
                          : 'default'
                    }
                  />
                </Stack>
                <Typography color="text.secondary" sx={{ mt: 1 }}>
                  {host?.name ?? t('已移除主机')} ·{' '}
                  {file.platform === 'windows' ? 'Windows' : 'Linux'}
                  {' · '}
                  {file.branch ?? '分支待核验'}
                </Typography>
                <Typography
                  component="p"
                  sx={{
                    mt: 2,
                    mb: 2,
                    fontFamily: 'monospace',
                    fontSize: '0.8rem',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {file.path || t('等待主机报告实际路径')}
                </Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, mb: 2.5 }}>
                  {[
                    ['占用空间', file.fileCount ? formatSize(file.sizeBytes) : '待扫描'],
                    ['文件数量', file.fileCount || '—'],
                    ['版本构建', file.buildId ?? '—'],
                    ['最近校验', formatDate(file.verifiedAt)],
                  ].map(([label, value]) => (
                    <Box key={label}>
                      <Typography variant="caption" color="text.secondary">
                        {t(String(label))}
                      </Typography>
                      <Typography sx={{ mt: 0.5 }}>{value}</Typography>
                    </Box>
                  ))}
                </Box>
                <Typography variant="body2" sx={{ mb: 1 }}>
                  {t('关联地图')}：
                  {bound.length
                    ? bound.map((item, index) => (
                        <span key={item.id}>
                          {index ? '、' : ''}
                          <MuiLink component={Link} to={`/instances/${item.id}`}>
                            {item.name}
                          </MuiLink>
                        </span>
                      ))
                    : associated
                      ? t('主机仍有关联待清理')
                      : t('未关联')}
                </Typography>
                {associated && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', mb: 1 }}
                  >
                    {t('更新前请关闭所有共用地图，再到地图管理执行一次更新。')}
                  </Typography>
                )}
                {!!reserved.length && (
                  <Typography variant="body2" sx={{ mb: 1 }}>
                    {t('待安装地图预留')}：{reserved.map((item) => item.name).join('、')}
                  </Typography>
                )}
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', mb: 2 }}
                >
                  {t('文件信息更新')}：{formatDate(file.updatedAt)}
                  {!connected ? ` · ${t('主机当前未连接')}` : ''}
                </Typography>
                {file.lastError && (
                  <Alert
                    severity="warning"
                    sx={{ mb: 2, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                  >
                    {file.lastError}
                  </Alert>
                )}
                {current && (
                  <Box sx={{ mb: 2 }}>
                    <LinearProgress aria-label={t('文件操作进行中')} />
                    <Typography
                      variant="body2"
                      sx={{ mt: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                    >
                      {current.progress || t('任务已提交')}
                    </Typography>
                  </Box>
                )}
                <Stack direction="row" gap={1} flexWrap="wrap">
                  <Button
                    variant="contained"
                    disabled={
                      !usable ||
                      !shareableServerFiles(file) ||
                      !['public', 'preaquatica'].includes(file.branch ?? '')
                    }
                    onClick={() => setReuse(file)}
                  >
                    {t('用于新地图')}
                  </Button>
                  <Button
                    variant="outlined"
                    color="inherit"
                    disabled={!file.path}
                    startIcon={<CopyIcon size={16} />}
                    onClick={() => void handleCopyClick(file.path)}
                  >
                    {t('复制路径')}
                  </Button>
                  <Button
                    variant="outlined"
                    color="inherit"
                    disabled={!usable || !file.path || file.status === 'missing'}
                    startIcon={<ArrowSquareOutIcon size={16} />}
                    onClick={() => void handleActionClick('open', file)}
                  >
                    {t('打开文件位置')}
                  </Button>
                  <Button
                    color="inherit"
                    disabled={!usable || !file.path}
                    onClick={() => void handleActionClick('rename', file)}
                  >
                    {t('重命名')}
                  </Button>
                  <Button
                    color="inherit"
                    disabled={!usable || !shareableServerFiles(file)}
                    onClick={() => void handleActionClick('clone', file)}
                  >
                    {t('创建本机副本')}
                  </Button>
                  <Button
                    color="inherit"
                    disabled={!writable || associated}
                    onClick={() => void handleActionClick('verify', file)}
                  >
                    {t('校验 / 修复')}
                  </Button>
                  <Button
                    color="inherit"
                    disabled={!writable || associated}
                    onClick={() => void handleActionClick('update', file)}
                  >
                    {t('更新文件')}
                  </Button>
                  <Button
                    color="error"
                    disabled={!usable || associated || !!reserved.length}
                    startIcon={<TrashIcon size={16} />}
                    onClick={() => void handleActionClick('delete', file)}
                  >
                    {t('删除下载文件')}
                  </Button>
                </Stack>
              </Surface>
            );
          })}
        </Box>
      ) : (
        <Surface>
          <Empty
            title={t(query || hostId ? '未找到匹配文件' : '尚无已下载服务端')}
            description={t('主机连接后会自动扫描助手管理的目录；也可以下载或导入已有专用服务端。')}
          />
        </Surface>
      )}
      <Surface sx={{ p: 3, mt: 3 }}>
        <Typography variant="h4" sx={{ mb: 2 }}>
          {t('最近文件任务')}
        </Typography>
        <Stack divider={<Divider />} gap={2}>
          {tasks
            .filter((task) => !hostId || task.hostId === hostId)
            .slice(0, 40)
            .map((task) => (
              <Stack key={task.id} gap={1}>
                <Stack direction="row" justifyContent="space-between" gap={1} flexWrap="wrap">
                  <Typography>
                    {t(operationLabels[task.kind])} · {String(task.payload.assetName ?? '')}
                  </Typography>
                  <Status value={task.status} />
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  {data?.hosts.find((host) => host.id === task.hostId)?.name ?? t('已移除主机')} ·{' '}
                  {formatDate(task.createdAt)}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                >
                  {task.error ?? task.progress}
                </Typography>
                {typeof task.result?.savedArchive === 'string' && (
                  <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
                    {t('存档已回收至')}：{task.result.savedArchive}
                  </Typography>
                )}
                <Stack direction="row" gap={1}>
                  {['failed', 'cancelled'].includes(task.status) && (
                    <Button size="small" onClick={() => void handleTaskClick(task.id, 'retry')}>
                      {t('重试')}
                    </Button>
                  )}
                  {active(task) &&
                    (task.status === 'queued' ||
                      !['delete', 'open', 'rename'].includes(task.kind)) && (
                      <Button
                        size="small"
                        color="inherit"
                        disabled={task.status === 'cancelling'}
                        onClick={() => void handleTaskClick(task.id, 'cancel')}
                      >
                        {t('取消任务')}
                      </Button>
                    )}
                </Stack>
              </Stack>
            ))}
          {!tasks.length && <Typography color="text.secondary">{t('暂无文件任务')}</Typography>}
        </Stack>
      </Surface>
      {dialog && (
        <FormDialog
          title={operationLabels[dialog.kind]}
          fields={fields}
          initial={{
            branch: dialog.asset?.branch === 'preaquatica' ? 'preaquatica' : 'public',
            hostId:
              dialog.asset?.hostId ??
              (hostId ||
                data?.hosts.find(
                  (host) =>
                    host.status === 'online' && host.features?.includes(SHARED_MAP_FILES_FEATURE),
                )?.id ||
                ''),
            name:
              dialog.kind === 'clone'
                ? `${dialog.asset?.name ?? 'ASE 服务端'} · 副本`.slice(0, 100)
                : (dialog.asset?.name ?? 'ASE 专用服务端'),
            sourcePath: '',
          }}
          description={`${t(descriptions[dialog.kind])}${dialog.asset?.path ? `\n${dialog.asset.path}` : ''}`}
          submitLabel={operationLabels[dialog.kind]}
          onClose={handleClose}
          onSubmit={handleSubmit}
        />
      )}
      {reuse && (
        <NewInstanceDialog
          onClose={handleReuseClose}
          initialHostId={reuse.hostId}
          initialFileSource={reuse.id}
        />
      )}
    </>
  );
}
