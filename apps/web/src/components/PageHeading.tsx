import type { ReactNode } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';

export default function PageHeading({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      justifyContent="space-between"
      gap={2}
      sx={{ mb: 4 }}
    >
      <Box>
        <Typography variant="h2" sx={{ mb: 1 }}>
          {t(title)}
        </Typography>
        <Typography color="text.secondary" sx={{ maxWidth: 680 }}>
          {t(description)}
        </Typography>
      </Box>
      {action && (
        <Box sx={{ flexShrink: 0, alignSelf: { xs: 'flex-start', sm: 'center' } }}>{action}</Box>
      )}
    </Stack>
  );
}
