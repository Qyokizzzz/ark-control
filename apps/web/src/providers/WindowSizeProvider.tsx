import type { PropsWithChildren } from 'react';
import { useMediaQuery, useTheme } from '@mui/material';
import { WindowSizeContext } from './context';
export default function WindowSizeProvider({ children }: PropsWithChildren) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down('md'));
  return <WindowSizeContext.Provider value={{ mobile }}>{children}</WindowSizeContext.Provider>;
}
