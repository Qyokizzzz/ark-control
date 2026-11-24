import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  MenuItem,
  Pagination,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { PlusIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { activeBan, createOperationId } from '@ark-control/common';
import type { ManagedPlayer, ManagementTask, PlayerBan, LedgerEntry } from '@ark-control/common';
import { request } from '@/api';
import { useManagementStore, useUiStore, useWorkspaceStore } from '@/store';
import { Empty, FormDialog, PageHeading, Surface, formatDate, ManagementScope } from '@/components';
import type { Field, FormValues } from '@/components';

const taskLabels: Record<string, string> = {
  sync: '同步余额与权限',
  coins: '调整金币',
  'vip-grant': '发放 / 续期 VIP',
  'vip-revoke': '撤销 VIP',
  ban: '封禁用户',
  unban: '解除封禁',
  'shop-read': '读取插件配置',
  'shop-publish': '发布商店',
  'independent-shop-purchase': '独立商店购买',
};
const states: Record<string, string> = {
  queued: '等待执行',
  leased: '已领取',
  executing: '正在执行',
  succeeded: '成功',
  failed: '失败',
  uncertain: '结果未知',
  cancelled: '已取消',
};
type Dialog = {
  kind: string;
  player?: ManagedPlayer;
  task?: ManagementTask;
  ban?: PlayerBan;
  requestId?: string;
};
export default function Players() {
  const { t } = useTranslation();
  const { data, scopeId, query, filter, load, search, setFilter, setPage, error } =
    useManagementStore();
  const workspace = useWorkspaceStore((state) => state.data);
  const notify = useUiStore((state) => state.notify);
  const [tab, setTab] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [exporting, setExporting] = useState(false);
  const independentShop = data?.shopMode === 'independent';
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [load]);
  const close = useCallback(() => setDialog(null), []);
  const add = useCallback(() => setDialog({ kind: 'add' }), []);
  const configure = useCallback(() => setDialog({ kind: 'settings' }), []);
  const handleQuery = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => search(event.target.value),
    [search],
  );
  const handleFilter = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => setFilter(event.target.value),
    [setFilter],
  );
  const handlePage = useCallback(
    (_event: React.ChangeEvent<unknown>, page: number) => setPage(page),
    [setPage],
  );
  const handleTab = useCallback((_event: React.SyntheticEvent, value: number) => setTab(value), []);
  const exportLedger = useCallback(async () => {
    setExporting(true);
    try {
      const before = new Date().toISOString();
      const entries: LedgerEntry[] = [];
      for (let page = 1; ; page++) {
        const params = new URLSearchParams({ scopeId, page: String(page), before });
        const result = await request<{ entries: LedgerEntry[]; total: number }>(
          `/management/ledger?${params}`,
        );
        entries.push(...result.entries);
        if (entries.length >= result.total || !result.entries.length) break;
      }
      const blob = new Blob([JSON.stringify({ scopeId, exportedAt: before, entries }, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'ark-ledger.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify(t('流水已导出。'));
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : t('导出失败。'), 'error');
    } finally {
      setExporting(false);
    }
  }, [scopeId, notify, t]);
  const action = useCallback(
    (kind: string, player: ManagedPlayer, ban?: PlayerBan) =>
      setDialog({ kind, player, ban, requestId: createOperationId() }),
    [],
  );
  const openTask = useCallback((task: ManagementTask) => setDialog({ kind: 'resolve', task }), []);
  const cancelTask = useCallback(
    async (task: ManagementTask) => {
      try {
        await request(`/management/tasks/${task.id}/cancel`, 'POST', {});
        await load();
        notify(t('任务已取消。'));
      } catch (failure) {
        notify(failure instanceof Error ? failure.message : t('操作失败。'), 'error');
      }
    },
    [load, notify, t],
  );
  const retryBranch = useCallback(
    async (id: string) => {
      try {
        await request(`/management/branches/${id}/retry`, 'POST', {});
        await load();
      } catch (failure) {
        notify(failure instanceof Error ? failure.message : t('操作失败。'), 'error');
      }
    },
    [load, notify, t],
  );
  const save = useCallback(
    async (values: FormValues) => {
      if (!dialog) return;
      const player = dialog.player;
      if (dialog.kind === 'add' || dialog.kind === 'note')
        await request('/management/players', 'POST', {
          scopeId,
          steamId: player?.steamId ?? String(values.steamId),
          name: String(values.name ?? player?.name ?? ''),
          note: String(values.note ?? ''),
        });
      else if (dialog.kind === 'settings')
        await request('/management/settings', 'POST', {
          scopeId,
          vipGroups: String(values.groups)
            .split(/[,\n]+/)
            .map((value) => value.trim())
            .filter(Boolean),
        });
      else if (dialog.kind === 'resolve')
        await request(`/management/tasks/${dialog.task?.id}/resolve`, 'POST', {
          outcome: values.outcome,
          evidence: values.evidence,
        });
      else
        await request('/management/actions', 'POST', {
          scopeId,
          steamId: player?.steamId,
          kind: dialog.kind,
          idempotencyKey: dialog.requestId,
          reason: String(values.reason || '管理员主动同步'),
          ...(dialog.kind === 'coins' ? { amount: Number(values.amount) } : {}),
          ...(dialog.kind.startsWith('vip-')
            ? { group: values.group, hours: Number(values.hours) || 24 }
            : {}),
          ...(dialog.kind === 'ban'
            ? {
                ips: values.ip
                  ? player?.addresses
                      .filter((address) => address.source === 'game')
                      .map((address) => address.address)
                  : [],
                devices: values.device ? player?.devices.map((device) => device.id) : [],
                allowSharedIp: !!values.shared,
                expiresAt:
                  Number(values.duration) > 0
                    ? new Date(Date.now() + Number(values.duration) * 3600000).toISOString()
                    : null,
              }
            : {}),
          ...(dialog.kind === 'unban' ? { banId: dialog.ban?.id } : {}),
        });
      await load();
      notify(t('已提交，执行结果请查看任务与流水。'));
    },
    [dialog, scopeId, load, notify, t],
  );
  const groups = data?.settings?.vipGroups ?? ['VIP'];
  const fields: Field[] = !dialog
    ? []
    : dialog.kind === 'add'
      ? [
          { key: 'steamId', label: 'SteamID64', required: true },
          { key: 'name', label: '玩家名称' },
          { key: 'note', label: '备注', kind: 'textarea' },
        ]
      : dialog.kind === 'note'
        ? [
            { key: 'name', label: '玩家名称', required: true },
            { key: 'note', label: '备注', kind: 'textarea' },
          ]
        : dialog.kind === 'settings'
          ? [
              {
                key: 'groups',
                label: '允许发放的 VIP 组',
                kind: 'textarea',
                required: true,
                helper: independentShop
                  ? '每行一个 VIP 组。有效 VIP 可享受独立商店的会员价。'
                  : '每行一个现有 Permissions 组；请先在游戏插件中配置实际权益。',
              },
            ]
          : dialog.kind === 'resolve'
            ? [
                {
                  key: 'outcome',
                  label: '核实结果',
                  kind: 'select',
                  required: true,
                  options: [
                    { value: 'succeeded', label: '已确认执行成功' },
                    { value: 'failed', label: '已确认未执行' },
                  ],
                },
                {
                  key: 'evidence',
                  label: '核实依据',
                  kind: 'textarea',
                  required: true,
                  helper: '核对游戏余额、权限或日志后填写；此操作只记录结论，不会再发金币。',
                },
              ]
            : [
                ...(dialog.kind === 'coins'
                  ? [
                      {
                        key: 'amount',
                        label: '金币变动',
                        kind: 'number' as const,
                        required: true,
                        min: -100000000,
                        max: 100000000,
                        step: '1',
                        helper: independentShop
                          ? '正数发放，负数扣除。直接更新本互通组的独立商店余额。'
                          : '正数发放，负数扣除；以 ArkShop 实际余额为准。',
                      },
                    ]
                  : []),
                ...(dialog.kind.startsWith('vip-')
                  ? [
                      {
                        key: 'group',
                        label: independentShop ? 'VIP 组' : 'VIP 权限组',
                        kind: 'select' as const,
                        required: true,
                        options: groups.map((group) => ({ value: group, label: group })),
                      },
                      ...(dialog.kind === 'vip-grant'
                        ? [
                            {
                              key: 'hours',
                              label: '增加时长（小时）',
                              kind: 'number' as const,
                              min: 1,
                              max: 87600,
                              required: true,
                              step: '1',
                              helper: '尚未到期的 VIP 会从原到期时间继续续期。',
                            },
                          ]
                        : []),
                    ]
                  : []),
                ...(dialog.kind === 'ban'
                  ? [
                      {
                        key: 'duration',
                        label: '封禁时长（小时，0 为永久）',
                        kind: 'number' as const,
                        min: 0,
                        max: 87600,
                        step: '1',
                      },
                      {
                        key: 'ip',
                        label: '同时封禁已验证游戏 IP',
                        kind: 'switch' as const,
                        disabled: !dialog.player?.addresses.some(
                          (address) => address.source === 'game',
                        ),
                        helper: '只对该服游戏端口添加规则。代理地址、共享 IP 需要核实。',
                      },
                      {
                        key: 'device',
                        label: '同时封禁绑定客户端设备',
                        kind: 'switch' as const,
                        disabled: !dialog.player?.devices.length,
                        helper: '只覆盖使用联机客户端的玩家，普通 Steam 直连仍可用。',
                      },
                      { key: 'shared', label: '已核实共享 IP 影响', kind: 'switch' as const },
                    ]
                  : []),
                {
                  key: 'reason',
                  label: dialog.kind === 'sync' ? '同步说明' : '操作原因',
                  required: true,
                  kind: 'textarea' as const,
                },
              ];
  const initial: FormValues =
    dialog?.kind === 'add'
      ? { steamId: '', name: '', note: '' }
      : dialog?.kind === 'note'
        ? { name: dialog.player?.name ?? '', note: dialog.player?.note ?? '' }
        : dialog?.kind === 'settings'
          ? { groups: groups.join('\n') }
          : dialog?.kind === 'resolve'
            ? { outcome: 'succeeded', evidence: '' }
            : {
                amount: '100',
                group: groups[0] ?? 'VIP',
                hours: '24',
                duration: '0',
                ip: false,
                device: false,
                shared: false,
                reason: dialog?.kind === 'sync' ? '管理员主动同步' : '',
              };
  return (
    <>
      <PageHeading
        title="用户管理"
        description="按互通组管理玩家、金币、VIP 与封禁，保留每次操作的结果。"
        action={
          <Stack direction="row" gap={1}>
            <Button onClick={configure} disabled={!scopeId}>
              {t('VIP 设置')}
            </Button>
            <Button variant="contained" startIcon={<PlusIcon />} onClick={add} disabled={!scopeId}>
              {t('添加玩家')}
            </Button>
          </Stack>
        }
      />
      <ManagementScope />
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      <Tabs value={tab} onChange={handleTab} sx={{ mb: 3 }}>
        <Tab label={t('玩家档案')} />
        <Tab label={t('任务与流水')} />
        <Tab label={t('分支更新')} />
      </Tabs>
      {tab === 0 && (
        <>
          <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} sx={{ mb: 3 }}>
            <TextField
              label={t('搜索玩家')}
              placeholder={t('名称、SteamID、IP、设备或备注')}
              value={query}
              onChange={handleQuery}
              fullWidth
            />
            <TextField
              select
              label={t('筛选')}
              value={filter}
              onChange={handleFilter}
              sx={{ minWidth: 150 }}
            >
              {[
                ['all', '全部玩家'],
                ['online', '在线'],
                ['vip', 'VIP'],
                ['banned', '已封禁'],
              ].map(([value, label]) => (
                <MenuItem key={value} value={value}>
                  {t(label!)}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          <Alert severity="info" sx={{ mb: 3 }}>
            {t(
              independentShop
                ? '金币和 VIP 来自当前互通组的独立商店。已采集的 IP 与玩家绑定的设备会显示在档案中。'
                : 'IP 与设备标识仅在采集到后显示；设备标识来自玩家同意绑定的客户端，可能被更换。金币为空表示尚未从 ArkShop 读取。',
            )}
          </Alert>
          {!data?.players.length ? (
            <Empty
              title="暂无玩家"
              description="地图运行后会自动采样，也可按 SteamID 添加离线玩家。"
            />
          ) : (
            <Stack gap={2}>
              {data.players.map((player) => {
                const ban = data.bans.find(
                  (item) => item.steamId === player.steamId && activeBan(item),
                );
                return (
                  <Surface key={player.id}>
                    <Box sx={{ p: 3 }}>
                      <Stack
                        direction={{ xs: 'column', sm: 'row' }}
                        justifyContent="space-between"
                        gap={2}
                      >
                        <Box sx={{ minWidth: 0 }}>
                          <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
                            <Typography variant="h5">{player.name}</Typography>
                            <Chip
                              size="small"
                              color={player.onlineMaps.length ? 'success' : 'default'}
                              label={t(player.onlineMaps.length ? '在线' : '离线')}
                            />
                            {ban && <Chip size="small" color="error" label={t('封禁中')} />}
                          </Stack>
                          <Typography
                            variant="body2"
                            color="text.secondary"
                            sx={{ mt: 1, overflowWrap: 'anywhere' }}
                          >
                            SteamID {player.steamId}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            {t('最近出现')} {formatDate(player.lastSeenAt)} · {t('累计在线')}{' '}
                            {Math.floor(player.onlineSeconds / 60)} {t('分钟')}
                          </Typography>
                        </Box>
                        <Box sx={{ minWidth: 140 }}>
                          <Typography variant="h4">
                            {player.balance ?? '—'}{' '}
                            <Typography component="span" variant="body2">
                              {t('金币')}
                            </Typography>
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {t(independentShop ? '余额更新' : '余额采样')}{' '}
                            {formatDate(player.balanceUpdatedAt)}
                          </Typography>
                        </Box>
                      </Stack>
                      <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 2 }}>
                        {player.vip
                          .filter((vip) => !vip.expiresAt || Date.parse(vip.expiresAt) > Date.now())
                          .map((vip) => (
                            <Chip
                              key={vip.group}
                              label={`${vip.group} · ${vip.expiresAt ? formatDate(vip.expiresAt) : t('永久')}`}
                            />
                          ))}
                        {player.tribeName && <Chip label={`${t('部落')} · ${player.tribeName}`} />}
                      </Stack>
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ mt: 2, overflowWrap: 'anywhere' }}
                      >
                        IP:{' '}
                        {player.addresses
                          .map(
                            (address) =>
                              `${address.address} (${t(address.source === 'game' ? '游戏实测' : '客户端')})`,
                          )
                          .join(', ') || t('未采集')}
                        <br />
                        {t('客户端设备')}:{' '}
                        {player.devices.map((device) => device.id.slice(0, 16) + '…').join(', ') ||
                          t('未绑定')}
                        <br />
                        {t('当前地图')}:{' '}
                        {player.onlineMaps
                          .map(
                            (id) =>
                              workspace?.instances.find((instance) => instance.id === id)?.name ??
                              id,
                          )
                          .join(', ') || '—'}
                      </Typography>
                      {player.note && (
                        <Typography sx={{ mt: 1, whiteSpace: 'pre-wrap' }}>
                          {player.note}
                        </Typography>
                      )}
                      <Divider sx={{ my: 2 }} />
                      <Stack direction="row" gap={1} flexWrap="wrap">
                        {(independentShop
                          ? ['coins', 'vip-grant', 'vip-revoke']
                          : ['sync', 'coins', 'vip-grant', 'vip-revoke']
                        ).map((kind) => (
                          <Button size="small" key={kind} onClick={() => action(kind, player)}>
                            {t(taskLabels[kind]!)}
                          </Button>
                        ))}
                        <Button size="small" onClick={() => action('note', player)}>
                          {t('备注')}
                        </Button>
                        <Button
                          size="small"
                          color={ban ? 'primary' : 'error'}
                          onClick={() => action(ban ? 'unban' : 'ban', player, ban)}
                        >
                          {t(ban ? '解除封禁' : '封禁用户')}
                        </Button>
                      </Stack>
                    </Box>
                  </Surface>
                );
              })}
            </Stack>
          )}
          {data && data.total > 25 && (
            <Pagination
              sx={{ mt: 3 }}
              page={data.page}
              count={Math.ceil(data.total / 25)}
              onChange={handlePage}
            />
          )}
        </>
      )}
      {tab === 1 && (
        <Stack gap={3}>
          <Button
            sx={{ alignSelf: 'flex-start' }}
            disabled={exporting || !scopeId}
            onClick={() => void exportLedger()}
          >
            {t(exporting ? '正在导出…' : '导出本组完整流水')}
          </Button>
          <Alert severity="info">
            {t(
              independentShop
                ? '消费流水记录独立商店的扣款和发货结果。发货结果未知时，可在商店管理中核实订单。'
                : '操作超时会标记为结果未知，核实前不会自动重发。消费流水来自 ArkShop 实际日志，未记录的事件无法凭余额恢复。',
            )}
          </Alert>
          <Surface>
            <Box sx={{ p: 3 }}>
              <Typography variant="h5" sx={{ mb: 2 }}>
                {t('最近管理任务')}
              </Typography>
              <Stack gap={2}>
                {data?.tasks.map((task) => (
                  <Box key={task.id} sx={{ borderBottom: 1, borderColor: 'divider', pb: 2 }}>
                    <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                      <Typography fontWeight={650}>{t(taskLabels[task.kind]!)}</Typography>
                      <Chip
                        size="small"
                        color={
                          task.status === 'succeeded'
                            ? 'success'
                            : ['failed', 'uncertain'].includes(task.status)
                              ? 'error'
                              : 'default'
                        }
                        label={t(states[task.status]!)}
                      />
                      <Typography variant="caption">
                        {formatDate(task.createdAt)} · {task.steamId ?? task.instanceId.slice(0, 8)}
                      </Typography>
                    </Stack>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ mt: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                    >
                      {task.error || task.progress}
                    </Typography>
                    {task.result && (
                      <Typography
                        component="pre"
                        variant="caption"
                        sx={{
                          whiteSpace: 'pre-wrap',
                          overflowWrap: 'anywhere',
                          maxHeight: 180,
                          overflow: 'auto',
                        }}
                      >
                        {JSON.stringify(task.result, null, 2)}
                      </Typography>
                    )}
                    {task.status === 'uncertain' && (
                      <Button size="small" onClick={() => openTask(task)}>
                        {t('核实结果')}
                      </Button>
                    )}
                    {task.status === 'queued' && !['ban', 'unban'].includes(task.kind) && (
                      <Button size="small" onClick={() => void cancelTask(task)}>
                        {t('取消任务')}
                      </Button>
                    )}
                  </Box>
                ))}
              </Stack>
            </Box>
          </Surface>
          <Surface>
            <Box sx={{ p: 3 }}>
              <Typography variant="h5" sx={{ mb: 2 }}>
                {t('最近流水（最多 200 条）')}
              </Typography>
              {data?.ledger.map((entry) => (
                <Box key={entry.id} sx={{ py: 2, borderBottom: 1, borderColor: 'divider' }}>
                  <Typography variant="body2">
                    {formatDate(entry.createdAt)} · {entry.steamId ?? '—'} ·{' '}
                    {t(taskLabels[entry.kind] ?? entry.kind)} ·{' '}
                    {t(states[entry.status] ?? entry.status)}
                  </Typography>
                  <Typography
                    component="pre"
                    variant="caption"
                    sx={{
                      whiteSpace: 'pre-wrap',
                      overflowWrap: 'anywhere',
                      maxHeight: 200,
                      overflow: 'auto',
                    }}
                  >
                    {JSON.stringify(entry.detail, null, 2)}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Surface>
        </Stack>
      )}
      {tab === 2 && (
        <Stack gap={2}>
          <Alert severity="info">
            {t(
              '每 15 分钟检查 Steam 分支。开启自动更新的互通组会先全组停服，再备份、更新并恢复此前运行的地图；失败后暂停并等待处理。',
            )}
          </Alert>
          {data?.rollouts.map((rollout) => (
            <Surface key={rollout.id}>
              <Box sx={{ p: 3 }}>
                <Typography variant="h6">
                  Build {rollout.buildId} ·{' '}
                  {t(
                    {
                      stopping: '停服中',
                      updating: '备份更新中',
                      starting: '恢复启动中',
                      succeeded: '更新完成',
                      failed: '更新失败',
                    }[rollout.phase],
                  )}
                </Typography>
                <Typography color="text.secondary">
                  {formatDate(rollout.updatedAt)} {rollout.error}
                </Typography>
                {rollout.phase === 'failed' && (
                  <Button onClick={() => void retryBranch(rollout.id)}>{t('重试组内更新')}</Button>
                )}
              </Box>
            </Surface>
          ))}
        </Stack>
      )}
      {dialog && (
        <FormDialog
          title={
            dialog.kind === 'add'
              ? '添加玩家'
              : dialog.kind === 'note'
                ? '编辑玩家'
                : dialog.kind === 'settings'
                  ? 'VIP 设置'
                  : dialog.kind === 'resolve'
                    ? '核实未知结果'
                    : taskLabels[dialog.kind]!
          }
          description={
            dialog.player ? `${dialog.player.name} · ${dialog.player.steamId}` : undefined
          }
          fields={fields}
          initial={initial}
          onClose={close}
          onSubmit={save}
          submitLabel="提交"
        />
      )}
    </>
  );
}
