import {
  Box,
  FormControlLabel,
  IconButton,
  InputAdornment,
  MenuItem,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import type { Field, FormValues } from './common';

export default function FormField({
  field,
  value,
  onChange,
  disabled,
  compact,
  reset,
}: {
  field: Field;
  value?: FormValues[string];
  onChange: (value: FormValues[string]) => void;
  disabled?: boolean;
  compact?: boolean;
  reset?: { onClick: () => void; disabled?: boolean; tooltip?: string };
}) {
  const { t } = useTranslation();
  const label = t(field.label);
  const unavailable = field.disabled || disabled;
  if (field.kind === 'switch') {
    return (
      <Box>
        <FormControlLabel
          sx={{ ml: 0, mr: 1 }}
          control={
            <Switch
              checked={value === true}
              disabled={unavailable}
              onChange={(_event, checked) => onChange(checked)}
              slotProps={{ input: { role: 'switch' } }}
            />
          }
          label={label}
        />
        {field.helper && (
          <Typography display="block" variant="caption" color="text.secondary">
            {t(field.helper)}
          </Typography>
        )}
      </Box>
    );
  }
  const resetLabel = reset && t('将{{field}}重置为默认值', { field: label });
  return (
    <TextField
      fullWidth
      size={compact ? 'small' : 'medium'}
      label={label}
      required={field.required}
      type={field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text'}
      select={field.kind === 'select'}
      multiline={field.kind === 'textarea'}
      minRows={field.kind === 'textarea' ? 5 : undefined}
      placeholder={field.placeholder}
      disabled={unavailable}
      value={value ?? ''}
      helperText={field.helper ? t(field.helper) : undefined}
      slotProps={{
        input: reset && {
          endAdornment: (
            <InputAdornment position="end">
              <Tooltip title={reset.tooltip ?? resetLabel}>
                <span style={{ display: 'inline-flex' }}>
                  <IconButton
                    type="button"
                    edge="end"
                    size="small"
                    aria-label={resetLabel}
                    disabled={unavailable || reset.disabled}
                    onClick={reset.onClick}
                  >
                    <ArrowCounterClockwiseIcon size={16} />
                  </IconButton>
                </span>
              </Tooltip>
            </InputAdornment>
          ),
        },
        htmlInput: {
          min: field.min,
          max: field.max,
          maxLength: field.maxLength,
          step: field.step ?? (field.kind === 'number' ? 'any' : undefined),
          autoComplete: field.kind === 'password' ? 'new-password' : undefined,
        },
      }}
      onChange={(event) => onChange(event.target.value)}
    >
      {field.kind === 'select' && [
        <MenuItem key="empty" value="" disabled>
          {t('请选择')}
        </MenuItem>,
        ...(field.options ?? []).map((option) => (
          <MenuItem key={option.value} value={option.value}>
            {t(option.label)}
          </MenuItem>
        )),
      ]}
    </TextField>
  );
}
