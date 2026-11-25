import { useCallback, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  Stack,
  Typography,
} from '@mui/material';
import { ArrowCounterClockwiseIcon, FloppyDiskIcon } from '@phosphor-icons/react';
import {
  CONFIG_SYNC_FEATURE,
  GAME_BRANCHES,
  INI_FILES,
  STEAM_SERVER_NAME_LIMIT,
  applyClusterPreset,
  configuredIni,
  defaultSteamServerName,
  iniEntries,
  isPrivateClusterGameKey,
  shareableServerFiles,
} from '@ark-control/common';
import type {
  Command,
  ConfigSaveSummary,
  GameConfig,
  Host,
  Instance,
  InstanceUpdateResult,
  IniFile,
  ServerFiles,
} from '@ark-control/common';
import { useTranslation } from 'react-i18next';
import { request } from '@/api';
import { focusPageAnchor } from '@/deployment';
import {
  basicGameFields,
  basicIniAddresses,
  configChangeLabel,
  configChangeValue,
  configGrid,
  draftConfig,
  imprintEstimate,
  manualOverrides,
  optionId,
  readGameForm,
  resetGameForm,
  saveGameForm,
} from '@/game-config';
import type { DraftEntry, GameFormResetScope } from '@/game-config';
import AdvancedIniFields, { IniOverride } from './AdvancedIniFields';
import ClusterPresetActions from './ClusterPresetActions';
import FormField from './FormField';
import Surface from './Surface';
import { formatDate, useMutation } from './common';
import type { Field, FormValues } from './common';
import { useClusterPresets } from './use-cluster-presets';

const manualFields: { file: IniFile; field: Field }[] = [
  {
    file: 'settings',
    field: {
      key: 'manualSettings',
      label: INI_FILES.settings,
      kind: 'textarea',
      maxLength: 50000,
      helper:
        '未写节标题的键归入 [ServerSettings]。服名覆盖使用 [SessionSettings] 下的 SessionName。',
    },
  },
  {
    file: 'game',
    field: {
      key: 'manualGame',
      label: INI_FILES.game,
      kind: 'textarea',
      maxLength: 50000,
      helper: '未写节标题的键归入游戏模式节。可以添加其他节和多条同名规则。',
    },
  },
];

const resetOptions = {
  all: {
    title: '重置全部游戏配置',
    message: '恢复基础和高级游戏设置的默认值，清空进服密码、模组列表及手写 INI。',
  },
  basic: {
    title: '重置基础配置',
    message:
      '恢复基础游戏设置的默认值，包括 Steam 服名、入服密码、模组列表和常用倍率。手写覆盖仍优先。',
  },
  advanced: {
    title: '重置高级配置',
    message: '恢复高级设置的默认值，清空自定义表单项。手写覆盖仍优先。',
  },
  manual: {
    title: '重置手写配置',
    message: '清空两段手写 INI。原本被覆盖的项目将使用表单值或默认值。',
  },
} satisfies Record<GameFormResetScope, { title: string; message: string }>;

type MapConfigProps = {
  instance: Instance;
  serverFiles: ServerFiles[];
  disabled: boolean;
  host?: Host;
  syncTask?: Command;
  saveSummary?: ConfigSaveSummary;
  onSaved: (summary: ConfigSaveSummary) => void;
};
type PresetConfigProps = {
  presetConfig: GameConfig;
  onSavePreset: (config: GameConfig) => void;
};

