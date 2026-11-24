import type { HTMLAttributes, ReactNode } from 'react';
import { Paper } from '@mui/material';

export default function Surface({
  children,
  sx,
  ...props
}: { children: ReactNode; sx?: object } & Pick<
  HTMLAttributes<HTMLDivElement>,
  'role' | 'aria-label'
>) {
  return (
    <Paper
      {...props}
      sx={{ border: 1, borderColor: 'divider', borderRadius: 3, overflow: 'hidden', ...sx }}
    >
      {children}
    </Paper>
  );
}
