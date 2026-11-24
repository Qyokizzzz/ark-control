import { Chip } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { STATUS_LABELS } from '@ark-control/common';

export default function Status({ value }: { value: string }) {
  const { t } = useTranslation();
  const color = ['running', 'online', 'sent', 'succeeded', 'verified'].includes(value)
    ? 'success'
    : ['error', 'failed', 'blocked', 'uncertain'].includes(value)
      ? 'error'
      : [
            'starting',
            'stopping',
            'deleting',
            'disconnecting',
            'pending',
            'retry',
            'executing',
          ].includes(value)
        ? 'warning'
        : 'default';
  return (
    <Chip
      label={t(STATUS_LABELS[value] ?? value)}
      color={color}
      variant="outlined"
      sx={{ height: 24, fontSize: 12 }}
    />
  );
}
