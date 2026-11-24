import { useCallback, useState } from 'react';
import {
  Button,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { DownloadSimpleIcon, PlusIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { createOperationId, instanceTarget } from '@ark-control/common';
import type { Backup } from '@ark-control/common';
import { useUiStore, useWorkspaceStore } from '@/store';
import { downloadBackup, request } from '@/api';
import { useWorkspaceCan } from '@/store/workspace-selection';
import {
  ConfirmDialog,
  Empty,
  FormDialog,
  PageHeading,
  Status,
  Surface,
  formatDate,
  formatSize,
  matches,
  useMutation,
} from '@/components';

export default function Backups() {
  const { t } = useTranslation();
  const data = useWorkspaceStore((state) => state.data);
  const query = useWorkspaceStore((state) => state.query);
  const notify = useUiStore((state) => state.notify);
  const mutate = useMutation();
  const can = useWorkspaceCan();
  const target = (id: string) => {
    const instance = data?.instances.find((item) => item.id === id);
    return instance ? instanceTarget(instance) : { kind: 'map' as const, instanceId: id };
  };
  const candidates =
    data?.instances.filter(
      (item) => item.installed && can('backups.create', instanceTarget(item)),
    ) ?? [];
  const [create, setCreate] = useState(false);
  const [restore, setRestore] = useState<Backup | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const handleCreateClick = useCallback(() => setCreate(true), []);
  const handleDownloadClick = useCallback(
    async (id: string) => {
      setBusy(id);
      try {
        await downloadBackup(id);
      } catch (error) {
        notify((error as Error).message, 'error');
      } finally {
        setBusy(null);
      }
    },
    [notify],
  );
  const backups =
    data?.backups.filter((item) =>
      matches(
        query,
        item.name,
        data.instances.find((instance) => instance.id === item.instanceId)?.name,
      ),
    ) ?? [];
  return (
    <>
      <PageHeading
        title={t('存档备份')}
        description="备份包含世界、人物、部落和配置。恢复前会再次保留当前存档。"
        action={
          <Button
            variant="contained"
            startIcon={<PlusIcon size={18} />}
            onClick={handleCreateClick}
            disabled={!candidates.length}
          >
            {t('立即备份')}
          </Button>
        }
      />
      {backups.length ? (
        <Surface>
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  {['地图实例', '备份时间', '备份大小', '状态', '操作'].map((label) => (
                    <TableCell key={label}>{t(label)}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {backups.map((backup) => (
                  <TableRow key={backup.id}>
                    <TableCell>
                      <Typography>
                        {data?.instances.find((instance) => instance.id === backup.instanceId)
                          ?.name ?? `已删除地图 (${backup.instanceId.slice(0, 8)})`}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        SHA256 {backup.sha256.slice(0, 12)}…
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {formatDate(backup.createdAt)}
                    </TableCell>
                    <TableCell>{formatSize(backup.size)}</TableCell>
                    <TableCell>
                      <Status value={backup.status} />
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" gap={1}>
                        <Button
                          color="inherit"
                          startIcon={<DownloadSimpleIcon size={16} />}
                          disabled={
                            backup.status !== 'ready' ||
                            busy === backup.id ||
                            !can('backups.download', target(backup.instanceId))
                          }
                          onClick={() => void handleDownloadClick(backup.id)}
                        >
                          {t('下载')}
                        </Button>
                        <Button
                          color="warning"
                          disabled={
                            backup.status !== 'ready' ||
                            !can('backups.restore', target(backup.instanceId)) ||
                            !data?.instances.some((item) => item.id === backup.instanceId)
                          }
                          onClick={() => setRestore(backup)}
                        >
                          {t('恢复存档')}
                        </Button>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Surface>
      ) : (
        <Surface>
          <Empty title={t('暂无备份')} description={t('创建备份后，可在这里下载或恢复。')} />
        </Surface>
      )}
      {create && (
        <FormDialog
          title="创建备份"
          fields={[
            {
              key: 'instanceId',
              label: '地图实例',
              kind: 'select',
              required: true,
              options: candidates.map((item) => ({ value: item.id, label: item.name })),
            },
          ]}
          initial={{ instanceId: data?.instances.find((item) => item.installed)?.id ?? '' }}
          onClose={() => setCreate(false)}
          onSubmit={(values) =>
            mutate(
              () =>
                request(`/instances/${values.instanceId}/commands`, 'POST', {
                  kind: 'backup',
                  countdownSeconds: 0,
                  idempotencyKey: createOperationId(),
                }),
              '备份任务已提交',
            )
          }
        />
      )}
      {restore && (
        <ConfirmDialog
          title="恢复这份存档"
          message="地图及同一互通组的地图必须先停止。系统会先备份当前存档、校验下载文件，再替换存档；跨图传送目录需单独保护。"
          destructive
          onClose={() => setRestore(null)}
          onConfirm={() =>
            mutate(
              () =>
                request(`/instances/${restore.instanceId}/commands`, 'POST', {
                  kind: 'restore',
                  backupId: restore.id,
                  countdownSeconds: 0,
                  idempotencyKey: createOperationId(),
                }),
              '恢复任务已提交',
            )
          }
        />
      )}
    </>
  );
}
