import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  Alert,
  Box,
  Button,
  Chip,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  Typography,
} from '@mui/material';
import {
  ArrowLeftIcon,
  ArrowClockwiseIcon,
  DownloadSimpleIcon,
  FloppyDiskIcon,
  GearSixIcon,
  MegaphoneIcon,
  UsersIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import {
  commandPermission,
  canTerminateStartup,
  createOperationId,
  effectiveGameConfig,
  instanceTarget,
  configuredIni,
  iniEntries,
  INI_SECTIONS,
  usesServerFiles,
} from '@ark-control/common';
import type { CommandKind, ConfigSaveSummary, Json } from '@ark-control/common';
import { useUiStore, useWorkspaceStore } from '@/store';
import { useWorkspaceCan } from '@/store/workspace-selection';
import { request } from '@/api';
import { workshopById } from '@/game-config/workshop';
import {
  ConfirmDialog,
  Empty,
  FormDialog,
  InstanceActions,
  InstanceConfigPanel,
  MapArt,
  ModsDialog,
  Status,
  StartupStatus,
  Surface,
  formatDate,
  useMutation,
} from '@/components';

export default function InstanceDetails() {
  const { id } = useParams();
  const { t } = useTranslation();
  const data = useWorkspaceStore((state) => state.data);
  const mutate = useMutation();
  const notify = useUiStore((state) => state.notify);
  const can = useWorkspaceCan();
  const [tab, setTab] = useState('overview');
  const [operation, setOperation] = useState<CommandKind | null>(null);
  const [lastConfigSave, setLastConfigSave] = useState<{
    instanceId: string;
    summary: ConfigSaveSummary;
  }>();
  const [mods, setMods] = useState(false);
  const [playerAction, setPlayerAction] = useState<{
    kind: 'kick' | 'ban' | 'unban';
    id: string;
    name: string;
  } | null>(null);
  const instance = data?.instances.find((item) => item.id === id);
  const commands = data?.commands.filter((item) => item.instanceId === id) ?? [];
  const sampledAt = useWorkspaceStore((state) => state.updatedAt);
  const active = commands.find((item) =>
    ['queued', 'leased', 'executing', 'cancelling'].includes(item.status),
  );
  const handleOperationClick = useCallback((kind: CommandKind) => setOperation(kind), []);
  const handleConfigSaved = useCallback(
    (summary: ConfigSaveSummary) => {
      if (id) setLastConfigSave({ instanceId: id, summary });
    },
    [id],
  );
  const enqueue = useCallback(
    (kind: CommandKind, payload: Record<string, unknown> = {}) =>
      mutate(
        () =>
          request(`/instances/${id}/commands`, 'POST', {
            kind,
            countdownSeconds: 30,
            idempotencyKey: createOperationId(),
            ...payload,
          }),
        '任务已提交',
      ),
    [id, mutate],
  );
  const handlePlayersClick = useCallback(() => {
    void enqueue('players').catch((error: Error) => notify(error.message, 'error'));
  }, [enqueue, notify]);
  const handleCancelClick = useCallback(
    (commandId: string) => {
      void mutate(() => request(`/commands/${commandId}/cancel`, 'POST'), '取消请求已提交').catch(
        (error: Error) => notify(error.message, 'error'),
      );
    },
    [mutate, notify],
  );
  if (!instance)
    return (
      <Surface>
        <Empty
          title="地图不存在或尚未加载"
          action={
            <Button component={Link} to="/instances">
              {t('返回')}
            </Button>
          }
        />
      </Surface>
    );
  const host = data?.hosts.find((item) => item.id === instance.hostId);
  const target = instanceTarget(instance);
  const configure = can('maps.configure', target);
  const canCommand = (kind: CommandKind) => can(commandPermission[kind], target);
  const starting = canTerminateStartup(instance, active);
  const showPlayers = canCommand('players') || canCommand('ban');
  const config = effectiveGameConfig(instance.config);
  const file = data?.serverFiles?.find((item) => usesServerFiles(instance, item));
  const sharedPeers = file
    ? (data?.instances ?? []).filter(
        (item) => item.id !== instance.id && usesServerFiles(item, file),
      )
    : [];
  const playerResult = commands.find(
    (item) => item.kind === 'players' && item.status === 'succeeded',
  );
  const players = Array.isArray(playerResult?.result?.players)
    ? (playerResult.result.players as { id: string; name: string; steamId: string }[])
    : [];
  const operationName = operation
    ? t(
        (
          {
            'force-stop': '强制停止',
            start: '启动',
            stop: '停止',
            restart: '重启',
            install: '安装服务端',
            update: '更新服务端',
            save: '保存世界',
            backup: '立即备份',
            broadcast: '发送公告',
            'mods-update': '更新模组',
            players: '玩家',
            kick: '踢出',
            ban: '封禁',
            unban: '解封',
            restore: '恢复存档',
            delete: '删除地图',
          } satisfies Record<CommandKind, string>
        )[operation],
      )
    : '';
  return (
    <>
      <Button
        component={Link}
        to="/instances"
        startIcon={<ArrowLeftIcon size={16} />}
        color="inherit"
        size="small"
        sx={{ mb: 3 }}
      >
        {t('地图管理')}
      </Button>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        gap={3}
        sx={{ mb: 4 }}
      >
        <Stack direction="row" gap={2} alignItems="center">
          <MapArt map={instance.map} size={64} />
          <Box>
            <Stack direction="row" alignItems="center" gap={2} sx={{ mb: 1 }}>
              <Typography variant="h2">{instance.name}</Typography>
              <Status value={instance.status} />
            </Stack>
            <Typography color="text.secondary">
              {instance.mapLabel} · {host?.name} · {config.pve ? 'PVE' : 'PVP'} ·{' '}
              {instance.gamePort}
            </Typography>
          </Box>
        </Stack>
        <InstanceActions instance={instance} showProgress={false} />
      </Stack>
      <StartupStatus instance={instance} />
      {active && !starting && (
        <Alert
          severity="info"
          sx={{ mb: 3 }}
          action={
            ['stop', 'restart', 'delete'].includes(active.kind) &&
            can(commandPermission[active.kind], target) ? (
              <Button
                color="inherit"
                onClick={() => handleCancelClick(active.id)}
                disabled={active.status === 'cancelling' || active.result?.stopCommitted === true}
                startIcon={<XIcon size={16} />}
              >
                取消倒计时
              </Button>
            ) : undefined
          }
        >
          {active.progress} · <Status value={active.status} />
        </Alert>
      )}
      {instance.lastError && (
        <Alert severity="warning" sx={{ mb: 3, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {instance.lastError}
        </Alert>
      )}
      <Tabs
        value={tab}
        onChange={(_event, value: string) => setTab(value)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ mb: 3, borderBottom: 1, borderColor: 'divider' }}
      >
        <Tab value="overview" label={t('概况')} />
        {configure && <Tab value="config" label={t('游戏配置')} />}
        {showPlayers && <Tab value="players" label={t('玩家')} />}
        <Tab value="mods" label={t('模组')} />
        <Tab value="tasks" label={t('任务')} />
      </Tabs>
      {tab === 'overview' && (
        <Stack gap={3}>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr 1fr', lg: 'repeat(4, 1fr)' },
              gap: 2,
            }}
          >
            {[
              ['CPU', `${instance.cpuPercent.toFixed(1)}%`],
              ['内存', `${(instance.memoryMb / 1024).toFixed(1)} GB`],
              [
                '运行时长',
                instance.startedAt
                  ? `${Math.max(0, (sampledAt - Date.parse(instance.startedAt)) / 3600000).toFixed(1)} h`
                  : '—',
              ],
              ['版本构建', instance.buildId ?? '—'],
              ['Steam 版本分支', instance.branch ?? 'public'],
            ].map(([label, value]) => (
              <Surface key={label} sx={{ p: 3 }}>
                <Typography color="text.secondary">{t(label!)}</Typography>
                <Typography variant="h3" sx={{ mt: 2 }}>
                  {value}
                </Typography>
              </Surface>
            ))}
          </Box>
          {file && (
            <Alert severity="info">
              {t('共享服务端文件')}：<Link to="/server-files">{file.name}</Link>
              {sharedPeers.length > 0 &&
                ` · ${t('同时供这些地图使用')}：${sharedPeers.map((item) => item.name).join('、')}`}
            </Alert>
          )}
          <Surface sx={{ p: 3 }}>
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              gap={2}
              flexWrap="wrap"
              sx={{ mb: 3 }}
            >
              <Typography variant="h4">{t('游戏配置')}</Typography>
              {configure && (
                <Button
                  variant="outlined"
                  onClick={() => setTab('config')}
                  startIcon={<GearSixIcon size={16} />}
                >
                  {t('编辑游戏配置')}
                </Button>
              )}
            </Stack>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr 1fr', lg: 'repeat(4, 1fr)' },
                gap: 3,
              }}
            >
              {[
                ['Steam 服务器名称', config.sessionName],
                ['玩家上限', config.maxPlayers],
                ['驯服倍率', `${config.taming}×`],
                ['采集倍率', `${config.harvest}×`],
                ['经验倍率', `${config.xp}×`],
                ['自动存档', `${config.autoSaveMinutes} min`],
                ['互通组', instance.clusterId || '独立地图'],
                ['自动拉起', instance.autoRestart ? '已启用' : '未启用'],
              ].map(([label, value]) => (
                <Box key={label}>
                  <Typography color="text.secondary" variant="caption">
                    {t(String(label))}
                  </Typography>
                  <Typography sx={{ mt: 1, overflowWrap: 'anywhere' }}>{value}</Typography>
                </Box>
              ))}
            </Box>
            <Typography color="text.secondary" variant="caption" sx={{ mt: 3, display: 'block' }}>
              {t('配置将在重启后生效。')}
            </Typography>
          </Surface>
          <Surface sx={{ p: 3 }}>
            <Typography variant="h4" sx={{ mb: 3 }}>
              维护操作
            </Typography>
            <Stack direction="row" gap={1.5} flexWrap="wrap">
              {[
                { kind: 'save', label: '保存世界', icon: FloppyDiskIcon },
                { kind: 'backup', label: '立即备份', icon: DownloadSimpleIcon },
                { kind: 'broadcast', label: '发送公告', icon: MegaphoneIcon },
                { kind: 'update', label: '更新服务端', icon: ArrowClockwiseIcon },
              ]
                .filter(({ kind }) => canCommand(kind as CommandKind))
                .map(({ kind, label, icon: Icon }) => (
                  <Button
                    key={kind}
                    variant="outlined"
                    color="inherit"
                    disabled={
                      !instance.installed ||
                      !!active ||
                      (kind === 'update' &&
                        (!!instance.pid ||
                          sharedPeers.some(
                            (item) => !!item.pid || !['stopped', 'error'].includes(item.status),
                          )))
                    }
                    startIcon={<Icon size={16} />}
                    onClick={() => handleOperationClick(kind as CommandKind)}
                  >
                    {t(label)}
                  </Button>
                ))}
              {canCommand('force-stop') && !starting && (
                <Button
                  color="error"
                  disabled={!instance.pid || !!active}
                  onClick={() => handleOperationClick('force-stop')}
                >
                  {t('强制停止')}
                </Button>
              )}
            </Stack>
          </Surface>
        </Stack>
      )}
      {tab === 'config' && configure && (
        <InstanceConfigPanel
          key={instance.id}
          instance={instance}
          serverFiles={data?.serverFiles ?? []}
          host={host}
          syncTask={commands.find((item) => item.id === instance.configSyncCommandId)}
          disabled={!!active && active.kind !== 'sync-config'}
          saveSummary={
            lastConfigSave?.instanceId === instance.id ? lastConfigSave.summary : undefined
          }
          onSaved={handleConfigSaved}
        />
      )}
      {tab === 'players' && showPlayers && (
        <Surface>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ p: 3 }}>
            <Box>
              <Typography variant="h4">{t('玩家')}</Typography>
              <Typography variant="caption" color="text.secondary">
                上次获取：{formatDate(playerResult?.completedAt)}
              </Typography>
            </Box>
            <Stack direction="row" gap={1}>
              {canCommand('unban') && (
                <Button
                  onClick={() => setPlayerAction({ kind: 'unban', id: '', name: '' })}
                  color="inherit"
                >
                  解封玩家
                </Button>
              )}
              {canCommand('players') && (
                <Button
                  variant="outlined"
                  startIcon={<UsersIcon size={16} />}
                  onClick={handlePlayersClick}
                  disabled={!!active || instance.status !== 'running'}
                >
                  获取在线玩家
                </Button>
              )}
            </Stack>
          </Stack>
          {!players.length ? (
            <Empty
              title="暂无玩家列表"
              description="地图运行后点击获取在线玩家；空服也会显示在任务结果中。"
            />
          ) : (
            <TableContainer>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>玩家名称</TableCell>
                    <TableCell>Steam ID</TableCell>
                    <TableCell>{t('操作')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {players.map((player) => (
                    <TableRow key={player.steamId}>
                      <TableCell>{player.name}</TableCell>
                      <TableCell>{player.steamId}</TableCell>
                      <TableCell>
                        {canCommand('kick') && (
                          <Button
                            color="inherit"
                            disabled={!!active}
                            onClick={() =>
                              setPlayerAction({
                                kind: 'kick',
                                id: player.steamId,
                                name: player.name,
                              })
                            }
                          >
                            踢出
                          </Button>
                        )}
                        {canCommand('ban') && (
                          <Button
                            color="error"
                            disabled={!!active}
                            onClick={() =>
                              setPlayerAction({
                                kind: 'ban',
                                id: player.steamId,
                                name: player.name,
                              })
                            }
                          >
                            封禁
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Surface>
      )}
      {tab === 'mods' && (
        <Surface sx={{ p: 3 }}>
          <Stack
            direction="row"
            justifyContent="space-between"
            alignItems="center"
            gap={2}
            sx={{ mb: 3 }}
          >
            <Typography variant="h4">模组与加载顺序</Typography>
            <Stack direction="row" gap={1}>
              {configure && (
                <Button onClick={() => setMods(true)} disabled={!!active}>
                  {t('编辑')}
                </Button>
              )}
              {canCommand('mods-update') && (
                <Button
                  variant="outlined"
                  onClick={() => handleOperationClick('mods-update')}
                  disabled={!!active || instance.status !== 'stopped' || !config.modIds.length}
                >
                  更新模组
                </Button>
              )}
            </Stack>
          </Stack>
          <Alert severity="info" sx={{ mb: 3 }}>
            按列表从上到下加载，前面的模组优先。服务端启动时使用 ASE
            自动模组管理；加载结果请查看运行日志。
          </Alert>
          {config.modIds.length ? (
            config.modIds.map((mod, index) => (
              <Stack key={mod} direction="row" gap={3} alignItems="center" sx={{ p: 2 }}>
                <Chip label={index + 1} />
                <Typography>
                  {workshopById.has(mod)
                    ? `${workshopById.get(mod)!.name} · ${mod}`
                    : `Workshop ${mod}`}
                </Typography>
              </Stack>
            ))
          ) : (
            <Typography color="text.secondary">尚未配置模组。</Typography>
          )}
        </Surface>
      )}
      {tab === 'tasks' && (
        <Surface>
          {commands.length ? (
            <TableContainer>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>操作</TableCell>
                    <TableCell>进度</TableCell>
                    <TableCell>状态</TableCell>
                    <TableCell>时间</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {commands.map((command) => (
                    <TableRow key={command.id}>
                      <TableCell>
                        {t(
                          (
                            {
                              'sync-config': '同步游戏配置',
                              'install-plugins': '安装服务端插件',
                            } as Record<string, string>
                          )[command.kind] ?? command.kind,
                        )}
                      </TableCell>
                      <TableCell
                        sx={{ maxWidth: 500, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
                      >
                        {command.error ?? command.progress}
                      </TableCell>
                      <TableCell>
                        <Status value={command.status} />
                      </TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        {formatDate(command.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          ) : (
            <Empty title="暂无任务" />
          )}
        </Surface>
      )}
      {operation && (
        <FormDialog
          title={`${operationName} · ${instance.name}`}
          description={
            operation === 'force-stop'
              ? '强制停止可能丢失最近未保存的数据。请确认正常停止已无法完成。'
              : ['stop', 'restart'].includes(operation)
                ? '倒计时后先保存世界，再请求正常退出；任务状态可在页面查看。'
                : operation === 'update'
                  ? '需要关闭共用这套文件的所有地图。更新一次即可，更新前会分别备份各地图的存档。'
                  : '任务交给主机助手执行，提交后可以继续使用其他页面。'
          }
          fields={
            ['stop', 'restart'].includes(operation)
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
              : operation === 'broadcast'
                ? [{ key: 'message', label: '公告内容', kind: 'textarea', required: true }]
                : []
          }
          initial={{ countdownSeconds: '30', message: '' }}
          onClose={() => setOperation(null)}
          onSubmit={(values) =>
            enqueue(operation, {
              countdownSeconds: Number(values.countdownSeconds),
              ...(operation === 'broadcast' ? { message: values.message } : {}),
            })
          }
          submitLabel={operationName}
        />
      )}
      {mods && (
        <ModsDialog
          key={instance.id}
          initial={instance.config.modIds}
          overridden={configuredIni(instance.config, 'settings')
            .flatMap((text) => iniEntries('settings', text))
            .some(
              ({ section, key, modifier }) =>
                !modifier &&
                section.toLowerCase() === INI_SECTIONS.settings.toLowerCase() &&
                key.toLowerCase() === 'activemods',
            )}
          onClose={() => setMods(false)}
          onSave={(modIds) =>
            mutate(() =>
              request(`/instances/${instance.id}`, 'PATCH', {
                config: {
                  ...instance.config,
                  modIds,
                },
              }),
            )
          }
        />
      )}
      {playerAction &&
        (playerAction.kind === 'unban' ? (
          <FormDialog
            title="解封玩家"
            fields={[{ key: 'playerId', label: '玩家 Steam ID', required: true }]}
            initial={{ playerId: '' }}
            onClose={() => setPlayerAction(null)}
            onSubmit={(values) => enqueue('unban', { playerId: values.playerId })}
          />
        ) : (
          <ConfirmDialog
            title={playerAction.kind === 'ban' ? '封禁玩家' : '踢出玩家'}
            message={`将对「${playerAction.name}」执行此操作。`}
            destructive
            onClose={() => setPlayerAction(null)}
            onConfirm={() =>
              enqueue(playerAction.kind, { playerId: playerAction.id } as Record<string, Json>)
            }
          />
        ))}
    </>
  );
}
