import { useCallback, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { CaretDownIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { INI_FILES, INI_SECTIONS } from '@ark-control/common';
import type { IniFile, Instance } from '@ark-control/common';
import { useTranslation } from 'react-i18next';
import {
  advancedById,
  advancedGroups,
  configGrid,
  maturityId,
  optionId,
  validCustomKey,
} from '@/game-config';
import type { DraftEntry, EntriesByOption, IniOption } from '@/game-config';
import FormField from './FormField';
import type { Field, FormValues } from './common';

const card = { p: 1.5, minWidth: 0, border: 1, borderColor: 'divider', borderRadius: 2 };
const privateKey = /password|secret|token|apikey/i;

export function IniOverride({ entries, secret }: { entries?: DraftEntry[]; secret?: boolean }) {
  const { t } = useTranslation();
  if (!entries?.length) return null;
  const last = entries.at(-1)!;
  const value =
    secret || privateKey.test(last.key)
      ? ''
      : entries.length > 1
        ? `${entries.length} ${t('条')}`
        : last.value.length > 45
          ? last.value.slice(0, 45) + '…'
          : last.value || t('空值');
  return (
    <Chip
      size="small"
      variant="outlined"
      color="warning"
      label={value ? `${t('手写覆盖')} · ${value}` : t('手写覆盖')}
      sx={{ alignSelf: 'flex-start', maxWidth: '100%' }}
    />
  );
}

function IniControl({
  option,
  entries,
  override,
  disabled,
  basicValue,
  onChange,
  onBasicChange,
}: {
  option: IniOption;
  entries: DraftEntry[];
  override?: DraftEntry[];
  disabled: boolean;
  basicValue?: FormValues[string];
  onChange: (entries: DraftEntry[]) => void;
  onBasicChange?: (value: FormValues[string]) => void;
}) {
  const { t } = useTranslation();
  const { key, label, file, section, kind, defaultValue, hint } = option;
  const isSwitch = kind === 'switch';
  const raw = entries.at(-1)?.value;
  const value =
    basicValue ??
    (isSwitch
      ? raw === undefined
        ? defaultValue === true
        : /^(?:true|1)$/i.test(raw)
      : (raw ?? String(defaultValue ?? '')));
  const makeEntry = (value: string): DraftEntry => ({ file, section, key, value, modifier: '' });
  const handleChange = (next: FormValues[string]) => {
    if (onBasicChange) {
      onBasicChange(next);
      return;
    }
    onChange([makeEntry(typeof next === 'boolean' ? (next ? 'True' : 'False') : String(next))]);
  };
  const defaultText =
    defaultValue === null
      ? t('由游戏决定')
      : typeof defaultValue === 'boolean'
        ? t(defaultValue ? '开启' : '关闭')
        : String(defaultValue);
  const modified = entries.length > 0 && !onBasicChange;
  return (
    <Stack spacing={0.75} sx={card}>
      {kind === 'list' ? (
        <>
          <Typography variant="body2" sx={{ fontWeight: 650, overflowWrap: 'anywhere' }}>
            {t(label)}
          </Typography>
          {entries.map((entry, index) => (
            <Stack key={index} direction="row" alignItems="center" spacing={0.5}>
              <FormField
                field={{ key, label: `${t('条目')} ${index + 1}`, kind: 'text' }}
                value={entry.value}
                onChange={(next) =>
                  onChange(
                    entries.map((item, position) =>
                      position === index ? { ...item, value: String(next) } : item,
                    ),
                  )
                }
                disabled={disabled}
                compact
              />
              <IconButton
                size="small"
                aria-label={`${t('删除条目')} ${index + 1}`}
                disabled={disabled}
                onClick={() => onChange(entries.filter((_entry, position) => position !== index))}
              >
                <TrashIcon size={16} />
              </IconButton>
            </Stack>
          ))}
          <Button
            size="small"
            startIcon={<PlusIcon size={15} />}
            onClick={() => onChange([...entries, makeEntry('')])}
            disabled={disabled}
            sx={{ alignSelf: 'flex-start' }}
          >
            {t('添加条目')}
          </Button>
        </>
      ) : (
        <FormField
          field={{
            key,
            label,
            kind: kind === 'integer' || kind === 'number' ? 'number' : kind,
            min: key === 'LimitTurretsNum' ? 1 : onBasicChange ? 0.1 : undefined,
            max: key === 'LimitTurretsNum' ? 2147483647 : onBasicChange ? 1000 : undefined,
            step: kind === 'integer' ? '1' : 'any',
            required: !!onBasicChange,
          }}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          compact
        />
      )}
      <Typography
        variant="caption"
        color="text.secondary"
        title={`${INI_FILES[file]} · [${section}]`}
        sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}
      >
        {key}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
        {hint ? t(hint) + ' ' : ''}
        {t('默认')} {defaultText}
      </Typography>
      <IniOverride entries={override} secret={kind === 'password'} />
      {modified && (
        <Button
          size="small"
          color="inherit"
          onClick={() => onChange([])}
          disabled={disabled}
          sx={{ alignSelf: 'flex-start' }}
        >
          {t('恢复默认')}
        </Button>
      )}
    </Stack>
  );
}

const fileOptions = Object.entries(INI_FILES).map(([value, label]) => ({ value, label }));
const customType: Field = {
  key: 'type',
  label: '值类型',
  kind: 'select',
  options: [
    { value: 'text', label: '文本或数值' },
    { value: 'switch', label: '开关' },
  ],
};

function CustomIniFields({
  entries,
  overrides,
  onChange,
  disabled,
  showComposer,
}: {
  entries: EntriesByOption;
  overrides: EntriesByOption;
  onChange: (id: string, entries: DraftEntry[]) => void;
  disabled: boolean;
  showComposer: boolean;
}) {
  const { t } = useTranslation();
  const [file, setFile] = useState<IniFile>('settings');
  const [section, setSection] = useState<string>(INI_SECTIONS.settings);
  const [key, setKey] = useState('');
  const [kind, setKind] = useState('text');
  const [error, setError] = useState('');
  const handleAdd = useCallback(() => {
    const cleanSection = section.trim();
    const cleanKey = key.trim();
    const issue = validCustomKey(file, cleanSection, cleanKey);
    if (issue) {
      setError(issue);
      return;
    }
    const entry = {
      file,
      section: cleanSection,
      key: cleanKey,
      modifier: '',
      value: kind === 'switch' ? 'False' : '',
      asSwitch: kind === 'switch',
    };
    const id = optionId(entry);
    onChange(id, [...(entries.get(id) ?? []), entry]);
    setKey('');
    setError('');
  }, [entries, file, key, kind, onChange, section]);

  return (
    <Stack spacing={2}>
      {showComposer && (
        <>
          <Typography variant="body2" color="text.secondary">
            {t('填写文件、节名和键名，可为模组或其他游戏设置添加表单项。')}
          </Typography>
          <Box sx={configGrid}>
            <FormField
              field={{ key: 'file', label: 'INI 文件', kind: 'select', options: fileOptions }}
              value={file}
              onChange={(next) => {
                const selected = next as IniFile;
                setFile(selected);
                setSection(INI_SECTIONS[selected]);
              }}
              disabled={disabled}
              compact
            />
            <FormField
              field={{ key: 'section', label: 'INI 节名' }}
              value={section}
              onChange={(value) => setSection(String(value))}
              disabled={disabled}
              compact
            />
            <FormField
              field={{ key: 'key', label: 'INI 键名' }}
              value={key}
              onChange={(value) => setKey(String(value))}
              disabled={disabled}
              compact
            />
            <FormField
              field={customType}
              value={kind}
              onChange={(value) => setKind(String(value))}
              disabled={disabled}
              compact
            />
            <Button
              onClick={handleAdd}
              disabled={disabled}
              startIcon={<PlusIcon size={16} />}
              variant="outlined"
              sx={{ justifySelf: 'start' }}
            >
              {t('添加配置项')}
            </Button>
          </Box>
          {error && <Alert severity="error">{t(error)}</Alert>}
        </>
      )}
      {[...entries]
        .filter(([id]) => !advancedById.has(id) && id !== maturityId)
        .map(([id, rows]) => {
          const first = rows[0]!;
          return (
            <Stack key={id} spacing={1} sx={card}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ overflowWrap: 'anywhere' }}
              >
                {INI_FILES[first.file]} · [{first.section}]
              </Typography>
              {rows.map((entry, index) => {
                const bool = entry.asSwitch === true;
                const label = `${entry.modifier}${entry.key}${rows.length > 1 ? ` · ${index + 1}` : ''}`;
                return (
                  <Stack key={index} direction="row" alignItems="center" spacing={1}>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <FormField
                        field={{
                          key: entry.key,
                          label,
                          kind: bool ? 'switch' : privateKey.test(entry.key) ? 'password' : 'text',
                        }}
                        value={bool ? /^true$/i.test(entry.value) : entry.value}
                        onChange={(value) =>
                          onChange(
                            id,
                            rows.map((row, position) =>
                              position === index
                                ? {
                                    ...row,
                                    value:
                                      typeof value === 'boolean'
                                        ? value
                                          ? 'True'
                                          : 'False'
                                        : String(value),
                                  }
                                : row,
                            ),
                          )
                        }
                        disabled={disabled}
                        compact
                      />
                    </Box>
                    <IconButton
                      aria-label={`${t('删除配置项')} ${label}`}
                      disabled={disabled}
                      onClick={() =>
                        onChange(
                          id,
                          rows.filter((_row, position) => position !== index),
                        )
                      }
                    >
                      <TrashIcon size={17} />
                    </IconButton>
                  </Stack>
                );
              })}
              <IniOverride entries={overrides.get(id)} />
            </Stack>
          );
        })}
    </Stack>
  );
}

