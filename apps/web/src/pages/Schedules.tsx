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
import { PlusIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import type { Schedule } from '@ark-control/common';
import { useUiStore, useWorkspaceStore } from '@/store';
import { request } from '@/api';
import {
  ConfirmDialog,
  Empty,
  FormDialog,
  PageHeading,
  Surface,
  formatDate,
  matches,
  useMutation,
} from '@/components';
import type { FormValues } from '@/components';

export default function Schedules() {
  const { t } = useTranslation();
  const data = useWorkspaceStore((state) => state.data);
  const query = useWorkspaceStore((state) => state.query);
  const mutate = useMutation();
  const notify = useUiStore((state) => state.notify);
  const [edit, setEdit] = useState<Schedule | 'new' | null>(null);
  const [remove, setRemove] = useState<Schedule | null>(null);
  const handleCreateClick = useCallback(() => setEdit('new'), []);
  const initial: FormValues =
    edit && edit !== 'new'
      ? {
          name: edit.name,
          instanceId: edit.instanceId,
          kind: edit.kind,
          cron: edit.cron,
          timezone: edit.timezone,
          countdownSeconds: String(edit.countdownSeconds),
          enabled: edit.enabled,
        }
      : {
          name: '',
          instanceId: data?.instances[0]?.id ?? '',
          kind: 'backup',
          cron: '0 4 * * *',
          timezone: 'Asia/Shanghai',
          countdownSeconds: '30',
          enabled: true,
        };
  const save = (values: FormValues) =>
    mutate(() =>
      request(
        edit === 'new' ? '/schedules' : `/schedules/${(edit as Schedule).id}`,
        edit === 'new' ? 'POST' : 'PATCH',
        { ...values, countdownSeconds: Number(values.countdownSeconds) },
      ),
    );
  const handleToggleClick = useCallback(
    async (schedule: Schedule) => {
      try {
        await mutate(() =>
          request(`/schedules/${schedule.id}`, 'PATCH', {
            ...schedule,
            enabled: !schedule.enabled,
          }),
        );
      } catch (error) {
        notify((error as Error).message, 'error');
      }
    },
    [mutate, notify],
  );
  const items =
    data?.schedules.filter((item) =>
      matches(
        query,
        item.name,
        data.instances.find((instance) => instance.id === item.instanceId)?.name,
      ),
    ) ?? [];
  return (
    <>
      <PageHeading
        title={t('维护计划')}
        description="按北京时间安排备份、重启和更新，执行结果记录在地图任务中。"
        action={
          <Button
            variant="contained"
            onClick={handleCreateClick}
            startIcon={<PlusIcon size={18} />}
            disabled={!data?.instances.length}
          >
            {t('新增计划')}
          </Button>
        }
      />
      {items.length ? (
        <Surface>
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  {['计划名称', '地图实例', '操作', '下次执行', '状态', '操作'].map(
                    (label, index) => (
                      <TableCell key={`${label}${index}`}>{t(label)}</TableCell>
                    ),
                  )}
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <Typography>{item.name}</Typography>
                      <Typography color="text.secondary" variant="caption">
                        {item.cron} · {item.timezone}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      {data?.instances.find((instance) => instance.id === item.instanceId)?.name}
                    </TableCell>
                    <TableCell>
                      {{ restart: '重启', backup: '备份', update: '更新' }[item.kind]}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {item.enabled ? formatDate(item.nextRunAt) : '—'}
                    </TableCell>
                    <TableCell>{item.enabled ? '已启用' : '已暂停'}</TableCell>
                    <TableCell>
                      <Stack direction="row">
                        <Button color="inherit" onClick={() => setEdit(item)}>
                          {t('编辑')}
                        </Button>
                        <Button color="inherit" onClick={() => void handleToggleClick(item)}>
                          {t(item.enabled ? '暂停' : '恢复')}
                        </Button>
                        <Button color="error" onClick={() => setRemove(item)}>
                          {t('删除')}
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
          <Empty title={t('暂无维护计划')} description={t('设置定时备份、重启或更新。')} />
        </Surface>
      )}
      {edit && (
        <FormDialog
          title={t(edit === 'new' ? '新增计划' : '编辑维护计划')}
          initial={initial}
          onClose={() => setEdit(null)}
          onSubmit={save}
          fields={[
            { key: 'name', label: '计划名称', required: true },
            {
              key: 'instanceId',
              label: '地图实例',
              kind: 'select',
              required: true,
              options: data?.instances.map((item) => ({ value: item.id, label: item.name })),
            },
            {
              key: 'kind',
              label: '操作',
              kind: 'select',
              required: true,
              options: [
                { value: 'backup', label: '备份' },
                { value: 'restart', label: '重启' },
                { value: 'update', label: '更新服务端' },
              ],
            },
            {
              key: 'cron',
              label: '执行计划（Cron）',
              required: true,
              helper: '例如 0 4 * * * 表示每天 04:00；0 */6 * * * 表示每六小时。',
            },
            { key: 'timezone', label: '时区', required: true },
            {
              key: 'countdownSeconds',
              label: '重启或更新前倒计时（秒）',
              kind: 'number',
              min: 0,
              max: 3600,
            },
            { key: 'enabled', label: '启用', kind: 'switch' },
          ]}
        />
      )}
      {remove && (
        <ConfirmDialog
          title="删除维护计划"
          message={`删除「${remove.name}」后不再自动执行。`}
          onClose={() => setRemove(null)}
          onConfirm={() => mutate(() => request(`/schedules/${remove.id}`, 'DELETE'))}
          destructive
        />
      )}
    </>
  );
}
