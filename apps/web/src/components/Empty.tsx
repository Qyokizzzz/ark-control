import type { ReactNode } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import { PlanetIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

export default function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Stack
      alignItems="center"
      justifyContent="center"
      spacing={2}
      sx={{ py: 8, px: 3, textAlign: 'center' }}
    >
      <Box sx={{ p: 2, color: 'primary.main', bgcolor: 'action.hover', borderRadius: 3 }}>
        <PlanetIcon size={32} weight="duotone" />
      </Box>
      <Typography variant="h4">{t(title)}</Typography>
      {description && (
        <Typography color="text.secondary" sx={{ maxWidth: 400 }}>
          {t(description)}
        </Typography>
      )}
      {action}
    </Stack>
  );
}
