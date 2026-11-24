import { Skeleton, Stack } from '@mui/material';

export default function PageLoading() {
  return (
    <Stack gap={3} sx={{ p: { xs: 2, md: 4 } }}>
      <Skeleton variant="rounded" width="50%" height={40} />
      <Skeleton variant="rounded" height={120} />
      <Skeleton variant="rounded" height={320} />
    </Stack>
  );
}
