import { createTheme } from '@mui/material/styles';
import type { PaletteOptions } from '@mui/material/styles';
import type { ThemeName } from '@ark-control/common';

const strategies: Record<ThemeName, () => PaletteOptions> = {
  dark: () => ({
    mode: 'dark',
    primary: { main: '#b9ed80', contrastText: '#181818' },
    secondary: { main: '#a8b4ee' },
    background: { default: '#181818', paper: '#1f1f1f' },
    text: { primary: '#f0f1ef', secondary: '#9c9f99' },
    divider: '#313131',
    success: { main: '#a0ce73' },
    warning: { main: '#e8c781' },
    error: { main: '#ef9d9d' },
  }),
  light: () => ({
    mode: 'light',
    primary: { main: '#40713d' },
    background: { default: '#f5f6f3', paper: '#ffffff' },
    text: { primary: '#202820', secondary: '#6b746a' },
    divider: '#e2e6df',
  }),
  blue: () => ({
    mode: 'light',
    primary: { main: '#345fce' },
    background: { default: '#f3f6fc', paper: '#ffffff' },
    text: { primary: '#202d46', secondary: '#69758b' },
    divider: '#dfe5ef',
  }),
  pink: () => ({
    mode: 'light',
    primary: { main: '#ad4277' },
    background: { default: '#fcf5f8', paper: '#ffffff' },
    text: { primary: '#402a36', secondary: '#8a6b7c' },
    divider: '#eedfe7',
  }),
  yellow: () => ({
    mode: 'light',
    primary: { main: '#8b6611' },
    background: { default: '#fbf8ed', paper: '#fffdf7' },
    text: { primary: '#3b3525', secondary: '#81775d' },
    divider: '#e9e1c9',
  }),
};
export function makeTheme(name: ThemeName) {
  return createTheme({
    palette: strategies[name](),
    shape: { borderRadius: 4 },
    spacing: 8,
    typography: {
      fontFamily: 'Geist, "Microsoft YaHei", "PingFang SC", sans-serif',
      fontSize: 14,
      h1: { fontSize: '2.25rem', lineHeight: '2.5rem', fontWeight: 600, letterSpacing: '-0.04em' },
      h2: {
        fontSize: '1.875rem',
        lineHeight: '2.25rem',
        fontWeight: 600,
        letterSpacing: '-0.03em',
      },
      h3: { fontSize: '1.5rem', lineHeight: '2rem', fontWeight: 600 },
      h4: { fontSize: '1.25rem', lineHeight: '1.75rem', fontWeight: 600 },
      h5: { fontSize: '1.125rem', lineHeight: '1.75rem', fontWeight: 500 },
      h6: { fontSize: '1rem', lineHeight: '1.5rem', fontWeight: 500 },
      body1: { fontSize: '0.875rem', lineHeight: '1.25rem' },
      body2: { fontSize: '0.75rem', lineHeight: '1rem' },
      button: {
        fontSize: '0.875rem',
        lineHeight: '1.25rem',
        fontWeight: 600,
        textTransform: 'none',
      },
      caption: { fontSize: '0.75rem', lineHeight: '1rem' },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: { minWidth: 320, backgroundImage: 'none' },
          'h1,h2,h3,h4,h5,h6': { textWrap: 'balance' },
          p: { textWrap: 'pretty' },
          '*:focus-visible': { outline: '2px solid #7cae58', outlineOffset: 3 },
          '::selection': { background: '#b9ed8040' },
        },
      },
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: { root: { backgroundImage: 'none' } },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: {
            borderRadius: 8,
            padding: '8px 12px',
            minHeight: 40,
            boxShadow: 'none',
            transition:
              'opacity 300ms cubic-bezier(0.22,1,0.36,1), transform 300ms cubic-bezier(0.22,1,0.36,1)',
            '&:active': { transform: 'scale(.98)' },
          },
        },
      },
      MuiIconButton: { styleOverrides: { root: { borderRadius: 8 } } },
      MuiTextField: { defaultProps: { size: 'small', fullWidth: true } },
      MuiOutlinedInput: { styleOverrides: { root: { borderRadius: 8, minHeight: 40 } } },
      MuiChip: {
        defaultProps: { size: 'small' },
        styleOverrides: { root: { borderRadius: 6, fontWeight: 500 }, label: { paddingInline: 8 } },
      },
      MuiDialog: {
        defaultProps: { fullWidth: true, maxWidth: 'sm' },
        styleOverrides: {
          paper: {
            borderRadius: 16,
            border: '1px solid',
            borderColor: name === 'dark' ? '#313131' : '#dfe5dc',
            margin: 16,
            maxHeight: 'calc(100% - 32px)',
          },
        },
      },
      MuiDialogTitle: { styleOverrides: { root: { fontSize: 20, fontWeight: 600, padding: 24 } } },
      MuiDialogContent: { styleOverrides: { root: { padding: 24 } } },
      MuiDialogActions: { styleOverrides: { root: { padding: 24, paddingTop: 16 } } },
      MuiTableCell: {
        styleOverrides: {
          root: { borderColor: name === 'dark' ? '#313131' : '#e2e6df', padding: '16px' },
          head: {
            fontSize: 12,
            color: name === 'dark' ? '#9c9f99' : '#6b746a',
            fontWeight: 500,
            whiteSpace: 'nowrap',
          },
        },
      },
      MuiAlert: {
        styleOverrides: {
          root: { borderRadius: 8, alignItems: 'center', padding: '10px 16px' },
          icon: { alignItems: 'center', flexShrink: 0, padding: 0 },
          message: { padding: 0, minWidth: 0, overflowWrap: 'anywhere' },
          action: {
            alignItems: 'center',
            flexShrink: 0,
            padding: 0,
            paddingInlineStart: 12,
          },
        },
      },
      MuiLinearProgress: { styleOverrides: { root: { borderRadius: 8, height: 4 } } },
      MuiTab: { styleOverrides: { root: { textTransform: 'none', fontSize: 14, minWidth: 64 } } },
    },
  });
}
