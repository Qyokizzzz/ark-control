import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { INI_FILES, clusterGameConfig, iniAddress, iniEntries } from '@ark-control/common';
import type { ClusterPreset, ClusterPresetContent, GameConfig, IniFile } from '@ark-control/common';
import { request } from '@/api';
import { basicGameFields } from '@/game-config';
import { workshopById } from '@/game-config/workshop';
import { useWorkspaceCan } from '@/store/workspace-selection';
import FormField from './FormField';
import { useMutation } from './common';
import { useClusterPresets } from './use-cluster-presets';

type Mode = 'save' | 'load';
type Draft = { kind: 'game'; config: GameConfig } | { kind: 'mods'; modIds: string[] };
type OpenPreset = { mode: Mode; draft: Draft };
type Difference = { label: string; before: string; after: string };

function iniDifferences(file: IniFile, before: string, after: string) {
  const rows = (text: string) => {
    const result = new Map<string, { label: string; values: string[] }>();
    for (const { section, key, modifier, value } of iniEntries(file, text)) {
      const address = iniAddress(section, key);
      const row = result.get(address) ?? {
        label: `${INI_FILES[file]} [${section}] ${key}`,
        values: [],
      };
      row.values.push(modifier ? `${modifier}${key}=${value}` : value);
      result.set(address, row);
    }
    return result;
  };
  const original = rows(before);
  const updated = rows(after);
  return [...new Set([...original.keys(), ...updated.keys()])].flatMap((key): Difference[] => {
    const left = original.get(key);
    const right = updated.get(key);
    if (JSON.stringify(left?.values) === JSON.stringify(right?.values)) return [];
    return [
      {
        label: right?.label ?? left!.label,
        before: left?.values.join('\n') ?? '—',
        after: right?.values.join('\n') ?? '—',
      },
    ];
  });
}

function differences(before: ClusterPresetContent, after: ClusterPresetContent): Difference[] {
  if (before.kind === 'mods' && after.kind === 'mods') {
    if (before.modIds.join(',') === after.modIds.join(',')) return [];
    const labels = (ids: string[]) =>
      ids.map((id) => workshopById.get(id)?.name ?? id).join('、') || '无模组';
    return [{ label: '模组加载顺序', before: labels(before.modIds), after: labels(after.modIds) }];
  }
  if (before.kind !== 'game' || after.kind !== 'game') return [];
  const left = Object.fromEntries(Object.entries(before.config));
  const right = Object.fromEntries(Object.entries(after.config));
  const basic = basicGameFields.flatMap(({ key, label }): Difference[] =>
    left[key] === right[key]
      ? []
      : [{ label, before: String(left[key]), after: String(right[key]) }],
  );
  return [
    ...basic,
    ...iniDifferences(
      'settings',
      before.config.advancedIni?.settings ?? '',
      after.config.advancedIni?.settings ?? '',
    ),
    ...iniDifferences(
      'game',
      before.config.advancedIni?.game ?? '',
      after.config.advancedIni?.game ?? '',
    ),
    ...iniDifferences('settings', before.config.extraSettingsIni, after.config.extraSettingsIni),
    ...iniDifferences('game', before.config.extraGameIni, after.config.extraGameIni),
  ];
}

export default function ClusterPresetActions({
  clusterId,
  getDraft,
  onLoad,
  onError,
  disabled,
  modOverride,
}: {
  clusterId: string;
  getDraft: (mode: Mode) => Draft;
  onLoad: (preset: ClusterPreset) => void;
  onError: (message: string) => void;
  disabled?: boolean;
  modOverride?: boolean;
}) {
  const { t } = useTranslation();
  const can = useWorkspaceCan();
  const [open, setOpen] = useState<(OpenPreset & { clusterId: string }) | null>(null);
  const start = (mode: Mode) => {
    try {
      setOpen({ clusterId, mode, draft: getDraft(mode) });
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : '当前配置无效。');
    }
  };
  return (
    <Stack
      direction="row"
      flexWrap="wrap"
      gap={1}
      title={clusterId ? undefined : t('请先加入互通组')}
    >
      <Button
        type="button"
        size="small"
        variant="outlined"
        disabled={disabled || !clusterId || !can('maps.configure', { kind: 'cluster', clusterId })}
        onClick={() => start('save')}
      >
        {t('保存到互通组')}
      </Button>
      <Button
        type="button"
        size="small"
        variant="outlined"
        disabled={disabled || !clusterId}
        onClick={() => start('load')}
      >
        {t('从互通组加载')}
      </Button>
      {open && open.clusterId === clusterId && (
        <PresetDialog
          key={clusterId}
          {...open}
          modOverride={modOverride}
          onLoad={onLoad}
          onClose={() => setOpen(null)}
        />
      )}
    </Stack>
  );
}

