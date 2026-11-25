import { useCallback, useId, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  InputLabel,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { SelectChangeEvent } from '@mui/material';
import { ArrowDownIcon, ArrowUpIcon, XIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { workshopById, workshopCatalog } from '@/game-config/workshop';
import ClusterPresetActions from './ClusterPresetActions';

const maxMods = 60;

function mergeIds(selected: string[], input: string) {
  const entered = input
    .trim()
    .split(/[\s,，]+/)
    .filter(Boolean);
  if (entered.some((id) => !/^\d{1,20}$/.test(id)))
    throw new Error('模组 ID 必须是 1～20 位数字。');
  const merged = [...new Set([...selected, ...entered])];
  if (merged.length > maxMods) throw new Error(`最多添加 ${maxMods} 个模组。`);
  return merged;
}

export default function ModsDialog({
  initial,
  overridden,
  clusterId,
  presetModOverride,
  onClose,
  onSave,
}: {
  initial: string[];
  overridden: boolean;
  clusterId: string;
  presetModOverride: boolean;
  onClose: () => void;
  onSave: (ids: string[], loadedFromGroup: boolean) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const selectId = useId();
  const [ids, setIds] = useState(() => [...new Set(initial)]);
  const [manual, setManual] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadedFromGroup, setLoadedFromGroup] = useState(false);
  const selected = ids.filter((id) => workshopById.has(id));

  const handleCatalogChange = useCallback(
    (event: SelectChangeEvent<string[]>) => {
      const values = event.target.value;
      const next = new Set(typeof values === 'string' ? values.split(',') : values);
      const merged = [
        ...ids.filter((id) => !workshopById.has(id) || next.has(id)),
        ...[...next].filter((id) => !ids.includes(id)),
      ];
      if (merged.length > maxMods) {
        setFieldError(`最多添加 ${maxMods} 个模组。`);
        return;
      }
      setIds(merged);
      setFieldError('');
    },
    [ids],
  );
  const handleAdd = useCallback(() => {
    try {
      setIds(mergeIds(ids, manual));
      setManual('');
      setFieldError('');
    } catch (error) {
      setFieldError((error as Error).message);
    }
  }, [ids, manual]);
  const handleMove = useCallback((index: number, direction: -1 | 1) => {
    setIds((current) => {
      const next = [...current];
      const target = index + direction;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }, []);
  const handleRemove = useCallback((id: string) => {
    setIds((current) => current.filter((value) => value !== id));
    setFieldError('');
  }, []);
  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      let merged: string[];
      try {
        merged = mergeIds(ids, manual);
      } catch (error) {
        setFieldError((error as Error).message);
        return;
      }
      setBusy(true);
      setSaveError('');
      try {
        await onSave(merged, loadedFromGroup);
        onClose();
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : '保存失败。');
      } finally {
        setBusy(false);
      }
    },
    [ids, manual, loadedFromGroup, onSave, onClose],
  );

  return (
    <Dialog open fullWidth maxWidth="sm" onClose={busy ? undefined : onClose}>
      <Box component="form" onSubmit={handleSubmit}>
        <DialogTitle>{t('编辑模组')}</DialogTitle>
        <DialogContent>
          <Stack gap={2} sx={{ pt: 1 }}>
            <ClusterPresetActions
              clusterId={clusterId}
              disabled={busy}
              modOverride={presetModOverride}
              getDraft={(mode) => ({
                kind: 'mods',
                modIds: mode === 'save' ? mergeIds(ids, manual) : ids,
              })}
              onError={setFieldError}
              onLoad={(preset) => {
                if (preset.kind !== 'mods') return;
                setIds([...preset.modIds]);
                setManual('');
                setFieldError('');
                setSaveError('');
                setLoadedFromGroup(true);
              }}
            />
            {overridden && !loadedFromGroup && (
              <Alert severity="warning">
                {t('手写配置里的 ActiveMods 会覆盖这份列表。如需使用这里的列表，请先移除手写项。')}
              </Alert>
            )}
            {loadedFromGroup && presetModOverride && (
              <Alert severity="info">
                {t('保存地图时会采用此模组顺序，并移除手写的模组列表覆盖项。')}
              </Alert>
            )}
            {saveError && <Alert severity="error">{saveError}</Alert>}
            <FormControl fullWidth disabled={busy}>
              <InputLabel id={selectId}>{t('常用模组')}</InputLabel>
              <Select
                multiple
                labelId={selectId}
                label={t('常用模组')}
                value={selected}
                onChange={handleCatalogChange}
                renderValue={(values) => values.map((id) => workshopById.get(id)?.name).join('、')}
                MenuProps={{ slotProps: { paper: { sx: { maxHeight: 320 } } } }}
              >
                {workshopCatalog.map(({ id, name, category }) => (
                  <MenuItem key={id} value={id}>
                    <Checkbox checked={selected.includes(id)} />
                    <ListItemText primary={name} secondary={`${t(category)} · ${id}`} />
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Typography variant="body2" color="text.secondary">
              {t('此列表使用 Steam 创意工坊 ID。ArkShop 等可在「地图管理 → 服务端插件」安装。')}
            </Typography>
            {ids.includes('731604991') && ids.includes('1999447172') && (
              <Alert severity="warning">
                {t(
                  'Structures Plus (S+) 与 Super Structures 使用部分相同资源，建议只选择其中一个。',
                )}
              </Alert>
            )}
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              gap={1}
              alignItems={{ sm: 'flex-start' }}
            >
              <TextField
                fullWidth
                multiline
                maxRows={4}
                label={t('手动输入 Workshop ID')}
                value={manual}
                onChange={(event) => {
                  setManual(event.target.value);
                  setFieldError('');
                }}
                disabled={busy}
                error={!!fieldError}
                helperText={fieldError || t('用逗号、空格或换行分隔多个 ID。')}
              />
              <Button variant="outlined" onClick={handleAdd} disabled={busy || !manual.trim()}>
                {t('添加')}
              </Button>
            </Stack>
            <Typography fontWeight={650}>
              {t('加载顺序')} · {ids.length}/{maxMods}
            </Typography>
            {!ids.length && <Typography color="text.secondary">{t('尚未选择模组。')}</Typography>}
            {ids.map((id, index) => {
              const mod = workshopById.get(id);
              const label = mod?.name ?? id;
              return (
                <Stack
                  key={id}
                  direction="row"
                  gap={1}
                  alignItems="center"
                  sx={{ py: 0.5, borderBottom: 1, borderColor: 'divider' }}
                >
                  <Typography color="text.secondary">{index + 1}</Typography>
                  <Box sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                    <Typography>{label}</Typography>
                    {mod && (
                      <Typography variant="caption" color="text.secondary">
                        {id}
                      </Typography>
                    )}
                  </Box>
                  <IconButton
                    aria-label={`${t('上移')} ${label}`}
                    size="small"
                    disabled={busy || index === 0}
                    onClick={() => handleMove(index, -1)}
                  >
                    <ArrowUpIcon />
                  </IconButton>
                  <IconButton
                    aria-label={`${t('下移')} ${label}`}
                    size="small"
                    disabled={busy || index === ids.length - 1}
                    onClick={() => handleMove(index, 1)}
                  >
                    <ArrowDownIcon />
                  </IconButton>
                  <IconButton
                    aria-label={`${t('移除')} ${label}`}
                    size="small"
                    disabled={busy}
                    onClick={() => handleRemove(id)}
                  >
                    <XIcon />
                  </IconButton>
                </Stack>
              );
            })}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={busy}>
            {t('取消')}
          </Button>
          <Button type="submit" variant="contained" disabled={busy}>
            {t(busy ? '正在保存…' : '保存')}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
