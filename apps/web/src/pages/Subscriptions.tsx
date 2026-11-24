import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import {
  Alert,
  Box,
  Button,
  Chip,
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
import type { Subscription } from '@ark-control/common';
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
import type { Field, FormValues } from '@/components';

export default function Subscriptions() {
  const { t } = useTranslation();
  const data = useWorkspaceStore((state) => state.data);
  const query = useWorkspaceStore((state) => state.query);
  const mutate = useMutation();
  const notify = useUiStore((state) => state.notify);
  const [edit, setEdit] = useState<Subscription | 'new' | null>(null);
  const [remove, setRemove] = useState<Subscription | null>(null);
  const handleCreateClick = useCallback(() => setEdit('new'), []);
  const defaultBot = data?.bots.find((bot) => bot.isDefault);
  const pinnedDefaultId =
    edit && edit !== 'new' && edit.botMode === 'default' ? edit.botId : defaultBot?.id;
  const selectedDefault = data?.bots.find((bot) => bot.id === pinnedDefaultId);
  const values: FormValues =
    edit && edit !== 'new'
      ? {
          ...edit,
          expiresAt: edit.expiresAt
            ? new Date(Date.parse(edit.expiresAt) + 8 * 3600000).toISOString().slice(0, 16)
            : '',
        }
      : {
          customer: '',
          instanceId: data?.instances[0]?.id ?? '',
          tribeId: '',
          tribeName: '',
          botMode: defaultBot ? 'default' : 'custom',
          botId: defaultBot?.id ?? data?.bots[0]?.id ?? '',
          groupId: '',
          enabled: true,
          expiresAt: '',
        };
  const fields = (current: FormValues): Field[] => {
    const botId = current.botMode === 'default' ? (pinnedDefaultId ?? '') : String(current.botId);
    return [
      { key: 'customer', label: '客户名称', required: true },
      {
        key: 'instanceId',
        label: '地图实例',
        kind: 'select',
        required: true,
        options: data?.instances.map((item) => ({
          value: item.id,
          label: `${item.name} · ${item.mapLabel}`,
        })),
      },
      {
        key: 'tribeId',
        label: '部落 ID',
        required: true,
        helper: '以实际部落 ID 绑定，改名不会串群。可在日志中查看已采集的部落。',
      },
      { key: 'tribeName', label: '部落名称', required: true },
      {
        key: 'botMode',
        label: '机器人选项',
        kind: 'select',
        required: true,
        options: [
          {
            value: 'default',
            label: selectedDefault ? `默认：${selectedDefault.name}` : '尚未设置默认机器人',
          },
          { value: 'custom', label: '用户自带机器人' },
        ],
      },
      ...(current.botMode === 'custom'
        ? [
            {
              key: 'botId',
              label: '选择机器人',
              kind: 'select' as const,
              required: true,
              options: data?.bots.map((item) => ({
                value: item.id,
                label: `${item.name}${item.owner ? ` · ${item.owner}` : ''}`,
              })),
            },
          ]
        : []),
      {
        key: 'groupId',
        label: '目标QQ群',
        kind: 'select',
        required: true,
        options: data?.groups
          .filter((group) => group.botId === botId)
          .map((group) => ({ value: group.id, label: group.name })),
        helper: '只列出当前机器人已经绑定的群。更换机器人后请重新选择。',
      },
      {
        key: 'expiresAt',
        label: '到期时间（北京时间，可留空）',
        helper: '格式：2026-12-31T23:59；留空表示长期有效。',
      },
      { key: 'enabled', label: '启用', kind: 'switch' },
    ];
  };
  const save = async (current: FormValues) => {
    const botId = current.botMode === 'default' ? pinnedDefaultId : current.botId;
    if (!botId) throw new Error('请先设置默认机器人或选择用户机器人。');
    return mutate(() =>
      request(
        edit === 'new' ? '/subscriptions' : `/subscriptions/${(edit as Subscription).id}`,
        edit === 'new' ? 'POST' : 'PATCH',
        {
          ...current,
          botId,
          expiresAt: current.expiresAt
            ? new Date(`${current.expiresAt}:00+08:00`).toISOString()
            : null,
        },
      ),
    );
  };
  const handleToggleClick = useCallback(
    async (item: Subscription) => {
      try {
        await mutate(() =>
          request(`/subscriptions/${item.id}`, 'PATCH', { ...item, enabled: !item.enabled }),
        );
      } catch (error) {
        notify((error as Error).message, 'error');
      }
    },
    [mutate, notify],
  );
  const items =
    data?.subscriptions.filter((item) =>
      matches(
        query,
        item.customer,
        item.tribeName,
        item.tribeId,
        data.instances.find((instance) => instance.id === item.instanceId)?.name,
      ),
    ) ?? [];
  return (
    <>
      <PageHeading
        title={t('部落订阅')}
        description="由你配置地图、部落、机器人与群，按部落精确推送。"
        action={
          <Button
            variant="contained"
            onClick={handleCreateClick}
            startIcon={<PlusIcon size={18} />}
            disabled={!data?.groups.length || !data.instances.length}
          >
            {t('新建部落订阅')}
          </Button>
        }
      />
      <Alert severity="info" sx={{ mb: 3 }}>
        全部部落日志 · 同名合并 30 秒 · 单条也显示数量。格式：地图-部落名： 日志 (count)
      </Alert>
      {items.length ? (
        <Surface>
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  {['客户名称', '地图与部落', '机器人与群', '状态', '到期时间', '操作'].map(
                    (label) => (
                      <TableCell key={label}>{t(label)}</TableCell>
                    ),
                  )}
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.customer}</TableCell>
                    <TableCell>
                      <Typography>
                        {data?.instances.find((instance) => instance.id === item.instanceId)?.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {item.tribeName} · {item.tribeId}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography>
                        {data?.groups.find((group) => group.id === item.groupId)?.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {data?.bots.find((bot) => bot.id === item.botId)?.name} ·{' '}
                        {item.botMode === 'default' ? '默认绑定' : '用户自带'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={item.enabled ? '已启用' : '已暂停'}
                        variant="outlined"
                        color={item.enabled ? 'success' : 'default'}
                      />
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {item.expiresAt ? formatDate(item.expiresAt) : '长期有效'}
                    </TableCell>
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
          <Empty
            title={t('暂无订阅')}
            description={t('绑定地图、部落和群，开始推送日志。')}
            action={
              !data?.groups.length ? (
                <Button component={Link} to="/bots" variant="contained">
                  接入机器人并绑定群
                </Button>
              ) : (
                <Button
                  onClick={handleCreateClick}
                  variant="contained"
                  disabled={!data.instances.length}
                >
                  {t('新建部落订阅')}
                </Button>
              )
            }
          />
        </Surface>
      )}
      {!!data?.tribes.length && (
        <Box sx={{ mt: 4 }}>
          <Typography variant="h4" sx={{ mb: 2 }}>
            最近发现的部落
          </Typography>
          <Stack direction="row" gap={1.5} flexWrap="wrap">
            {data.tribes.slice(0, 20).map((tribe) => (
              <Chip
                key={tribe.id}
                label={`${data.instances.find((instance) => instance.id === tribe.instanceId)?.mapLabel} · ${tribe.name} · ${tribe.tribeId}`}
                variant="outlined"
              />
            ))}
          </Stack>
        </Box>
      )}
      {edit && (
        <FormDialog
          title={t(edit === 'new' ? '新建部落订阅' : '编辑部落订阅')}
          initial={values}
          fields={fields}
          onClose={() => setEdit(null)}
          onSubmit={save}
        />
      )}
      {remove && (
        <ConfirmDialog
          title="删除订阅"
          message={`停止「${remove.customer}」这条订阅的后续推送。原始日志仍保留。`}
          onClose={() => setRemove(null)}
          onConfirm={() => mutate(() => request(`/subscriptions/${remove.id}`, 'DELETE'))}
          destructive
        />
      )}
    </>
  );
}