function PresetDialog({
  clusterId,
  mode,
  draft,
  modOverride,
  onLoad,
  onClose,
}: OpenPreset & {
  clusterId: string;
  modOverride?: boolean;
  onLoad: (preset: ClusterPreset) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const mutate = useMutation();
  const catalog = useClusterPresets();
  const group = catalog.groups.find((item) => item.id === clusterId);
  const presets = (group?.presets ?? []).filter((item) => item.kind === draft.kind);
  const [method, setMethod] = useState<'new' | 'overwrite'>('new');
  const [selection, setSelection] = useState('');
  const [name, setName] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saving = mode === 'save';
  const overwrite = saving && method === 'overwrite';
  const selected = presets.find((preset) => preset.id === selection) ?? presets[0];
  let number = 1;
  while (presets.some((preset) => preset.name === `配置 ${number}`)) number++;
  const enteredName = name ?? `配置 ${number}`;
  const current: ClusterPresetContent =
    draft.kind === 'game' ? { kind: 'game', config: clusterGameConfig(draft.config) } : draft;
  const changes =
    selected && (!saving || overwrite)
      ? differences(saving ? selected : current, saving ? current : selected)
      : null;
  const available = !catalog.loading && !catalog.error && !!group && (!saving || group.canSave);
  const blocked =
    busy ||
    !available ||
    ((!saving || overwrite) && !selected) ||
    (saving && !overwrite && !enteredName.trim());
  const submit = async (updateMaps: boolean) => {
    if (blocked) return;
    setBusy(true);
    setError('');
    try {
      await mutate(
        () =>
          request<{ updatedMaps: number }>(
            `/clusters/${encodeURIComponent(clusterId)}/presets`,
            'POST',
            {
              ...draft,
              name: overwrite ? selected!.name : enteredName,
              ...(overwrite && { overwrite: { id: selected!.id, revision: selected!.revision } }),
              updateMaps,
            },
          ),
        ({ updatedMaps }) =>
          updateMaps
            ? `已覆盖预设，${updatedMaps} 张地图将在下次启动时应用。`
            : overwrite
              ? '已覆盖组配置'
              : '已新建组配置',
      );
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存组配置失败。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open fullWidth maxWidth="sm" onClose={busy ? undefined : onClose}>
      <DialogTitle>
        {t(confirm ? '覆盖组配置' : saving ? '保存到互通组' : '从互通组加载')}
      </DialogTitle>
      <DialogContent>
        <Stack gap={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            {clusterId} · {t(draft.kind === 'game' ? '游戏配置' : '模组')}
          </Typography>
          {catalog.loading && <Typography variant="body2">{t('正在读取互通组配置…')}</Typography>}
          {(error || catalog.error) && <Alert severity="error">{error || catalog.error}</Alert>}
          {!catalog.loading && !catalog.error && !available && (
            <Alert severity="warning">{t('当前账号无法执行此互通组操作。')}</Alert>
          )}
          {available && !confirm && saving && (
            <>
              <FormField
                field={{
                  key: 'method',
                  label: '保存方式',
                  kind: 'select',
                  options: [
                    { value: 'new', label: '新建一份' },
                    ...(presets.length ? [{ value: 'overwrite', label: '覆盖已有配置' }] : []),
                  ],
                }}
                value={method}
                disabled={busy}
                onChange={(value) => setMethod(value === 'overwrite' ? 'overwrite' : 'new')}
              />
              {!overwrite && (
                <FormField
                  field={{ key: 'name', label: '配置名称', required: true, maxLength: 80 }}
                  value={enteredName}
                  disabled={busy}
                  onChange={(value) => setName(String(value))}
                />
              )}
            </>
          )}
          {available &&
            !confirm &&
            (!saving || overwrite) &&
            (presets.length ? (
              <FormField
                field={{
                  key: 'preset',
                  label: '选择配置',
                  kind: 'select',
                  options: presets.map(({ id, name: label }) => ({ value: id, label })),
                }}
                value={selected?.id}
                disabled={busy}
                onChange={(value) => setSelection(String(value))}
              />
            ) : (
              <Alert severity="info">{t('此互通组还没有这一类配置。')}</Alert>
            ))}
          {confirm && (
            <Alert severity="info">
              {t('请选择覆盖范围。')}
              {t('更新整组会替换所有组内地图的同类配置，下次启动时生效。')} {group?.mapCount ?? 0}{' '}
              {t('张地图')}
            </Alert>
          )}
          {((!saving && modOverride) || (confirm && draft.kind === 'mods')) && (
            <Alert severity="warning">
              {t(
                confirm
                  ? '更新整组时会替换地图中手写的模组列表覆盖项。'
                  : '保存此地图时会替换手写 ActiveMods 等模组列表覆盖项，以应用所选顺序。',
              )}
            </Alert>
          )}
          {changes && (
            <Box sx={{ maxHeight: 260, overflowY: 'auto' }}>
              <Typography variant="subtitle2">{t('变更预览')}</Typography>
              {!changes.length && (
                <Typography variant="body2" color="text.secondary">
                  {t('内容相同。')}
                </Typography>
              )}
              {changes.map(({ label, before, after }, index) => (
                <Box
                  key={`${label}-${index}`}
                  sx={{ py: 0.75, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
                >
                  <Typography variant="body2" fontWeight={650}>
                    {t(label)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {before} → {after}
                  </Typography>
                </Box>
              ))}
            </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button type="button" onClick={confirm ? () => setConfirm(false) : onClose} disabled={busy}>
          {t(confirm ? '返回' : '取消')}
        </Button>
        {confirm ? (
          <>
            <Button type="button" disabled={blocked} onClick={() => void submit(false)}>
              {t('仅覆盖预设')}
            </Button>
            <Button
              type="button"
              variant="contained"
              disabled={blocked}
              onClick={() => void submit(true)}
            >
              {t('覆盖并更新整组')}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="contained"
            disabled={blocked}
            onClick={() => {
              if (!saving && selected) {
                onLoad(selected);
                onClose();
              } else if (overwrite) setConfirm(true);
              else if (saving) void submit(false);
            }}
          >
            {t(busy ? '正在保存…' : saving ? (overwrite ? '继续' : '保存') : '加载')}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
