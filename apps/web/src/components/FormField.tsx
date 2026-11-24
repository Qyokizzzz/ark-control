import { Box, FormControlLabel, MenuItem, Switch, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { Field, FormValues } from './common';

export default function FormField({
  field,
  value,
  onChange,
  disabled,
  compact,
}: {
  field: Field;
  value?: FormValues[string];
  onChange: (value: FormValues[string]) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
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
          label={t(field.label)}
        />
        {field.helper && (
          <Typography display="block" variant="caption" color="text.secondary">
            {t(field.helper)}
          </Typography>
        )}
      </Box>
    );
  }
  return (
    <TextField
      fullWidth
      size={compact ? 'small' : 'medium'}
      label={t(field.label)}
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