export default function AdvancedIniFields({
  instance,
  entries,
  overrides,
  disabled,
  babyMature,
  estimate,
  onMaturityChange,
  onChange,
}: {
  instance: Instance;
  entries: EntriesByOption;
  overrides: EntriesByOption;
  disabled: boolean;
  babyMature: FormValues[string];
  estimate: { opportunities: number; intervalMinutes: number } | null;
  onMaturityChange: (value: FormValues[string]) => void;
  onChange: (id: string, entries: DraftEntry[]) => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const terms = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  const pinned = advancedGroups[0]!;
  const matches = (...words: string[]) => {
    const haystack = words.join(' ').toLowerCase();
    return terms.every((term) => haystack.includes(term));
  };
  const filtered = (group: (typeof advancedGroups)[number]) =>
    group.options.filter((option) =>
      matches(group.title, option.label, option.key, option.section, INI_FILES[option.file]),
    );
  const top = filtered(pinned);
  const groups = advancedGroups
    .slice(1)
    .map((group) => ({ title: group.title, options: filtered(group) }))
    .filter((group) => group.options.length);
  const managed = [
    { field: { key: 'Port', label: '游戏端口', kind: 'number' }, value: instance.gamePort },
    {
      field: { key: 'QueryPort', label: 'Steam 查询端口', kind: 'number' },
      value: instance.queryPort,
    },
    { field: { key: 'RCONPort', label: 'RCON 端口', kind: 'number' }, value: instance.rconPort },
    { field: { key: 'RCONEnabled', label: '启用 RCON', kind: 'switch' }, value: true },
    {
      field: {
        key: 'ServerAdminPassword',
        label: '管理密码',
        kind: 'password',
        placeholder: '主机助手托管',
      },
      value: '',
    },
  ].filter(({ field }) => matches('主机助手托管', field.key, field.label, INI_FILES.settings));
  const customMatches = new Map(
    [...entries].filter(([id, rows]) => {
      const row = rows[0]!;
      return !advancedById.has(id) && matches(row.key, row.section, INI_FILES[row.file]);
    }),
  );
  const renderOptions = (options: IniOption[]) => (
    <Box sx={configGrid}>
      {options.map((option) => {
        const id = optionId(option);
        return (
          <IniControl
            key={id}
            option={option}
            entries={entries.get(id) ?? []}
            override={overrides.get(id)}
            disabled={disabled}
            basicValue={id === maturityId ? babyMature : undefined}
            onBasicChange={id === maturityId ? onMaturityChange : undefined}
            onChange={(next) => onChange(id, next)}
          />
        );
      })}
    </Box>
  );
  return (
    <Stack spacing={2}>
      <TextField
        fullWidth
        size="small"
        label={t('搜索高级配置')}
        placeholder={t('按中文名称、INI 键名或文件搜索')}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {!!top.length && (
        <Stack spacing={1.5}>
          <Typography variant="h6" component="h3">
            {t(pinned.title)}
          </Typography>
          {renderOptions(top)}
          {(!searching || top.some((option) => /baby/i.test(option.key))) && (
            <Box sx={{ ...card, bgcolor: 'action.hover' }} aria-live="polite">
              <Typography variant="body2" sx={{ fontWeight: 650 }}>
                {t('留痕次数预估')}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {estimate
                  ? `原版霸王龙成年前约可照料 ${estimate.opportunities.toLocaleString('zh-CN')} 次，间隔约 ${estimate.intervalMinutes} 分钟。不同物种的次数不同。`
                  : t('填写有效的成长和留痕间隔倍率后显示预估。')}
              </Typography>
            </Box>
          )}
        </Stack>
      )}
      <Stack spacing={1}>
        {groups.map((group) => (
          <Accordion
            key={group.title + (searching ? '-search' : '')}
            defaultExpanded={searching}
            disableGutters
            variant="outlined"
            slotProps={{ transition: { unmountOnExit: true } }}
          >
            <AccordionSummary expandIcon={<CaretDownIcon size={16} />}>
              <Stack direction="row" spacing={1.25} alignItems="center">
                <Typography variant="body2" sx={{ fontWeight: 650 }}>
                  {t(group.title)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {group.options.length}
                </Typography>
              </Stack>
            </AccordionSummary>
            <AccordionDetails>{renderOptions(group.options)}</AccordionDetails>
          </Accordion>
        ))}
        {!!managed.length && (
          <Accordion
            key={searching ? 'managed-search' : 'managed'}
            defaultExpanded={searching}
            disableGutters
            variant="outlined"
            slotProps={{ transition: { unmountOnExit: true } }}
          >
            <AccordionSummary expandIcon={<CaretDownIcon size={16} />}>
              <Typography variant="body2" sx={{ fontWeight: 650 }}>
                {t('端口与 RCON · 主机助手托管')}
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Box sx={configGrid}>
                {managed.map(({ field, value }) => (
                  <FormField
                    key={field.key}
                    field={field as Field}
                    value={typeof value === 'boolean' ? value : String(value)}
                    onChange={() => undefined}
                    disabled
                    compact
                  />
                ))}
              </Box>
            </AccordionDetails>
          </Accordion>
        )}
        {(!searching || customMatches.size > 0) && (
          <Accordion
            key={searching ? 'custom-search' : 'custom'}
            defaultExpanded={searching}
            disableGutters
            variant="outlined"
            slotProps={{ transition: { unmountOnExit: true } }}
          >
            <AccordionSummary expandIcon={<CaretDownIcon size={16} />}>
              <Typography variant="body2" sx={{ fontWeight: 650 }}>
                {t('自定义 INI 键值')}
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              <CustomIniFields
                entries={searching ? customMatches : entries}
                overrides={overrides}
                onChange={onChange}
                disabled={disabled}
                showComposer={!searching}
              />
            </AccordionDetails>
          </Accordion>
        )}
      </Stack>
      {!top.length && !groups.length && !managed.length && !customMatches.size && (
        <Typography variant="body2" color="text.secondary">
          {t('未找到匹配的高级配置。清除搜索后可添加自定义 INI 键值。')}
        </Typography>
      )}
    </Stack>
  );
}