export default function InstanceConfigPanel(props: MapConfigProps | PresetConfigProps) {
  const { t } = useTranslation();
  const mutate = useMutation();
  const map = 'instance' in props ? props : undefined;
  const instance = map?.instance;
  const clusterCatalog = useClusterPresets(!!instance?.clusterId);
  const baseConfig = 'presetConfig' in props ? props.presetConfig : props.instance.config;
  const onSavePreset = 'onSavePreset' in props ? props.onSavePreset : undefined;
  const [draft, setDraft] = useState<ReturnType<typeof readGameForm>>(() => {
    const values = readGameForm(baseConfig);
    if (!instance) return values;
    return {
      ...values,
      basic: {
        ...values.basic,
        name: instance.name,
        autoRestart: instance.autoRestart,
        autoBranchUpdate: instance.autoBranchUpdate ?? false,
        branch: instance.branch ?? 'public',
        serverFileSource:
          instance.serverFileSource === 'download' ? 'auto' : (instance.serverFileSource ?? 'auto'),
      } satisfies FormValues,
    };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [resetScope, setResetScope] = useState<GameFormResetScope | null>(null);
  const [lastSave, setLastSave] = useState<{
    previousId?: string;
    requestedId?: string;
  }>();
  const editableSource =
    !!instance && !instance.installed && !instance.pid && !instance.serverFileId;
  const editableBranch = editableSource && !instance.filesTouched;
  const branch = editableBranch ? draft.basic.branch : (instance?.branch ?? 'public');
  const blocked = !!map?.disabled || busy;
  const mapName = instance?.mapLabel || instance?.map || '';
  const prefix = clusterCatalog.groups.find(
    (group) => group.id === instance?.clusterId,
  )?.serverNamePrefix;
  const steamName = defaultSteamServerName(
    String(draft.basic.name ?? '').trim() || mapName,
    prefix,
  );
  const overrides = useMemo(() => manualOverrides(draft.manual), [draft.manual]);
  const estimate = imprintEstimate(
    draftConfig(baseConfig, draft.basic, draft.advanced, draft.manual),
  );

  const fields: Field[] = map
    ? [
        basicGameFields[0]!,
        { key: 'name', label: '后台地图名称', required: true, maxLength: 80 },
        ...basicGameFields.slice(1),
        ...(editableBranch
          ? [
              {
                key: 'branch',
                label: 'Steam 版本分支',
                kind: 'select' as const,
                required: true,
                options: GAME_BRANCHES.map(({ value, label }) => ({ value, label })),
              },
            ]
          : []),
        ...(editableSource
          ? [
              {
                key: 'serverFileSource',
                label: '服务端文件来源',
                kind: 'select' as const,
                options: [
                  { value: 'auto', label: '自动共用本机同分支文件，没有时下载' },
                  ...map.serverFiles
                    .filter(
                      (file) =>
                        file.hostId === map.instance.hostId &&
                        file.branch === branch &&
                        (shareableServerFiles(file) || file.id === map.instance.serverFileSource),
                    )
                    .map((file) => ({ value: file.id, label: file.name })),
                ],
              },
            ]
          : []),
        { key: 'autoRestart', label: '自动拉起', kind: 'switch' },
        { key: 'autoBranchUpdate', label: '自动跟随分支更新（备份后维护重启）', kind: 'switch' },
      ]
    : basicGameFields.filter(
        ({ key }) => !['sessionName', 'serverPassword', 'modIds'].includes(key),
      );

  const handleBasicChange = useCallback((key: string, value: FormValues[string]) => {
    setDirty(true);
    setDraft((current) => ({
      ...current,
      basic: {
        ...current.basic,
        ...(key === 'branch' ? { serverFileSource: 'auto' } : {}),
        [key]: value,
      },
    }));
  }, []);
  const handleAdvancedChange = useCallback((id: string, entries: DraftEntry[]) => {
    setDirty(true);
    setDraft((current) => {
      const advanced = new Map(current.advanced);
      if (entries.length) advanced.set(id, entries);
      else advanced.delete(id);
      return { ...current, advanced };
    });
  }, []);
  const handleManualChange = useCallback((file: IniFile, value: string) => {
    setDirty(true);
    setDraft((current) => ({ ...current, manual: { ...current.manual, [file]: value } }));
  }, []);
  const handleReset = () => {
    if (!resetScope || blocked) return;
    setDraft((current) => resetGameForm(current, resetScope));
    setDirty(true);
    setError(null);
    setResetScope(null);
  };
  const sectionReset = (scope: Exclude<GameFormResetScope, 'all'>) => (
    <Button
      type="button"
      size="small"
      color="inherit"
      disabled={blocked}
      aria-label={t(resetOptions[scope].title)}
      onClick={() => setResetScope(scope)}
    >
      {t('重置')}
    </Button>
  );
  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (blocked) return;
      setError(null);
      setBusy(true);
      try {
        const config = saveGameForm(baseConfig, draft.basic, draft.advanced, draft.manual);
        if (!map) {
          const privateEntry = (['settings', 'game'] as const)
            .flatMap((file) =>
              configuredIni(config, file).flatMap((text) => iniEntries(file, text)),
            )
            .find(({ key }) => isPrivateClusterGameKey(key));
          if (privateEntry)
            throw new Error(
              t('「{{key}}」请在对应的地图或模组页面设置。', { key: privateEntry.key }),
            );
          onSavePreset?.(config);
          return;
        }
        const { instance, onSaved } = map;
        const updated = await mutate(
          () =>
            request<InstanceUpdateResult>(`/instances/${instance.id}`, 'PATCH', {
              name: draft.basic.name,
              autoRestart: draft.basic.autoRestart,
              autoBranchUpdate: draft.basic.autoBranchUpdate,
              ...(editableSource ? { serverFileSource: draft.basic.serverFileSource } : {}),
              ...(editableBranch ? { branch: draft.basic.branch } : {}),
              config,
            }),
          '游戏配置已保存到后台',
        );
        setLastSave({
          previousId: instance.configSyncCommandId,
          requestedId: updated.configSyncCommandId,
        });
        onSaved(updated.configSave);
        setDirty(false);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : '保存游戏配置失败。');
      } finally {
        setBusy(false);
      }
    },
    [blocked, baseConfig, draft, editableBranch, editableSource, map, mutate, onSavePreset, t],
  );

  // A dashboard refresh already in flight at submit time can still contain the previous receipt.
  const awaitingRefresh =
    !!lastSave?.requestedId &&
    instance?.configSyncCommandId === lastSave.previousId &&
    lastSave.requestedId !== instance?.configSyncCommandId;
  return (
    <Box component="form" onSubmit={handleSubmit} aria-label={t('游戏配置')}>
      <Surface>
        <Stack
          component="section"
          aria-labelledby="basic-config-title"
          spacing={2.5}
          sx={sectionSpacing}
        >
          {instance && (
            <ClusterPresetActions
              clusterId={instance.clusterId}
              disabled={blocked}
              getDraft={(mode) => ({
                kind: 'game',
                config: (mode === 'save' ? saveGameForm : draftConfig)(
                  instance.config,
                  draft.basic,
                  draft.advanced,
                  draft.manual,
                ),
              })}
              onError={setError}
              onLoad={(preset) => {
                if (preset.kind !== 'game') return;
                setDraft((current) => {
                  const config = draftConfig(
                    instance.config,
                    current.basic,
                    current.advanced,
                    current.manual,
                  );
                  const next = readGameForm(applyClusterPreset(config, preset));
                  return { ...next, basic: { ...current.basic, ...next.basic } };
                });
                setDirty(true);
                setError(null);
              }}
            />
          )}
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            gap={1}
            justifyContent="space-between"
            alignItems={{ sm: 'center' }}
          >
            <Box>
              <Stack direction="row" alignItems="center" gap={1}>
                <Typography variant="h4" component="h2" id="basic-config-title">
                  {t('基础配置')}
                </Typography>
                {sectionReset('basic')}
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {t(
                  instance
                    ? '设置 Steam 服名、人数和常用倍率。保存后，下次启动地图时应用。'
                    : '设置玩家上限、PvE 模式和常用倍率。',
                )}
              </Typography>
            </Box>
            <Stack direction="row" gap={1} sx={{ flexShrink: 0 }}>
              <Button
                size="small"
                component="a"
                href="#advanced-config-title"
                onClick={focusPageAnchor}
              >
                {t('高级配置')}
              </Button>
              <Button
                size="small"
                component="a"
                href="#manual-config-title"
                onClick={focusPageAnchor}
              >
                {t('手写配置')}
              </Button>
            </Stack>
          </Stack>
          <Box sx={configGrid}>
            {fields.map((field) => {
              const address = basicIniAddresses[field.key];
              const value = draft.basic[field.key];
              const isSteamName = field.key === 'sessionName';
              const defaultName =
                field.key === 'name' ? mapName : isSteamName ? steamName : undefined;
              return (
                <Stack key={field.key} spacing={0.5} sx={{ minWidth: 0 }}>
                  <FormField
                    field={
                      isSteamName && String(value).trim().length > STEAM_SERVER_NAME_LIMIT
                        ? { ...field, helper: '默认 Steam 服名超过 80 个字符，请填写较短的服名。' }
                        : field
                    }
                    value={value}
                    onChange={(value) => handleBasicChange(field.key, value)}
                    disabled={blocked}
                    compact
                    reset={
                      defaultName === undefined
                        ? undefined
                        : {
                            disabled:
                              value === defaultName ||
                              (isSteamName && (clusterCatalog.loading || !!clusterCatalog.error)),
                            tooltip: isSteamName ? clusterCatalog.error : undefined,
                            onClick: () => handleBasicChange(field.key, defaultName),
                          }
                    }
                  />
                  {address && (
                    <IniOverride
                      entries={overrides.get(optionId(address))}
                      secret={field.kind === 'password'}
                    />
                  )}
                </Stack>
              );
            })}
          </Box>
        </Stack>
        <Divider />
        <Stack
          component="section"
          aria-labelledby="advanced-config-title"
          spacing={2.5}
          sx={sectionSpacing}
        >
          <Box>
            <Stack direction="row" alignItems="center" gap={1}>
              <Typography variant="h4" component="h2" id="advanced-config-title" tabIndex={-1}>
                {t('高级配置')}
              </Typography>
              {sectionReset('advanced')}
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {t('按玩法展开配置，或直接搜索。未修改的高级项继续使用游戏默认值。')}
            </Typography>
          </Box>
          <AdvancedIniFields
            instance={instance}
            entries={draft.advanced}
            overrides={overrides}
            disabled={blocked}
            babyMature={draft.basic.babyMature ?? ''}
            estimate={estimate}
            onMaturityChange={(value) => handleBasicChange('babyMature', value)}
            onChange={handleAdvancedChange}
          />
        </Stack>
        <Divider />
        <Stack
          component="section"
          aria-labelledby="manual-config-title"
          spacing={2.5}
          sx={sectionSpacing}
        >
          <Box>
            <Stack direction="row" alignItems="center" gap={1}>
              <Typography variant="h4" component="h2" id="manual-config-title" tabIndex={-1}>
                {t('手写配置')}
              </Typography>
              {sectionReset('manual')}
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {t('同一文件、同一 INI 节里的同名键，以手写值为准。移除手写项即可恢复表单值。')}
            </Typography>
          </Box>
          <Box
            sx={{
              ...configGrid,
              gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' },
            }}
          >
            {manualFields.map(({ file, field }) => (
              <Box
                key={file}
                sx={{ minWidth: 0, '& textarea': { fontFamily: 'monospace', fontSize: 13 } }}
              >
                <FormField
                  field={field}
                  value={draft.manual[file]}
                  onChange={(value) => handleManualChange(file, String(value))}
                  disabled={blocked}
                  compact
                />
              </Box>
            ))}
          </Box>
        </Stack>
      </Surface>
      <Stack spacing={1} sx={{ position: 'sticky', bottom: { xs: 8, sm: 16 }, zIndex: 2, mt: 2 }}>
        {error && <Alert severity="error">{error}</Alert>}
        <Surface sx={{ px: { xs: 1.5, sm: 2.5 }, py: 1.25, boxShadow: 2 }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1.5}
            justifyContent="space-between"
            alignItems={{ xs: 'stretch', sm: 'flex-start' }}
          >
            {dirty ? (
              <Typography variant="body2" aria-live="polite">
                {t('有尚未保存的修改。')}
              </Typography>
            ) : (
              map && (
                <Stack spacing={0.75} sx={{ flex: 1, minWidth: 0 }}>
                  <ConfigSyncStatus
                    task={awaitingRefresh ? undefined : map.syncTask}
                    waiting={awaitingRefresh}
                    host={map.host}
                  />
                  {map.saveSummary && <SavePreview summary={map.saveSummary} />}
                </Stack>
              )
            )}
            <Stack
              direction="row"
              spacing={1}
              justifyContent="flex-end"
              sx={{ flexShrink: 0, ml: 'auto' }}
            >
              <Button
                type="button"
                variant="outlined"
                color="inherit"
                startIcon={<ArrowCounterClockwiseIcon size={18} />}
                disabled={blocked}
                sx={{ whiteSpace: 'nowrap' }}
                onClick={() => setResetScope('all')}
              >
                {t('重置为默认')}
              </Button>
              <Button
                type="submit"
                variant="contained"
                startIcon={<FloppyDiskIcon size={18} />}
                disabled={blocked}
                sx={{ whiteSpace: 'nowrap' }}
              >
                {t(busy ? '正在保存…' : instance ? '保存配置' : '保存预设')}
              </Button>
            </Stack>
          </Stack>
        </Surface>
      </Stack>
      {resetScope && (
        <Dialog
          open
          onClose={() => setResetScope(null)}
          aria-describedby="game-config-reset-description"
        >
          <DialogTitle>{t(resetOptions[resetScope].title)}</DialogTitle>
          <DialogContent>
            <DialogContentText id="game-config-reset-description">
              {t(
                !instance && resetScope === 'all'
                  ? '恢复基础和高级游戏设置的默认值，并清空手写 INI。'
                  : !instance && resetScope === 'basic'
                    ? '恢复基础游戏设置的默认值。手写覆盖仍优先。'
                    : resetOptions[resetScope].message,
              )}{' '}
              {t(instance ? '点击「保存配置」后提交。' : '点击「保存预设」后提交。')}
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button type="button" onClick={() => setResetScope(null)}>
              {t('取消')}
            </Button>
            <Button type="button" variant="contained" onClick={handleReset} disabled={blocked}>
              {t('确认重置')}
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Box>
  );
}

const sectionSpacing = { p: { xs: 2, sm: 3, lg: 4 }, minWidth: 0 };

function SavePreview({ summary }: { summary: ConfigSaveSummary }) {
  const { t } = useTranslation();
  if (!summary.total)
    return (
      <Typography variant="body2" color="text.secondary">
        {t('本次保存没有修改配置项。')}
      </Typography>
    );
  const remaining = summary.total - summary.changes.length;
  return (
    <Box sx={{ minWidth: 0 }}>
      <Stack
        component="ul"
        aria-label={t('本次修改')}
        spacing={0.25}
        sx={{ m: 0, p: 0, listStyle: 'none' }}
      >
        {summary.changes.map((change, index) => {
          const label = configChangeLabel(change, t);
          const before = configChangeValue(change.before, !!change.redacted, t);
          const after = configChangeValue(change.after, !!change.redacted, t);
          const line = change.key ? `${label} · ${before} → ${after}` : label;
          return (
            <Stack component="li" key={index} direction="row" alignItems="baseline" spacing={0.5}>
              <Typography variant="body2" title={line} noWrap sx={{ minWidth: 0 }}>
                {line.replace(/\r?\n/g, ' · ')}
              </Typography>
              {remaining > 0 && index === summary.changes.length - 1 && (
                <Typography
                  variant="body2"
                  aria-label={t('还有 {{count}} 项修改', { count: remaining })}
                  title={t('还有 {{count}} 项修改', { count: remaining })}
                >
                  …
                </Typography>
              )}
            </Stack>
          );
        })}
      </Stack>
      {summary.auditId && (
        <Button
          component={Link}
          to={`/logs?tab=audit&entry=${summary.auditId}`}
          size="small"
          sx={{ mt: 0.25, px: 0 }}
        >
          {t('查看完整记录')}
        </Button>
      )}
    </Box>
  );
}

function ConfigSyncStatus({
  task,
  waiting,
  host,
}: {
  task?: Command;
  waiting: boolean;
  host?: Host;
}) {
  const { t } = useTranslation();
  if (task?.status === 'succeeded' && task.result?.verified === true) {
    const { settingsPath, gamePath } = task.result;
    return (
      <Box sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        <Typography variant="body2" color="success.main" role="status">
          {t('主机已写入并校验 INI。')} · {formatDate(task.completedAt)}
        </Typography>
        <Box component="details" sx={{ typography: 'caption', '& summary': { cursor: 'pointer' } }}>
          <summary>{t('查看配置文件路径')}</summary>
          <div>{String(settingsPath)}</div>
          <div>{String(gamePath)}</div>
        </Box>
      </Box>
    );
  }
  let message = '保存后同步到游戏主机，地图下次启动时生效。';
  if (waiting || task?.status === 'waiting-agent') {
    if (host?.status !== 'online') message = '配置已保存，等待游戏主机上线后写入。';
    else if (!host.features?.includes(CONFIG_SYNC_FEATURE))
      message = '配置已保存，请更新并重启游戏主机上的助手以写入 INI。';
    else message = '配置已保存，等待主机助手写入 INI。';
  } else if (task?.status === 'leased' || task?.status === 'executing') {
    message = '主机正在写入并校验 INI。';
  } else if (task?.status === 'failed' || task?.status === 'cancelled') {
    message = '主机未确认写入。再次保存可重试。';
  }
  return (
    <Typography
      variant="body2"
      color={task?.error ? 'error.main' : 'text.secondary'}
      role="status"
      sx={{ minWidth: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
    >
      {t(message)}
      {task?.error && `\n${task.error}`}
    </Typography>
  );
}
