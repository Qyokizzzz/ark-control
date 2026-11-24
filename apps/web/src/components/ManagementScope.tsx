import { useCallback } from 'react';
import type { ReactNode } from 'react';
import { Box, MenuItem, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useManagementStore } from '@/store';

export default function ManagementScope({
  secondaryField,
  action,
}: { secondaryField?: ReactNode; action?: ReactNode } = {}) {
  const { t } = useTranslation();
  const { data, scopeId, select } = useManagementStore();
  const handleSelect = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => select(event.target.value),
    [select],
  );
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: 'minmax(0, max-content) minmax(0, 1fr)',
          sm: '260px minmax(0, max-content)',
        },
        gridTemplateAreas: {
          xs: `"scope scope" "hint ."${secondaryField ? ' "secondary secondary"' : ''}${action ? ' "action ."' : ''}`,
          sm: `"scope hint"${secondaryField || action ? ' "secondary action"' : ''}`,
        },
        gap: { xs: 1.5, sm: 2 },
        mb: 3,
      }}
    >
      <TextField
        id="management-scope"
        select
        label={t('互通组 / 独立服')}
        value={data?.scopes.some((scope) => scope.id === scopeId) ? scopeId : ''}
        onChange={handleSelect}
        sx={{ gridArea: 'scope', minWidth: 0 }}
      >
        {(data?.scopes ?? []).map((scope) => (
          <MenuItem key={scope.id} value={scope.id}>
            {scope.name}
          </MenuItem>
        ))}
      </TextField>
      <Typography
        color="text.secondary"
        variant="body2"
        sx={{ gridArea: 'hint', alignSelf: 'center' }}
      >
        {t('同一互通组共享用户和经济')}
      </Typography>
      {secondaryField && <Box sx={{ gridArea: 'secondary', minWidth: 0 }}>{secondaryField}</Box>}
      {action && (
        <Box sx={{ gridArea: 'action', contain: 'inline-size', alignSelf: 'start' }}>{action}</Box>
      )}
    </Box>
  );
}
