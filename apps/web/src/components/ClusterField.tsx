import { Autocomplete, TextField } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { clusterIdSchema } from '@ark-control/common';
import type { ClusterPresetGroup, GameBranch } from '@ark-control/common';

export default function ClusterField({
  value,
  groups,
  onChange,
  branch,
  disabled,
  loading,
  error,
}: {
  value: string;
  groups: ClusterPresetGroup[];
  onChange: (id: string) => void;
  branch?: GameBranch;
  disabled?: boolean;
  loading?: boolean;
  error?: string;
}) {
  const { t } = useTranslation();
  const byId = new Map(groups.map((group) => [group.id, group]));
  const options = [...new Set(['', ...byId.keys(), value])];
  const label = (id: string) => id || t('独立地图');
  return (
    <Autocomplete
      options={options}
      value={value}
      disabled={disabled || loading || !!error}
      loading={loading}
      openOnFocus
      autoHighlight
      getOptionLabel={label}
      getOptionDisabled={(option) => {
        const group = byId.get(option);
        return !!group && (!group.canJoin || (branch !== undefined && branch !== group.branch));
      }}
      onChange={(_event, option) => onChange(option ?? '')}
      filterOptions={(available, { inputValue }) => {
        const id = inputValue.trim();
        const search = inputValue === label(value) ? '' : id.toLowerCase();
        const filtered = available.filter((option) => label(option).toLowerCase().includes(search));
        if (
          search &&
          id &&
          clusterIdSchema.safeParse(id).success &&
          !available.some((option) => option.toLowerCase() === search)
        )
          filtered.push(id);
        return filtered;
      }}
      renderOption={(props, option) => {
        const { key, ...attributes } = props;
        const group = byId.get(option);
        return (
          <li key={key} {...attributes}>
            {option && option !== value && !group
              ? `${t('创建互通组')}「${option}」`
              : label(option)}
            {group && ` · ${group.branch === 'public' ? '361' : '358'}`}
          </li>
        );
      }}
      noOptionsText={t('请输入字母、数字、短横线或下划线创建互通组。')}
      renderInput={(params) => (
        <TextField
          {...params}
          fullWidth
          label={t('互通组')}
          error={!!error}
          helperText={
            error || t(loading ? '正在读取互通组…' : '选择已有组，也可以输入标识创建新组。')
          }
        />
      )}
    />
  );
}
